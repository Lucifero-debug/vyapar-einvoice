/**
 * Repair the stored `hsnTotals` rows on existing invoices.
 *
 * WHY
 * ---
 * The sale and purchase forms have always sent each HSN row as
 * { hsn, gstRate, amount, total }, but `models/invoiceModel.js` declared only
 * { hsn, amount }. Mongoose strict mode drops undeclared subdocument fields
 * without complaining, so `gstRate` and `total` never reached the database.
 *
 * Read back, every row was rate 0 and total 0, and the HSN summary on the
 * printed bill -- which showed the taxable value as total minus GST -- put the
 * tax itself in that column as a negative number, against a total of zero.
 *
 * The schema now declares all four fields, and the print page derives the
 * summary from the line items rather than trusting these rows, so bills are
 * correct with or without this script. What is left is the stored data itself:
 * truncated rows sitting in the collection, wrong for anything that reads them
 * later -- a GSTR export, a report, a future page.
 *
 * This script rewrites those rows from the invoice's own line items, through
 * `lib/hsnTotals.mjs` -- the same derivation the print page renders, so the
 * two agree by construction.
 *
 * SCOPE
 * -----
 * Only the `hsnTotals` field is written. Items, totals, customer balances,
 * ledger rows and stock rows are all left strictly alone: nothing else derives
 * from this field, so nothing else needs to move with it.
 *
 * An invoice with no line items cannot have its rows derived -- there is
 * nothing to derive them from. Those are reported and skipped, never emptied.
 *
 * USAGE
 * -----
 *   node scripts/backfill-hsn-totals.mjs           # dry run
 *   node scripts/backfill-hsn-totals.mjs --apply   # write (backs up first)
 *   node scripts/backfill-hsn-totals.mjs --apply --yes
 *   node scripts/backfill-hsn-totals.mjs --all     # rewrite every invoice's
 *                                                  # rows, not just bad ones
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";

import { loadEnv, flags, writeBackup, confirmYes, pad, padL } from "./_shared.mjs";
import { hsnTotalsForStorage } from "../lib/hsnTotals.mjs";

const { apply: APPLY, yes: ASSUME_YES } = flags();
const REWRITE_ALL = process.argv.includes("--all");

/* --------------------------------------------------------------- models --- */

const invoices = mongoose.model(
  "Invoice",
  new mongoose.Schema({}, { strict: false, collection: "invoices" })
);

/* ------------------------------------------------------------ inspection -- */

/** A paisa of slack: these are floats that have been through toFixed and back. */
const differs = (a, b) => Math.abs(Number(a || 0) - Number(b || 0)) > 0.005;

/**
 * What is wrong with an invoice's stored rows, compared with the rows its
 * line items imply?
 *
 * A missing `gstRate` or `total` is the schema truncation. A wrong `amount`,
 * or a row that should not be there at all, means the stored summary has
 * drifted from the lines for some other reason -- worth rewriting, worth
 * naming separately in the report.
 */
export function diagnoseInvoice(stored = [], derived = []) {
  const problems = [];

  if (!stored.length && derived.length) return ["no stored rows"];

  if (stored.some((r) => r.gstRate === undefined || r.gstRate === null))
    problems.push("gstRate dropped");
  if (stored.some((r) => r.total === undefined || r.total === null))
    problems.push("total dropped");

  const byHsn = new Map(derived.map((r) => [String(r.hsn), r]));
  if (stored.length !== derived.length) {
    problems.push(`row count ${stored.length} → ${derived.length}`);
  }

  for (const row of stored) {
    const want = byHsn.get(String(row.hsn));
    if (!want) {
      problems.push(`hsn ${row.hsn} not in the lines`);
      continue;
    }
    if (differs(row.amount, want.amount)) {
      problems.push(
        `hsn ${row.hsn} gst ${Number(row.amount || 0).toFixed(2)} → ${want.amount.toFixed(2)}`
      );
    }
    // Only compare the fields that survived; a dropped one is already named.
    if (row.total != null && differs(row.total, want.total)) {
      problems.push(
        `hsn ${row.hsn} total ${Number(row.total).toFixed(2)} → ${want.total.toFixed(2)}`
      );
    }
  }

  return problems;
}

/**
 * Plan the backfill. Pure, so it can be exercised against fixtures without a
 * database — see scripts/backfill-hsn-totals.test.mjs.
 */
export function planBackfill({ allInvoices = [], rewriteAll = false } = {}) {
  const plan = [];
  const skipped = [];
  const counts = {
    invoices: allInvoices.length,
    withStoredRows: 0,
    rowsMissingGstRate: 0,
    rowsMissingTotal: 0,
  };

  for (const invoice of allInvoices) {
    const stored = invoice.hsnTotals || [];
    const items = invoice.items || [];

    if (stored.length) counts.withStoredRows += 1;
    for (const row of stored) {
      if (row.gstRate === undefined || row.gstRate === null)
        counts.rowsMissingGstRate += 1;
      if (row.total === undefined || row.total === null)
        counts.rowsMissingTotal += 1;
    }

    if (!items.length) {
      // Nothing to derive from. Emptying the stored rows would destroy the
      // only record of the tax on this bill, so it is left exactly as it is.
      if (stored.length) {
        skipped.push({
          invoiceNo: invoice.invoiceNo,
          _id: String(invoice._id),
          why: "no line items to derive from",
          stored,
        });
      }
      continue;
    }

    const derived = hsnTotalsForStorage(items);
    const problems = diagnoseInvoice(stored, derived);

    if (!problems.length && !rewriteAll) continue;

    plan.push({
      _id: String(invoice._id),
      invoiceNo: invoice.invoiceNo,
      type: invoice.type,
      date: invoice.date,
      problems,
      stored,
      derived,
    });
  }

  return { plan, skipped, counts };
}

/* --------------------------------------------------------------- report --- */

function report({ plan, skipped, counts }) {
  console.log(`\nInvoices: ${counts.invoices}`);
  console.log(`  ${counts.withStoredRows} carry stored hsnTotals rows.`);
  console.log(
    `  ${counts.rowsMissingGstRate} row(s) have no gstRate, ` +
      `${counts.rowsMissingTotal} row(s) have no total — the schema truncation.`
  );

  if (skipped.length) {
    console.log(
      `\n⚠ ${skipped.length} invoice(s) have stored rows but no line items. ` +
        `Left untouched:`
    );
    for (const s of skipped) {
      console.log(`    invoice ${s.invoiceNo} (${s._id.slice(-8)}) — ${s.why}`);
    }
  }

  if (!plan.length) {
    console.log("\n✅ Every invoice's stored rows already match its lines. Nothing to do.\n");
    return;
  }

  console.log(`\n${plan.length} invoice(s) would be rewritten:\n`);
  console.log(
    pad("Invoice", 14) + pad("Date", 12) + padL("Rows", 8) + "   Why"
  );
  console.log("-".repeat(100));

  for (const p of plan) {
    const when = p.date ? new Date(p.date).toISOString().slice(0, 10) : "—";
    console.log(
      pad(`${p.invoiceNo ?? "—"} ${p.type || ""}`.trim(), 14) +
        pad(when, 12) +
        padL(`${p.stored.length} → ${p.derived.length}`, 8) +
        "   " +
        (p.problems.join("; ") || "forced by --all")
    );
  }

  // The figures themselves, so the change can be read before it is made.
  console.log("\nRow detail (before → after):\n");
  for (const p of plan) {
    console.log(`  invoice ${p.invoiceNo}`);
    for (const row of p.derived) {
      const was = p.stored.find((r) => String(r.hsn) === String(row.hsn));
      const wasTotal = Number(was?.total || 0);
      const wasGst = Number(was?.amount || 0);
      const wasTaxable = was ? (wasTotal - wasGst).toFixed(2) : "—";
      console.log(
        `    hsn ${pad(row.hsn, 10)}` +
          `rate ${padL(was?.gstRate ?? 0, 5)}% → ${padL(row.gstRate, 5)}%   ` +
          `taxable ${padL(wasTaxable, 10)} → ${padL((row.total - row.amount).toFixed(2), 10)}   ` +
          `gst ${padL(wasGst.toFixed(2), 9)} → ${padL(row.amount.toFixed(2), 9)}   ` +
          `total ${padL(wasTotal.toFixed(2), 10)} → ${padL(row.total.toFixed(2), 10)}`
      );
    }
  }
}

/* ---------------------------------------------------------------- write --- */

async function write(plan) {
  const file = writeBackup("invoice-hsn-totals", {
    note:
      "hsnTotals rows replaced by backfill-hsn-totals.mjs. `stored` is what " +
      "was in the invoice before the rewrite; restore from it by setting " +
      "hsnTotals back to that array on the matching _id.",
    invoices: plan.map((p) => ({
      _id: p._id,
      invoiceNo: p.invoiceNo,
      problems: p.problems,
      stored: p.stored,
      written: p.derived,
    })),
  });
  console.log(`\n💾 Backup written to ${file}`);

  const ok = await confirmYes(
    `\nRewrite the hsnTotals rows on ${plan.length} invoice(s)? ` +
      `Nothing else on the invoice is touched. Type "yes": `,
    ASSUME_YES
  );
  if (!ok) {
    console.log("Aborted. Nothing was written.\n");
    return;
  }

  let updated = 0;
  for (const p of plan) {
    // $set on the one field, matched by _id: no other field can be caught by
    // it, and an invoice not in the plan cannot be reached at all.
    const res = await invoices.updateOne(
      { _id: new mongoose.Types.ObjectId(p._id) },
      { $set: { hsnTotals: p.derived } }
    );
    updated += res.modifiedCount || 0;
  }

  console.log(`\n✅ Rewrote hsnTotals on ${updated} invoice(s).`);
  console.log(
    "   Items, totals, balances and ledger rows were not touched — nothing " +
      "else derives from this field.\n"
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
  if (REWRITE_ALL) console.log("Scope: ALL invoices (--all)");

  try {
    const allInvoices = await invoices.find({}).lean();
    const result = planBackfill({ allInvoices, rewriteAll: REWRITE_ALL });
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
    console.error("\nBackfill failed:", err);
    process.exit(1);
  });
}
