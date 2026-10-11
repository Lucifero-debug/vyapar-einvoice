/**
 * Planning the contra-row backfill.
 *
 * Pure and dependency-free, like the rest of lib/*.mjs, so `node` can run the
 * fixture tests directly -- which is the whole reason this is not simply part
 * of scripts/backfill-gl-legs.mjs. The four existing backfill suites import
 * their logic FROM their scripts, and every one of them needs a real
 * node_modules to run at all; a migration that rewrites a client's books is
 * the last thing that should be hard to test.
 *
 * The script keeps the database work: reading, backing up, writing, and
 * moving the head balances.
 */

import { round2 } from "./balance.mjs";
import { glDeltas, glRows, isMaterialDifference } from "./invoiceGl.mjs";

/**
 * Which accounts an invoice's existing rows already cover.
 *
 * Keyed on the account the row BELONGS to (`customerName`), never on the
 * contra column: "Sales Account" has sat in the contra column of every party
 * row since the beginning, and treating that as evidence of a Sales row would
 * make the script decide every invoice was already done.
 */
export const postedAccounts = (rows = []) =>
  new Set(rows.map((r) => String(r?.customerName ?? "").trim()).filter(Boolean));

/**
 * Plan the backfill. Pure, so it can be exercised against fixtures without a
 * database -- see scripts/gl-backfill.test.mjs.
 *
 * `rowsByInvoice` maps an invoice's `_id` (as a string) to its existing ledger
 * rows.
 */
export function planBackfill({ allInvoices = [], rowsByInvoice = new Map() } = {}) {
  const plan = [];
  const skipped = [];
  const material = [];
  const counts = {
    invoices: allInvoices.length,
    alreadyComplete: 0,
    toPost: 0,
    rowsToWrite: 0,
    noContraNeeded: 0,
  };

  for (const invoice of allInvoices) {
    const id = String(invoice._id);
    const existing = rowsByInvoice.get(id) || [];
    const already = postedAccounts(existing);

    const derived = glDeltas(invoice);
    const partyName = String(invoice?.customer?.name ?? "").trim();
    const contraMoves = derived.moves.filter((m) => m.account !== partyName);

    if (!contraMoves.length) {
      // A nil invoice, or one whose lines carry no taxable value at all. There
      // is no contra to write; that is not a failure.
      counts.noContraNeeded += 1;
      skipped.push({ invoiceNo: invoice.invoiceNo, reason: "nothing to post" });
      continue;
    }

    // Any contra head already present means this invoice has been posted or
    // backfilled. Partial coverage is treated as done rather than topped up:
    // adding rows beside existing ones would double the head's movement, and a
    // half-posted invoice is a thing to look at, not to guess at.
    const covered = contraMoves.filter((m) => already.has(m.account));
    if (covered.length) {
      counts.alreadyComplete += 1;
      skipped.push({
        invoiceNo: invoice.invoiceNo,
        reason:
          covered.length === contraMoves.length
            ? "already posted"
            : `PARTLY posted (${covered.length} of ${contraMoves.length}) -- look at this one`,
        partial: covered.length !== contraMoves.length,
      });
      continue;
    }

    if (isMaterialDifference(derived.difference)) {
      // Still posted -- the books balance either way -- but named, because a
      // difference this size is freight or a bad extraction rather than
      // rounding, and burying it in Round Off is how it stays buried.
      material.push({
        invoiceNo: invoice.invoiceNo,
        party: partyName,
        finalAmount: derived.finalAmount,
        taxable: derived.taxable,
        tax: derived.tax,
        difference: derived.difference,
      });
    }

    const rows = glRows({
      invoice,
      invoiceNo: invoice.invoiceNo,
      date: invoice.date || invoice.createdAt || new Date(),
      voucherId: invoice._id,
      paymentType: invoice.paymentType,
    });

    counts.toPost += 1;
    counts.rowsToWrite += rows.length;

    plan.push({
      _id: invoice._id,
      invoiceNo: invoice.invoiceNo,
      party: partyName,
      type: invoice.type,
      isReturn: Boolean(invoice.return),
      taxable: derived.taxable,
      tax: derived.tax,
      difference: derived.difference,
      interState: derived.interState,
      rows,
      moves: contraMoves,
    });
  }

  return { plan, skipped, material, counts };
}

/**
 * The net movement per account across the whole plan.
 *
 * Applied to `customers.lastBal` in one update each rather than one per
 * invoice: a book of ten thousand invoices touches six heads, not sixty
 * thousand.
 */
export function netMoves(plan = []) {
  const moves = new Map();
  for (const entry of plan) {
    for (const move of entry.moves || []) {
      moves.set(move.account, round2((moves.get(move.account) || 0) + move.delta));
    }
  }
  return moves;
}

