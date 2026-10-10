/**
 * Retire the index that stops two firms using the same invoice number.
 *
 *   node scripts/sync-indexes.mjs            # report only, changes nothing
 *   node scripts/sync-indexes.mjs --apply    # drop them
 *
 * THE PROBLEM
 *
 * Every unique index on a tenant collection is declared per firm in the
 * schemas -- `{ companyId: 1, invoiceNo: 1 }`. They did not start that way.
 * And **MongoDB does not drop an index because a schema stopped declaring
 * it**: Mongoose's autoIndex creates what is missing and never retires what is
 * obsolete. So the old global `invoiceNo_1` is still there, still unique
 * across every firm, and the second firm to open cannot write invoice 1. Same
 * for a state's name and code, an HSN code, a customer group, the counter.
 *
 * What the user sees is a duplicate-key error about a value they have never
 * used, because somebody in another firm used it.
 *
 * WHAT THIS DOES
 *
 * Drops exactly the unique indexes on tenant collections that are not led by
 * companyId. It does not create anything: Mongoose's autoIndex already builds
 * the per-firm ones when the app boots.
 *
 * Before dropping, it checks each collection for rows that would collide
 * WITHIN one firm. That matters -- if two invoices in the same firm already
 * share a number, the per-firm index cannot build, autoIndex fails quietly at
 * startup, and the collection ends up with no protection at all. Those are
 * reported and the drop is refused unless you pass --force.
 *
 * Index definitions are backed up to /backups first, so a drop can be undone.
 */

import mongoose from "mongoose";
import { loadEnv, flags, writeBackup, confirmYes, pad } from "./_shared.mjs";
import { MASTER_COLLECTIONS, TRANSACTION_COLLECTIONS } from "../lib/clearData.mjs";
import {
  auditIndexes,
  describeIndex,
  keySignature,
  missingTenantUniques,
  protectedFields,
} from "../lib/indexAudit.mjs";

/**
 * The models, imported only to read what their schemas DECLARE. Nothing here
 * queries through them -- the raw driver does that, so no tenant context is
 * needed -- but `schema.indexes()` is the only honest source for which
 * per-firm unique indexes are supposed to exist.
 */
const MODELS = Object.fromEntries(
  await Promise.all(
    [
      ["customers", "custModel"],
      ["items", "itemModel"],
      ["hsns", "hsnModel"],
      ["pricelists", "priceListModel"],
      ["customergroups", "customerGroupModel"],
      ["states", "stateModel"],
      ["invoices", "invoiceModel"],
      ["orders", "orderModel"],
      ["vouchers", "voucherModel"],
      ["ledgers", "ledgerModel"],
      ["itemledgers", "itemLedgerModel"],
      ["counters", "counterModel"],
    ].map(async ([collection, file]) => [
      collection,
      (await import(`../models/${file}.js`)).default,
    ])
  )
);

/**
 * The tenant collections, from the one list the app already keeps. Deriving
 * them rather than retyping means a collection added later is covered.
 *
 * `users` and `companies` are deliberately absent: a user's email is unique
 * GLOBALLY and must stay that way, because signing in happens before anyone
 * belongs to a firm.
 */
const COLLECTIONS = [...MASTER_COLLECTIONS, ...TRANSACTION_COLLECTIONS];

const { apply, yes } = flags();
const force = process.argv.includes("--force");

loadEnv();
if (!process.env.MONGO_URI) {
  console.error("MONGO_URI is not set (looked in env, .env.local, .env).");
  process.exit(1);
}

await mongoose.connect(process.env.MONGO_URI);
const db = mongoose.connection.db;
console.log(`\ndatabase : ${mongoose.connection.name}`);
console.log(`host     : ${mongoose.connection.host}`);
console.log(`mode     : ${apply ? "APPLY -- indexes will be dropped" : "report only"}\n`);

const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));

const plan = [];
const collisions = [];
const missing = [];
const backup = {};

for (const name of COLLECTIONS) {
  if (!existing.has(name)) {
    console.log(`${pad(name, 16)} (not created yet)`);
    continue;
  }

  const collection = db.collection(name);
  const indexes = await collection.indexes();
  backup[name] = indexes;

  const { drop } = auditIndexes(indexes);

  // The other half of the job: is the per-firm replacement actually there?
  // Without it the collection protects nothing at all.
  const declared = MODELS[name]?.schema?.indexes?.() || [];
  const absent = missingTenantUniques(declared, indexes);
  for (const key of absent) missing.push({ collection: name, key });

  if (drop.length === 0 && absent.length === 0) {
    console.log(`${pad(name, 16)} ok -- ${indexes.length} index(es), none global-unique`);
    continue;
  }

  if (drop.length === 0) {
    console.log(`${pad(name, 16)} ${indexes.length} index(es), none global-unique`);
  } else {
    console.log(`${pad(name, 16)} ${drop.length} to drop:`);
  }

  for (const key of absent) {
    console.log(`                   MISSING per-firm unique { ${keySignature(key)} }`);
  }

  for (const index of drop) {
    console.log(`                   ${describeIndex(index)}`);
    plan.push({ collection: name, index });

    // Would the per-firm index be able to build once this is gone?
    const fields = protectedFields(index);
    if (fields.length === 0) continue;

    const groupId = { companyId: "$companyId" };
    for (const f of fields) groupId[f] = `$${f}`;

    const dupes = await collection
      .aggregate([
        { $group: { _id: groupId, n: { $sum: 1 } } },
        { $match: { n: { $gt: 1 } } },
        { $limit: 5 },
      ])
      .toArray();

    if (dupes.length) {
      collisions.push({ collection: name, fields, dupes });
      console.log(
        `                   ^ WARNING: ${dupes.length}+ duplicate(s) of ${fields.join(" + ")} within one firm`
      );
    }
  }
}

console.log("");

const reportMissing = () => {
  if (missing.length === 0) return;
  console.log("PER-FIRM UNIQUE INDEXES THAT DO NOT EXIST\n");
  console.log("Until these are built the collection has NO uniqueness protection:");
  console.log("two rows in one firm can take the same value.\n");
  for (const m of missing) {
    console.log(`  ${m.collection}  { ${keySignature(m.key)} }`);
  }
  console.log("");
  console.log("Mongoose's autoIndex builds them when the app next uses that model, so");
  console.log("start the app and open a page that touches each one, then re-run this.");
  console.log("If they still do not appear, autoIndex is off or the build is failing --");
  console.log("check the server log at startup.\n");
};

if (plan.length === 0) {
  if (missing.length === 0) {
    console.log("Nothing to do. Every unique index is scoped per firm, and present.\n");
    await mongoose.disconnect();
    process.exit(0);
  }
  reportMissing();
  await mongoose.disconnect();
  process.exit(1);
}

if (collisions.length) {
  console.log("DUPLICATES WITHIN A FIRM\n");
  console.log("These have to be sorted out first. Dropping the global index while");
  console.log("they exist means the per-firm index cannot build, autoIndex fails");
  console.log("quietly on the next boot, and nothing is protected at all.\n");
  for (const c of collisions) {
    console.log(`  ${c.collection} -- duplicate ${c.fields.join(" + ")}:`);
    for (const d of c.dupes) {
      const vals = c.fields.map((f) => `${f}=${d._id[f]}`).join(", ");
      console.log(`     firm ${d._id.companyId}  ${vals}  (${d.n} rows)`);
    }
  }
  console.log("");
  if (!force) {
    console.log("Refusing to drop anything. Fix the duplicates, or pass --force if you");
    console.log("have decided to go ahead without the per-firm index.\n");
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log("--force given: going ahead anyway.\n");
}

if (!apply) {
  console.log(`${plan.length} index(es) would be dropped. Re-run with --apply to do it.\n`);
  await mongoose.disconnect();
  process.exit(0);
}

const backupPath = writeBackup("index-definitions", {
  database: mongoose.connection.name,
  indexes: backup,
});
console.log(`Index definitions backed up to ${backupPath}`);

const ok = await confirmYes(
  `\nDrop ${plan.length} index(es) from ${mongoose.connection.name}? Type yes to confirm: `,
  yes
);
if (!ok) {
  console.log("Nothing was dropped.\n");
  await mongoose.disconnect();
  process.exit(0);
}

let dropped = 0;
for (const { collection, index } of plan) {
  try {
    await db.collection(collection).dropIndex(index.name);
    console.log(`  dropped  ${collection}.${index.name}`);
    dropped += 1;
  } catch (err) {
    console.error(`  FAILED   ${collection}.${index.name} -- ${err.message}`);
  }
}

console.log(`\n${dropped} of ${plan.length} dropped.\n`);
reportMissing();
console.log("Now start the app and open a page that touches each collection, so");
console.log("Mongoose builds the per-firm indexes. Then re-run this script: it has to");
console.log("say \"scoped per firm, and present\" before you trust the uniqueness.\n");

await mongoose.disconnect();
