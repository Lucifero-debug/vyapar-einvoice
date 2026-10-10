/**
 * Blank out item units that were saved as "0".
 *
 * WHY
 * ---
 * The item master initialised its Unit field to the number 0, so any item
 * saved without the user typing a unit went into the database with unit "0".
 * The form now starts the field empty, but the old rows remain -- and the
 * price list master seeds each row's unit from the item, so those "0"s were
 * copied into price lists as well.
 *
 * This script sets `unit` to "" wherever it is "0" (or a stored number 0):
 *   - on items, and
 *   - on the rows inside price lists.
 *
 * A "0" unit is never meaningful, so nothing real is lost. Every other field
 * is left alone.
 *
 * USAGE
 * -----
 *   node scripts/clear-zero-units.mjs                 # dry run
 *   node scripts/clear-zero-units.mjs --apply         # write (backs up first)
 *   node scripts/clear-zero-units.mjs --apply --yes
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";

import { loadEnv, flags, writeBackup, confirmYes, pad } from "./_shared.mjs";

const { apply: APPLY, yes: ASSUME_YES } = flags();

/* --------------------------------------------------------------- models --- */

const items = mongoose.model(
  "Item",
  new mongoose.Schema({}, { strict: false, collection: "items" })
);
const priceLists = mongoose.model(
  "PriceList",
  new mongoose.Schema({}, { strict: false, collection: "pricelists" })
);

/* ----------------------------------------------------------------- plan --- */

/** "0", " 0 " or the number 0 -- what the old form default left behind. */
export const isZeroUnit = (unit) =>
  unit !== null && unit !== undefined && String(unit).trim() === "0";

/**
 * Plan the cleanup. Pure, so it can be exercised against fixtures without a
 * database -- see scripts/clear-zero-units.test.mjs.
 */
export function planCleanup({ allItems = [], allPriceLists = [] } = {}) {
  const itemPlan = allItems
    .filter((item) => isZeroUnit(item.unit))
    .map((item) => ({ _id: String(item._id), name: item.name, unit: item.unit }));

  const priceListPlan = [];
  for (const list of allPriceLists) {
    const rows = list.items || [];
    const hits = rows
      .map((row, index) => ({ index, name: row.name, unit: row.unit }))
      .filter((r) => isZeroUnit(r.unit));
    if (!hits.length) continue;
    priceListPlan.push({
      _id: String(list._id),
      party: list.partyName || list.party,
      date: list.date,
      rows: hits,
    });
  }

  return { itemPlan, priceListPlan };
}

/* --------------------------------------------------------------- report --- */

function report({ itemPlan, priceListPlan }, counts) {
  console.log(`\nItems: ${counts.items}, price lists: ${counts.priceLists}`);

  if (!itemPlan.length && !priceListPlan.length) {
    console.log('\n✅ No unit is stored as "0". Nothing to do.\n');
    return;
  }

  if (itemPlan.length) {
    console.log(`\n${itemPlan.length} item(s) with unit "0" would be blanked:\n`);
    for (const i of itemPlan) console.log(`    ${pad(i.name ?? "—", 40)} ${i._id}`);
  }

  if (priceListPlan.length) {
    const rows = priceListPlan.reduce((n, p) => n + p.rows.length, 0);
    console.log(
      `\n${rows} price list row(s) across ${priceListPlan.length} list(s) would be blanked:\n`
    );
    for (const p of priceListPlan) {
      const when = p.date ? new Date(p.date).toISOString().slice(0, 10) : "—";
      console.log(`  ${p.party ?? "—"} — list of ${when} (${p._id})`);
      for (const r of p.rows) console.log(`    row ${r.index + 1}: ${r.name ?? "—"}`);
    }
  }
}

/* ---------------------------------------------------------------- write --- */

async function write({ itemPlan, priceListPlan }) {
  const file = writeBackup("zero-units", {
    note:
      'unit was "0" on these records before clear-zero-units.mjs set it to "". ' +
      "Restore by setting unit back on the matching _id (and row index).",
    items: itemPlan,
    priceLists: priceListPlan,
  });
  console.log(`\n💾 Backup written to ${file}`);

  const ok = await confirmYes(
    `\nBlank the unit on ${itemPlan.length} item(s) and ` +
      `${priceListPlan.length} price list(s)? Type "yes": `,
    ASSUME_YES
  );
  if (!ok) {
    console.log("Aborted. Nothing was written.\n");
    return;
  }

  let itemCount = 0;
  for (const i of itemPlan) {
    const res = await items.updateOne(
      { _id: new mongoose.Types.ObjectId(i._id) },
      { $set: { unit: "" } }
    );
    itemCount += res.modifiedCount || 0;
  }

  let rowCount = 0;
  for (const p of priceListPlan) {
    const $set = {};
    for (const r of p.rows) $set[`items.${r.index}.unit`] = "";
    const res = await priceLists.updateOne(
      { _id: new mongoose.Types.ObjectId(p._id) },
      { $set }
    );
    if (res.modifiedCount) rowCount += p.rows.length;
  }

  console.log(
    `\n✅ Blanked the unit on ${itemCount} item(s) and ${rowCount} price list row(s).\n`
  );
}

/* ----------------------------------------------------------------- main --- */

async function main() {
  loadEnv();
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set (looked in env, .env.local, .env).");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected to ${mongoose.connection.name}`);
  console.log(APPLY ? "Mode: APPLY" : "Mode: DRY RUN (pass --apply to write)");

  try {
    const allItems = await items.find({}, { name: 1, unit: 1 }).lean();
    const allPriceLists = await priceLists.find({}).lean();
    const plan = planCleanup({ allItems, allPriceLists });
    report(plan, { items: allItems.length, priceLists: allPriceLists.length });

    const any = plan.itemPlan.length || plan.priceListPlan.length;
    if (APPLY && any) await write(plan);
    else if (!APPLY && any)
      console.log("\nDry run only — nothing written. Re-run with --apply.\n");
  } finally {
    await mongoose.disconnect();
  }
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    console.error("\nCleanup failed:", err);
    process.exit(1);
  });
}
