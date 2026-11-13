import { BaseError, ContractFunctionRevertedError, type PublicClient } from "viem";
import { log } from "./log.ts";

/// The custom error name in a contract revert, if any (needs the full ABI in the call).
export function revertName(e: unknown): string | undefined {
  if (!(e instanceof BaseError)) return undefined;
  const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
  return r instanceof ContractFunctionRevertedError ? r.data?.errorName : undefined;
}

/// Gas estimate (which is the simulation), or null, logged as a skip, when the revert is one that only means the
/// chain moved on since it was read. `raceReason` maps such error names to the logged reason; other reverts throw.
export async function estimateOrSkip(
  client: PublicClient,
  call: Parameters<PublicClient["estimateContractGas"]>[0],
  at: Record<string, unknown>,
  raceReason: (errorName: string) => string | undefined,
): Promise<bigint | null> {
  try {
    return await client.estimateContractGas(call);
  } catch (e) {
    const name = revertName(e);
    const reason = name ? raceReason(name) : undefined;
    if (name && reason) {
      log("info", "skip", { ...at, reason, error: name });
      return null;
    }
    throw e;
  }
}
