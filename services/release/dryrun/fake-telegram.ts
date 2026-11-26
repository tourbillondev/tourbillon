// A local stand-in for the Telegram Bot API, for a dry run without the test group's token. It answers like Telegram
// and records every call (method, chat, text or caption, file name and size) to a JSON-lines file.
// GET /whoami answers with its record file and pid, so a run can check that the recorder on its port is its own.
// Start it through telegram-recorder.ts, which gives each run folder its own port and refuses a port in use.
//   bun fake-telegram.ts <port> <record file>
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";

const [portArg, outArg] = process.argv.slice(2);
if (!portArg || !outArg) {
  console.error("usage: bun fake-telegram.ts <port> <record file>");
  process.exit(2);
}
const port = Number(portArg);
const out = resolve(outArg);
let id = 1000;

try {
  Bun.serve({
    port,
    hostname: "127.0.0.1",
    reusePort: false,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/whoami" && req.method === "GET") return Response.json({ record: out, pid: process.pid });
      const m = /^\/bot[^/]+\/(\w+)$/.exec(path);
      if (!m || req.method !== "POST") return Response.json({ ok: false, description: "Not Found" }, { status: 404 });
      const method = m[1]!;
      let rec: Record<string, unknown> = { method };
      if ((req.headers.get("content-type") ?? "").includes("multipart/form-data")) {
        const fd = await req.formData();
        for (const [k, v] of fd.entries()) rec[k] = typeof v === "string" ? v : { file: (v as File).name, bytes: (v as File).size };
      } else rec = { method, ...(await req.json()) };
      if (!/^(sendMessage|sendPhoto|sendDocument)$/.test(method)) return Response.json({ ok: false, description: "method not used by the release job" }, { status: 400 });
      rec.message_id = ++id;
      rec.at = new Date().toISOString();
      appendFileSync(out, JSON.stringify(rec) + "\n");
      return Response.json({ ok: true, result: { message_id: id } });
    },
  });
} catch (e) {
  const inUse = (e as { code?: string }).code === "EADDRINUSE" || /in use/i.test(String(e));
  console.error(inUse ? `STOP: port ${port} is already in use; this recorder (for ${out}) did not start.` : `STOP: ${String(e)}`);
  process.exit(2);
}
console.log(`fake telegram on ${port}, recording to ${out}`);
