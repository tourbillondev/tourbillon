import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { createPublicClient, getAddress, http, type PublicClient } from "viem";
import { chainFor } from "@tourbillon/common/chain.ts";
import { log } from "@tourbillon/common/log.ts";
import type { Dep } from "./config.ts";

/// What both hedgers share: the deployment file, the RPC check, the per-market status file the risk-monitor reads,
/// and the loop (3 failed passes in a row raise "hedging failing"; the risk-monitor pauses opens after 15 minutes).

export function loadDeployment(path: string): Dep {
  const d = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const need = (k: string) => {
    if (typeof d[k] !== "string") throw new Error(`deployment: missing ${k}`);
    return getAddress(d[k] as string);
  };
  return {
    chainId: Number(d.chainId),
    router: need("MarkRouter"),
    board: need("QuorumBoard"),
    pool: need("MainspringPool"),
    book: need("PathFundingBook"),
    markets: d.markets as string[],
    gate: typeof d.HedgeKeeperGate === "string" && d.HedgeKeeperGate !== "0x0000000000000000000000000000000000000000" ? getAddress(d.HedgeKeeperGate) : null, // RH8b: the pool's keeper role sits on the gate
  };
}

export async function connect(rpc: string | undefined, dep: Dep): Promise<PublicClient> {
  const client = createPublicClient({ chain: chainFor(dep.chainId), transport: http(rpc) }) as PublicClient;
  const rpcId = await client.getChainId();
  if (rpcId !== dep.chainId) throw new Error(`RPC is chain ${rpcId}, deployment file is chain ${dep.chainId}`);
  return client;
}

/// Per-market hedging status: a market is failing when its venue could not be reached or refused its trades (not
/// when it was skipped for a stale or mismatched mark).
/// hedger-onchain adds the pool's holding, the target and the band (shares), for the risk-monitor's inventory check.
export type MarketStatus = { ok: boolean; lastOkAt: string | null; error?: string; held?: number; target?: number; band?: number };

export class StatusBook {
  readonly status = new Map<string, MarketStatus>();
  constructor(
    private readonly file: string | undefined,
    private readonly venue: string,
  ) {}

  set(market: string, ok: boolean, error?: string, extra: { held?: number; target?: number; band?: number } = {}): void {
    const prev = this.status.get(market);
    this.status.set(market, { ok, lastOkAt: ok ? new Date().toISOString() : (prev?.lastOkAt ?? null), error, ...extra });
  }

  write(): void {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ updatedAt: new Date().toISOString(), venue: this.venue, markets: Object.fromEntries(this.status) }));
    renameSync(tmp, this.file); // atomic replace: the monitor never reads half a file
  }
}

export async function loop(markets: string[], st: StatusBook, once: boolean, tickSeconds: number, tick: () => Promise<void>): Promise<void> {
  let failures = 0;
  let stopping = false;
  process.on("SIGINT", () => (stopping = true));
  process.on("SIGTERM", () => (stopping = true));
  while (!stopping) {
    try {
      await tick();
      if (failures >= 3) log("info", "venue recovered", { after: failures });
      failures = 0;
    } catch (e) {
      failures++;
      const error = e instanceof Error ? e.message.split("\n")[0] : String(e);
      for (const m of markets) if (st.status.get(m)?.ok !== false) st.set(m, false, error);
      if (failures >= 3) log("alarm", "hedging failing", { failures, error });
      else log("error", "tick failed", { failures, error });
    }
    st.write();
    if (once) break;
    for (let i = 0; i < tickSeconds && !stopping; i++) await Bun.sleep(1000);
  }
  log("info", "stopped");
}

export function fatal(e: unknown): never {
  log("error", "fatal", { error: e instanceof Error ? e.message.split("\n")[0] : String(e) });
  process.exit(1);
}
