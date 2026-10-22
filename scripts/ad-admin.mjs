import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const usage = `Usage:
  npm run ad:admin -- status
  npm run ad:admin -- enable
  npm run ad:admin -- disable
  npm run ad:admin -- list
  npm run ad:admin -- approve SUBMISSION_ID
  npm run ad:admin -- reject SUBMISSION_ID [reason]

Options:
  --base URL   API origin (default: https://termdrop.sh)`;

async function main() {
  const args = process.argv.slice(2);
  const baseIndex = args.indexOf("--base");
  const baseUrl = baseIndex >= 0 ? args.splice(baseIndex, 2)[1] : "https://termdrop.sh";
  const [command, id, ...reasonParts] = args;
  const commands = ["status", "enable", "disable", "list", "approve", "reject"];
  if (!baseUrl || !commands.includes(command)) throw new Error(usage);
  if (["approve", "reject"].includes(command) && !id) throw new Error(usage);

  const secret = process.env.TERMDROP_AD_ADMIN_SECRET?.trim() || await readSecretFile();
  const isGet = command === "list" || command === "status";
  const path = command === "list"
    ? "/api/ad/admin/pending"
    : ["status", "enable", "disable"].includes(command)
      ? "/api/ad/admin/enabled"
      : `/api/ad/admin/${command}`;
  const body = command === "enable" || command === "disable"
    ? { enabled: command === "enable" }
    : { id, reason: reasonParts.join(" ") || undefined };
  const response = await fetch(new URL(path, baseUrl), {
    method: isGet ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      ...(isGet ? {} : { "Content-Type": "application/json" }),
    },
    body: isGet ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`TermDrop returned HTTP ${response.status}: ${text}`);
  const output = text ? JSON.parse(text) : { ok: true };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

async function readSecretFile() {
  try {
    return (await readFile(join(homedir(), ".config", "termdrop", "ad-admin-secret"), "utf8")).trim();
  } catch {
    throw new Error(
      "Set TERMDROP_AD_ADMIN_SECRET or create ~/.config/termdrop/ad-admin-secret.",
    );
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
