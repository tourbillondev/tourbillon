import { readFileSync } from "node:fs";
import { settlementOf } from "@tourbillon/common/settlement.ts";
import { log } from "@tourbillon/common/log.ts";
import { lintText, why } from "@tourbillon/common/words.ts";
import { chatFor, DEFAULT_ENV_FILE, loadSecrets, redact } from "./config.ts";
import { telegramSender } from "./telegram.ts";

/// Posts prepared texts, in order, to the shared alert test group only (the intro and the pinned guide live there).
/// Staff announcements go through announce.ts, with a preview and a confirmation. Prints each post with its message id;
/// never prints the token.
///   bun src/post.ts --file posts/a.txt [--file posts/b.txt …] [--deployment <file>] [--env-file ~/.tourbillon/alerts.env]
/// A post that names the settlement token says {{SETTLEMENT}}; it is filled with the symbol from the deployment file
/// (owner D1: USDG on Robinhood Chain), and a post with a placeholder left is never sent.

export const TELEGRAM_LIMIT = 4096; // UTF-16 code units per message

export const utf16Length = (s: string) => s.length; // JS strings are UTF-16: an emoji counts as two, as Telegram counts

/// The spec's wording rules (Overview section 9), as warnings for texts the owner writes (the shared words lint).
export function wordingWarnings(text: string): string[] {
  return [...new Set(lintText(text).map((f) => why(f.rule)))];
}

/// Fills {{SETTLEMENT}} with the settlement token's symbol.
export function fillSettlement(text: string, symbol: string): string {
  return text.replaceAll("{{SETTLEMENT}}", symbol);
}

export function checkPosts(texts: string[]): void {
  texts.forEach((t, i) => {
    if (t.trim().length === 0) throw new Error(`post ${i + 1} is empty`);
    if (utf16Length(t) > TELEGRAM_LIMIT) throw new Error(`post ${i + 1} is ${utf16Length(t)} UTF-16 units, over Telegram's ${TELEGRAM_LIMIT}`);
    if (/\{\{[A-Z_]+\}\}/.test(t)) throw new Error(`post ${i + 1} has a placeholder left (give --deployment for the settlement token)`);
  });
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const files: string[] = [];
  let envFile = DEFAULT_ENV_FILE;
  let deployment: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--file") files.push(argv[++i]!);
    else if (argv[i] === "--env-file") envFile = argv[++i]!;
    else if (argv[i] === "--deployment") deployment = argv[++i]!;
    else throw new Error(`unknown flag ${argv[i]}`);
  }
  if (files.length === 0) throw new Error("give at least one --file");
  const symbol = deployment ? settlementOf(JSON.parse(readFileSync(deployment, "utf8"))).symbol : undefined;
  const texts = files.map((f) => {
    const t = readFileSync(f, "utf8").replace(/\n+$/, "");
    return symbol ? fillSettlement(t, symbol) : t;
  });
  checkPosts(texts); // all checked before the first is sent
  const secrets = loadSecrets(envFile);
  const send = telegramSender(secrets.token);
  const chat = chatFor(secrets, false); // the test group, always
  const where = "the test group";
  for (let i = 0; i < texts.length; i++) {
    try {
      const id = await send(chat, texts[i]!);
      process.stdout.write(`--- sent ${i + 1}/${texts.length} to ${where} (message ${id ?? "?"}) from ${files[i]}\n${texts[i]}\n`);
    } catch (e) {
      log("error", "post failed; stopping", { post: i + 1, file: files[i], error: redact((e as Error).message, secrets.token) });
      process.exit(1);
    }
    await Bun.sleep(1200); // stay well under Telegram's per-chat rate
  }
}
