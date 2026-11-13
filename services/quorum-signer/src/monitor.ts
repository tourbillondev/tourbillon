import { BaseError, ContractFunctionRevertedError, createPublicClient, http, parseEventLogs, type Address, type PublicClient } from "viem";
import { boardAbi, boardKeys, marketBytes32, type BoardKey } from "./board.ts";
import { chainFor } from "@tourbillon/common/chain.ts";
import { loadDeployment, type Deployment } from "./deployment.ts";

/// Read-only monitor for a deployment: the board's events (votes, finals, dropped votes) and the router's
/// markWad, polled. No key, no transaction. Used by scripts/local-soak.ts and for the testnet soak.

export const routerAbi = [
  { type: "function", name: "markWad", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "error", name: "NoRoute", inputs: [{ type: "bytes32" }] },
  { type: "error", name: "Stale", inputs: [{ type: "bytes32" }, { type: "address" }] },
  { type: "error", name: "Disagree", inputs: [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }] },
] as const;

type Ev =
  | { type: "Voted"; t: number; key: string; round: bigint; signer: Address; tx: string }
  | { type: "VoteDropped"; t: number; key: string; round: bigint; signer: Address; tx: string }
  | { type: "Finalised"; t: number; key: string; round: bigint; median: bigint; published: bigint; votes: number; tx: string };

type Tx = { hash: string; t: number; from: Address; gasUsed: bigint; voted: boolean; finalised: boolean };

export type Sample = {
  t: number; // chain time
  router: Record<string, string>; // market -> "fresh" | error name
  markAge: Record<string, number | null>; // market -> seconds since the MARK final, null if none
  volAge: Record<string, number | null>;
  nonces: Record<string, number>;
};

export type Phase = { name: string; start: number; end: number };

export class Monitor {
  readonly events: Ev[] = [];
  readonly txs = new Map<string, Tx>();
  readonly samples: Sample[] = [];
  private keys: BoardKey[] = [];
  private nextBlock = 0n;
  private blockTimes = new Map<bigint, number>();

  constructor(
    readonly client: PublicClient,
    readonly dep: Deployment,
    readonly signers: Address[] = dep.signers,
  ) {}

  async init(fromBlock?: bigint): Promise<void> {
    this.keys = await boardKeys(this.client, this.dep.board, this.dep.markets);
    this.nextBlock = fromBlock ?? (await this.client.getBlockNumber());
  }

  keyName(key: string): string {
    const k = this.keys.find((x) => x.key === key);
    return k ? `${k.kind} ${k.market}` : key;
  }

  async now(): Promise<number> {
    return Number((await this.client.getBlock()).timestamp);
  }

  private async blockTime(n: bigint): Promise<number> {
    let t = this.blockTimes.get(n);
    if (t === undefined) {
      t = Number((await this.client.getBlock({ blockNumber: n })).timestamp);
      this.blockTimes.set(n, t);
    }
    return t;
  }

  async poll(): Promise<Sample> {
    const block = await this.client.getBlock();
    const t = Number(block.timestamp);

    // Board events since the last poll, in chunks
    for (let from = this.nextBlock; from <= block.number; from += 2000n) {
      const to = from + 1999n < block.number ? from + 1999n : block.number;
      const logs = await this.client.getLogs({ address: this.dep.board, fromBlock: from, toBlock: to });
      const parsed = parseEventLogs({ abi: boardAbi, logs, strict: false });
      for (const l of parsed) {
        const at = await this.blockTime(l.blockNumber!);
        const tx = l.transactionHash!;
        const a = l.args as Record<string, unknown>;
        if (l.eventName === "Voted" || l.eventName === "VoteDropped") {
          this.events.push({ type: l.eventName, t: at, key: a.key as string, round: a.round as bigint, signer: a.signer as Address, tx });
        } else if (l.eventName === "Finalised") {
          this.events.push({
            type: "Finalised",
            t: at,
            key: a.key as string,
            round: a.round as bigint,
            median: a.median as bigint,
            published: a.published as bigint,
            votes: Number(a.votes),
            tx,
          });
        } else continue;
        let rec = this.txs.get(tx);
        if (!rec) {
          const r = await this.client.getTransactionReceipt({ hash: tx });
          rec = { hash: tx, t: at, from: r.from, gasUsed: r.gasUsed, voted: false, finalised: false };
          this.txs.set(tx, rec);
        }
        if (l.eventName === "Voted") rec.voted = true;
        if (l.eventName === "Finalised") rec.finalised = true;
      }
    }
    this.nextBlock = block.number + 1n;

    const router: Record<string, string> = {};
    const markAge: Record<string, number | null> = {};
    const volAge: Record<string, number | null> = {};
    for (const m of this.dep.markets) {
      try {
        await this.client.readContract({ address: this.dep.router, abi: routerAbi, functionName: "markWad", args: [marketBytes32(m)] });
        router[m] = "fresh";
      } catch (e) {
        router[m] = errorName(e);
      }
    }
    for (const k of this.keys) {
      let age: number | null = null;
      try {
        const [, , , updatedAt] = await this.client.readContract({
          address: this.dep.board,
          abi: boardAbi,
          functionName: "latestRoundData",
          args: [k.key],
        });
        age = t - Number(updatedAt);
      } catch {
        age = null;
      }
      (k.kind === "MARK" ? markAge : volAge)[k.market] = age;
    }
    const nonces: Record<string, number> = {};
    for (const s of this.signers) nonces[s] = await this.client.getTransactionCount({ address: s, blockNumber: block.number });
    const sample = { t, router, markAge, volAge, nonces };
    this.samples.push(sample);
    return sample;
  }

  report(phases: Phase[]): PhaseReport[] {
    return phases.map((p) => phaseReport(this, p));
  }
}

function errorName(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? "reverted";
    return "rpc-error";
  }
  return "error";
}

// ---------------------------------------------------------------- statistics

export function quantile(xs: number[], q: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[i]!;
}

export type KeyStats = {
  finals: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
  twoVoteFinals: number;
  clampHits: number;
};

export type MarketStats = {
  polls: number;
  fresh: number;
  freshPct: number;
  firstNotFresh: number | null; // seconds after the phase start
  maxMarkAge: number | null;
  maxVolAge: number | null;
};

export type SignerStats = { votes: number; finalizes: number; txs: number; failedTxs: number; gas: bigint };

export type PhaseReport = {
  name: string;
  seconds: number;
  keys: Record<string, KeyStats>;
  markets: Record<string, MarketStats>;
  signers: Record<string, SignerStats>;
  droppedVotes: number;
  allFreshAfter: number | null; // seconds from the phase start to the first poll with every market fresh
  gas: { vote: number[]; voteAndFinal: number[]; finalizeOnly: number[] };
};

export function phaseReport(m: Monitor, p: Phase): PhaseReport {
  const inP = (t: number) => t >= p.start && t < p.end;
  const keys: Record<string, KeyStats> = {};
  const byKey = new Map<string, number[]>();
  for (const e of m.events) {
    if (e.type !== "Finalised" || !inP(e.t)) continue;
    const name = m.keyName(e.key);
    keys[name] ??= { finals: 0, p50: null, p95: null, max: null, twoVoteFinals: 0, clampHits: 0 };
    keys[name].finals++;
    if (e.votes < 3) keys[name].twoVoteFinals++;
    if (e.median !== e.published) keys[name].clampHits++;
    const ts = byKey.get(name) ?? [];
    ts.push(e.t);
    byKey.set(name, ts);
  }
  for (const [name, ts] of byKey) {
    const gaps = ts.slice(1).map((t, i) => t - ts[i]!);
    keys[name]!.p50 = quantile(gaps, 0.5);
    keys[name]!.p95 = quantile(gaps, 0.95);
    keys[name]!.max = gaps.length ? Math.max(...gaps) : null;
  }

  const samples = m.samples.filter((s) => inP(s.t));
  const markets: Record<string, MarketStats> = {};
  for (const mk of m.dep.markets) {
    const polls = samples.length;
    const fresh = samples.filter((s) => s.router[mk] === "fresh").length;
    const firstBad = samples.find((s) => s.router[mk] !== "fresh");
    const ages = samples.map((s) => s.markAge[mk]).filter((x): x is number => x !== null);
    const vages = samples.map((s) => s.volAge[mk]).filter((x): x is number => x !== null);
    markets[mk] = {
      polls,
      fresh,
      freshPct: polls ? (100 * fresh) / polls : 0,
      firstNotFresh: firstBad ? firstBad.t - p.start : null,
      maxMarkAge: ages.length ? Math.max(...ages) : null,
      maxVolAge: vages.length ? Math.max(...vages) : null,
    };
  }
  const allFresh = samples.find((s) => m.dep.markets.every((mk) => s.router[mk] === "fresh"));

  const signers: Record<string, SignerStats> = {};
  const gas = { vote: [] as number[], voteAndFinal: [] as number[], finalizeOnly: [] as number[] };
  for (const s of m.signers) signers[s] = { votes: 0, finalizes: 0, txs: 0, failedTxs: 0, gas: 0n };
  for (const tx of m.txs.values()) {
    if (!inP(tx.t)) continue;
    const st = signers[tx.from];
    if (st) {
      st.txs++;
      st.gas += tx.gasUsed;
      if (tx.voted) st.votes++;
      else if (tx.finalised) st.finalizes++;
    }
    const g = Number(tx.gasUsed);
    if (tx.voted && tx.finalised) gas.voteAndFinal.push(g);
    else if (tx.voted) gas.vote.push(g);
    else if (tx.finalised) gas.finalizeOnly.push(g);
  }
  // Transactions sent = nonce change over the phase; every successful board transaction emits an event, so the
  // difference is failed transactions.
  const before = [...m.samples].reverse().find((s) => s.t < p.start) ?? samples[0];
  const last = samples.at(-1);
  if (before && last) {
    for (const s of m.signers) {
      const sent = (last.nonces[s] ?? 0) - (before.nonces[s] ?? 0);
      signers[s]!.failedTxs = Math.max(0, sent - signers[s]!.txs);
    }
  }
  return {
    name: p.name,
    seconds: p.end - p.start,
    keys,
    markets,
    signers,
    droppedVotes: m.events.filter((e) => e.type === "VoteDropped" && inP(e.t)).length,
    allFreshAfter: allFresh ? allFresh.t - p.start : null,
    gas,
  };
}

export function gasSummary(xs: number[]): string {
  if (xs.length === 0) return "none";
  const mean = Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
  return `n=${xs.length} median ${quantile(xs, 0.5)} mean ${mean} max ${Math.max(...xs)}`;
}

/// Plain-text report: one block per phase.
export function formatReport(reports: PhaseReport[], short: (a: string) => string = (a) => a.slice(0, 8)): string {
  const out: string[] = [];
  for (const r of reports) {
    out.push(`== ${r.name} (${Math.round(r.seconds)} s)`);
    out.push("key        finals  p50  p95  max  2-vote  clamp");
    for (const [k, s] of Object.entries(r.keys).sort()) {
      out.push(`${k.padEnd(10)} ${String(s.finals).padStart(6)} ${f(s.p50)} ${f(s.p95)} ${f(s.max)} ${String(s.twoVoteFinals).padStart(7)} ${String(s.clampHits).padStart(6)}`);
    }
    out.push("market  router fresh      first not fresh  max mark age  max vol age");
    for (const [mk, s] of Object.entries(r.markets)) {
      out.push(
        `${mk.padEnd(7)} ${`${s.fresh}/${s.polls} ${s.freshPct.toFixed(1)}%`.padEnd(18)} ${f(s.firstNotFresh, 15)} ${f(s.maxMarkAge, 13)} ${f(s.maxVolAge, 12)}`,
      );
    }
    out.push(`all markets fresh after: ${r.allFreshAfter === null ? "never" : `${r.allFreshAfter} s`}; dropped votes: ${r.droppedVotes}`);
    for (const [a, s] of Object.entries(r.signers)) {
      out.push(`signer ${short(a)}: ${s.votes} votes, ${s.finalizes} finalize, ${s.failedTxs} failed tx, gas ${s.gas}`);
    }
    out.push(`gas: vote ${gasSummary(r.gas.vote)}; vote+final ${gasSummary(r.gas.voteAndFinal)}; finalize ${gasSummary(r.gas.finalizeOnly)}`);
    out.push("");
  }
  return out.join("\n");
}

function f(x: number | null, w = 4): string {
  return (x === null ? "-" : String(Math.round(x))).padStart(w);
}

// ---------------------------------------------------------------- command line

/// bun src/monitor.ts --deployment <file> [--rpc <url>] [--minutes N] [--poll-seconds 5] [--out report.json]
if (import.meta.main) {
  const args = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) args.set(argv[i]!.replace(/^--/, ""), argv[i + 1] ?? "");
  const depPath = args.get("deployment");
  if (!depPath) throw new Error("--deployment is required");
  const dep = loadDeployment(depPath);
  const client = createPublicClient({ chain: chainFor(dep.chainId), transport: http(args.get("rpc")) }) as PublicClient;
  if ((await client.getChainId()) !== dep.chainId) throw new Error("RPC chain differs from the deployment file");
  const mon = new Monitor(client, dep);
  await mon.init();
  const pollMs = Number(args.get("poll-seconds") ?? 5) * 1000;
  const minutes = Number(args.get("minutes") ?? 0);
  const start = await mon.now();
  const wallEnd = minutes > 0 ? Date.now() + minutes * 60_000 : Infinity;
  let stop = false;
  process.on("SIGINT", () => (stop = true));
  process.on("SIGTERM", () => (stop = true));
  let lastPrint = 0;
  while (!stop && Date.now() < wallEnd) {
    try {
      const s = await mon.poll();
      if (Date.now() - lastPrint > 60_000) {
        lastPrint = Date.now();
        console.log(JSON.stringify({ t: s.t, router: s.router, markAge: s.markAge, volAge: s.volAge }));
      }
    } catch (e) {
      console.error(JSON.stringify({ level: "error", msg: "poll failed", error: (e as Error).message.split("\n")[0] }));
    }
    await Bun.sleep(pollMs);
  }
  const end = (await mon.now()) + 1;
  const reports = mon.report([{ name: "soak", start, end }]);
  console.log(formatReport(reports));
  const out = args.get("out");
  if (out) await Bun.write(out, JSON.stringify(reports, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}
