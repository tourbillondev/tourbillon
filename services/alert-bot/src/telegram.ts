import { redact } from "./config.ts";

/// The Telegram Bot API calls the bot uses. The token never leaves this module: errors carry the HTTP status and
/// Telegram's own description only, passed through `redact` before they can reach a log.

export type Sender = (chatId: string, text: string) => Promise<number | void>; // the message id when sent

export type Telegram = {
  send: Sender;
  edit(chatId: string, messageId: number, text: string): Promise<void>;
  pin(chatId: string, messageId: number): Promise<void>;
  updates(offset: number): Promise<{ update_id: number; message?: { chat: { id: number }; text?: string } }[]>;
};

export function telegramClient(token: string, fetchFn: typeof fetch = fetch): Telegram {
  const call = async <T>(method: string, body: Record<string, unknown>): Promise<T> => {
    let res: Response;
    try {
      res = await fetchFn(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new Error(redact(`telegram: request failed (${(e as Error).message.split("\n")[0]})`, token));
    }
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!res.ok || json.ok === false) throw new Error(redact(`telegram: HTTP ${res.status}${json.description ? ` (${json.description})` : ""}`, token));
    return json.result as T;
  };
  return {
    send: async (chatId, text) => (await call<{ message_id: number }>("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true }))?.message_id,
    edit: async (chatId, messageId, text) => {
      try {
        await call("editMessageText", { chat_id: chatId, message_id: messageId, text, disable_web_page_preview: true });
      } catch (e) {
        if (!String((e as Error).message).includes("message is not modified")) throw e;
      }
    },
    pin: async (chatId, messageId) => void (await call("pinChatMessage", { chat_id: chatId, message_id: messageId, disable_notification: true })),
    updates: async (offset) => (await call<{ update_id: number; message?: { chat: { id: number }; text?: string } }[]>("getUpdates", { offset, timeout: 0, allowed_updates: ["message"] })) ?? [],
  };
}

/// The sender alone (kept for the posting tools and tests).
export const telegramSender = (token: string, fetchFn: typeof fetch = fetch): Sender => telegramClient(token, fetchFn).send;
