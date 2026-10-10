/**
 * Rebuild every customer's `lastBal` / `lastMode` under the signed convention.
 *
 * WHY A REBUILD RATHER THAN A CONVERSION
 * --------------------------------------
 * Before this migration two incompatible conventions wrote to the same field:
 *
 *   - save-invoice / sale-alter / delete-invoice / voucher-add stored
 *     `Math.abs(balance)` plus a separate Dr/Cr flag, then read it back as if
 *     it were signed — so every transaction on a Cr party used the wrong sign.
 *   - delete-voucher / voucher-alter did `$inc` on that same field, treating it
 *     as signed and never touching the flag.
 *
 * A stored balance is therefore some unknowable mixture of the two. There is no
 * formula that recovers the truth from the scalar alone, so this script ignores
 * it and recomputes from the primary documents instead:
 *
 *     lastBal = signed(openingBal) + Σ invoices + Σ voucher lines
 *
 * It uses the very same lib/balance.mjs helpers the runtime uses, so the
 * migration and the application cannot drift apart.
 *
 * USAGE
 * -----
 *   node scripts/migrate-balances.mjs            # dry run, prints a diff table
 *   node scripts/migrate-balances.mjs --apply    # writes (backs up first)
 *   node scripts/migrate-balances.mjs --apply --yes   # skip confirmation
 *
 * A JSON backup of the prior values is always written before anything changes.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";

import {
  ROOT,
  loadEnv,
  flags,
  writeBackup,
  confirmYes,
  money,
  pad,
  padL,
} from "./_shared.mjs";

import {
  invoiceDelta,
  voucherDelta,
  toSigned,
  modeOf,
  round2,
} from "../lib/balance.mjs";

const { apply: APPLY, yes: ASSUME_YES } = flags();

/* --------------------------------------------------------------- models --- */
// Declared locally so the script never pulls the Next path aliases into Node.

const customers = mongoose.model(
  "customers",
  new mongoose.Schema({}, { strict: false, collection: "customers" })
);
const invoices = mongoose.model(
  "Invoice",
  new mongoose.Schema({}, { strict: false, collection: "invoices" })
);
const vouchers = mongoose.model(
  "Voucher",
  new mongoose.Schema({}, { strict: false, collection: "vouchers" })
);

/* ------------------------------------------------------------- rebuild --- */

/**
 * Normalise a legacy opening balance into the signed convention.
 *
 * `openingBal` was written straight from the form as a magnitude alongside an
 * `openingMode` dropdown, so when a mode is present it is authoritative. When
 * no mode was ever chosen the raw value is taken as-is, sign included, rather
 * than guessing.
 */
function openingSigned(customer) {
  const raw = Number(customer.openingBal) || 0;
  const mode = customer.openingMode;
  if (mode === "Dr" || mode === "Cr") return toSigned(raw, mode);
  return round2(raw);
}

/**
 * The rebuild itself — pure, so it can be exercised against fixtures without
 * a database. See scripts/migrate-balances.test.mjs.
 */
export function computeRebuild({ allCustomers, allInvoices, allVouchers }) {
  // Index the movements by party name — the same key the runtime matches on.
  const movements = new Map(); // name -> { invoices: n, vouchers: n, delta }
  const bump = (name, delta, kind) => {
    if (!name) return;
    const m = movements.get(name) || { invoices: 0, vouchers: 0, delta: 0 };
    m.delta = round2(m.delta + delta);
    m[kind] += 1;
    movements.set(name, m);
  };

  let skippedUploads = 0;
  for (const inv of allInvoices) {
    // Invoices created by the bulk-upload path never touched a balance.
    if (inv.source === "upload") {
      skippedUploads += 1;
      continue;
    }
    const name = inv?.customer?.name;
    bump(
      name,
      invoiceDelta({
        type: inv.type,
        isReturn: inv.return,
        amount: inv.balanceDue || 0,
      }),
      "invoices"
    );
  }

  for (const v of allVouchers) {
    for (const line of v.customers || []) {
      // voucher-add only ever moved the per-party balances, never acName's.
      bump(
        line.name,
        voucherDelta({ debit: line.debit, credit: line.credit }),
        "vouchers"
      );
    }
  }

  const rows = allCustomers.map((c) => {
    const opening = openingSigned(c);
    const m = movements.get(c.name) || { invoices: 0, vouchers: 0, delta: 0 };
    const rebuilt = round2(opening + m.delta);
    return {
      _id: c._id,
      name: c.name,
      opening,
      txns: m.invoices + m.vouchers,
      oldBal: Number(c.lastBal) || 0,
      oldMode: c.lastMode || "",
      newBal: rebuilt,
      newMode: modeOf(rebuilt),
      oldOpeningBal: Number(c.openingBal) || 0,
      oldOpeningMode: c.openingMode || "",
    };
  });

  // Parties that appear on documents but have no customer record: their
  // movements are unattributable, so flag rather than silently drop them.
  const known = new Set(allCustomers.map((c) => c.name));
  const orphans = [...movements.keys()].filter((n) => !known.has(n));

  return { rows, orphans, skippedUploads, counts: {
    customers: allCustomers.length,
    invoices: allInvoices.length,
    vouchers: allVouchers.length,
  }};
}

async function rebuild() {
  const [allCustomers, allInvoices, allVouchers] = await Promise.all([
    customers.find({}).lean(),
    invoices.find({}).lean(),
    vouchers.find({}).lean(),
  ]);
  return computeRebuild({ allCustomers, allInvoices, allVouchers });
}

/* --------------------------------------------------------------- report --- */

function report({ rows, orphans, skippedUploads, counts }) {
  const changed = rows.filter(
    (r) => r.oldBal !== r.newBal || r.oldMode !== r.newMode
  );

  console.log(
    `\nScanned ${counts.customers} customers, ${counts.invoices} invoices, ` +
      `${counts.vouchers} vouchers.` +
      (skippedUploads ? ` Skipped ${skippedUploads} bulk-upload invoice(s).` : "")
  );

  if (!changed.length) {
    console.log("\n✅ Every balance already matches the rebuild. Nothing to do.\n");
    return changed;
  }

  console.log(`\n${changed.length} customer(s) would change:\n`);
  console.log(
    pad("Customer", 26) +
      padL("Txns", 5) +
      padL("Opening", 13) +
      padL("Stored", 14) +
      padL("Rebuilt", 14) +
      "   Shift"
  );
  console.log("-".repeat(92));

  for (const r of changed) {
    const oldSigned = r.oldMode === "Cr" ? -Math.abs(r.oldBal) : r.oldBal;
    const flip = r.oldMode && r.oldMode !== r.newMode ? "  ⚠ side flip" : "";
    console.log(
      pad(r.name, 26) +
        padL(r.txns, 5) +
        padL(money(r.opening), 13) +
        padL(`${money(r.oldBal)} ${r.oldMode || "--"}`, 14) +
        padL(`${money(r.newBal)} ${r.newMode}`, 14) +
        padL(money(round2(r.newBal - oldSigned)), 12) +
        flip
    );
  }

  const worst = [...changed].sort(
    (a, b) =>
      Math.abs(b.newBal - (b.oldMode === "Cr" ? -Math.abs(b.oldBal) : b.oldBal)) -
      Math.abs(a.newBal - (a.oldMode === "Cr" ? -Math.abs(a.oldBal) : a.oldBal))
  )[0];
  if (worst) {
    console.log(
      `\nLargest correction: ${worst.name} — stored ${money(worst.oldBal)} ` +
        `${worst.oldMode || "--"}, rebuilt ${money(worst.newBal)} ${worst.newMode}.`
    );
  }

  if (orphans.length) {
    console.log(
      `\n⚠  ${orphans.length} party name(s) appear on invoices/vouchers with no ` +
        `matching customer record. Their movements are NOT reflected anywhere:`
    );
    for (const o of orphans.slice(0, 20)) console.log(`     - ${o}`);
    if (orphans.length > 20) console.log(`     ... and ${orphans.length - 20} more`);
    console.log(
      "   These are usually renamed customers (ledgers join on name, not _id)."
    );
  }

  return changed;
}

/* ---------------------------------------------------------------- write --- */

async function write(rows, changed) {
  const file = writeBackup("customer-balances", {
    note: "Pre-migration customer balance values (signed-balance migration).",
    customers: rows.map((r) => ({
      _id: String(r._id),
      name: r.name,
      lastBal: r.oldBal,
      lastMode: r.oldMode,
      openingBal: r.oldOpeningBal,
      openingMode: r.oldOpeningMode,
    })),
  });
  console.log(`\n💾 Backup written to ${file}`);

  const ok = await confirmYes(
    `\nApply ${changed.length} balance correction(s) to the database? Type "yes": `,
    ASSUME_YES
  );
  if (!ok) {
    console.log("Aborted. Nothing was written.\n");
    return;
  }

  const ops = rows.map((r) => ({
    updateOne: {
      filter: { _id: r._id },
      update: {
        $set: {
          lastBal: r.newBal,
          lastMode: r.newMode,
          openingBal: r.opening,
          openingMode: modeOf(r.opening),
        },
      },
    },
  }));

  const res = await customers.bulkWrite(ops, { ordered: false });
  console.log(
    `\n✅ Updated ${res.modifiedCount} customer record(s). ` +
      `Opening balances normalised to signed form as well.\n`
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
    const result = await rebuild();
    const changed = report(result);
    if (APPLY && changed.length) await write(result.rows, changed);
    else if (!APPLY && changed.length)
      console.log("\nDry run only — nothing written. Re-run with --apply.\n");
  } finally {
    await mongoose.disconnect();
  }
}

// Only connect to a database when run as a script, so the pure rebuild above
// can be imported by tests.
const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    console.error("\nMigration failed:", err);
    process.exit(1);
  });
}
