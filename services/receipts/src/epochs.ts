import type { Hex, PublicClient } from "viem";
import { receiptOf, watched, type M7Deployment, type Receipt } from "./collect.ts";
import { buildTree, leafOf, type Tree } from "./tree.ts";

/// Reads the watched contracts' logs block range by block range, keeps each receipt under its hour, and says which
/// hours are complete (the chain's latest block is past the hour's end plus a margin).

export type Epoch = { epoch: number; receipts: Receipt[]; tree: Tree | null };

export class Collector {
  readonly byEpoch = new Map<number, Receipt[]>();
  private nextBlock: bigint;
  private readonly ts = new Map<bigint, number>();
  latestTs = 0;

  constructor(
    private readonly client: PublicClient,
    private readonly d: M7Deployment,
    fromBlock: bigint,
  ) {
    this.nextBlock = fromBlock;
  }

  private async timestampOf(n: bigint): Promise<number> {
    let t = this.ts.get(n);
    if (t === undefined) {
      t = Number((await this.client.getBlock({ blockNumber: n })).timestamp);
      this.ts.set(n, t);
    }
    return t;
  }

  async scan(): Promise<void> {
    const latest = await this.client.getBlock();
    this.latestTs = Number(latest.timestamp);
    for (let from = this.nextBlock; from <= latest.number; from += 2000n) {
      const to = from + 1999n < latest.number ? from + 1999n : latest.number;
      const logs = await this.client.getLogs({ address: watched(this.d), fromBlock: from, toBlock: to });
      for (const l of logs) {
        const r = receiptOf(this.d, l, await this.timestampOf(l.blockNumber!));
        if (!r) continue;
        const list = this.byEpoch.get(r.epoch) ?? [];
        if (!list.some((x) => x.txHash === r.txHash && x.logIndex === r.logIndex)) list.push(r);
        this.byEpoch.set(r.epoch, list);
      }
    }
    this.nextBlock = latest.number + 1n;
  }

  /// Hours that are over (by `marginS` past their end at the latest block), in order, after `after`.
  completeAfter(after: number, marginS: number): Epoch[] {
    const out: Epoch[] = [];
    for (const e of [...this.byEpoch.keys()].sort((a, b) => a - b)) {
      if (e <= after) continue;
      if (this.latestTs < (e + 1) * 3600 + marginS) continue;
      const receipts = this.byEpoch.get(e)!;
      out.push({ epoch: e, receipts, tree: receipts.length ? buildTree(receipts.map((r) => leafOf(r.encoded))) : null });
    }
    return out;
  }

  /// The epoch and tree of a receipt, by transaction and log index.
  find(txHash: Hex, logIndex: number): { epoch: number; receipt: Receipt } | null {
    for (const [epoch, list] of this.byEpoch) {
      const receipt = list.find((r) => r.txHash.toLowerCase() === txHash.toLowerCase() && r.logIndex === logIndex);
      if (receipt) return { epoch, receipt };
    }
    return null;
  }
}
