import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { DEFAULT_ENV_FILE, loadSecrets, redact } from "./config.ts";
import { checkPosts, wordingWarnings } from "./post.ts";
import { telegramClient } from "./telegram.ts";

/// Owner announcements to the staff group (before launch). Takes a text file the owner wrote, shows a preview, and
/// posts it exactly as written only after the owner types "post". Interactive only: it refuses without a terminal.
///   bun src/announce.ts --file announcement.txt [--env-file ~/.tourbillon/alerts.env]

const argv = process.argv.slice(2);
let file = "";
let envFile = DEFAULT_ENV_FILE;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--file") file = argv[++i] ?? "";
  else if (argv[i] === "--env-file") envFile = argv[++i] ?? envFile;
  else throw new Error(`unknown flag ${argv[i]}`);
}
if (!file) throw new Error("--file is required");
if (!process.stdin.isTTY) throw new Error("announce is interactive: run it in a terminal to confirm");
const text = readFileSync(file, "utf8").replace(/\n+$/, "");
checkPosts([text]);
const secrets = loadSecrets(envFile);
process.stdout.write(`\n--- preview: this goes to the STAFF group exactly as written (${text.length} of 4096 units) ---\n${text}\n--- end of preview ---\n`);
for (const w of wordingWarnings(text)) process.stdout.write(`warning: ${w}\n`);
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = (await rl.question('Type "post" to send it to the staff group, anything else to cancel: ')).trim();
rl.close();
if (answer !== "post") {
  process.stdout.write("cancelled: nothing sent\n");
  process.exit(0);
}
try {
  const id = await telegramClient(secrets.token).send(secrets.opsChatId, text);
  process.stdout.write(`sent to the staff group (message ${id ?? "?"})\n`);
} catch (e) {
  process.stderr.write(`${redact((e as Error).message, secrets.token)}\n`);
  process.exit(1);
}
