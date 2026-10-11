/**
 * Add the missing contra rows to invoices already in the books.
 *
 * WHY
 * ---
 * An invoice posted the party's side and, when something was settled at the
 * counter, both sides of the receipt. It named "Sales Account" in the contra
 * column of the party's row as TEXT and wrote no row owned by that account,
 * and nothing at all for GST. The ledger was therefore a party-and-cash
 * subledger: every per-account report it served was right, and a trial balance
 * drawn from it was short by exactly sales plus tax.
 *
 * `lib/invoiceGl.mjs` now supplies that side and the billing routes post it,
 * so invoices raised from here on are complete. What is left is history. An
 * un-backfilled book balances only from the changeover date, and a period
 * spanning it fails to balance with nothing on the sheet to say why -- which
 * is the one outcome worse than no trial balance at all.
 *
 * WHAT IT WRITES
 * --------------
 *   ledgers    the contra rows -- Sales or Purchase, the GST heads, the
 *              round-off -- each carrying the invoice's `voucherId`, so
 *              `delete-invoice` and `sale-alter` find and reverse them
 *              exactly as they do for a freshly posted invoice
 *   customers  the ledger heads themselves, created if absent, and their
 *              `lastBal` moved by what the new rows say
 *
 * That second part is not optional. `delete-invoice` reverses an invoice by
 * reading its rows back, so a backfilled invoice whose head balances were
 * never moved would, on deletion, reverse a movement that had not happened --
 * and leave the head drifting further from its own ledger with every delete.
 *
 * WHAT IT LEAVES ALONE
 * --------------------
 * The invoice documents, the party rows, the receipt rows, party balances,
 * stock. Nothing about the party's position changes: the contra side is the
 * other half of an entry whose first half was already right.
 *
 *   node scripts/backfill-gl-legs.mjs            # dry run
 *   node scripts/backfill-gl-legs.mjs --apply    # write (backs up first)
 *   node scripts/backfill-gl-legs.mjs --apply --yes
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";

import { loadEnv, flags, writeBackup, confirmYes, money, pad, padL } from "./_shared.mjs";
import { GL_ACCOUNTS, GL_ACCOUNT_GROUPS } from "../lib/invoiceGl.mjs";
// The planning is pure and lives in lib/, so it can be exercised against
// fixtures under bare node. See the note atop that file.
import { netMoves, planBackfill } from "../lib/glBackfill.mjs";

const { apply: APPLY, yes: ASSUME_YES } = flags();

/* --------------------------------------------------------------- models --- */

const invoices = mongoose.model(
  "Invoice",
  new mongoose.Schema({}, { strict: false, collection: "invoices" })
);
const ledgers = mongoose.model(
  "Ledger",
  new mongoose.Schema({}, { strict: false, collection: "ledgers" })
);
const customers = mongoose.model(
  "Customer",
  new mongoose.Schema({}, { strict: false, collection: "customers" })
);

/* ------------------------------------------------------------------ run --- */

async function main() {
  loadEnv();
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set (looked in env, .env.local, .env).");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log(`\nConnected to ${mongoose.connection.name}`);
  console.log(`Mode: ${APPLY ? "APPLY -- rows will be written" : "report only"}\n`);

  // EVERY FIRM. These scripts run outside Next and therefore outside the
  // tenant context, so the plugin's scoping does not apply -- which is the
  // point here, since a backfill that silently did one firm would leave the
  // others unbalanced. The companyId already on each invoice is copied onto
  // its new rows, so nothing crosses between firms.
  const allInvoices = await invoices.find({}).lean();
  const ids = allInvoices.map((i) => i._id);

  const existingRows = await ledgers
    .find({ voucherId: { $in: ids } }, { voucherId: 1, customerName: 1, debit: 1, credit: 1 })
    .lean();

  const rowsByInvoice = new Map();
  for (const row of existingRows) {
    const key = String(row.voucherId);
    if (!rowsByInvoice.has(key)) rowsByInvoice.set(key, []);
    rowsByInvoice.get(key).push(row);
  }

  const { plan, skipped, material, counts } = planBackfill({ allInvoices, rowsByInvoice });

  console.log(`invoices                : ${counts.invoices}`);
  console.log(`already posted          : ${counts.alreadyComplete}`);
  console.log(`nothing to post         : ${counts.noContraNeeded}`);
  console.log(`to back-fill            : ${counts.toPost}`);
  console.log(`rows to write           : ${counts.rowsToWrite}\n`);

  const partial = skipped.filter((s) => s.partial);
  if (partial.length) {
    console.log(`PARTLY POSTED -- ${partial.length} invoice(s), skipped and worth a look:`);
    for (const s of partial.slice(0, 20)) console.log(`  #${s.invoiceNo}  ${s.reason}`);
    if (partial.length > 20) console.log(`  ... and ${partial.length - 20} more`);
    console.log();
  }

  if (material.length) {
    console.log(
      `ROUNDING OVER A RUPEE -- ${material.length} invoice(s). These post to Round Off,`
    );
    console.log(`which balances them, but the gap is freight or a bad figure, not rounding:\n`);
    console.log(`  ${pad("Invoice", 10)}${pad("Party", 24)}${padL("Final", 12)}${padL("Taxable", 12)}${padL("Tax", 10)}${padL("Gap", 10)}`);
    for (const m of material.slice(0, 25)) {
      console.log(
        `  ${pad("#" + m.invoiceNo, 10)}${pad(m.party, 24)}${padL(money(m.finalAmount), 12)}${padL(money(m.taxable), 12)}${padL(money(m.tax), 10)}${padL(money(m.difference), 10)}`
      );
    }
    if (material.length > 25) console.log(`  ... and ${material.length - 25} more`);
    console.log();
  }

  const moves = netMoves(plan);
  if (moves.size) {
    console.log("head balances after this run:\n");
    for (const [name, delta] of [...moves].sort((a, b) => a[0].localeCompare(b[0]))) {
      console.log(`  ${pad(name, 24)}${padL(money(delta), 14)}  (${GL_ACCOUNT_GROUPS[name] || "?"})`);
    }
    console.log();
  }

  if (!APPLY) {
    console.log("Nothing written. Re-run with --apply to write.\n");
    await mongoose.disconnect();
    return;
  }

  if (!plan.length) {
    console.log("Nothing to do.\n");
    await mongoose.disconnect();
    return;
  }

  const backup = writeBackup("gl-legs", {
    counts,
    material,
    plan: plan.map(({ rows, ...rest }) => ({ ...rest, rowCount: rows.length })),
    headBalancesBefore: await customers
      .find({ name: { $in: GL_ACCOUNTS } }, { name: 1, group: 1, lastBal: 1 })
      .lean(),
  });
  console.log(`Backup written to ${backup}`);

  if (!(await confirmYes(`\nWrite ${counts.rowsToWrite} rows? Type "yes": `, ASSUME_YES))) {
    console.log("Aborted.\n");
    await mongoose.disconnect();
    return;
  }

  // The heads first, so the rows below have something to belong to and the
  // trial balance files them under the right heading from the start.
  for (const [name] of moves) {
    await customers.updateOne(
      { name },
      {
        $setOnInsert: {
          name,
          group: GL_ACCOUNT_GROUPS[name] || "Suspense A/c",
          openingBal: 0,
          openingMode: "Dr",
        },
      },
      { upsert: true, collation: { locale: "en", strength: 2 } }
    );
  }

  // The rows, each stamped with its invoice's own companyId so a multi-firm
  // database stays separated.
  const byId = new Map(allInvoices.map((i) => [String(i._id), i]));
  let written = 0;
  for (const entry of plan) {
    const invoice = byId.get(String(entry._id));
    await ledgers.insertMany(
      entry.rows.map((row) => ({ ...row, companyId: invoice?.companyId })),
      { ordered: true }
    );
    written += entry.rows.length;
  }
  console.log(`\n${written} rows written.`);

  // The head balances. Signed, positive Dr, exactly as lib/balance.mjs stores
  // them -- and `lastMode` kept in step, or the display and the figure drift.
  for (const [name, delta] of moves) {
    const doc = await customers.findOne({ name }, { lastBal: 1 }).lean();
    const next = round2((Number(doc?.lastBal) || 0) + delta);
    await customers.updateOne(
      { name },
      { $set: { lastBal: next, lastMode: next >= 0 ? "Dr" : "Cr" } }
    );
    console.log(`  ${pad(name, 24)}${padL(money(next), 14)}`);
  }

  console.log("\nDone. Run `npm run sync:indexes` if this is a fresh database.\n");
  await mongoose.disconnect();
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch(async (err) => {
    console.error(err);
    await mongoose.disconnect();
    process.exit(1);
  });
}
