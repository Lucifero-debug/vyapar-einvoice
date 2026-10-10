/**
 * Convert stored customer phone numbers AND pincodes from Number to String.
 *
 * WHY
 * ---
 * `customers.phone` was declared `type: Number`. A phone number is an
 * identifier, not a quantity, so that was wrong in three ways:
 *
 *   "09811122233"      ->  9811122233      the leading zero is gone for good
 *   "+91 98111 22233"  ->  null            not a number at all
 *   "98111 22233, 98222 33344"  ->  null   two numbers never fit
 *
 * The schema is now String. Mongoose casts on hydration, so ordinary reads of
 * old rows already come back as strings -- but `.lean()` SKIPS casting, and
 * most read routes here use `.lean()`. Those would hand a raw BSON number to
 * code that expects a string, so `phone.trim()` throws and `phone === "..."`
 * is never true.
 *
 * This rewrites the stored value in place. The digits are preserved exactly as
 * they survive in the database today; a leading zero lost when the row was
 * first written cannot be recovered, and the backup records what was there.
 *
 * USAGE
 * -----
 *   node scripts/phone-to-string.mjs                 # dry run
 *   node scripts/phone-to-string.mjs --apply         # write (backs up first)
 *   node scripts/phone-to-string.mjs --apply --yes
 */

import mongoose from "mongoose";
import { loadEnv, flags, writeBackup, confirmYes, pad } from "./_shared.mjs";
import { looksTruncated, planFieldConversion } from "../lib/phone.mjs";

const { apply: APPLY, yes: ASSUME_YES } = flags();

/* --------------------------------------------------------------- models --- */

const customers = mongoose.model(
  "Customer",
  new mongoose.Schema({}, { strict: false, collection: "customers" })
);

/* ---------------------------------------------------------------- report --- */

function report(plan, total) {
  console.log(`\nScanned ${total} customer(s).`);

  if (plan.length === 0) {
    console.log("Every phone and pincode is already a string. Nothing to do.\n");
    return;
  }

  console.log(`\n${plan.length} value(s) are stored as numbers:\n`);
  console.log(`  ${pad("PARTY", 30)} ${pad("FIELD", 9)} ${pad("STORED", 16)} BECOMES`);
  console.log(`  ${"-".repeat(30)} ${"-".repeat(9)} ${"-".repeat(16)} ${"-".repeat(20)}`);

  for (const row of plan) {
    console.log(
      `  ${pad(row.name ?? "—", 30)} ${pad(row.field, 9)} ${pad(String(row.from), 16)} ${
        row.to === "" ? "(blank)" : row.to
      }`
    );
  }

  const lostZero = plan.filter(looksTruncated);
  if (lostZero.length) {
    console.log(
      `\n⚠  ${lostZero.length} of these are 9 digits long. A 10-digit Indian mobile stored as a\n` +
      `   number loses a leading zero, so these may be missing one. The digits that\n` +
      `   survive are kept as they are — check them against your records.`
    );
  }
}

/* ----------------------------------------------------------------- write --- */

async function write(plan) {
  const file = writeBackup("phone-to-string", {
    note:
      "These customer fields held these values before phone-to-string.mjs " +
      "converted them to strings. Restore by setting each field back on the " +
      "matching _id.",
    customers: plan,
  });
  console.log(`\n💾 Backup written to ${file}`);

  const ok = await confirmYes(
    `\nConvert ${plan.length} value(s) to strings? Type "yes": `,
    ASSUME_YES
  );
  if (!ok) {
    console.log("Aborted. Nothing was written.\n");
    return;
  }

  let changed = 0;
  for (const row of plan) {
    const res = await customers.updateOne(
      { _id: new mongoose.Types.ObjectId(row._id) },
      { $set: { [row.field]: row.to } }
    );
    changed += res.modifiedCount || 0;
  }

  console.log(`\n✅ Converted ${changed} value(s).\n`);
}

/* ------------------------------------------------------------------ main --- */

async function main() {
  loadEnv();
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set (looked in env, .env.local, .env).");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);

  try {
    const all = await customers.find({}, { name: 1, phone: 1, pincode: 1 }).lean();
    const plan = [
      ...planFieldConversion(all, "phone"),
      ...planFieldConversion(all, "pincode"),
    ];

    report(plan, all.length);

    if (!plan.length) return;

    if (!APPLY) {
      console.log("\nDry run. Re-run with --apply to write these changes.\n");
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
