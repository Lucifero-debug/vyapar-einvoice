/**
 * Fill the state master with India's states, union territories and GST codes.
 *
 * WHY
 * ---
 * The billing pages offered a hard-coded list of three — "Delhi", "Mumbai",
 * "Jaipur" — two of which are cities rather than states, and none of which
 * carried a GST state code. The code is the first two digits of a GSTIN and is
 * what decides CGST+SGST versus IGST, so it has to come from somewhere real.
 *
 * Creates only what the master does not already hold, matching on either the
 * code or the name, so running it twice is safe and your own edits survive.
 *
 * USAGE
 *   node scripts/seed-states.mjs                 # dry run
 *   node scripts/seed-states.mjs --apply         # write
 *   node scripts/seed-states.mjs --apply --yes
 */

import mongoose from "mongoose";
import { loadEnv, flags, writeBackup, confirmYes, pad } from "./_shared.mjs";
import { planStateSeed } from "../lib/states.mjs";

const { apply: APPLY, yes: ASSUME_YES } = flags();

const states = mongoose.model(
  "State",
  new mongoose.Schema({}, { strict: false, collection: "states" })
);

async function main() {
  loadEnv();
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set (looked in env, .env.local, .env).");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);

  try {
    const existing = await states.find({}, { name: 1, code: 1 }).lean();
    const plan = planStateSeed({ existing });

    console.log(`\nMaster holds ${existing.length} state(s).`);

    if (!plan.length) {
      console.log("Every state is already there. Nothing to do.\n");
      return;
    }

    console.log(`\n${plan.length} state(s) would be created:\n`);
    console.log(`  ${pad("CODE", 6)} NAME`);
    console.log(`  ${"-".repeat(6)} ${"-".repeat(44)}`);
    for (const s of plan) console.log(`  ${pad(s.code, 6)} ${s.name}`);

    if (!APPLY) {
      console.log("\nDry run. Re-run with --apply to create them.\n");
      return;
    }

    const file = writeBackup("seed-states", {
      note: "seed-states.mjs created these state records. Remove them by code to undo.",
      created: plan,
    });
    console.log(`\n💾 Backup written to ${file}`);

    const ok = await confirmYes(`\nCreate ${plan.length} state(s)? Type "yes": `, ASSUME_YES);
    if (!ok) {
      console.log("Aborted. Nothing was written.\n");
      return;
    }

    const now = new Date();
    const res = await states.insertMany(
      plan.map((s) => ({ name: s.name, code: s.code, createdAt: now, updatedAt: now })),
      { ordered: false }
    );

    console.log(`\n✅ Created ${res.length} state(s).\n`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
