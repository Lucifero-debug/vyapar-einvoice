/**
 * Give every existing row a firm.
 *
 *   node scripts/adopt-tenant.mjs                 # dry run
 *   node scripts/adopt-tenant.mjs --apply         # do it
 *   node scripts/adopt-tenant.mjs --apply --company <id>
 *
 * Multi-tenancy arrived after the data did. Every customer, item, invoice,
 * ledger row and voucher already in the database has no `companyId`, and the
 * scoping plugin filters on it -- so until this runs, the existing books are
 * invisible to everybody. Not lost: invisible.
 *
 * With one company in the database this adopts everything into it without
 * being told which. With more than one it refuses and asks, because guessing
 * would hand one firm's books to another, which is the one mistake here that
 * cannot be undone from the outside.
 *
 * A JSON backup of every row it is about to touch is written first.
 */

import mongoose from "mongoose";
import { loadEnv, flags, writeBackup, confirmYes, pad, padL } from "./_shared.mjs";

const COLLECTIONS = [
  "customers",
  "items",
  "invoices",
  "ledgers",
  "itemledgers",
  "vouchers",
  "hsns",
  "pricelists",
  "customergroups",
  "states",
  "counters",
];

loadEnv();

const { apply, yes } = flags();
const idFlag = process.argv.indexOf("--company");
const wanted = idFlag > -1 ? process.argv[idFlag + 1] : null;

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
console.log(`host     : ${mongoose.connection.host}\n`);

const companies = await db.collection("companies").find({}).toArray();

if (companies.length === 0) {
  console.error("No companies yet. Sign up at /signup first, then re-run this.\n");
  await mongoose.disconnect();
  process.exit(1);
}

let company;
if (wanted) {
  if (!mongoose.Types.ObjectId.isValid(wanted)) {
    console.error(`"${wanted}" is not a valid company id.\n`);
    await mongoose.disconnect();
    process.exit(1);
  }
  company = companies.find((c) => String(c._id) === String(wanted));
  if (!company) {
    console.error(`No company with id ${wanted}.\n`);
    await mongoose.disconnect();
    process.exit(1);
  }
} else if (companies.length === 1) {
  company = companies[0];
} else {
  // Refusing beats guessing: picking the wrong one here hands one firm's
  // ledger to another, and nothing in the app would flag it.
  console.error("More than one company exists. Say which one to adopt the existing rows into:\n");
  for (const c of companies) console.error(`  --company ${c._id}   ${c.name}`);
  console.error("");
  await mongoose.disconnect();
  process.exit(1);
}

console.log(`adopting into: ${company.name}  (${company._id})\n`);

const present = (await db.listCollections().toArray()).map((c) => c.name);
const width = Math.max(...COLLECTIONS.map((n) => n.length), 12);

console.log(pad("collection", width), padL("orphans", 9), padL("already", 9));
console.log("-".repeat(width + 22));

const orphanFilter = { $or: [{ companyId: { $exists: false } }, { companyId: null }] };
const counts = {};
let total = 0;
for (const name of COLLECTIONS) {
  if (!present.includes(name)) { counts[name] = 0; continue; }
  const orphans = await db.collection(name).countDocuments(orphanFilter);
  const owned = await db.collection(name).countDocuments({ companyId: { $exists: true, $ne: null } });
  counts[name] = orphans;
  total += orphans;
  console.log(pad(name, width), padL(orphans, 9), padL(owned, 9));
}

if (total === 0) {
  console.log("\nNothing to adopt — every row already belongs to a firm.\n");
  await mongoose.disconnect();
  process.exit(0);
}

if (!apply) {
  console.log(`\nDry run. ${total} row(s) would be adopted into ${company.name}.`);
  console.log("Re-run with --apply to do it.\n");
  await mongoose.disconnect();
  process.exit(0);
}

const ok = await confirmYes(
  `\nAdopt ${total} row(s) into "${company.name}"? Type "yes": `,
  yes
);
if (!ok) {
  console.log("Aborted.\n");
  await mongoose.disconnect();
  process.exit(0);
}

// Back up what is about to change, so a wrong --company is recoverable.
const snapshot = {};
for (const name of COLLECTIONS) {
  if (!counts[name]) continue;
  snapshot[name] = await db.collection(name).find(orphanFilter).toArray();
}
const backup = writeBackup("adopt-tenant", {
  database: db.databaseName,
  company: { id: String(company._id), name: company.name },
  collections: snapshot,
});
console.log(`\nbackup written: ${backup}`);

for (const name of COLLECTIONS) {
  if (!counts[name]) continue;
  const { modifiedCount } = await db
    .collection(name)
    .updateMany(orphanFilter, { $set: { companyId: company._id } });
  console.log(`  adopted ${pad(name, width)} ${padL(modifiedCount, 9)}`);
}

// The old global unique indexes would stop a second firm reusing an invoice
// number, an HSN code or a state code. They are replaced by compound ones in
// the models, but Mongo keeps the originals until they are dropped.
console.log("\nStale global indexes to drop (the models now build per-firm ones):");
for (const [name, index] of [
  ["invoices", "invoiceNo_1"],
  ["hsns", "hsncode_1"],
  ["customergroups", "name_1"],
  ["states", "name_1"],
  ["states", "code_1"],
  ["counters", "name_1"],
]) {
  if (!present.includes(name)) continue;
  try {
    await db.collection(name).dropIndex(index);
    console.log(`  dropped ${pad(name + "." + index, width + 10)}`);
  } catch (err) {
    if (err?.codeName === "IndexNotFound") console.log(`  absent  ${name}.${index}`);
    else console.log(`  FAILED  ${name}.${index}: ${err.message}`);
  }
}

console.log("\nDone. Restart the app so the models rebuild their indexes.\n");
await mongoose.disconnect();
