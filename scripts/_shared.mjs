/**
 * Shared plumbing for the maintenance scripts: env loading, backups,
 * confirmation prompts and table formatting.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

/** Minimal .env.local reader — these run outside Next, which usually does it. */
export function loadEnv() {
  if (process.env.MONGO_URI) return;
  for (const file of [".env.local", ".env"]) {
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) continue;
    for (const raw of fs.readFileSync(full, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!(key in process.env)) process.env[key] = value;
    }
  }
}

export const flags = () => ({
  apply: process.argv.includes("--apply"),
  yes: process.argv.includes("--yes"),
});

/** Write a timestamped JSON backup under /backups. Returns the path. */
export function writeBackup(name, payload) {
  const dir = path.join(ROOT, "backups");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${name}-${stamp}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ takenAt: new Date().toISOString(), ...payload }, null, 2)
  );
  return path.relative(ROOT, file);
}

export async function confirmYes(question, assumeYes = false) {
  if (assumeYes) return true;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await new Promise((res) => rl.question(question, res));
  rl.close();
  return answer.trim().toLowerCase() === "yes";
}

/* ------------------------------------------------------------ formatting -- */

/** Accounting style: negatives in parentheses. */
export const money = (n) =>
  n < 0 ? `(${Math.abs(n).toFixed(2)})` : Number(n).toFixed(2);

export const pad = (s, w) => String(s).padEnd(w).slice(0, w);
export const padL = (s, w) => String(s).padStart(w);
