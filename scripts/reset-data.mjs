/**
 * Wipe the books back to empty.
 *
 * This exists so that clearing data is a deliberate, logged, backed-up act run
 * by someone with shell access — rather than an unauthenticated DELETE route
 * that anyone on the internet can call.
 *
 * USAGE
 * -----
 *   node scripts/reset-data.mjs                      # dry run, prints what would go
 *   node scripts/reset-data.mjs --apply              # wipes everything (asks first)
 *   node scripts/reset-data.mjs --apply --yes        # no prompt
 *   node scripts/reset-data.mjs --apply --keep-masters
 *
 * --keep-masters keeps customers, items and HSN codes and clears only the
 * transactions. Balances and stock cannot simply be left alone in that case:
 * they are the accumulated effect of the documents being deleted, so every
 * customer is reset to its opening balance and the invoice counter to zero.
 * Skipping that step is what leaves a "clean" book showing money owed by
 * nobody for invoices that no longer exist.
 *
 * A JSON backup of everything deleted is always written first.
 */

import mongoose from "mongoose";

import { loadEnv, flags, writeBackup, confirmYes, pad, padL } from "./_shared.mjs";

const TRANSACTIONS = ["invoices", "ledgers", "itemledgers", "vouchers"];
const MASTERS = ["customers", "items", "hsns"];
const COUNTERS = ["counters"];

loadEnv();

const { apply, yes } = flags();
const keepMasters = process.argv.includes("--keep-masters");

const targets = keepMasters
  ? [...TRANSACTIONS, ...COUNTERS]
  : [...TRANSACTIONS, ...MASTERS, ...COUNTERS];

if (!process.env.MONGO_URI) {
  console.error("MONGO_URI is not set (looked in .env.local and .env).");
  process.exit(1);
}

await mongoose.connect(process.env.MONGO_URI, {
  bufferCommands: false,
  serverSelectionTimeoutMS: 20000,
});

const db = mongoose.connection.db;

console.log(`\ndatabase : ${db.databaseName}`);
console.log(`host     : ${mongoose.connection.host}`);
console.log(`mode     : ${keepMasters ? "transactions only" : "everything"}\n`);

const present = (await db.listCollections().toArray()).map((c) => c.name).sort();

const counts = {};
for (const name of present) {
  counts[name] = await db.collection(name).countDocuments();
}

const width = Math.max(...present.map((n) => n.length), 12);
console.log(pad("collection", width), padL("docs", 8), "  action");
console.log("-".repeat(width + 20));
for (const name of present) {
  const hit = targets.includes(name);
  console.log(
    pad(name, width),
    padL(counts[name], 8),
    hit ? "  DELETE" : "  keep"
  );
}

// Anything the app writes that this script does not know about would survive a
// "wipe" and quietly poison the next run, so say so rather than staying silent.
const unknown = present.filter(
  (n) => !targets.includes(n) && !n.startsWith("system.")
);
if (unknown.length && !keepMasters) {
  console.log(`\nnot recognised, left untouched: ${unknown.join(", ")}`);
}

const doomed = present.filter((n) => targets.includes(n));
const total = doomed.reduce((sum, n) => sum + counts[n], 0);

if (!apply) {
  console.log(`\nDry run. ${total} document(s) would be deleted.`);
  console.log("Re-run with --apply to do it.\n");
  await mongoose.disconnect();
  process.exit(0);
}

if (total === 0) {
  console.log("\nNothing to delete.\n");
  await mongoose.disconnect();
  process.exit(0);
}

const ok = await confirmYes(
  `\nDelete ${total} document(s) from ${db.databaseName}? This cannot be undone. Type "yes": `,
  yes
);
if (!ok) {
  console.log("Aborted.\n");
  await mongoose.disconnect();
  process.exit(0);
}

// Back up before anything goes.
const snapshot = {};
for (const name of doomed) {
  snapshot[name] = await db.collection(name).find({}).toArray();
}
const backup = writeBackup("reset-data", {
  database: db.databaseName,
  mode: keepMasters ? "transactions" : "everything",
  collections: snapshot,
});
console.log(`\nbackup written: ${backup}`);

for (const name of doomed) {
  const { deletedCount } = await db.collection(name).deleteMany({});
  console.log(`  cleared ${pad(name, width)} ${padL(deletedCount, 8)}`);
}

if (keepMasters) {
  // Balances and stock are derived from the documents just deleted; reset them
  // to their opening positions so the books start consistent.
  const customers = await db.collection("customers").find({}).toArray();
  for (const c of customers) {
    const opening = Number(c.openingBal) || 0;
    await db.collection("customers").updateOne(
      { _id: c._id },
      { $set: { lastBal: opening, lastMode: opening >= 0 ? "Dr" : "Cr" } }
    );
  }
  console.log(`  reset    ${pad("balances", width)} ${padL(customers.length, 8)}`);
}

console.log("\nDone.\n");
await mongoose.disconnect();
