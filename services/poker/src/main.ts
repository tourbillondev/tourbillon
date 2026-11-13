import { createPublicClient, formatEther, formatGwei, http, stringToHex, type PublicClient } from "viem";
import { chainFor } from "@tourbillon/common/chain.ts";
import { LOW_BALANCE, MAX_FEE_PER_GAS, POLL_MS, withHeadroom } from "@tourbillon/common/gas.ts";
import { log } from "@tourbillon/common/log.ts";
import { loadSigner, type Signer } from "@tourbillon/common/signer.ts";
import { revertName } from "@tourbillon/common/tx.ts";
import { bookAbi } from "./abi.ts";
import { checkForChain, parseArgs, TICK_SECONDS, type Config } from "./config.ts";
import { loadM2Deployment, type M2Deployment } from "./deployment.ts";
import { ALARM_AFTER_MISSED, decidePoke, missedWindows } from "./poke.ts";
import { selectDue, STEPS_PER_TX, Walker } from "./walker.ts";
import { keep } from "./keeper.ts";

/// The poker: pokes every market once per 5-minute window (the book reads the mark and vol itself; a caller only
/// chooses when), and walks series with open positions that fall 8 or more intervals behind.

const MAX_WALKS_PER_TICK = 5;

type Ctx = { cfg: Config; client: PublicClient; dep: M2Deployment; signer: Signer; walker: Walker };

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));
  const dep = loadM2Deployment(cfg.deployment);
  const client = createPublicClient({ chain: chainFor(dep.chainId), transport: http(cfg.rpc), pollingInterval: POLL_MS }) as PublicClient;
  const rpcId = await client.getChainId();
  if (rpcId !== dep.chainId) throw new Error(`RPC is chain ${rpcId}, deployment file is chain ${dep.chainId}`);
  checkForChain(cfg, rpcId);
  const signer = await loadSigner(cfg.key, dep.chainId, cfg.rpc);
  const walker = new Walker(client, dep.book, dep.engine, dep.deployBlock, dep.writerBook);
  const ctx: Ctx = { cfg, client, dep, signer, walker };
  log("info", "started", { poker: signer.address, role: cfg.role, chainId: dep.chainId, book: dep.book, markets: dep.markets, dryRun: cfg.dryRun });

  let stopping = false;
  process.on("SIGINT", () => (stopping = true));
  process.on("SIGTERM", () => (stopping = true));
  const lastMissed = new Map<string, number>();
  while (!stopping) {
    try {
      await tick(ctx, lastMissed);
    } catch (e) {
      log("error", "tick failed", { error: e instanceof Error ? e.message.split("\n")[0] : String(e) });
    }
    if (cfg.once) break;
    for (let s = 0; s < TICK_SECONDS && !stopping; s++) await Bun.sleep(1000);
  }
  log("info", "stopped");
}

async function tick(ctx: Ctx, lastMissed: Map<string, number>): Promise<void> {
  const { client, signer } = ctx;
  const block = await client.getBlock();
  const now = Number(block.timestamp);
  const baseFee = block.baseFeePerGas ?? 0n;
  const balance = await client.getBalance({ address: signer.address });
  if (balance < LOW_BALANCE) log("warn", "low balance", { balance: formatEther(balance), below: formatEther(LOW_BALANCE) });
  const gasPaused = baseFee > MAX_FEE_PER_GAS;
  if (gasPaused) log("alarm", "base fee above cap: transactions paused", { baseFee: formatGwei(baseFee), cap: formatGwei(MAX_FEE_PER_GAS) });

  const latestByMarket = new Map<string, number>();
  for (const market of ctx.dep.markets) {
    try {
      latestByMarket.set(stringToHex(market, { size: 32 }), await pokeMarket(ctx, market, now, gasPaused, lastMissed));
    } catch (e) {
      log("error", "market failed", { market, error: e instanceof Error ? e.message.split("\n")[0] : String(e) });
    }
  }
  try {
    await walk(ctx, latestByMarket, gasPaused);
  } catch (e) {
    log("error", "walk failed", { error: e instanceof Error ? e.message.split("\n")[0] : String(e) });
  }
  if (ctx.dep.pool) {
    try {
      await keep(client, ctx.dep.pool, signer, ctx.cfg.role, now, ctx.cfg.dryRun, gasPaused);
    } catch (e) {
      log("error", "keeper failed", { error: e instanceof Error ? e.message.split("\n")[0] : String(e) });
    }
  }
}

/// Returns the market's latest sample time after this pass (0 if none).
async function pokeMarket(ctx: Ctx, market: string, now: number, gasPaused: boolean, lastMissed: Map<string, number>): Promise<number> {
  const { client, dep, signer, cfg } = ctx;
  const name = stringToHex(market, { size: 32 });
  const latestT = await latestSample(client, dep, name);

  const missed = missedWindows(now, latestT);
  if (missed !== (lastMissed.get(market) ?? 0)) {
    lastMissed.set(market, missed);
    if (missed >= ALARM_AFTER_MISSED) log("alarm", "no sample for whole windows", { market, missed });
    else if (missed > 0) log("warn", "window missed", { market, missed });
  }

  const d = decidePoke(cfg.role, now, latestT);
  if (d !== "poke") {
    log("info", "skip", { market, reason: d });
    return latestT;
  }
  const call = { address: dep.book, abi: bookAbi, functionName: "poke", args: [name], account: signer.address, maxFeePerGas: MAX_FEE_PER_GAS, maxPriorityFeePerGas: 0n } as const;
  let gas: bigint;
  try {
    gas = await client.estimateContractGas(call);
  } catch (e) {
    // The book reads the router and the board itself: a stale or disputed source means no sample (law 2).
    log("warn", "cannot poke", { market, error: revertName(e) ?? (e instanceof Error ? e.message.split("\n")[0] : String(e)) });
    return latestT;
  }
  if (cfg.dryRun || !signer.wallet) {
    log("info", "would poke", { market });
    return latestT;
  }
  if (gasPaused) return latestT;
  const hash = await signer.wallet.writeContract({ ...call, account: signer.account!, chain: signer.wallet.chain, gas: withHeadroom(gas) });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
  log("info", "poked", { market, tx: hash, status: receipt.status, gasUsed: receipt.gasUsed });
  return latestSample(client, dep, name);
}

async function latestSample(client: PublicClient, dep: M2Deployment, name: `0x${string}`): Promise<number> {
  try {
    const [t] = await client.readContract({ address: dep.book, abi: bookAbi, functionName: "latestSample", args: [name] });
    return Number(t);
  } catch (e) {
    if (revertName(e) === "NoHistory") return 0;
    throw e;
  }
}

async function walk(ctx: Ctx, latestByMarket: Map<string, number>, gasPaused: boolean): Promise<void> {
  const { client, dep, signer, cfg, walker } = ctx;
  await walker.scan();
  const cursorAt = new Map<bigint, number>();
  for (const s of walker.series.values()) {
    if (s.openRaw === 0n) continue;
    const c = await client.readContract({ address: dep.book, abi: bookAbi, functionName: "cursor", args: [s.id] });
    cursorAt.set(s.id, Number(c.at));
  }
  const due = selectDue(walker.series.values(), cursorAt, latestByMarket);
  for (const s of due.slice(0, MAX_WALKS_PER_TICK)) {
    const behind = (latestByMarket.get(s.market) ?? 0) - (cursorAt.get(s.id) ?? 0);
    if (cfg.dryRun || !signer.wallet) {
      log("info", "would walk", { id: s.id, behindS: behind });
      continue;
    }
    if (gasPaused) continue;
    const call = { address: dep.book, abi: bookAbi, functionName: "accrue", args: [s.id, STEPS_PER_TX], account: signer.address, maxFeePerGas: MAX_FEE_PER_GAS, maxPriorityFeePerGas: 0n } as const;
    const gas = await client.estimateContractGas(call);
    const hash = await signer.wallet.writeContract({ ...call, account: signer.account!, chain: signer.wallet.chain, gas: withHeadroom(gas) });
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
    // After the walk the cursor is at (or nearer) the latest sample; when caught up normNow is exact (the step 6
    // finding: never report units from normNow of a series that is behind).
    const c = await client.readContract({ address: dep.book, abi: bookAbi, functionName: "cursor", args: [s.id] });
    const caughtUp = Number(c.at) >= (latestByMarket.get(s.market) ?? 0);
    const norm = caughtUp ? await client.readContract({ address: dep.book, abi: bookAbi, functionName: "normNow", args: [s.id] }) : undefined;
    log("info", "walked", { id: s.id, behindS: behind, tx: hash, status: receipt.status, gasUsed: receipt.gasUsed, caughtUp, norm });
  }
}

main().catch((e) => {
  log("error", "fatal", { error: e instanceof Error ? e.message.split("\n")[0] : String(e) });
  process.exit(1);
});
