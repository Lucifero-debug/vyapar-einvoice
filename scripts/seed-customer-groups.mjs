/**
 * Fill the customer group master from the groups already in use.
 *
 * WHY
 * ---
 * `customers.group` was free text, so the groups that exist are whatever has
 * been typed into that box over time. The Group field picks from a master now;
 * without this, every existing party would be sitting in a group that is not
 * on the list, and opening one to edit would offer to move them out of it.
 *
 * This reads every distinct group in use and creates a master record for each,
 * plus Cash and Bank, which the app itself depends on: an invoice settles what
 * was paid at the counter into the account it finds by those group names
 * (lib/cashAccount.mjs). Nothing is renamed and no customer is touched.
 *
 * USAGE
 *   node scripts/seed-customer-groups.mjs                 # dry run
 *   node scripts/seed-customer-groups.mjs --apply         # write
 *   node scripts/seed-customer-groups.mjs --apply --yes
 */

import mongoose from "mongoose";
import { loadEnv, flags, writeBackup, confirmYes, pad } from "./_shared.mjs";
import { planSeed } from "../lib/customerGroups.mjs";

const { apply: APPLY, yes: ASSUME_YES } = flags();

const customers = mongoose.model(
  "Customer",
  new mongoose.Schema({}, { strict: false, collection: "customers" })
);
const groups = mongoose.model(
  "CustomerGroup",
  new mongoose.Schema({}, { strict: false, collection: "customergroups" })
);

/* --------------------------------------------------------------- report --- */

function report(plan, distinctCount, existingCount) {
  console.log(
    `\n${distinctCount} distinct group(s) in use; master holds ${existingCount}.`
  );

  if (!plan.length) {
    console.log("The master already covers every group in use. Nothing to do.\n");
    return;
  }

  console.log(`\n${plan.length} group(s) would be created:\n`);
  console.log(`  ${pad("GROUP", 34)} SOURCE`);
  console.log(`  ${"-".repeat(34)} ${"-".repeat(28)}`);
  for (const g of plan) {
    console.log(`  ${pad(g.name, 34)} ${g.reserved ? "required by invoicing" : "in use by parties"}`);
  }
}

/* ---------------------------------------------------------------- write --- */

async function write(plan) {
  const file = writeBackup("seed-customer-groups", {
    note:
      "seed-customer-groups.mjs created these customer group records. " +
      "Remove them by name to undo; no customer was modified.",
    created: plan,
  });
  console.log(`\n💾 Backup written to ${file}`);

  const ok = await confirmYes(`\nCreate ${plan.length} group(s)? Type "yes": `, ASSUME_YES);
  if (!ok) {
    console.log("Aborted. Nothing was written.\n");
    return;
  }

  const now = new Date();
  const res = await groups.insertMany(
    plan.map((g) => ({ name: g.name, createdAt: now, updatedAt: now })),
    { ordered: false }
  );

  console.log(`\n✅ Created ${res.length} group(s).\n`);
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
    const [inUse, existing] = await Promise.all([
      customers.distinct("group"),
      groups.find({}, { name: 1 }).lean(),
    ]);

    const plan = planSeed({ inUse, existing });
    report(plan, inUse.filter(Boolean).length, existing.length);

    if (!plan.length) return;

    if (!APPLY) {
      console.log("\nDry run. Re-run with --apply to create them.\n");
      return;
    }

    await write(plan);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
