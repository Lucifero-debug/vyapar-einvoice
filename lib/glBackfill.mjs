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
 * The same, folded: trimmed and lower-cased. The app posts under the head's
 * STORED name (lib/glAccounts.mjs finds it case-insensitively), so a firm
 * whose head is "Sales account" has rows under exactly that. Compared
 * exactly, such an invoice read as unposted -- and the backfill planned to
 * post it again.
 */
export const postedHeads = (rows = []) =>
  new Set([...postedAccounts(rows)].map((name) => name.toLowerCase()));

/** Has an account been posted, by the folded comparison above? */
export const isPosted = (posted, account) => posted.has(String(account ?? "").trim().toLowerCase());

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
    noFirm: 0,
  };

  for (const invoice of allInvoices) {
    const id = String(invoice._id);

    // An invoice that belongs to no firm is invisible to the app, and its
    // rows would belong to nobody. Named, never posted.
    if (invoice.companyId === undefined || invoice.companyId === null || invoice.companyId === "") {
      counts.noFirm = (counts.noFirm || 0) + 1;
      skipped.push({ invoiceNo: invoice.invoiceNo, reason: "no companyId -- not posted", noFirm: true });
      continue;
    }

    const existing = rowsByInvoice.get(id) || [];
    const already = postedHeads(existing);

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
    const covered = contraMoves.filter((m) => isPosted(already, m.account));
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
      // The firm the rows and the head movements belong to. Every write the
      // script makes is keyed on it -- see netMovesByFirm.
      companyId: invoice.companyId ?? null,
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


/**
 * The net movement per head PER FIRM -- what the script applies.
 *
 * `netMoves` above sums across the whole database, which is right for a
 * one-firm install and wrong for any other: every firm has its own "Sales
 * Account", and applying the database-wide total to whichever head is found
 * first by name moves one firm's balance by every firm's sales. Keyed
 * `${companyId}|${account}`.
 */
export function netMovesByFirm(plan = []) {
  const moves = new Map();
  for (const entry of plan) {
    const firm = String(entry.companyId ?? "");
    for (const move of entry.moves || []) {
      const key = `${firm}|${move.account}`;
      const prev = moves.get(key) || { companyId: entry.companyId ?? null, account: move.account, delta: 0 };
      prev.delta = round2(prev.delta + move.delta);
      moves.set(key, prev);
    }
  }
  return moves;
}

const fold = (name) => String(name ?? "").trim().toLowerCase();

/**
 * Match the heads a firm already has to the names the posting uses.
 *
 * The app finds a head case-insensitively and posts under the name as STORED
 * (lib/glAccounts.mjs): a firm whose head is "Round off" gets rows under
 * "Round off". The backfill must do the same, or it splits the account in
 * two. Returns { names: Map(account -> stored name), missing: [account],
 * clashes: [[stored names]] } where a clash is two heads in ONE firm that
 * fold to the same name -- which head would be meant is not knowable, so the
 * script stops.
 */
export function matchHeads(heads = [], accounts = []) {
  const byFold = new Map();
  for (const h of heads) {
    const k = fold(h?.name);
    if (!k) continue;
    if (!byFold.has(k)) byFold.set(k, []);
    byFold.get(k).push(h.name);
  }
  const names = new Map();
  const missing = [];
  const clashes = [];
  for (const account of accounts) {
    const hits = byFold.get(fold(account)) || [];
    if (hits.length > 1) clashes.push(hits);
    else if (hits.length === 1) names.set(account, hits[0]);
    else missing.push(account);
  }
  return { names, missing, clashes };
}

/**
 * A head's stored balance against its own rows.
 *
 * `lastBal` should equal openingBal plus every row's debit less credit
 * (signed, positive Dr -- lib/balance.mjs). Returns the drift, 0 when they
 * agree. Checked before the backfill (a head that already drifts is reported,
 * not fixed) and after it (the backfill must not introduce any).
 */
export function headDrift(head = {}, rows = []) {
  const fromRows = rows.reduce(
    (sum, r) => round2(sum + (Number(r?.debit) || 0) - (Number(r?.credit) || 0)),
    round2(Number(head?.openingBal) || 0)
  );
  return round2((Number(head?.lastBal) || 0) - fromRows);
}

/**
 * The running `balance` for every row of one head, oldest first -- the same
 * order and arithmetic as lib/runningBalances.mjs, so the stored figure is
 * the one the reports show. Returns [{ _id, balance }].
 */
export function runningBalances(head = {}, rows = []) {
  const sorted = [...rows].sort((a, b) => {
    const da = new Date(a?.date).getTime() || 0;
    const dbt = new Date(b?.date).getTime() || 0;
    if (da !== dbt) return da - dbt;
    return String(a?._id) < String(b?._id) ? -1 : String(a?._id) > String(b?._id) ? 1 : 0;
  });
  let running = Number(head?.openingBal) || 0;
  return sorted.map((row) => {
    running = round2(running + (Number(row?.debit) || 0) - (Number(row?.credit) || 0));
    return { _id: row._id, balance: running };
  });
}
