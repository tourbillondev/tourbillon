import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

/// One release job per data folder: two jobs would both answer commands and both deploy. The lock is a file holding
/// the job's process id; a lock left by a job that is no longer running is taken over.
export function takeLock(dataDir: string, pid = process.pid, alive = (p: number) => {
  try {
    process.kill(p, 0);
    return true;
  } catch {
    return false;
  }
}): () => void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const p = join(dataDir, "job.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(p, "wx", 0o600);
      writeSync(fd, String(pid));
      closeSync(fd);
      return () => rmSync(p, { force: true });
    } catch {
      const other = Number(readFileSync(p, "utf8").trim());
      if (other && other !== pid && alive(other)) throw new Error(`another release job (process ${other}) is already running on ${dataDir}: stop it first`);
      rmSync(p, { force: true }); // left by a job that has stopped
    }
  }
  throw new Error(`the job lock ${p} could not be taken`);
}
