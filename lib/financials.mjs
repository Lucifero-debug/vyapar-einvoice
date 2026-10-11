/**
 * Trial Balance, Trading Account, Profit & Loss and Balance Sheet.
 *
 * Pure and dependency-free, like the rest of lib/*.mjs, so `node` can run
 * scripts/financials.test.mjs directly. Never import Mongoose in here.
 *
 *
 * SIGNS, ONCE, BECAUSE EVERYTHING BELOW DEPENDS ON THEM
 * ----------------------------------------------------
 * A position is SIGNED: positive is Dr, negative is Cr (lib/balance.mjs).
 * So, for a firm that is trading normally:
 *
 *   debtors, cash, stock, fixed assets   positive  (Dr)
 *   creditors, capital, loans, GST owed  negative  (Cr)
 *   purchases, expenses                  positive  (Dr)
 *   sales, income                        negative  (Cr)
 *
 * Every entry sums to zero (lib/invoiceGl.mjs guarantees it per invoice), so
 * the sum of ALL positions is zero. That single fact is what makes the trial
 * balance foot and the balance sheet balance, and it is asserted directly
 * rather than inferred.
 *
 *
 * TWO DIFFERENT PROFIT FIGURES, AND WHY
 * -------------------------------------
 * The Trading and P&L statements measure a PERIOD: what was sold and spent
 * between two dates. The Balance Sheet measures a POSITION: what is owned and
 * owed on one date. They are not the same arithmetic and they do not have to
 * agree.
 *
 * This app never posts year-end closing entries -- nothing transfers a
 * nominal balance into Capital -- so a sales account's closing balance is its
 * whole history, not just this year's. The Balance Sheet therefore carries
 * ACCUMULATED profit (every nominal account since the books opened, plus
 * closing stock) and the P&L shows the PERIOD's profit. For a book run from
 * its first entry the two coincide; for a mid-year window they differ by the
 * earlier profit, which is exactly what retained earnings means. Both are
 * labelled, and `profitDiffers` says when to explain it.
 *
 *
 * STOCK IS NOT IN THE LEDGER
 * --------------------------
 * Purchases are expensed to Purchase Account; nothing posts a stock asset.
 * Stock is derived from the item ledger at the item master's cost
 * (lib/itemStock.mjs), which is why `openingStock` and `closingStock` arrive
 * as figures rather than as account balances.
 *
 * That is also why closing stock appears TWICE and must: credited in the
 * Trading account (raising gross profit) and debited on the Balance Sheet (as
 * an asset). Those two are the two halves of one entry, and dropping either
 * breaks the sheet by exactly the stock value.
 */

import { modeOf, round2 } from "./balance.mjs";
import { istDayNumber } from "./istDate.mjs";
import { ACCOUNT_GROUPS, groupByName, primaryGroups, resolveGroup } from "./accountGroups.mjs";

const text = (value) => String(value ?? "").trim();
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** Where an account whose group means nothing is shown. Sigfa's group 4. */
export const SUSPENSE_GROUP = "Suspense A/c";

export const STATEMENT_KINDS = ["trial", "trading", "pl", "balance"];

export const STATEMENT_TITLES = {
  trial: "Trial Balance",
  trading: "Trading Account",
  pl: "Profit & Loss Account",
  balance: "Balance Sheet",
};

export const isStatementKind = (kind) => STATEMENT_KINDS.includes(text(kind));

/**
 * Every account's opening, movement and closing position.
 *
 * Computed from the rows, never from `Customer.lastBal`: that field is a cache
 * the posting path maintains, and a figure a trial balance must foot on cannot
 * be a cache. Dates compared as IST calendar days, for the reason set out in
 * lib/accountBooks.mjs -- a server-day comparison gave different answers on
 * this container and on Vercel.
 *
 * An account whose group means nothing lands in Suspense, named rather than
 * guessed: filing it under Sundry Debtors would put it on the balance sheet as
 * an asset on no evidence at all.
 */
export const accountPositions = ({ accounts = [], rows = [], from, to } = {}) => {
  const start = istDayNumber(from);
  const end = istDayNumber(to);

  const byAccount = new Map();
  for (const row of rows) {
    const name = text(row?.customerName);
    if (!name) continue;
    const day = istDayNumber(row?.date);
    if (day === null) continue;
    if (end !== null && day > end) continue;

    if (!byAccount.has(name)) byAccount.set(name, { before: 0, within: 0 });
    const bucket = byAccount.get(name);
    const delta = num(row.debit) - num(row.credit);
    if (start !== null && day < start) bucket.before = round2(bucket.before + delta);
    else bucket.within = round2(bucket.within + delta);
  }

  // Every account in the master, plus any name that has rows but no master
  // record -- the latter counted from zero rather than dropped, because money
  // that moved is money that moved.
  const seen = new Set();
  const out = [];

  for (const account of accounts) {
    const name = text(account?.name);
    if (!name) continue;
    seen.add(name);
    const bucket = byAccount.get(name) || { before: 0, within: 0 };
    const opening = round2(num(account?.openingBal) + bucket.before);
    const group = resolveGroup(account?.group);
    out.push({
      name,
      group: group?.name || SUSPENSE_GROUP,
      statedGroup: text(account?.group),
      mapped: Boolean(group),
      opening,
      movement: bucket.within,
      closing: round2(opening + bucket.within),
    });
  }

  for (const [name, bucket] of byAccount) {
    if (seen.has(name)) continue;
    out.push({
      name,
      group: SUSPENSE_GROUP,
      statedGroup: "",
      mapped: false,
      orphan: true,
      opening: bucket.before,
      movement: bucket.within,
      closing: round2(bucket.before + bucket.within),
    });
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
};

/** The positions belonging to one statement: 'T', 'P' or 'B'. */
export const positionsFor = (positions = [], statement) =>
  positions.filter((p) => (groupByName(p.group)?.statement || "B") === statement);

/** Signed sum of a set of positions, by whichever figure the statement wants. */
export const sumOf = (positions = [], field = "closing") =>
  round2(positions.reduce((total, p) => round2(total + num(p[field])), 0));

/* ------------------------------------------------------------------ *
 *  Trial Balance
 * ------------------------------------------------------------------ */

/**
 * Every account's closing position, grouped, with Dr and Cr columns.
 *
 * CLOSING for every account, not movement -- that uniformity is what makes it
 * foot. A trial balance that showed nominal accounts by period and real
 * accounts by position would only balance when the period began at the first
 * entry.
 *
 * `totalOnly` groups (Sigfa's TrialGrp: Sundry Debtors, Sundry Creditors,
 * Local Purchase) collapse to one line. Eighty debtors on a trial balance is
 * not a report anybody reads, and Sigfa reached the same conclusion.
 */
export const trialBalance = (positions = [], { expand = false } = {}) => {
  const groups = [];
  let debit = 0;
  let credit = 0;

  // Primary groups in Sigfa's order, each followed by its sub-groups.
  const sequence = [];
  for (const primary of primaryGroups()) {
    sequence.push(primary);
    for (const sub of ACCOUNT_GROUPS.filter((g) => g.under === primary.code)) sequence.push(sub);
  }

  for (const group of sequence) {
    const members = positions.filter((p) => p.group === group.name);
    if (!members.length) continue;

    // THE COLUMNS ARE SUMMED PER ACCOUNT, never from the group's net, and
    // never from the collapsed line. Two reasons, and the second is the one
    // that matters:
    //
    //   A group holding a large Dr and a large Cr nets to almost nothing --
    //   Duties And Taxes, with output tax Cr and input tax Dr, is exactly
    //   that -- so a netted column total understates both sides of the book.
    //
    //   Collapsing is a DISPLAY choice. If the totals came from the group
    //   lines, expanding Sundry Debtors would change the trial balance's
    //   totals, which is a reported figure moving because somebody clicked
    //   something. Both still foot, which is what makes that kind of bug
    //   invisible.
    for (const member of members) {
      const value = round2(member.closing);
      if (value > 0) debit = round2(debit + value);
      else if (value < 0) credit = round2(credit + Math.abs(value));
    }

    const total = sumOf(members, "closing");

    groups.push({
      group: group.name,
      code: group.code,
      main: group.main,
      under: group.under,
      statement: group.statement,
      // The group's NET, as a subtotal. Deliberately not the sum of the Dr and
      // Cr columns above -- a group containing both nets, and saying so is the
      // point of a subtotal.
      total,
      mode: modeOf(total),
      collapsed: Boolean(group.totalOnly) && !expand,
      accounts: group.totalOnly && !expand ? [] : members,
      accountCount: members.length,
      // Carried even when collapsed, so a reader can see that the one line
      // standing for eighty debtors is a net of both sides.
      debit: round2(
        members.reduce((t, m) => (m.closing > 0 ? round2(t + m.closing) : t), 0)
      ),
      credit: round2(
        members.reduce((t, m) => (m.closing < 0 ? round2(t - m.closing) : t), 0)
      ),
    });
  }

  // A suspense bucket for anything whose group did not resolve. Listed last
  // and never hidden: an unfiled account is the one thing on a trial balance
  // that silently moves a figure into the wrong half of the sheet.
  const unfiled = positions.filter((p) => !p.mapped);

  return {
    groups,
    totals: { debit, credit },
    difference: round2(debit - credit),
    // The property the whole exercise rests on. Every entry sums to zero, so
    // the columns must be equal; anything else means an entry was written
    // one-sided, and the number says by how much.
    balanced: round2(debit - credit) === 0,
    unfiled,
    accounts: positions.length,
  };
};

/* ------------------------------------------------------------------ *
 *  Trading Account
 * ------------------------------------------------------------------ */

/**
 * Opening stock + purchases + direct expenses against sales + direct income +
 * closing stock, for the period.
 *
 * MOVEMENT, not closing position: a Trading account answers "what happened
 * between these dates".
 *
 * Expenses are naturally Dr (positive) and income Cr (negative), so the credit
 * side is negated to present it as a magnitude. A sales account sitting Dr --
 * which happens when returns exceed sales in a short window -- comes through
 * as a negative on the credit side rather than being flipped to the other
 * column, because moving it would hide what happened.
 */
export const tradingAccount = ({ positions = [], openingStock = 0, closingStock = 0 } = {}) => {
  const trading = positionsFor(positions, "T");

  const sideOf = (left) =>
    trading.filter((p) => Boolean(groupByName(p.group)?.left) === left);

  const debitAccounts = sideOf(true);
  const creditAccounts = sideOf(false);

  const open = round2(openingStock);
  const close = round2(closingStock);

  const left = [
    { label: "Opening Stock", amount: open, derived: true },
    ...debitAccounts.map((p) => ({ label: p.name, group: p.group, amount: round2(p.movement) })),
  ];
  const right = [
    ...creditAccounts.map((p) => ({ label: p.name, group: p.group, amount: round2(-p.movement) })),
    { label: "Closing Stock", amount: close, derived: true },
  ];

  const leftTotal = round2(left.reduce((t, r) => round2(t + r.amount), 0));
  const rightTotal = round2(right.reduce((t, r) => round2(t + r.amount), 0));
  const gross = round2(rightTotal - leftTotal);

  return {
    left,
    right,
    leftTotal,
    rightTotal,
    openingStock: open,
    closingStock: close,
    // One figure, signed, and two labels -- rather than two fields where one
    // is always zero and every reader has to check which.
    gross,
    grossProfit: gross > 0 ? gross : 0,
    grossLoss: gross < 0 ? Math.abs(gross) : 0,
    // Both sides including the result, which is what a printed account shows.
    footing: round2(Math.max(leftTotal + Math.max(gross, 0), rightTotal + Math.max(-gross, 0))),
  };
};

/* ------------------------------------------------------------------ *
 *  Profit & Loss
 * ------------------------------------------------------------------ */

/**
 * Indirect expenses against indirect income, with the gross result carried in.
 *
 * The gross figure comes from the Trading account rather than being recomputed,
 * so the two statements cannot disagree about it.
 */
export const profitAndLoss = ({ positions = [], gross = 0 } = {}) => {
  const pl = positionsFor(positions, "P");
  const sideOf = (left) => pl.filter((p) => Boolean(groupByName(p.group)?.left) === left);

  const g = round2(gross);

  const left = [
    ...(g < 0 ? [{ label: "Gross Loss b/d", amount: Math.abs(g), carried: true }] : []),
    ...sideOf(true).map((p) => ({ label: p.name, group: p.group, amount: round2(p.movement) })),
  ];
  const right = [
    ...(g > 0 ? [{ label: "Gross Profit b/d", amount: g, carried: true }] : []),
    ...sideOf(false).map((p) => ({ label: p.name, group: p.group, amount: round2(-p.movement) })),
  ];

  const leftTotal = round2(left.reduce((t, r) => round2(t + r.amount), 0));
  const rightTotal = round2(right.reduce((t, r) => round2(t + r.amount), 0));
  const net = round2(rightTotal - leftTotal);

  return {
    left,
    right,
    leftTotal,
    rightTotal,
    net,
    netProfit: net > 0 ? net : 0,
    netLoss: net < 0 ? Math.abs(net) : 0,
    footing: round2(Math.max(leftTotal + Math.max(net, 0), rightTotal + Math.max(-net, 0))),
  };
};

/* ------------------------------------------------------------------ *
 *  Balance Sheet
 * ------------------------------------------------------------------ */

/**
 * Profit since the books opened: every nominal account's whole position, plus
 * closing stock.
 *
 * Nominal positions are Cr for income and Dr for expense, so their signed sum
 * is negative when the firm has made money -- hence the negation. Closing
 * stock is added because it is credited in the Trading account and has no
 * ledger row of its own.
 *
 * This, not the period's net profit, is what makes the sheet balance -- see
 * the note at the top of this file.
 */
export const accumulatedProfit = ({ positions = [], closingStock = 0 } = {}) => {
  const nominal = [...positionsFor(positions, "T"), ...positionsFor(positions, "P")];
  return round2(-sumOf(nominal, "closing") + round2(closingStock));
};

/**
 * What is owned and owed on one date.
 *
 * Liabilities left, assets right -- the Indian horizontal form, which is what
 * Sigfa's `LeftP` column encodes (lib/accountGroups.mjs).
 *
 * It balances by construction, and the test proves it rather than trusting it:
 * every entry sums to zero, so real positions plus nominal positions are zero;
 * accumulated profit is defined as minus the nominal positions plus closing
 * stock; and closing stock is added to the assets. The two sides then differ
 * by nothing.
 */
export const balanceSheet = ({ positions = [], closingStock = 0, profit = null } = {}) => {
  const real = positionsFor(positions, "B");
  const sideOf = (left) => real.filter((p) => Boolean(groupByName(p.group)?.left) === left);

  const accumulated = profit === null ? accumulatedProfit({ positions, closingStock }) : round2(profit);

  // Liabilities are Cr, so their closing positions are negative; presented as
  // magnitudes. An account on the liabilities side sitting Dr -- an overpaid
  // supplier, say -- comes through negative rather than being moved across,
  // because moving it would misstate both halves.
  const liabilities = [
    ...sideOf(true).map((p) => ({ label: p.name, group: p.group, amount: round2(-p.closing) })),
    {
      label: accumulated >= 0 ? "Profit & Loss A/c" : "Profit & Loss A/c (loss)",
      amount: accumulated,
      carried: true,
    },
  ];

  const assets = [
    ...sideOf(false).map((p) => ({ label: p.name, group: p.group, amount: round2(p.closing) })),
    { label: "Closing Stock", amount: round2(closingStock), derived: true },
  ];

  const liabilitiesTotal = round2(liabilities.reduce((t, r) => round2(t + r.amount), 0));
  const assetsTotal = round2(assets.reduce((t, r) => round2(t + r.amount), 0));

  return {
    liabilities,
    assets,
    liabilitiesTotal,
    assetsTotal,
    profit: accumulated,
    difference: round2(assetsTotal - liabilitiesTotal),
    balanced: round2(assetsTotal - liabilitiesTotal) === 0,
  };
};

/* ------------------------------------------------------------------ *
 *  What the reader has to be told
 * ------------------------------------------------------------------ */

/**
 * Everything that would otherwise make a statement quietly wrong.
 *
 * A financial statement that cannot be trusted has to say so on its face. All
 * four of these have been live possibilities in this app:
 */
export const statementWarnings = ({
  positions = [],
  trial,
  openingStock = 0,
  closingStock = 0,
  periodNet = null,
  accumulated = null,
} = {}) => {
  const warnings = [];

  if (trial && !trial.balanced) {
    warnings.push(
      `The trial balance is out by ${Math.abs(trial.difference).toFixed(2)}. Some entry was written one-sided -- run "npm run backfill:gl-legs" if invoices predate the contra posting.`
    );
  }

  const unfiled = positions.filter((p) => !p.mapped);
  if (unfiled.length) {
    warnings.push(
      `${unfiled.length} account${unfiled.length === 1 ? "" : "s"} ${
        unfiled.length === 1 ? "is" : "are"
      } not filed under a known group, so ${unfiled.length === 1 ? "it is" : "they are"} shown under Suspense A/c: ${unfiled
        .slice(0, 6)
        .map((p) => p.name)
        .join(", ")}${unfiled.length > 6 ? ", …" : ""}.`
    );
  }

  const orphans = positions.filter((p) => p.orphan);
  if (orphans.length) {
    warnings.push(
      `${orphans.length} name${orphans.length === 1 ? " has" : "s have"} ledger rows but no account record: ${orphans
        .slice(0, 6)
        .map((p) => p.name)
        .join(", ")}${orphans.length > 6 ? ", …" : ""}.`
    );
  }

  // A firm that has also booked stock as an account balance would be counting
  // it twice, since the statements take stock from the item ledger.
  const stockGroups = ["Opening Stock", "Stock In Hand", "Manufacturing Stock", "Stock In Progress"];
  const stockAccounts = positions.filter(
    (p) => stockGroups.includes(p.group) && round2(p.closing) !== 0
  );
  if (stockAccounts.length) {
    warnings.push(
      `${stockAccounts.map((p) => p.name).join(", ")} ${
        stockAccounts.length === 1 ? "holds" : "hold"
      } a balance in a stock group, and stock is also valued from the item ledger -- that is counted twice.`
    );
  }

  if (round2(closingStock) === 0 && positions.some((p) => p.group === "Purchase Account")) {
    warnings.push(
      "Closing stock is nil while purchases have been booked, so the whole purchase is charged against this period's profit. Check the item costs, or type a figure."
    );
  }

  if (
    periodNet !== null &&
    accumulated !== null &&
    round2(periodNet) !== round2(accumulated)
  ) {
    warnings.push(
      `The P&L shows ${round2(periodNet).toFixed(2)} for this period; the balance sheet carries ${round2(
        accumulated
      ).toFixed(2)} accumulated since the books opened. Nothing closes a nominal account at year end in this app, so the two differ by the earlier profit.`
    );
  }

  if (round2(openingStock) !== 0) {
    warnings.push(
      `Opening stock of ${round2(openingStock).toFixed(2)} is charged in the Trading account. It has no ledger entry behind it, so the balance sheet does not carry the matching asset -- compare the period result with care.`
    );
  }

  return warnings;
};

/** Does the period's result differ from what the sheet carries? */
export const profitDiffers = (periodNet, accumulated) =>
  round2(num(periodNet)) !== round2(num(accumulated));

/* ------------------------------------------------------------------ *
 *  Valuing the stock
 * ------------------------------------------------------------------ */

/**
 * What the stock on hand is worth, at the item master's cost.
 *
 * `stock` is what `buildStockIndex` in lib/itemStock.mjs returns -- quantities
 * summed from the stock ledger rather than read off a cached balance, for the
 * reason documented there.
 *
 * `missingCosts` is the part that earns its keep. An item with no cost in the
 * master contributes nothing, so a closing stock figure computed over a master
 * half of whose items are unpriced is confidently too low -- and it feeds
 * straight into gross profit, where nobody can see the hole. Naming them lets
 * the statement say "valued on 40 of 62 items" instead.
 *
 * Items with no stock are skipped either way: an unpriced item with nothing on
 * the shelf is not a gap in the valuation.
 */
export const stockValue = ({ stock = [], items = [] } = {}) => {
  const costOf = new Map(
    items.map((i) => [text(i?.name).toLowerCase(), num(i?.cost)])
  );

  let value = 0;
  let valued = 0;
  const missingCosts = [];

  for (const entry of stock) {
    const name = text(entry?.name);
    const quantity = num(entry?.quantity);
    if (!name || quantity === 0) continue;

    const cost = costOf.get(name.toLowerCase()) || 0;
    if (cost <= 0) {
      missingCosts.push(name);
      continue;
    }
    value = round2(value + quantity * cost);
    valued += 1;
  }

  return {
    value,
    valued,
    // Counted over items that actually HOLD stock, so the figure the page
    // shows is about the valuation and not about the size of the master.
    held: valued + missingCosts.length,
    missingCosts,
  };
};
