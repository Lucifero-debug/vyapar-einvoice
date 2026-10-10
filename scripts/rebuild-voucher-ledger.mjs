/**
 * Regenerate the ledger rows belonging to vouchers.
 *
 * WHY
 * ---
 * `voucher-alter` used to hand-roll its ledger rows in a different shape from
 * `voucher-add`: no `customerName` (so the ledger could not group them), the
 * party always booked as a credit regardless of the side entered, a `type`
 * field the schema silently dropped, and one main-account row per line instead
 * of a single aggregate. Any voucher edited before that fix still has those
 * malformed rows sitting in the database.
 *
 * This script deletes the ledger rows belonging to vouchers and rebuilds them
 * from the `vouchers` collection through `lib/voucherLedger.mjs` — the same
 * builder both routes now use.
 *
 * ⚠ THE `voucherId` FIELD IS OVERLOADED
 * -------------------------------------
 * Despite `ref: "Voucher"` on the schema, `save-invoice` also stamps
 * `voucherId` onto its ledger rows, holding an *Invoice* `_id`. Deleting rows
 * by "has a voucherId" would therefore destroy every invoice's ledger.
 *
 * This script only ever touches rows whose `voucherId` matches an `_id` in the
 * `vouchers` collection. Everything else — invoice rows, opening balances,
 * anything hand-entered — is left strictly alone.
 *
 * WHAT CANNOT BE RECOVERED
 * ------------------------
 * `narration` was never declared on the voucher schema until this fix, so
 * strict mode dropped it on save. For vouchers created before then the text is
 * simply not in the database and the rebuilt rows fall back to the generated
 * default. The script reports how many rows this affects.
 *
 * Balances are NOT touched: they are derived from invoices and vouchers, not
 * from ledger rows. Run migrate-balances.mjs separately if they need attention.
 *
 * USAGE
 * -----
 *   node scripts/rebuild-voucher-ledger.mjs           # dry run
 *   node scripts/rebuild-voucher-ledger.mjs --apply   # rebuild (backs up first)
 *   node scripts/rebuild-voucher-ledger.mjs --apply --yes
 *   node scripts/rebuild-voucher-ledger.mjs --all     # rebuild every voucher,
 *                                                     # not just malformed ones
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";

import { loadEnv, flags, writeBackup, confirmYes, pad, padL } from "./_shared.mjs";
import { buildVoucherLedgerRows } from "../lib/voucherLedger.mjs";

const { apply: APPLY, yes: ASSUME_YES } = flags();
const REBUILD_ALL = process.argv.includes("--all");

/* --------------------------------------------------------------- models --- */

const vouchers = mongoose.model(
  "Voucher",
  new mongoose.Schema({}, { strict: false, collection: "vouchers" })
);
const ledgers = mongoose.model(
  "Ledger",
  new mongoose.Schema({}, { strict: false, collection: "ledgers" })
);

/* ------------------------------------------------------------ inspection -- */

/**
 * Does this row carry the fingerprint of the old hand-rolled shape?
 *
 * Any one of these is enough to know the row did not come from the builder.
 */
export function diagnoseRow(row, voucher) {
  const problems = [];
  if (!row.customerName) problems.push("no customerName");
  if ("type" in row) problems.push("stray `type` field");
  if (row.customerName && row.account === row.customerName)
    problems.push("booked against itself");
  if (voucher && row.customerName && row.account === voucher.acName) {
    // A well-formed party row books the contra account. Check the side matches
    // the voucher line it claims to represent.
    const line = (voucher.customers || []).find(
      (c) => c.name === row.customerName
    );
    if (line) {
      const debit = Number(line.debit) || 0;
      const credit = Number(line.credit) || 0;
      if (Number(row.debit) !== debit || Number(row.credit) !== credit)
        problems.push("side does not match the voucher line");
    }
  }
  return problems;
}

/**
 * Plan the rebuild. Pure, so it can be exercised against fixtures without a
 * database — see scripts/rebuild-voucher-ledger.test.mjs.
 */
export function planRebuild({ allVouchers, allLedgers, rebuildAll = false }) {
  const voucherById = new Map(allVouchers.map((v) => [String(v._id), v]));

  // Partition the ledger strictly: only rows pointing at a real voucher are
  // ours to touch. Invoice rows also carry a voucherId — leave them be.
  const owned = new Map(); // voucherId -> rows
  const foreign = [];
  let orphaned = 0;

  for (const row of allLedgers) {
    const key = row.voucherId ? String(row.voucherId) : null;
    if (key && voucherById.has(key)) {
      if (!owned.has(key)) owned.set(key, []);
      owned.get(key).push(row);
    } else {
      foreign.push(row);
      // A voucherId pointing at nothing in `vouchers` is either an invoice row
      // (expected) or a leftover from a deleted voucher (not).
      if (key) orphaned += 1;
    }
  }

  const plan = [];
  let narrationLost = 0;

  for (const voucher of allVouchers) {
    const key = String(voucher._id);
    const existing = owned.get(key) || [];

    const rebuilt = buildVoucherLedgerRows({
      acName: voucher.acName,
      date: voucher.date,
      paymentType: voucher.paymentType,
      narration: voucher.narration,
      customers: voucher.customers || [],
      voucherId: voucher._id,
    });

    const problems = [
      ...new Set(existing.flatMap((r) => diagnoseRow(r, voucher))),
    ];
    // A voucher whose rows are missing entirely also needs rebuilding.
    if (existing.length === 0) problems.push("no ledger rows at all");
    else if (existing.length !== rebuilt.length)
      problems.push(`${existing.length} rows, expected ${rebuilt.length}`);

    if (!voucher.narration) narrationLost += 1;

    if (problems.length || rebuildAll) {
      plan.push({
        voucherId: key,
        acName: voucher.acName,
        date: voucher.date,
        parties: (voucher.customers || []).length,
        existing,
        rebuilt,
        problems,
      });
    }
  }

  return {
    plan,
    narrationLost,
    counts: {
      vouchers: allVouchers.length,
      ledgerRows: allLedgers.length,
      ownedRows: [...owned.values()].reduce((a, r) => a + r.length, 0),
      untouchedRows: foreign.length,
      orphanedRows: orphaned,
    },
  };
}

/* --------------------------------------------------------------- report --- */

function report({ plan, narrationLost, counts }) {
  console.log(
    `\nScanned ${counts.vouchers} vouchers and ${counts.ledgerRows} ledger rows.`
  );
  console.log(
    `  ${counts.ownedRows} row(s) belong to vouchers and are in scope.\n` +
      `  ${counts.untouchedRows} row(s) belong to invoices or openings — ` +
      `these are NOT touched.`
  );
  if (counts.orphanedRows) {
    console.log(
      `  ⚠ ${counts.orphanedRows} row(s) point at a voucherId that is neither ` +
        `a voucher nor\n    resolvable — likely leftovers from a deleted ` +
        `voucher. Left in place.`
    );
  }

  if (!plan.length) {
    console.log("\n✅ Every voucher's ledger rows already match. Nothing to do.\n");
    return;
  }

  console.log(`\n${plan.length} voucher(s) would be rebuilt:\n`);
  console.log(
    pad("Voucher", 26) +
      pad("Account", 16) +
      padL("Parties", 8) +
      padL("Rows", 12) +
      "   Why"
  );
  console.log("-".repeat(100));

  for (const p of plan) {
    const when = p.date ? new Date(p.date).toISOString().slice(0, 10) : "—";
    console.log(
      pad(`${p.voucherId.slice(-8)}  ${when}`, 26) +
        pad(p.acName || "—", 16) +
        padL(p.parties, 8) +
        padL(`${p.existing.length} → ${p.rebuilt.length}`, 12) +
        "   " +
        (p.problems.join("; ") || "forced by --all")
    );
  }

  const deleting = plan.reduce((a, p) => a + p.existing.length, 0);
  const inserting = plan.reduce((a, p) => a + p.rebuilt.length, 0);
  console.log(
    `\nWould delete ${deleting} row(s) and insert ${inserting} row(s).`
  );

  if (narrationLost) {
    console.log(
      `\nNote: ${narrationLost} voucher(s) have no stored narration — it was ` +
        `dropped by the\n  schema before this fix and cannot be recovered. ` +
        `Those rows get the default text.`
    );
  }
}

/* ---------------------------------------------------------------- write --- */

async function write(plan) {
  const file = writeBackup("voucher-ledger-rows", {
    note:
      "Ledger rows deleted by rebuild-voucher-ledger.mjs, with the rows that " +
      "replaced them. Only rows belonging to vouchers are included.",
    vouchers: plan.map((p) => ({
      voucherId: p.voucherId,
      acName: p.acName,
      problems: p.problems,
      deleted: p.existing,
      inserted: p.rebuilt,
    })),
  });
  console.log(`\n💾 Backup written to ${file}`);

  const deleting = plan.reduce((a, p) => a + p.existing.length, 0);
  const ok = await confirmYes(
    `\nRebuild ledger rows for ${plan.length} voucher(s), replacing ` +
      `${deleting} row(s)? Type "yes": `,
    ASSUME_YES
  );
  if (!ok) {
    console.log("Aborted. Nothing was written.\n");
    return;
  }

  let deleted = 0;
  let inserted = 0;

  for (const p of plan) {
    // Scoped to this one voucher's id, so nothing else can be caught by it.
    // Matched as both ObjectId and string: the field is untyped in this
    // script's schema, and a row written by an older path may hold either.
    const ids = [p.voucherId];
    if (mongoose.Types.ObjectId.isValid(p.voucherId)) {
      ids.push(new mongoose.Types.ObjectId(p.voucherId));
    }

    const res = await ledgers.deleteMany({ voucherId: { $in: ids } });
    deleted += res.deletedCount || 0;

    if (p.rebuilt.length) {
      await ledgers.insertMany(p.rebuilt);
      inserted += p.rebuilt.length;
    }
  }

  console.log(
    `\n✅ Deleted ${deleted} row(s), inserted ${inserted} row(s) across ` +
      `${plan.length} voucher(s).`
  );
  console.log(
    "   Customer balances were not touched — they derive from the vouchers " +
      "themselves.\n"
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
  if (REBUILD_ALL) console.log("Scope: ALL vouchers (--all)");

  try {
    const [allVouchers, allLedgers] = await Promise.all([
      vouchers.find({}).lean(),
      ledgers.find({}).lean(),
    ]);

    const result = planRebuild({
      allVouchers,
      allLedgers,
      rebuildAll: REBUILD_ALL,
    });
    report(result);

    if (APPLY && result.plan.length) await write(result.plan);
    else if (!APPLY && result.plan.length)
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
    console.error("\nRebuild failed:", err);
    process.exit(1);
  });
}
