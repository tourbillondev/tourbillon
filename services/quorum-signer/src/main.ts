import { createPublicClient, formatEther, formatGwei, http, type PublicClient } from "viem";
import { chainFor } from "@tourbillon/common/chain.ts";
import { LOW_BALANCE, MAX_FEE_PER_GAS, POLL_MS, withHeadroom } from "@tourbillon/common/gas.ts";
import { log } from "@tourbillon/common/log.ts";
import { loadSigner as loadKey, type Signer } from "@tourbillon/common/signer.ts";
import { estimateOrSkip as estimate } from "@tourbillon/common/tx.ts";
import { boardAbi, boardErrorName, boardKeys, equityBoardKey, raceReason, readKeyState, type BoardKey } from "./board.ts";
import { EquitySource, equityKey } from "./equity.ts";
import type { Kind, Reading } from "./decide.ts";
import { checkForChain, parseArgs, TICK_SECONDS, type Config } from "./config.ts";
import { decide } from "./decide.ts";
import { loadDeployment, type Deployment } from "./deployment.ts";
import { FixedSource, HyperliquidSource, SplitSource, type ValueSource } from "./source.ts";

async function connect(cfg: Config, dep: Deployment): Promise<PublicClient> {
  const chain = chainFor(dep.chainId);
  const client = createPublicClient({ chain, transport: http(cfg.rpc), pollingInterval: POLL_MS }) as PublicClient;
  const rpcId = await client.getChainId();
  if (rpcId !== dep.chainId) throw new Error(`RPC is chain ${rpcId}, deployment file is chain ${dep.chainId}`);
  checkForChain(cfg, rpcId);
  return client;
}

function loadSigner(cfg: Config, dep: Deployment): Promise<Signer> {
  return loadKey(cfg.key, dep.chainId, cfg.rpc);
}

/// Hyperliquid marks and vol by default. On anvil, --test-marks / --test-vol replace them. EQUITY readings come from the
/// pool's Hyperliquid account when --equity-pool / --equity-hl-user are given.
function sourceFor(cfg: Config, dep: Deployment): ValueSource {
  const hl = cfg.hlApi ? new HyperliquidSource(dep.markets, cfg.hlApi) : new HyperliquidSource(dep.markets);
  let base: ValueSource = cfg.testMarks ? new FixedSource(cfg.testMarks, undefined) : hl;
  if (cfg.testVol !== undefined) base = new SplitSource(base, new FixedSource(undefined, cfg.testVol));
  if (!cfg.equityHlUser) return base;
  const equity = cfg.hlApi ? new EquitySource(cfg.equityHlUser, cfg.hlApi) : new EquitySource(cfg.equityHlUser);
  return {
    name: `${base.name},equity:hyperliquid`,
    read(market: string, kind: Kind, now: number): Promise<Reading> {
      return kind === "EQUITY" ? equity.read(now) : base.read(market, kind, now);
    },
  };
}

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2));
  const dep = loadDeployment(cfg.deployment);
  const client = await connect(cfg, dep);
  const source = sourceFor(cfg, dep);
  const signer = await loadSigner(cfg, dep);

  if (!(await client.readContract({ address: dep.board, abi: boardAbi, functionName: "isSigner", args: [signer.address] }))) {
    throw new Error(`${signer.address} is not a signer on board ${dep.board}`);
  }
  const keys = await boardKeys(client, dep.board, dep.markets);
  if (cfg.equityPool) keys.push(await equityBoardKey(client, dep.board, equityKey(cfg.equityPool)));
  log("info", "started", {
    signer: signer.address,
    chainId: dep.chainId,
    board: dep.board,
    markets: dep.markets,
    source: source.name,
    dryRun: cfg.dryRun,
  });

  const myVotes = new Map<string, { round: bigint; at: number }>();
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopping) {
    try {
      await tick(cfg, client, dep, signer, source, keys, myVotes);
    } catch (e) {
      log("error", "tick failed", { error: e instanceof Error ? e.message.split("\n")[0] : String(e) });
    }
    if (cfg.once) break;
    for (let s = 0; s < TICK_SECONDS && !stopping; s++) await Bun.sleep(1000);
  }
  log("info", "stopped");
}

async function tick(
  cfg: Config,
  client: PublicClient,
  dep: Deployment,
  signer: Signer,
  source: ValueSource,
  keys: BoardKey[],
  myVotes: Map<string, { round: bigint; at: number }>,
): Promise<void> {
  const block = await client.getBlock();
  const now = Number(block.timestamp);
  const baseFee = block.baseFeePerGas ?? 0n;
  const balance = await client.getBalance({ address: signer.address });
  if (balance < LOW_BALANCE) log("warn", "low balance", { balance: formatEther(balance), below: formatEther(LOW_BALANCE) });
  const gasPaused = baseFee > MAX_FEE_PER_GAS;
  if (gasPaused) log("alarm", "base fee above cap: votes paused", { baseFee: formatGwei(baseFee), cap: formatGwei(MAX_FEE_PER_GAS) });

  const quorum = Number(await client.readContract({ address: dep.board, abi: boardAbi, functionName: "quorum" }));
  for (const k of keys) {
    try {
      await handleKey(cfg, client, dep, signer, source, k, myVotes, now, quorum, gasPaused);
    } catch (e) {
      // One key's failure never blocks the others.
      log("error", "key failed", {
        market: k.market,
        kind: k.kind,
        boardError: boardErrorName(e),
        error: e instanceof Error ? e.message.split("\n")[0] : String(e),
      });
    }
  }
}

async function handleKey(
  cfg: Config,
  client: PublicClient,
  dep: Deployment,
  signer: Signer,
  source: ValueSource,
  k: BoardKey,
  myVotes: Map<string, { round: bigint; at: number }>,
  now: number,
  quorum: number,
  gasPaused: boolean,
): Promise<void> {
  const mine = myVotes.get(k.key);
  const state = await readKeyState(client, dep.board, k, signer.address, null, quorum);
  if (mine && mine.round === state.latestRound + 1n) state.myVoteAt = state.iVoted ? mine.at : null;
  const reading = await source.read(k.market, k.kind, now);
  const d = decide(k.kind, state, reading, now);
  const at = { market: k.market, kind: k.kind };
  if (d.action === "skip") {
    log("info", "skip", { ...at, reason: d.reason });
    return;
  }
  if (d.action === "finalize") {
    if (cfg.dryRun || !signer.wallet || !signer.account) {
      log("info", "would finalize", at);
      return;
    }
    if (gasPaused) return;
    await finalize(client, dep, signer, k, at);
    return;
  }
  if (cfg.dryRun || !signer.wallet || !signer.account) {
    log("info", "would vote", { ...at, round: d.round, value: d.value, reason: d.reason });
    return;
  }
  if (gasPaused) return;
  // The gas estimate is the simulation: a vote that would revert is never sent and costs nothing.
  const call = {
    address: dep.board,
    abi: boardAbi,
    functionName: "vote",
    args: [k.key, d.round, d.value],
    account: signer.account,
    maxFeePerGas: MAX_FEE_PER_GAS,
    maxPriorityFeePerGas: 0n,
  } as const;
  const gas = await estimateOrSkip(client, call, at);
  if (gas === null) return;
  const hash = await signer.wallet.writeContract({ ...call, chain: signer.wallet.chain, gas: withHeadroom(gas) });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
  myVotes.set(k.key, { round: d.round, at: now });
  log("info", "voted", { ...at, round: d.round, value: d.value, reason: d.reason, tx: hash, status: receipt.status, gasUsed: receipt.gasUsed });
}

/// Finalises an open round once the board would accept it. The gas estimate is the simulation: a NotReady
/// answer costs nothing.
async function finalize(
  client: PublicClient,
  dep: Deployment,
  signer: Signer,
  k: BoardKey,
  at: { market: string; kind: string },
): Promise<void> {
  const call = {
    address: dep.board,
    abi: boardAbi,
    functionName: "finalize",
    args: [k.key],
    account: signer.account!,
    maxFeePerGas: MAX_FEE_PER_GAS,
    maxPriorityFeePerGas: 0n,
  } as const;
  const gas = await estimateOrSkip(client, call, at);
  if (gas === null) return;
  const hash = await signer.wallet!.writeContract({ ...call, chain: signer.wallet!.chain, gas: withHeadroom(gas) });
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
  log("info", "finalized", { ...at, tx: hash, status: receipt.status, gasUsed: receipt.gasUsed });
}

/// Gas estimate with the full board ABI, or null (logged as a skip) when the board has moved on since it was read.
function estimateOrSkip(
  client: PublicClient,
  call: Parameters<PublicClient["estimateContractGas"]>[0],
  at: { market: string; kind: string },
): Promise<bigint | null> {
  return estimate(client, call, at, raceReason);
}

main().catch((e) => {
  log("error", "fatal", { error: e instanceof Error ? e.message.split("\n")[0] : String(e) });
  process.exit(1);
});
