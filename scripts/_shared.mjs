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

/* ------------------------------------------------------------ connecting -- */

/**
 * Connect WITHOUT letting Mongoose change the database.
 *
 * By default Mongoose builds every index a compiled model declares
 * (autoIndex) and creates every collection it has a model for (autoCreate)
 * as soon as the connection opens. A script that imports a model -- even
 * only to read `schema.indexes()`, even in a dry run -- would therefore
 * build unique indexes over the live data, possibly the very ones the dry run
 * is meant to check first. Off, here and on the connection, for every
 * maintenance script. Anything a script builds, it builds itself, by name.
 *
 * Call `quietMongoose(mongoose)` BEFORE importing models (use a dynamic
 * import after it), then `connectMaintenance(mongoose, uri)`.
 */
export function quietMongoose(mongoose) {
  mongoose.set("autoIndex", false);
  mongoose.set("autoCreate", false);
}

export async function connectMaintenance(mongoose, uri) {
  quietMongoose(mongoose);
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  return mongoose.connection;
}

/**
 * Can this deployment run multi-document transactions?
 *
 * Only a replica set or a sharded cluster can (Atlas is always one; a plain
 * `mongod` on a laptop is not). Returns `{ ok, kind }`.
 */
export async function transactionSupport(db) {
  try {
    const hello = await db.admin().command({ hello: 1 });
    if (hello.setName) return { ok: true, kind: `replica set "${hello.setName}"` };
    if (hello.msg === "isdbgrid") return { ok: true, kind: "sharded cluster" };
    return { ok: false, kind: "standalone server" };
  } catch (err) {
    return { ok: false, kind: `unknown (${err.message})` };
  }
}

/* ------------------------------------------------------------ formatting -- */

/** Accounting style: negatives in parentheses. */
export const money = (n) =>
  n < 0 ? `(${Math.abs(n).toFixed(2)})` : Number(n).toFixed(2);

export const pad = (s, w) => String(s).padEnd(w).slice(0, w);
export const padL = (s, w) => String(s).padStart(w);
