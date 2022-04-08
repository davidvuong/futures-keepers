import { Contract } from "@ethersproject/contracts";
import { chunk, orderBy } from "lodash";
import ethers, { BigNumber, utils } from "ethers";
import winston, { format, Logger, transports } from "winston";
import * as metrics from "./metrics";
import SignerPool from "./signer-pool";
import {
  TransactionReceipt,
  TransactionResponse,
} from "@ethersproject/abstract-provider";
import { wei } from "@synthetixio/wei";
import Denque from "denque"; // double sided queue for volume measurement

const UNIT = utils.parseUnits("1");

function isObjectOrErrorWithCode(x: unknown): x is { code: string } {
  if (typeof x !== "object") return false;
  if (x === null) return false;
  return "code" in x;
}

const EventsOfInterest = {
  PositionLiquidated: "PositionLiquidated",
  PositionModified: "PositionModified",
  FundingRecomputed: "FundingRecomputed",
};

class Keeper {
  baseAsset: string;
  futuresMarket: Contract;
  logger: Logger;
  positions: {
    [account: string]: {
      id: string;
      event: string;
      account: string;
      size: number;
      leverage: number;
    };
  };
  activeKeeperTasks: { [id: string]: boolean | undefined };
  provider:
    | ethers.providers.WebSocketProvider
    | ethers.providers.JsonRpcProvider;
  blockQueue: Denque<string>;
  blockTip: string | null;
  blockTipTimestamp: number;
  signerPool: SignerPool;
  network: string;
  volumeQueue: Denque<{ tradeSizeUSD: number; timestamp: number }>;
  recentVolume: number;

  constructor({
    futuresMarket,
    baseAsset,
    signerPool,
    network,
    provider,
  }: {
    futuresMarket: ethers.Contract;
    baseAsset: string;
    signerPool: SignerPool;
    network: string;
    provider:
      | ethers.providers.WebSocketProvider
      | ethers.providers.JsonRpcProvider;
  }) {
    this.baseAsset = baseAsset;
    this.network = network;

    // Contracts.
    this.futuresMarket = futuresMarket;

    this.logger = winston.createLogger({
      level: "info",
      format: format.combine(
        format.colorize(),
        format.timestamp(),
        format.label({ label: `FuturesMarket [${baseAsset}]` }),
        format.printf(info => {
          return [
            info.timestamp,
            info.level,
            info.label,
            info.component,
            info.message,
          ]
            .filter(x => !!x)
            .join(" ");
        })
      ),
      transports: [new transports.Console()],
    });
    this.logger.info(`market deployed at ${futuresMarket.address}`);

    // The index.
    this.positions = {};

    // A mapping of already running keeper tasks.
    this.activeKeeperTasks = {};

    // A FIFO queue of blocks to be processed.
    this.blockQueue = new Denque();

    this.blockTip = null;
    this.blockTipTimestamp = 0;
    this.provider = provider;
    this.signerPool = signerPool;

    // volume accounting for metrics
    // this queue maintains 24h worth of recent volume updates so that rolling
    // volume can be computed.
    // Denque is used in order for this to be computed efficiently in
    // linear time instead of quadratic (for a regular array)
    this.volumeQueue = new Denque();
    this.recentVolume = 0;
  }

  static async create({
    futuresMarket,
    signerPool,
    provider,
    network,
  }: {
    futuresMarket: Contract;
    signerPool: SignerPool;
    network: string;
    provider:
      | ethers.providers.JsonRpcProvider
      | ethers.providers.WebSocketProvider;
  }) {
    const baseAssetBytes32 = await futuresMarket.baseAsset();
    const baseAsset = utils.parseBytes32String(baseAssetBytes32);

    return new Keeper({
      futuresMarket,
      baseAsset,
      signerPool,
      provider,
      network,
    });
  }
  async startProcessNewBlockConsumer() {
    // The L2 node is constantly mining blocks, one block per transaction. When a new block is received, we queue it
    // for processing in a FIFO queue. `processNewBlock` will scan its events, rebuild the index, and then run any
    // keeper tasks that need running that aren't already active.
    while (1) {
      if (!this.blockQueue.length) {
        await new Promise((resolve, reject) => setTimeout(resolve, 10));
        continue;
      }

      const blockNumber = this.blockQueue.shift();
      if (blockNumber) {
        await this.processNewBlock(blockNumber);
      }
    }
  }
  async getEvents(fromBlock: string | number, toBlock: string | number) {
    const eventNames = Object.values(EventsOfInterest);
    const nestedEvents = await Promise.all(
      eventNames.map(eventName => {
        // For some reason query filters logs out stuff to the console
        return this.futuresMarket.queryFilter(
          this.futuresMarket.filters[eventName](),
          fromBlock,
          toBlock
        );
      })
    );
    // warn about requesting too many events
    nestedEvents.map((singleFilterEvents, index) => {
      if (singleFilterEvents.length > 1000) {
        // at some point we'll issues getting enough events
        this.logger.log(
          "warn",
          `Got ${singleFilterEvents.length} ${eventNames[index]} events, will run into RPC limits at 10000`,
          { component: "Indexer" }
        );
      }
    });
    const events = nestedEvents.flat(1);
    // sort by block, tx index, and log index, so that events are processed in order
    events.sort(
      (a, b) =>
        a.blockNumber - b.blockNumber ||
        a.transactionIndex - b.transactionIndex ||
        a.logIndex - b.logIndex
    );
    return events;
  }
  async run({ fromBlock }: { fromBlock: string | number }) {
    const events = await this.getEvents(fromBlock, "latest");
    this.logger.log("info", `Rebuilding index from ${fromBlock} to latest`, {
      component: "Indexer",
    });
    this.logger.log("info", `${events.length} events to process`, {
      component: "Indexer",
    });
    await this.updateIndex(events);

    // TODO remove
    this.logger.log(
      "info",
      `VolumeQueue after sync: total ${
        this.recentVolume
      }\n:${this.volumeQueue
        .toArray()
        .map(o => `${o.tradeSizeUSD} ${o.timestamp}`)}`,
      { component: "Indexer" }
    );

    this.logger.log("info", `Index build complete!`, { component: "Indexer" });
    this.logger.log("info", `Starting keeper loop`);
    await this.runKeepers();

    this.logger.log("info", `Listening for events`);
    this.provider.on("block", async blockNumber => {
      if (!this.blockTip) {
        // Don't process the first block we see.
        this.blockTip = blockNumber;
        return;
      }

      this.logger.log("debug", `New block: ${blockNumber}`);
      this.blockQueue.push(blockNumber);
    });

    this.startProcessNewBlockConsumer();
  }

  async processNewBlock(blockNumber: string) {
    // first try to liquidate any positions that can be liquidated now
    await this.runKeepers();

    // now process new events to update index, since it's impossible for a position that
    // was just updated to be liquidatable at the same block
    const events = await this.getEvents(blockNumber, blockNumber);
    this.blockTip = blockNumber;
    if (!events.length) {
      // set block timestamp here in case there were no events to update the timestamp from
      this.blockTipTimestamp = (
        await this.provider.getBlock(blockNumber)
      ).timestamp;
    }
    this.logger.log(
      "info",
      `Processing new block: ${blockNumber}, ${events.length} events to process`,
      {
        component: "Indexer",
      }
    );
    await this.updateIndex(events);
  }

  async updateIndex(
    events: ethers.Event[],
    deps = {
      totalLiquidationsMetric: metrics.totalLiquidations,
      marketSizeMetric: metrics.marketSize,
      marketSkewMetric: metrics.marketSkew,
      recentVolumeMetric: metrics.recentVolume,
    }
  ) {
    events.forEach(({ event, args, blockNumber }) => {
      if (event === EventsOfInterest.FundingRecomputed && args) {
        // just a sneaky way to get timestamps without making awaiting getBlock() calls
        // keeping track of time is needed for the volume metrics during the initial
        // sync so that we don't have to await getting block timestamp for each new block
        this.blockTipTimestamp = args.timestamp.toNumber();
        this.logger.log(
          "debug",
          `FundingRecomputed timestamp ${this.blockTipTimestamp}, blocknumber ${blockNumber}`,
          { component: "Indexer" }
        );
        return;
      }

      if (event === EventsOfInterest.PositionModified && args) {
        const { id, account, size, margin, lastPrice, tradeSize } = args;

        this.logger.log(
          "debug",
          `PositionModified id=${id} account=${account}, blocknumber ${blockNumber}`,
          { component: "Indexer" }
        );

        if (margin.eq(BigNumber.from(0)) || size.eq(BigNumber.from(0))) {
          // Position has been closed.
          delete this.positions[account];
          return;
        }

        //   PositionModified(
        //     uint indexed id,
        //     address indexed account,
        //     uint margin,
        //     int size,
        //     int tradeSize,
        //     uint lastPrice,
        //     uint fundingIndex,
        //     uint fee
        // )
        // This is what's avaiable, ideally we should calculate the liq price based on margin and size maybe?

        this.positions[account] = {
          id,
          event,
          account,
          size: wei(size)
            .div(UNIT)
            .toNumber(),
          leverage: wei(size)
            .abs()
            .mul(lastPrice)
            .div(margin)
            .div(UNIT)
            .toNumber(),
        };

        // keep track of volume
        this.pushTradeToVolumeQueue(tradeSize, lastPrice);

        return;
      }
      if (event === EventsOfInterest.PositionLiquidated && args) {
        const { account, liquidator } = args;
        this.logger.log(
          "debug",
          `PositionLiquidated account=${account} liquidator=${liquidator}, blocknumber ${blockNumber}`,
          { component: "Indexer" }
        );

        deps.totalLiquidationsMetric.inc({
          market: this.baseAsset,
          network: this.network,
        });
        delete this.positions[account];
        return;
      }

      this.logger.debug(`No handler for event ${event}`, {
        component: "Indexer",
      });
    });

    // update volume metrics
    this.updateVolumeMetrics(deps);

    // update open interest metrics
    await this.updateOIMetrics(deps);
  }

  pushTradeToVolumeQueue(tradeSize: BigNumber, lastPrice: BigNumber) {
    const tradeSizeUSD = wei(tradeSize)
      .abs()
      .mul(lastPrice)
      .div(UNIT)
      .toNumber();
    // push into rolling queue
    this.volumeQueue.push({
      tradeSizeUSD: tradeSizeUSD,
      timestamp: this.blockTipTimestamp,
    });
    // add to total volume sum
    this.recentVolume += tradeSizeUSD;
  }

  updateVolumeMetrics(
    args = {
      recentVolumeMetric: metrics.recentVolume,
    }
  ) {
    const cutoffTimestamp =
      this.blockTipTimestamp - metrics.VOLUME_RECENCY_CUTOFF; // old values
    let peekFront = this.volumeQueue.peekFront();
    // remove old entries from the queue
    while (peekFront && peekFront.timestamp < cutoffTimestamp) {
      // remove from queue
      const removedEntry = this.volumeQueue.shift();
      // update sum of volume
      this.recentVolume -= removedEntry?.tradeSizeUSD || 0; // ts
      // update peekfront value for the loop condition
      peekFront = this.volumeQueue.peekFront();
    }
    args.recentVolumeMetric.set(
      { market: this.baseAsset, network: this.network },
      this.recentVolume
    );
  }

  async updateOIMetrics(
    args = {
      marketSizeMetric: metrics.marketSize,
      marketSkewMetric: metrics.marketSkew,
    }
  ) {
    const assetPrice = parseFloat(
      utils.formatUnits((await this.futuresMarket.assetPrice()).price)
    );

    const marketSize = Object.values(this.positions).reduce(
      (a, v) => a + Math.abs(v.size),
      0
    );
    const marketSkew = Object.values(this.positions).reduce(
      (a, v) => a + v.size,
      0
    );

    args.marketSizeMetric.set(
      { market: this.baseAsset, network: this.network },
      marketSize * assetPrice
    );
    args.marketSkewMetric.set(
      { market: this.baseAsset, network: this.network },
      marketSkew * assetPrice
    );
  }

  async runKeepers(deps = { BATCH_SIZE: 500, WAIT: 2000, metrics }) {
    const numPositions = Object.keys(this.positions).length;
    deps.metrics.futuresOpenPositions.set(
      { market: this.baseAsset, network: this.network },
      numPositions
    );
    this.logger.log("info", `${numPositions} positions to keep`, {
      component: "Keeper",
    });

    // Get current liquidation price for each position (including funding).
    const positions = orderBy(
      Object.values(this.positions),
      ["leverage"],
      "desc"
    );
    for (const batch of chunk(positions, deps.BATCH_SIZE)) {
      this.logger.log(
        "info",
        `Running keeper batch with ${batch.length} positions to keep`,
        {
          component: "Keeper",
        }
      );
      await Promise.all(
        batch.map(async position => {
          const { id, account } = position;
          await this.runKeeperTask(id, "liquidation", () =>
            this.liquidateOrder(id, account)
          );
        })
      );
      await new Promise((res, rej) => setTimeout(res, deps.WAIT));
    }
  }

  async runKeeperTask(id: string, taskLabel: string, cb: () => Promise<void>) {
    if (this.activeKeeperTasks[id]) {
      // Skip task as its already running.
      return;
    }
    this.activeKeeperTasks[id] = true;

    this.logger.log("debug", `running`, {
      component: `Keeper [${taskLabel}] id=${id}`,
    });
    try {
      await cb();
    } catch (err) {
      if (err && typeof err === "object" && err.toString) {
        this.logger.log("error", `error \n${err.toString()}`, {
          component: `Keeper [${taskLabel}] id=${id}`,
        });
      }
      metrics.keeperErrors.inc({
        market: this.baseAsset,
        network: this.network,
      });
    }
    this.logger.log("debug", `done`, {
      component: `Keeper [${taskLabel}] id=${id}`,
    });

    delete this.activeKeeperTasks[id];
  }

  async liquidateOrder(
    id: string,
    account: string,
    deps = { metricFuturesLiquidations: metrics.futuresLiquidations }
  ) {
    const taskLabel = "liquidation";
    const canLiquidateOrder = await this.futuresMarket.canLiquidate(account);
    if (!canLiquidateOrder) {
      this.logger.log("debug", `Cannot liquidate order`, {
        component: `Keeper [${taskLabel}] id=${id}`,
      });
      return;
    }

    this.logger.log("info", `begin liquidatePosition`, {
      component: `Keeper [${taskLabel}] id=${id}`,
    });
    let receipt: TransactionReceipt | undefined;

    await this.signerPool.withSigner(async signer => {
      try {
        const tx: TransactionResponse = await this.futuresMarket
          .connect(signer)
          .liquidatePosition(account);
        this.logger.log(
          "debug",
          `submit liquidatePosition [nonce=${tx.nonce}]`,
          { component: `Keeper [${taskLabel}] id=${id}` }
        );

        receipt = await tx.wait(1);
      } catch (err) {
        if (isObjectOrErrorWithCode(err)) {
          // Special handeling for NONCE_EXPIRED
          if (err.code === "NONCE_EXPIRED") {
            this.logger.error(err.toString());
            const nonce = signer.getTransactionCount("latest");
            this.logger.info(
              `Updating nonce for Nonce manager to nonce ${nonce}`
            );
            signer.setTransactionCount(nonce);
          }
        }

        throw err;
      }
    });

    deps.metricFuturesLiquidations.inc(
      { market: this.baseAsset, network: this.network },
      1
    );

    this.logger.log(
      "info",
      `done liquidatePosition`,
      `block=${receipt?.blockNumber}`,
      `success=${!!receipt?.status}`,
      `tx=${receipt?.transactionHash}`,
      `gasUsed=${receipt?.gasUsed}`,
      { component: `Keeper [${taskLabel}] id=${id}` }
    );
  }
}

export default Keeper;
