/// A minimal MCP server core (JSON-RPC 2.0, one message per line): `initialize`, `ping`, `tools/list`, `tools/call`.
/// MCP is the tool protocol named in the spec ("api / mcp"); automated clients use it to read Tourbillon and to get
/// unsigned transactions and mandates to sign elsewhere. This server never holds a key (M7 G17).

export const PROTOCOL_VERSION = "2025-06-18";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Tool = {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  run(args: Record<string, unknown>): Promise<unknown>;
};

type Request = { jsonrpc: "2.0"; id?: number | string | null; method: string; params?: Record<string, unknown> };

const toJson = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x))) as Json;

/// Handles one message; returns the response line, or null for a notification.
export async function handle(tools: Tool[], line: string, info = { name: "tourbillon-mcp", version: "0.1.0" }): Promise<string | null> {
  let req: Request;
  try {
    req = JSON.parse(line) as Request;
  } catch {
    return JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
  }
  const reply = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: req.id ?? null, result: toJson(result) });
  const fail = (code: number, message: string) => JSON.stringify({ jsonrpc: "2.0", id: req.id ?? null, error: { code, message } });
  if (req.id === undefined) return null; // a notification (e.g. notifications/initialized)
  switch (req.method) {
    case "initialize":
      return reply({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: info });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    case "tools/call": {
      const name = String(req.params?.name ?? "");
      const tool = tools.find((t) => t.name === name);
      if (!tool) return fail(-32602, `unknown tool ${name}`);
      try {
        const out = await tool.run((req.params?.arguments ?? {}) as Record<string, unknown>);
        return reply({ content: [{ type: "text", text: JSON.stringify(toJson(out)) }], structuredContent: toJson(out), isError: false });
      } catch (e) {
        return reply({ content: [{ type: "text", text: (e as Error).message.split("\n")[0] }], isError: true });
      }
    }
    default:
      return fail(-32601, `method not found: ${req.method}`);
  }
}
