import { encodeAbiParameters, getAddress, hexToString, keccak256, parseAbi, stringToHex, type Address, type Hex } from "viem";

/// The events the indexer reads, and how each becomes rows. Pure: decoded events in, row operations out.

export const eventsAbi = parseAbi([
  "event Recorded(bytes32 indexed name, uint256 t, uint256 sWad, uint256 sigmaBps, bool l0, bool l1, bool l2)",
  "event Voted(bytes32 indexed key, uint80 indexed round, address indexed signer, uint256 value)",
  "event VoteDropped(bytes32 indexed key, uint80 indexed round, address indexed signer, uint256 value)",
  "event Finalised(bytes32 indexed key, uint80 indexed round, uint256 median, uint256 published, uint256 votes)",
  "event Bought(address indexed buyer, uint256 indexed id, bytes32 indexed market, uint256 units, uint256 raw, uint256 sWad, uint256 sigmaBps, uint256 unitValueWad, uint256 premium, uint256 fee)",
  "event ShapeBought(address indexed buyer, uint256 indexed id, bytes32 indexed market, uint256 units, uint256 raw, uint256 sWad, uint256 sigmaBps, int256 unitValueWad, uint256 premium, uint256 fee)",
  "event Sold(address indexed seller, uint256 indexed id, bytes32 indexed market, uint256 units, uint256 raw, uint256 sWad, uint256 sigmaBps, uint256 unitValueWad, uint256 gross, uint256 fee, uint256 net, bool markFromSample, bool volFromSample)",
  "event AgentBought(bytes32 indexed mandate, address indexed owner, uint256 indexed id, uint256 raw, uint256 cost, uint8 kind)",
  "event PositionSold(address indexed owner, uint256 indexed id, uint256 raw, uint256 units, uint256 net, bytes32 mandate)",
]);

export const marketName = (h: Hex) => hexToString(h, { size: 32 }).replace(/\0+$/, "");
const key = (kind: string, m: string) => keccak256(encodeAbiParameters([{ type: "string" }, { type: "bytes32" }], [kind, stringToHex(m, { size: 32 })]));

/// The board keys of the deployment's markets (and the pool's EQUITY key), for labelling votes and finals.
export function boardKeys(markets: string[], equityKey: Hex | null): { key: Hex; market: string; kind: string }[] {
  const out = markets.flatMap((m) => [
    { key: key("MARK", m), market: m, kind: "MARK" },
    { key: key("VOL", m), market: m, kind: "VOL" },
  ]);
  if (equityKey) out.push({ key: equityKey, market: "POOL", kind: "EQUITY" });
  return out;
}

export type Op =
  | { t: "sample"; market: string; level: number; at: bigint; sWad: bigint; sigmaBps: bigint }
  | { t: "vote"; key: Hex; round: bigint; signer: Address; value: bigint; ts: bigint }
  | { t: "drop"; key: Hex; round: bigint; signer: Address }
  | { t: "final"; key: Hex; round: bigint; median: bigint; published: bigint; votes: bigint; ts: bigint }
  | { t: "position"; id: bigint; owner: Address; held: "direct" | "agentRouter"; market: string | null; delta: bigint; norm: bigint | null; ts: bigint };

const WAD = 10n ** 18n;

/// Row operations for one decoded event (`router` is the AgentRouter: its own Engine buys and sells are the
/// sub-accounts' and are not counted as a direct holding).
export function opsFor(e: { eventName: string; args: Record<string, unknown> }, ts: bigint, router: Address | null): Op[] {
  const a = e.args;
  switch (e.eventName) {
    case "Recorded": {
      const m = marketName(a.name as Hex);
      return ([a.l0, a.l1, a.l2] as boolean[]).flatMap((on, level) => (on ? [{ t: "sample" as const, market: m, level, at: a.t as bigint, sWad: a.sWad as bigint, sigmaBps: a.sigmaBps as bigint }] : []));
    }
    case "Voted":
      return [{ t: "vote", key: a.key as Hex, round: a.round as bigint, signer: getAddress(a.signer as string), value: a.value as bigint, ts }];
    case "VoteDropped":
      return [{ t: "drop", key: a.key as Hex, round: a.round as bigint, signer: getAddress(a.signer as string) }];
    case "Finalised":
      return [{ t: "final", key: a.key as Hex, round: a.round as bigint, median: a.median as bigint, published: a.published as bigint, votes: a.votes as bigint, ts }];
    case "Bought":
    case "ShapeBought": {
      const buyer = getAddress(a.buyer as string);
      if (router && buyer === router) return [];
      const raw = a.raw as bigint;
      return [{ t: "position", id: a.id as bigint, owner: buyer, held: "direct", market: marketName(a.market as Hex), delta: raw, norm: raw > 0n ? ((a.units as bigint) * WAD) / raw : null, ts }];
    }
    case "Sold": {
      const seller = getAddress(a.seller as string);
      if (router && seller === router) return [];
      const raw = a.raw as bigint;
      return [{ t: "position", id: a.id as bigint, owner: seller, held: "direct", market: marketName(a.market as Hex), delta: -raw, norm: raw > 0n ? ((a.units as bigint) * WAD) / raw : null, ts }];
    }
    case "AgentBought":
      return [{ t: "position", id: a.id as bigint, owner: getAddress(a.owner as string), held: "agentRouter", market: null, delta: a.raw as bigint, norm: null, ts }];
    case "PositionSold": {
      const raw = a.raw as bigint;
      return [{ t: "position", id: a.id as bigint, owner: getAddress(a.owner as string), held: "agentRouter", market: null, delta: -raw, norm: raw > 0n ? ((a.units as bigint) * WAD) / raw : null, ts }];
    }
  }
  return [];
}
