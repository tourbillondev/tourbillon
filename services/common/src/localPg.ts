import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

/// LOCAL ONLY: a throwaway Postgres cluster in a temp folder (trust auth, a random port, TCP on 127.0.0.1 only), for the
/// indexer and API tests. Skipped when the Postgres binaries are not installed.

const bin = (name: string) => Bun.which(name) ?? [`/usr/local/opt/postgresql@17/bin/${name}`, `/opt/homebrew/opt/postgresql@17/bin/${name}`].find((p) => Bun.file(p).size > 0) ?? null;
export const havePostgres = () => bin("initdb") !== null && bin("pg_ctl") !== null;

export type LocalPg = { url: string; stop(): void };

export async function startLocalPg(port: number): Promise<LocalPg> {
  const dir = mkdtempSync(join(tmpdir(), "local-pg-"));
  const data = join(dir, "data");
  // macOS: without a locale in the environment the postmaster refuses to start ("became multithreaded during startup")
  const env = { ...process.env, LC_ALL: "C", LANG: "C" };
  const init = Bun.spawnSync([bin("initdb")!, "-D", data, "-A", "trust", "-U", userInfo().username, "--no-locale", "-E", "UTF8"], { stdout: "ignore", stderr: "pipe", env });
  if (init.exitCode !== 0) throw new Error(`initdb failed: ${init.stderr.toString().slice(0, 300)}`);
  const start = Bun.spawnSync([bin("pg_ctl")!, "-D", data, "-l", join(dir, "pg.log"), "-o", `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=''`, "-w", "start"], { stdout: "ignore", stderr: "pipe", env });
  if (start.exitCode !== 0) {
    const logText = await Bun.file(join(dir, "pg.log")).text().catch(() => "");
    throw new Error(`pg_ctl start failed: ${start.stderr.toString().slice(0, 200)} ${logText.slice(-400)}`);
  }
  return {
    url: `postgres://${userInfo().username}@127.0.0.1:${port}/postgres`,
    stop: () => {
      Bun.spawnSync([bin("pg_ctl")!, "-D", data, "-m", "immediate", "stop"], { stdout: "ignore", stderr: "ignore", env });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
