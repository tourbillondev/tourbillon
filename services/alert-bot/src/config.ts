import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/// The bot's settings. The token and the two chat ids live outside the repo, in ~/.tourbillon/alerts.env:
///   ALERT_BOT_TOKEN  the "Tourbillon Alerts" bot token (never printed, logged or committed)
///   OPS_CHAT_ID      the staff group (posts go there only with --staff)
///   TEST_CHAT_ID     the shared alert test group (the default target)
/// The bot refuses to start if the two ids are the same, so a test can never land in the staff group by mistake.

export const DEFAULT_ENV_FILE = join(homedir(), ".tourbillon", "alerts.env");

export type Secrets = { token: string; opsChatId: string; testChatId: string };

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, eq).trim()] = v;
  }
  return out;
}

export function secretsFrom(env: Record<string, string>): Secrets {
  for (const k of ["ALERT_BOT_TOKEN", "OPS_CHAT_ID", "TEST_CHAT_ID"]) {
    if (!env[k]) throw new Error(`alerts env: ${k} is missing`);
  }
  if (env.OPS_CHAT_ID === env.TEST_CHAT_ID) throw new Error("alerts env: OPS_CHAT_ID and TEST_CHAT_ID are the same; refusing to start");
  return { token: env.ALERT_BOT_TOKEN!, opsChatId: env.OPS_CHAT_ID!, testChatId: env.TEST_CHAT_ID! };
}

export function loadSecrets(path = DEFAULT_ENV_FILE): Secrets {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`alerts env: cannot read ${path}`);
  }
  return secretsFrom(parseEnv(text));
}

/// The target chat: the test group unless --staff.
export const chatFor = (s: Secrets, staff: boolean) => (staff ? s.opsChatId : s.testChatId);

/// Removes the token from any text before it is logged (an error from the HTTP layer can carry the request URL).
export function redact(text: string, token: string): string {
  return token ? text.split(token).join("[token]") : text;
}
