import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { DEFAULT_ENV_FILE, loadSecrets, redact, type Secrets } from "./config.ts";
import { checkPosts, wordingWarnings } from "./post.ts";
import { telegramClient } from "./telegram.ts";

/// Owner announcements. Takes a text file the owner wrote, shows a preview and the wording check, and posts it exactly
/// as written only after the owner types "post". Interactive only: it refuses without a terminal.
/// The habit: every announcement goes to the Alert Test group with --test first, then to the staff group.
///   bun src/announce.ts --test --file announcement.txt     (Alert Test group, TEST_CHAT_ID)
///   bun src/announce.ts --file announcement.txt            (staff group, OPS_CHAT_ID)
///   [--env-file ~/.tourbillon/alerts.env]

export type AnnounceArgs = { file: string; envFile: string; test: boolean };

export function parseAnnounceArgs(argv: string[]): AnnounceArgs {
  const a: AnnounceArgs = { file: "", envFile: DEFAULT_ENV_FILE, test: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--file") a.file = argv[++i] ?? "";
    else if (argv[i] === "--env-file") a.envFile = argv[++i] ?? a.envFile;
    else if (argv[i] === "--test") a.test = true;
    else throw new Error(`unknown flag ${argv[i]}`);
  }
  if (!a.file) throw new Error("--file is required");
  return a;
}

export const groupName = (test: boolean) => (test ? "Alert Test group" : "STAFF group");

/// Preview, wording warnings, the typed confirmation, then one send to the chosen group. Returns what happened.
export async function announce(
  text: string,
  test: boolean,
  secrets: Secrets,
  io: { write: (s: string) => void; ask: (q: string) => Promise<string>; send: (chatId: string, text: string) => Promise<number | void> },
): Promise<"sent" | "cancelled"> {
  checkPosts([text]);
  const group = groupName(test);
  const chatId = test ? secrets.testChatId : secrets.opsChatId;
  io.write(`\n--- preview: this goes to the ${group} exactly as written (${text.length} of 4096 units) ---\n${text}\n--- end of preview ---\n`);
  for (const w of wordingWarnings(text)) io.write(`warning: ${w}\n`);
  const answer = (await io.ask(`Type "post" to send it to the ${group}, anything else to cancel: `)).trim();
  if (answer !== "post") {
    io.write("cancelled: nothing sent\n");
    return "cancelled";
  }
  const id = await io.send(chatId, text);
  io.write(`sent to the ${group} (message ${id ?? "?"})\n`);
  return "sent";
}

if (import.meta.main) {
  const args = parseAnnounceArgs(process.argv.slice(2));
  if (!process.stdin.isTTY) throw new Error("announce is interactive: run it in a terminal to confirm");
  const text = readFileSync(args.file, "utf8").replace(/\n+$/, "");
  const secrets = loadSecrets(args.envFile);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await announce(text, args.test, secrets, {
      write: (s) => process.stdout.write(s),
      ask: (q) => rl.question(q),
      send: telegramClient(secrets.token).send,
    });
  } catch (e) {
    process.stderr.write(`${redact((e as Error).message, secrets.token)}\n`);
    process.exitCode = 1;
  } finally {
    rl.close();
  }
}
