import { readFileSync } from "node:fs";
import { basename } from "node:path";

/// The team bot's Telegram calls, on the alert bot's token. Plain Bot API over fetch, no dependency. Errors carry only
/// Telegram's own code and description, never the token or the request. "Too many requests" is waited out
/// (retry_after + 1 s, at least 1 s) and tried again; a network failure is tried again a few times (2 s, 4 s, 6 s).
/// Messages are Telegram HTML; the copy-ready captions are plain text.

export type TgMessage = {
  message_id: number;
  chat: { id: number };
  from?: { is_bot?: boolean; username?: string };
  text?: string;
  message_thread_id?: number;
  is_topic_message?: boolean;
  reply_to_message?: TgMessage;
};
export type TgUpdate = { update_id: number; message?: TgMessage };

/// What the team bot needs from Telegram. Tests use a stand-in.
export interface Tg {
  send(chat: number, html: string): Promise<number>;
  photo(chat: number, file: string, caption: string, html?: boolean): Promise<number>;
  document(chat: number, name: string, data: Uint8Array, caption: string): Promise<number>;
  edit(chat: number, messageId: number, html: string): Promise<void>;
  pin(chat: number, messageId: number): Promise<void>;
  me(): Promise<string>;
  setCommands(chat: number, commands: [string, string][]): Promise<void>;
  updates(offset: number, timeoutSec: number): Promise<TgUpdate[]>;
  copy(chat: number, fromChat: number, messageId: number): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function telegramClient(token: string, o: { api?: string; fetch?: typeof fetch; wait?: (ms: number) => Promise<void> } = {}): Tg {
  const api = (o.api ?? "https://api.telegram.org").replace(/\/$/, "");
  const f = o.fetch ?? fetch;
  const wait = o.wait ?? sleep;
  const clean = (s: string) => (token ? s.split(token).join("<token>") : s);

  async function call<T>(method: string, body: Record<string, unknown> | FormData, tries = 4, timeoutMs = 15_000): Promise<T> {
    for (let i = 0; ; i++) {
      let r: Response;
      try {
        r = await f(`${api}/bot${token}/${method}`, {
          method: "POST",
          ...(body instanceof FormData ? { body } : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        if (i < tries - 1) {
          await wait(2000 * (i + 1));
          continue;
        }
        throw new Error(`Telegram could not be reached (${method})`);
      }
      let j: { ok?: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } } = {};
      try {
        j = (await r.json()) as typeof j;
      } catch {
        /* not JSON */
      }
      if (r.ok && j.ok) return j.result as T;
      if ((j.error_code ?? r.status) === 429 && i < tries - 1) {
        await wait(Math.max(1, (j.parameters?.retry_after ?? 5) + 1) * 1000);
        continue;
      }
      throw new Error(`Telegram said ${j.error_code ?? r.status} ${clean(j.description ?? "")} (${method})`.trim());
    }
  }
  const html = { parse_mode: "HTML", link_preview_options: { is_disabled: true } };
  const upload = (method: string, field: string, chat: number, file: Blob, name: string, caption: string, isHtml: boolean) => {
    const fd = new FormData();
    fd.set("chat_id", String(chat));
    fd.set(field, file, name);
    fd.set("caption", caption);
    if (isHtml) fd.set("parse_mode", "HTML");
    return call<{ message_id: number }>(method, fd, 4, 60_000); // uploads: 60 s
  };

  return {
    send: async (chat, text) => (await call<{ message_id: number }>("sendMessage", { chat_id: chat, text, ...html })).message_id,
    photo: async (chat, file, caption, isHtml = false) => (await upload("sendPhoto", "photo", chat, new Blob([readFileSync(file)], { type: "image/png" }), basename(file), caption, isHtml)).message_id,
    document: async (chat, name, data, caption) => (await upload("sendDocument", "document", chat, new Blob([new Uint8Array(data)], { type: "application/zip" }), name, caption, false)).message_id,
    edit: async (chat, id, text) => void (await call("editMessageText", { chat_id: chat, message_id: id, text, ...html }, 1)),
    pin: async (chat, id) => void (await call("pinChatMessage", { chat_id: chat, message_id: id, disable_notification: true })),
    me: async () => (await call<{ username: string }>("getMe", {})).username,
    setCommands: async (chat, commands) => void (await call("setMyCommands", { commands: commands.map(([command, description]) => ({ command, description })), scope: { type: "chat", chat_id: chat } })),
    updates: async (offset, timeout) => call<TgUpdate[]>("getUpdates", { offset, timeout, allowed_updates: ["message"] }, 1, (timeout + 10) * 1000),
    copy: async (chat, from, id) => void (await call("copyMessage", { chat_id: chat, from_chat_id: from, message_id: id })),
  };
}
