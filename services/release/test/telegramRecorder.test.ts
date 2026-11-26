import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FIRST_PORT, nextPort, portInUse, portOf, startRecorder, whoami } from "../dryrun/telegram-recorder.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "project-rec-"));
const started: number[] = [];
afterAll(() => {
  for (const pid of started) {
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
  }
});

/** A port nothing listens on right now. */
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", () => ok()));
  const p = (s.address() as { port: number }).port;
  await new Promise<void>((ok) => s.close(() => ok()));
  return p;
}

const post = (port: number, text: string) =>
  fetch(`http://127.0.0.1:${port}/botTOKEN/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: "-1", text }) });
const lines = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean) : []);

describe("each dry-run folder has its own Telegram recorder", () => {
  test("a new folder gets the next port no other folder uses; the old shared port does not count", () => {
    const root = tmp();
    expect(nextPort(root)).toBe(FIRST_PORT);
    const folder = (name: string, api?: string) => {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, "release.dryrun.json"), JSON.stringify(api ? { telegramApi: api } : {}));
    };
    folder("dryrun-old", "http://127.0.0.1:18081");
    folder("no-telegram");
    expect(nextPort(root)).toBe(FIRST_PORT);
    folder("dryrun-g37", `http://127.0.0.1:${FIRST_PORT}`);
    folder("dryrun-g43", `http://127.0.0.1:${FIRST_PORT + 3}`);
    expect(nextPort(root)).toBe(FIRST_PORT + 4);
    expect(portOf(join(root, "dryrun-g43", "release.dryrun.json"))).toBe(FIRST_PORT + 3);
    expect(() => portOf(join(root, "no-telegram", "release.dryrun.json"))).toThrow("no telegramApi");
  });

  test("telegramApi must be a local address", () => {
    const f = join(tmp(), "c.json");
    writeFileSync(f, JSON.stringify({ telegramApi: "https://api.telegram.org" }));
    expect(() => portOf(f)).toThrow("must be http://127.0.0.1:<port>");
  });

  test("a recorder answers as itself and records to its own file only", async () => {
    const d = tmp();
    const port = await freePort();
    const rec = join(d, "telegram-record.jsonl");
    const pid = await startRecorder(port, rec, join(d, "fake-telegram.log"));
    started.push(pid);
    expect(await whoami(port)).toEqual({ record: resolve(rec), pid });
    expect((await post(port, "hello")).ok).toBe(true);
    expect(lines(rec).map((l) => JSON.parse(l).text)).toEqual(["hello"]);
  });

  test("a port in use by another run's recorder stops the run with a clear error; nothing goes to the other record", async () => {
    const a = tmp();
    const b = tmp();
    const port = await freePort();
    const recA = join(a, "telegram-record.jsonl");
    const recB = join(b, "telegram-record.jsonl");
    started.push(await startRecorder(port, recA, join(a, "fake-telegram.log")));
    await expect(startRecorder(port, recB, join(b, "fake-telegram.log"))).rejects.toThrow(
      new RegExp(`port ${port} is already in use by a Telegram recorder writing to ${resolve(recA).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
    );
    expect((await post(port, "only for A")).ok).toBe(true);
    expect(lines(recA)).toHaveLength(1);
    expect(existsSync(recB)).toBe(false);
  });

  test("a port in use by some other program is refused too", async () => {
    const d = tmp();
    const port = await freePort();
    const other: Server = createServer((s) => s.destroy()); // takes the port, answers nothing
    await new Promise<void>((ok) => other.listen(port, "127.0.0.1", () => ok()));
    try {
      expect(await portInUse(port)).toBe(true);
      await expect(startRecorder(port, join(d, "r.jsonl"), join(d, "l.log"))).rejects.toThrow(`port ${port} is already in use by another program`);
    } finally {
      await new Promise<void>((ok) => other.close(() => ok()));
    }
    expect(await portInUse(port)).toBe(false);
  });

  test("the start command exits 1 with STOP and the reason; fake-telegram.ts itself exits 2 when its port is taken", async () => {
    const a = tmp();
    const b = tmp();
    const port = await freePort();
    started.push(await startRecorder(port, join(a, "telegram-record.jsonl"), join(a, "fake-telegram.log")));
    writeFileSync(join(b, "release.dryrun.json"), JSON.stringify({ telegramApi: `http://127.0.0.1:${port}` }));
    const dir = resolve(import.meta.dir, "../dryrun");
    const cli = spawnSync("bun", [join(dir, "telegram-recorder.ts"), "start", b], { encoding: "utf8" });
    expect(cli.status).toBe(1);
    expect(cli.stderr).toContain(`STOP: port ${port} is already in use by a Telegram recorder writing to`);
    expect(existsSync(join(b, "fake-telegram.pid"))).toBe(false);
    const direct = spawnSync("bun", [join(dir, "fake-telegram.ts"), String(port), join(b, "x.jsonl")], { encoding: "utf8", timeout: 10_000 });
    expect(direct.status).toBe(2);
    expect(direct.stderr).toContain(`STOP: port ${port} is already in use`);
  });

  test("the start command writes the folder's pid file and records to the folder's own file", async () => {
    const d = tmp();
    const port = await freePort();
    writeFileSync(join(d, "release.dryrun.json"), JSON.stringify({ telegramApi: `http://127.0.0.1:${port}` }));
    const cli = spawnSync("bun", [resolve(import.meta.dir, "../dryrun/telegram-recorder.ts"), "start", d], { encoding: "utf8" });
    expect(cli.status).toBe(0);
    const pid = Number(readFileSync(join(d, "fake-telegram.pid"), "utf8"));
    started.push(pid);
    expect(await whoami(port)).toEqual({ record: join(d, "telegram-record.jsonl"), pid });
  });
});
