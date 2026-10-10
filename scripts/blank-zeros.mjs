/**
 * Clear master-data figures that were saved as 0 because the form defaulted
 * to 0, not because anyone typed one.
 *
 * WHY
 * ---
 * The item and customer forms started every numeric box at 0, and coerced an
 * empty box back to 0 on each keystroke (`parseFloat(v) || 0`). A price or a
 * discount nobody filled in therefore went into the database as a real zero,
 * and reopening the record showed "0" instead of an empty field.
 *
 * The forms keep a blank blank now. This clears what they already wrote, by
 * UNSETTING the field. An absent field and a stored 0 read identically through
 * `Number(x) || 0`, so no calculation changes -- only what the form shows.
 *
 * Quantities and balances are deliberately NOT touched: an opening stock of 0
 * is a real statement, and the balance fields are system-owned.
 *
 * USAGE
 *   node scripts/blank-zeros.mjs                 # dry run
 *   node scripts/blank-zeros.mjs --apply         # write (backs up first)
 *   node scripts/blank-zeros.mjs --apply --yes
 */

import mongoose from "mongoose";
import { loadEnv, flags, writeBackup, confirmYes, pad } from "./_shared.mjs";
import {
  CUSTOMER_FIELDS,
  ITEM_FIELDS,
  planBlanking,
  unsetFor,
} from "../lib/blankZeros.mjs";

const { apply: APPLY, yes: ASSUME_YES } = flags();

const items = mongoose.model(
  "Item",
  new mongoose.Schema({}, { strict: false, collection: "items" })
);
const customers = mongoose.model(
  "Customer",
  new mongoose.Schema({}, { strict: false, collection: "customers" })
);

/* --------------------------------------------------------------- report --- */

function report(label, plan, total, fields) {
  console.log(`\n${label}: scanned ${total}, ${plan.length} with zeros to clear.`);
  if (!plan.length) return;

  console.log(`\n  ${pad("RECORD", 34)} FIELDS CLEARED`);
  console.log(`  ${"-".repeat(34)} ${"-".repeat(40)}`);
  for (const row of plan) {
    console.log(`  ${pad(row.name ?? "—", 34)} ${row.fields.join(", ")}`);
  }

  const counts = {};
  for (const row of plan) for (const f of row.fields) counts[f] = (counts[f] || 0) + 1;
  console.log(
    `\n  by field: ${fields
      .filter((f) => counts[f])
      .map((f) => `${f} ${counts[f]}`)
      .join(", ")}`
  );
}

/* ---------------------------------------------------------------- write --- */

async function write(itemPlan, customerPlan) {
  const file = writeBackup("blank-zeros", {
    note:
      "These fields held 0 before blank-zeros.mjs unset them. Restore by " +
      "setting each listed field back to 0 on the matching _id.",
    items: itemPlan,
    customers: customerPlan,
  });
  console.log(`\n💾 Backup written to ${file}`);

  const ok = await confirmYes(
    `\nClear zeros on ${itemPlan.length} item(s) and ${customerPlan.length} ` +
      `customer(s)? Type "yes": `,
    ASSUME_YES
  );
  if (!ok) {
    console.log("Aborted. Nothing was written.\n");
    return;
  }

  let itemCount = 0;
  for (const entry of itemPlan) {
    const res = await items.updateOne(
      { _id: new mongoose.Types.ObjectId(entry._id) },
      { $unset: unsetFor(entry) }
    );
    itemCount += res.modifiedCount || 0;
  }

  let custCount = 0;
  for (const entry of customerPlan) {
    const res = await customers.updateOne(
      { _id: new mongoose.Types.ObjectId(entry._id) },
      { $unset: unsetFor(entry) }
    );
    custCount += res.modifiedCount || 0;
  }

  console.log(`\n✅ Cleared ${itemCount} item(s) and ${custCount} customer(s).\n`);
}

/* ----------------------------------------------------------------- main --- */

async function main() {
  loadEnv();
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set (looked in env, .env.local, .env).");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);

  try {
    const [allItems, allCustomers] = await Promise.all([
      items.find({}, { name: 1, ...Object.fromEntries(ITEM_FIELDS.map((f) => [f, 1])) }).lean(),
      customers.find({}, { name: 1, ...Object.fromEntries(CUSTOMER_FIELDS.map((f) => [f, 1])) }).lean(),
    ]);

    const itemPlan = planBlanking(allItems, ITEM_FIELDS);
    const customerPlan = planBlanking(allCustomers, CUSTOMER_FIELDS);

    report("Items", itemPlan, allItems.length, ITEM_FIELDS);
    report("Customers", customerPlan, allCustomers.length, CUSTOMER_FIELDS);

    if (!itemPlan.length && !customerPlan.length) {
      console.log("\nNothing to clear.\n");
      return;
    }

    if (!APPLY) {
      console.log("\nDry run. Re-run with --apply to write these changes.\n");
      return;
    }

    await write(itemPlan, customerPlan);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
