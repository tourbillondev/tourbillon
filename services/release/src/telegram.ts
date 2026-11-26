import { readFileSync, statSync } from "node:fs";

/// The one Telegram call the release system makes: the send-only emergency for the team bot's own heartbeat, to Alert
/// Test (every other message is posted by the team bot). The token is only ever in the request URL to the API and is
/// removed from every error text; it is never logged or posted.

export type Telegram = {
  send(chat: string, text: string): Promise<number>;
};

/// Reads the alarm secrets file (KEY=value lines). Refuses a file others can read.
///   ALERT_BOT_TOKEN   the alert bot's token (a dry run: its own bot)
///   TEST_CHAT_ID      Alert Test
export function readSecrets(path: string): { token: string; testChat: string } {
  let st;
  try {
    st = statSync(path);
  } catch {
    throw new Error(`the posting secrets file ${path} cannot be read`);
  }
  if ((st.mode & 0o077) !== 0) throw new Error(`the posting secrets file ${path} is readable by others: chmod 600 it`);
  const kv = new Map<string, string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) kv.set(m[1]!, m[2]!.replace(/^["']|["']$/g, ""));
  }
  const token = kv.get("ALERT_BOT_TOKEN") ?? "";
  const testChat = kv.get("TEST_CHAT_ID") ?? "";
  if (!/^\d+:[\w-]{20,}$/.test(token)) throw new Error(`${path}: ALERT_BOT_TOKEN is missing or not a bot token`);
  if (!/^-\d+$/.test(testChat)) throw new Error(`${path}: TEST_CHAT_ID is missing or not a group id (it starts with -)`);
  return { token, testChat };
}

export const scrub = (text: string, token: string) => (token ? text.split(token).join("[token]") : text);

export function telegramClient(token: string, o: { api?: string; fetch?: typeof fetch } = {}): Telegram {
  const api = (o.api ?? "https://api.telegram.org").replace(/\/$/, "");
  const f = o.fetch ?? fetch;
  async function call(method: string, body: Record<string, unknown>): Promise<number> {
    let r: Response;
    try {
      r = await f(`${api}/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new Error(`telegram: ${method} got no answer`);
    }
    let j: { ok?: boolean; result?: { message_id?: number }; description?: string } = {};
    try {
      j = (await r.json()) as typeof j;
    } catch {
      /* not JSON */
    }
    if (!r.ok || !j.ok) throw new Error(scrub(`telegram: ${method} refused (${r.status}${j.description ? `: ${j.description}` : ""})`, token));
    return j.result?.message_id ?? -1;
  }
  return {
    send: (chat, text) => call("sendMessage", { chat_id: chat, text, link_preview_options: { is_disabled: true } }),
  };
}
