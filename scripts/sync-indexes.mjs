/**
 * Bring each tenant collection's UNIQUE indexes in line with its schema.
 *
 *   node scripts/sync-indexes.mjs            # report only -- reads, changes nothing
 *   node scripts/sync-indexes.mjs --apply    # build the missing, then drop the stale
 *   node scripts/sync-indexes.mjs --apply --yes   # without the typed confirmation
 *
 * THE PROBLEM
 *
 * Every unique index on a tenant collection is declared per firm in the
 * schemas -- `{ companyId: 1, invoiceNo: 1 }`. They did not start that way,
 * and **MongoDB does not drop an index because a schema stopped declaring
 * it**. Two generations of stale index survive:
 *
 *   global      `invoiceNo_1`, unique across every firm: the second firm to
 *               open cannot write invoice 1
 *   per-firm    `companyId_1_docNo_1` on stock vouchers, replaced by
 *               (companyId, kind, docNo): while it survives, Goods Issue 5 and
 *               Production 5 cannot both exist in one firm
 *
 * WHAT THIS DOES, IN THIS ORDER
 *
 *   1. Reads every tenant collection's indexes and backs the definitions up
 *      (on --apply, before anything changes).
 *   2. For every unique index the schema declares but the database lacks,
 *      checks the data for rows the index would refuse -- duplicates within
 *      one firm, in the index's own scope (partial filters honoured). Any
 *      duplicate anywhere stops the run: nothing is built, nothing dropped.
 *      Nothing is ever deleted to make an index fit; the report names the
 *      rows by _id and the fix is a human decision.
 *   3. Builds the missing declared indexes, by name, and re-reads the index
 *      list to confirm they exist.
 *   4. Drops a stale unique index ONLY when its replacement -- a declared,
 *      per-firm unique index covering every field the stale one protected --
 *      is confirmed present. A stale index with no replacement is reported
 *      and left in place.
 *
 * It never relies on the app's autoIndex. Mongoose's autoIndex and autoCreate
 * are switched off for this connection (scripts/_shared.mjs), so the report
 * run cannot build an index by merely importing a model.
 *
 * ROLLBACK: the backup JSON holds every index definition as it was. To undo a
 * drop, `db.<collection>.createIndex(<key>, <options>)` from the backup; to
 * undo a build, `db.<collection>.dropIndex("<name>")`. See
 * MIGRATIONS.md.
 */

import mongoose from "mongoose";
import {
  connectMaintenance,
  confirmYes,
  flags,
  loadEnv,
  pad,
  quietMongoose,
  writeBackup,
} from "./_shared.mjs";
import { MASTER_COLLECTIONS, TRANSACTION_COLLECTIONS } from "../lib/clearData.mjs";
import {
  buildOptions,
  describeIndex,
  duplicatePipeline,
  indexConflicts,
  keySignature,
  missingTenantUniques,
  replacementFor,
  staleUniques,
} from "../lib/indexAudit.mjs";

// Before any model is compiled: importing one must not build anything.
quietMongoose(mongoose);

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
      // The document series: unique per firm AND per scope, so the audit has
      // to read the declaration rather than assume (companyId, code).
      ["series", "seriesModel"],
      ["invoices", "invoiceModel"],
      ["orders", "orderModel"],
      ["vouchers", "voucherModel"],
      ["ledgers", "ledgerModel"],
      ["itemledgers", "itemLedgerModel"],
      ["counters", "counterModel"],
      // Bills of material and the production entries made from them. Listed
      // here as well as in clearData's lists because COLLECTIONS below is
      // derived from those, and a collection present there but absent here
      // gets audited for obsolete indexes while nothing checks that its
      // per-firm replacements exist.
      ["boms", "bomModel"],
      ["productions", "productionModel"],
      // Sales and purchase challans: one number per kind per firm.
      ["challans", "challanModel"],
      // The persistent low-stock alerts, whose "one open alert per item"
      // partial unique index is declared on the schema.
      ["stockalerts", "stockAlertModel"],
      // Staff accounts: one per email PER FIRM, case-insensitively.
      ["users", "userModel"],
    ].map(async ([collection, file]) => [
      collection,
      (await import(`../models/${file}.js`)).default,
    ])
  )
);

/**
 * The tenant collections, from the one list the app already keeps (deriving
 * them means a collection added later is covered), plus `users`: its email
 * is unique per firm and case-insensitive (models/userModel.js), so a
 * surviving global `email_1` would stop one person working for two firms.
 *
 * `companies` is absent: it is the tenant list itself, with no companyId,
 * and is deliberately not unique on name.
 */
const COLLECTIONS = [...MASTER_COLLECTIONS, ...TRANSACTION_COLLECTIONS, "users"];

const { apply, yes } = flags();

loadEnv();
if (!process.env.MONGO_URI) {
  console.error("MONGO_URI is not set (looked in env, .env.local, .env).");
  process.exit(1);
}

await connectMaintenance(mongoose, process.env.MONGO_URI);
const db = mongoose.connection.db;
console.log(`\ndatabase : ${mongoose.connection.name}`);
console.log(`host     : ${mongoose.connection.host}`);
console.log(`mode     : ${apply ? "APPLY -- indexes will be built and dropped" : "report only -- nothing is changed"}\n`);

const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));

const backup = {};
const toBuild = []; // { collection, key, options }
const stale = []; // { collection, index }
const duplicates = []; // { collection, key, groups }
const conflicts = []; // { collection, key, index } -- same key, different options
const orphans = []; // { collection, count } -- rows with no companyId

for (const name of COLLECTIONS) {
  if (!existing.has(name)) {
    console.log(`${pad(name, 16)} (not created yet)`);
    continue;
  }

  const collection = db.collection(name);
  const indexes = await collection.indexes();
  backup[name] = indexes;

  const model = MODELS[name];
  const declared = model?.schema?.indexes?.() || [];
  const declaredByKey = new Map(declared.map(([key, options]) => [keySignature(key), options]));

  const absent = missingTenantUniques(declared, indexes);
  const old = staleUniques(indexes, declared, { hasModel: Boolean(model) });
  const clash = indexConflicts(declared, indexes);
  for (const c of clash) conflicts.push({ collection: name, ...c });

  // A row with no firm on it is invisible to the app (the tenant plugin
  // scopes every query) and, to a per-firm index, belongs to firm `null`.
  const noFirm = await collection.countDocuments({
    $or: [{ companyId: { $exists: false } }, { companyId: null }],
  });
  if (noFirm) orphans.push({ collection: name, count: noFirm });

  if (!absent.length && !old.length && !clash.length) {
    console.log(`${pad(name, 16)} ok -- ${indexes.length} index(es), unique ones all declared and present`);
    continue;
  }
  console.log(`${pad(name, 16)} ${indexes.length} index(es)`);

  for (const c of clash) {
    console.log(`                   CONFLICT ${describeIndex(c.index)} -- declared with other options`);
  }

  for (const key of absent) {
    const options = declaredByKey.get(keySignature(key)) || { unique: true };
    console.log(`                   MISSING  { ${keySignature(key)} }  [unique${options.partialFilterExpression ? ", partial" : ""}]`);
    toBuild.push({ collection: name, key, options });

    // Would it build? Same scope as the index itself.
    const groups = await collection
      .aggregate(duplicatePipeline(key, options), { allowDiskUse: true })
      .toArray();
    if (groups.length) {
      duplicates.push({ collection: name, key, groups });
      console.log(`                   ^ ${groups.length}${groups.length >= 20 ? "+" : ""} duplicate group(s) -- it cannot build`);
    }
  }

  for (const index of old) {
    console.log(`                   STALE    ${describeIndex(index)}`);
    stale.push({ collection: name, index, declared });
  }
}

console.log("");

if (orphans.length) {
  console.log("ROWS WITH NO FIRM (companyId missing)\n");
  console.log("Invisible to the app, and grouped together as firm `null` by every");
  console.log("per-firm index. Assign them to their firm (scripts/adopt-tenant.mjs)");
  console.log("before relying on the per-firm indexes:\n");
  for (const o of orphans) console.log(`  ${pad(o.collection, 16)} ${o.count} row(s)`);
  console.log("");
}

if (duplicates.length) {
  console.log("DUPLICATES THAT WOULD STOP A PER-FIRM UNIQUE INDEX FROM BUILDING\n");
  console.log("Nothing will be built or dropped until these are resolved. Nothing is");
  console.log("deleted automatically: decide, per group, which row is the real one,");
  console.log("then renumber or rename the others through the app.\n");
  for (const d of duplicates) {
    console.log(`  ${d.collection}  { ${keySignature(d.key)} }`);
    for (const g of d.groups) {
      const vals = Object.entries(g._id)
        .map(([k, v]) => `${k}=${v === null || v === undefined ? "(missing)" : v}`)
        .join(", ");
      console.log(`     ${vals}  -- ${g.n} rows, _id ${g.ids.map(String).join(", ")}${g.n > g.ids.length ? ", ..." : ""}`);
    }
  }
  console.log("");
}

if (conflicts.length) {
  console.log("INDEXES WITH THE DECLARED KEY BUT DIFFERENT OPTIONS\n");
  console.log("The declared index cannot be built while one of these holds its key,");
  console.log("and neither can be trusted as the replacement. Compare each with the");
  console.log("schema and drop the wrong one by hand, then re-run:\n");
  for (const c of conflicts) {
    console.log(`  ${c.collection}  ${describeIndex(c.index)}`);
    console.log(`               declared: { ${keySignature(c.key)} } ${JSON.stringify(buildOptions(c.options))}`);
  }
  console.log("");
}

// What a run would drop: a stale index whose replacement is present now, or
// is in this run's build list.
const willExist = (collection, indexes) => [
  ...indexes,
  ...toBuild.filter((b) => b.collection === collection).map((b) => ({ key: b.key })),
];
const unreplaced = stale.filter(
  (s) => !replacementFor(s.index, s.declared, willExist(s.collection, backup[s.collection]))
);
if (unreplaced.length) {
  console.log("STALE UNIQUE INDEXES WITH NO DECLARED REPLACEMENT -- left in place\n");
  console.log("No per-firm unique index in the schema covers what these protect.");
  console.log("Dropping one would remove protection outright, so that is a decision");
  console.log("for a person, made by hand:\n");
  for (const s of unreplaced) console.log(`  ${s.collection}  ${describeIndex(s.index)}`);
  console.log("");
}

const droppable = stale.filter((s) => !unreplaced.includes(s));

if (!toBuild.length && !droppable.length && !conflicts.length) {
  console.log(
    unreplaced.length
      ? "Nothing this script will change. See the stale indexes above.\n"
      : "Nothing to do. Every unique index is declared, per firm, and present.\n"
  );
  await mongoose.disconnect();
  process.exit(unreplaced.length || orphans.length ? 1 : 0);
}

console.log(`Plan: build ${toBuild.length}, then drop ${droppable.length} (each only after its replacement is confirmed).`);
for (const b of toBuild) console.log(`  build  ${b.collection}  { ${keySignature(b.key)} }`);
for (const s of droppable) console.log(`  drop   ${s.collection}  ${s.index.name}`);
console.log("");

if (duplicates.length || conflicts.length) {
  console.log("BLOCKED by the duplicates or conflicts above. Re-run once they are resolved.\n");
  await mongoose.disconnect();
  process.exit(1);
}

if (!apply) {
  console.log("Report only. Re-run with --apply to do it (after a database backup).\n");
  await mongoose.disconnect();
  process.exit(0);
}

const backupPath = writeBackup("index-definitions", {
  database: mongoose.connection.name,
  indexes: backup,
  plan: {
    build: toBuild.map((b) => ({ collection: b.collection, key: b.key, options: buildOptions(b.options) })),
    drop: droppable.map((s) => ({ collection: s.collection, name: s.index.name, key: s.index.key })),
  },
});
console.log(`Index definitions backed up to ${backupPath}`);

const ok = await confirmYes(
  `\nBuild ${toBuild.length} and drop up to ${droppable.length} index(es) on ${mongoose.connection.name}? Type yes to confirm: `,
  yes
);
if (!ok) {
  console.log("Nothing was changed.\n");
  await mongoose.disconnect();
  process.exit(0);
}

// 1. Build. A failure here (a duplicate written since the check) stops the
//    run before anything is dropped.
for (const b of toBuild) {
  try {
    const name = await db.collection(b.collection).createIndex(b.key, buildOptions(b.options));
    console.log(`  built    ${b.collection}.${name}`);
  } catch (err) {
    console.error(`  FAILED   building ${b.collection} { ${keySignature(b.key)} } -- ${err.message}`);
    console.error("\nStopped. Nothing has been dropped. Resolve the cause and re-run.\n");
    await mongoose.disconnect();
    process.exit(1);
  }
}

// 2. Drop, each only once its replacement is confirmed in the live list.
let dropped = 0;
for (const s of droppable) {
  const now = await db.collection(s.collection).indexes();
  if (!replacementFor(s.index, s.declared, now)) {
    console.error(`  KEPT     ${s.collection}.${s.index.name} -- its replacement is not present`);
    continue;
  }
  try {
    await db.collection(s.collection).dropIndex(s.index.name);
    console.log(`  dropped  ${s.collection}.${s.index.name}`);
    dropped += 1;
  } catch (err) {
    console.error(`  FAILED   ${s.collection}.${s.index.name} -- ${err.message}`);
  }
}

console.log(`\nBuilt ${toBuild.length}; dropped ${dropped} of ${droppable.length}.`);
console.log("Re-run without --apply: it must report every collection ok before the");
console.log("per-firm uniqueness is trusted.\n");

await mongoose.disconnect();
