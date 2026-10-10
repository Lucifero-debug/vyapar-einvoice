/**
 * Report master records that already share a name.
 *
 * WHY
 * ---
 * The routes refuse a duplicate name now, case- and whitespace-insensitively.
 * That stops new ones; it cannot see what is already stored, and the guards
 * used to be inconsistent — some compared exactly, so "Sharma Traders" and
 * "sharma traders" could both have been created.
 *
 * Every master here is joined BY NAME: ledger rows carry `customerName`, stock
 * rows carry `itemName`, items carry an HSN code, customers carry a group name.
 * So a duplicate silently splits one account's history in two and neither
 * ledger is right.
 *
 * READ-ONLY. It never writes, because merging two parties means deciding which
 * balance and which history survive — a judgement, not a migration. The report
 * tells you what to merge by hand.
 *
 * USAGE
 *   node scripts/check-duplicates.mjs
 */

import mongoose from "mongoose";
import { loadEnv, pad } from "./_shared.mjs";
import { findDuplicates } from "../lib/uniqueName.mjs";

const loose = (collection) =>
  mongoose.model(collection, new mongoose.Schema({}, { strict: false, collection }));

const MASTERS = [
  { label: "Customers / parties", collection: "customers", field: "name" },
  { label: "Items", collection: "items", field: "name" },
  { label: "HSN codes", collection: "hsn", field: "hsncode" },
  { label: "Customer groups", collection: "customergroups", field: "name" },
];

function report({ label, field }, dupes, total) {
  if (!dupes.length) {
    console.log(`\n✅ ${label}: ${total} record(s), no duplicates.`);
    return 0;
  }

  const rows = dupes.reduce((n, d) => n + d.records.length, 0);
  console.log(`\n❌ ${label}: ${dupes.length} name(s) held by ${rows} records\n`);
  console.log(`   ${pad("NAME", 36)} ${pad("COPIES", 7)} SPELLINGS / IDS`);
  console.log(`   ${"-".repeat(36)} ${"-".repeat(7)} ${"-".repeat(40)}`);

  for (const d of dupes) {
    console.log(`   ${pad(d.name, 36)} ${pad(String(d.records.length), 7)} ${d.spellings.join("  |  ")}`);
    for (const r of d.records) {
      console.log(`   ${" ".repeat(36)} ${" ".repeat(7)} ${r._id}`);
    }
  }

  return dupes.length;
}

async function main() {
  loadEnv();
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set (looked in env, .env.local, .env).");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);

  try {
    let offending = 0;

    for (const master of MASTERS) {
      const Model = loose(master.collection);
      const records = await Model.find({}, { [master.field]: 1 }).lean();
      offending += report(master, findDuplicates(records, master.field), records.length);
    }

    // Price lists are keyed by party and date rather than by a name.
    const lists = await loose("pricelists")
      .find({}, { party: 1, partyName: 1, date: 1 })
      .lean();
    const byPartyDay = new Map();
    for (const l of lists) {
      const day = l.date ? new Date(l.date).toISOString().slice(0, 10) : "—";
      const k = `${l.party}|${day}`;
      if (!byPartyDay.has(k)) byPartyDay.set(k, []);
      byPartyDay.get(k).push({ ...l, day });
    }
    const listDupes = [...byPartyDay.values()].filter((g) => g.length > 1);

    if (!listDupes.length) {
      console.log(`\n✅ Price lists: ${lists.length} list(s), none duplicated for a party on one date.`);
    } else {
      offending += listDupes.length;
      console.log(`\n❌ Price lists: ${listDupes.length} party/date pair(s) with more than one list\n`);
      for (const g of listDupes) {
        console.log(`   ${pad(g[0].partyName || String(g[0].party), 36)} ${g[0].day}  (${g.length} lists)`);
        for (const l of g) console.log(`   ${" ".repeat(36)} ${l._id}`);
      }
      console.log(
        `\n   Billing takes the most recent list per party, so with two on the same\n` +
        `   date the one that wins is whichever the sort leaves first. Delete the\n` +
        `   one you do not want.`
      );
    }

    if (offending) {
      console.log(
        `\n${"─".repeat(72)}\n` +
        `${offending} duplicate group(s) found. Nothing was changed.\n\n` +
        `To fix one: open the records, move any history onto the spelling you want\n` +
        `to keep (rename cascades to the ledger, stock and invoices), then delete\n` +
        `the empty one. A master still in use refuses deletion, which is the check\n` +
        `that you moved everything.\n`
      );
      process.exitCode = 1;
    } else {
      console.log(`\n${"─".repeat(72)}\nNo duplicates in any master.\n`);
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
