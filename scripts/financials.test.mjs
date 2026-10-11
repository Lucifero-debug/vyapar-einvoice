/**
 * Fixture tests for the general-ledger legs and the four financial statements.
 *
 *   node scripts/financials.test.mjs
 *
 * ONE PROPERTY MATTERS MORE THAN ALL THE OTHERS: every entry sums to zero, so
 * the trial balance foots and the balance sheet balances. Everything below is
 * in service of that, because a statement that is wrong by a consistent amount
 * still looks like a statement -- the columns line up, the totals print, and
 * nothing on the page says the sales figure is missing.
 *
 * That was the actual state of this app until now. An invoice posted the
 * party's side and named "Sales Account" in the contra column as TEXT, with no
 * row owned by that account and nothing at all for GST. Every per-account
 * report was right. A trial balance would have been short by exactly sales
 * plus tax, and short silently.
 *
 * So the four failure modes:
 *
 *   1. A ONE-SIDED ENTRY. Checked for every combination of sale, purchase,
 *      return, intra-state and inter-state, and at odd paisa values where
 *      halving the tax can lose or gain one.
 *
 *   2. THE WRONG SIDE. Liabilities left and assets right is Sigfa's LeftP
 *      column and the Indian horizontal form. Swapping them produces a sheet
 *      that still balances, with the two halves exchanged.
 *
 *   3. STOCK COUNTED ONCE OR THRICE. Closing stock is credited in the Trading
 *      account AND debited on the Balance Sheet -- two halves of one entry.
 *      Dropping either breaks the sheet by exactly the stock value.
 *
 *   4. A DISPLAY CHOICE MOVING A FIGURE. Collapsing a trial-balance group must
 *      not change its totals. Both versions foot, which is what makes that
 *      kind of bug invisible.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  GL_ACCOUNTS,
  GL_ACCOUNT_GROUPS,
  PURCHASE_ACCOUNT,
  ROUNDING_TOLERANCE,
  ROUND_OFF_ACCOUNT,
  SALES_ACCOUNT,
  TAX_ACCOUNTS,
  glDeltas,
  glRows,
  isInterState,
  isMaterialDifference,
  lineTotals,
  postingDirection,
  rowsImbalance,
  sides,
} from "../lib/invoiceGl.mjs";
import {
  balanceMovesFromRows,
  buildInvoiceLedgerRows,
  invoicePostingDeltas,
} from "../lib/invoicePosting.mjs";
import { netMoves, planBackfill, postedAccounts } from "../lib/glBackfill.mjs";
import {
  STATEMENT_KINDS,
  STATEMENT_TITLES,
  SUSPENSE_GROUP,
  accountPositions,
  accumulatedProfit,
  balanceSheet,
  isStatementKind,
  positionsFor,
  profitAndLoss,
  profitDiffers,
  statementWarnings,
  stockValue,
  sumOf,
  tradingAccount,
  trialBalance,
} from "../lib/financials.mjs";
import { groupByName } from "../lib/accountGroups.mjs";
import { canAccessPath, permissionForPath } from "../lib/roles.mjs";

let passed = 0;
const test = (name, fn) => {
  try {
    const result = fn();
    assert.equal(result, undefined, "this test body is async -- make it synchronous");
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  }
};

/** Read a project file, for the wiring checks. Declared with the helper. */
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

/** A sale of 10,000 + 18% intra-state, billed on credit. */
const invoice = (over = {}) => ({
  invoiceNo: 7,
  type: "Sale",
  return: false,
  taxType: "local",
  finalAmount: 11800,
  received: 0,
  customer: { name: "Acme Traders" },
  date: new Date("2026-07-05T00:00:00Z"),
  items: [{ taxableAmount: 10000, gstRate: 18, hsn: "7318", total: 11800 }],
  ...over,
});

/** Everything one invoice posts, through the real row builder. */
const allRows = (inv, { received = 0, cash = "Cash" } = {}) =>
  buildInvoiceLedgerRows({
    type: inv.type,
    customerName: inv.customer.name,
    cashAccountName: received ? cash : undefined,
    invoiceNo: inv.invoiceNo,
    date: inv.date,
    paymentType: "Cash",
    voucherId: `v${inv.invoiceNo}`,
    deltas: invoicePostingDeltas({
      type: inv.type,
      isReturn: Boolean(inv.return),
      finalAmount: inv.finalAmount,
      received,
    }),
    invoice: { ...inv, received },
  });

console.log("\n--- the direction of a posting ---");

test("the four cases, and only four", () => {
  assert.equal(postingDirection({ type: "Sale" }), 1);
  assert.equal(postingDirection({ type: "Sale", isReturn: true }), -1);
  assert.equal(postingDirection({ type: "Purchase" }), -1);
  assert.equal(postingDirection({ type: "Purchase", isReturn: true }), 1);
});

test("the direction is derived, not read off the party's delta", () => {
  // A nil invoice has a delta of zero and still has a direction. Reading the
  // sign off the delta would make every zero-value document a sale.
  assert.equal(postingDirection({ type: "Purchase" }), -1);
  assert.equal(postingDirection({ type: "" }), 1, "anything not a purchase is a sale");
});

test("a signed movement becomes a debit or a credit, never both", () => {
  assert.deepEqual(sides(500), { debit: 500, credit: 0 });
  assert.deepEqual(sides(-500), { debit: 0, credit: 500 });
  assert.deepEqual(sides(0), { debit: 0, credit: 0 });
});

console.log("\n--- the tax split ---");

test("intra-state halves into CGST and SGST; inter-state is IGST", () => {
  const local = glDeltas(invoice());
  const by = Object.fromEntries(local.moves.map((m) => [m.account, m.delta]));
  assert.equal(by[TAX_ACCOUNTS.outputCgst], -900);
  assert.equal(by[TAX_ACCOUNTS.outputSgst], -900);
  assert.equal(by[TAX_ACCOUNTS.outputIgst], undefined);

  const inter = glDeltas(invoice({ taxType: "central" }));
  const byI = Object.fromEntries(inter.moves.map((m) => [m.account, m.delta]));
  assert.equal(byI[TAX_ACCOUNTS.outputIgst], -1800);
  assert.equal(byI[TAX_ACCOUNTS.outputCgst], undefined);
});

test("a purchase uses the INPUT heads, which are different accounts", () => {
  // Output tax is owed to the government; input tax is claimable from it. A
  // balance sheet that netted them would hide both.
  const by = Object.fromEntries(
    glDeltas(invoice({ type: "Purchase" })).moves.map((m) => [m.account, m.delta])
  );
  assert.equal(by[TAX_ACCOUNTS.inputCgst], 900);
  assert.equal(by[TAX_ACCOUNTS.inputSgst], 900);
  assert.equal(by[TAX_ACCOUNTS.outputCgst], undefined);
  assert.notEqual(TAX_ACCOUNTS.inputCgst, TAX_ACCOUNTS.outputCgst);
});

test("halving an odd tax does not lose or gain a paisa", () => {
  // 900.01 halved twice and rounded apiece would be 450.01 + 450.01 = 900.02,
  // overstating the tax and unbalancing the entry by a paisa on every bill.
  const odd = invoice({
    finalAmount: 5900.08,
    items: [{ taxableAmount: 5000.07, gstRate: 18, hsn: "x", total: 5900.08 }],
  });
  const d = glDeltas(odd);
  const by = Object.fromEntries(d.moves.map((m) => [m.account, m.delta]));
  assert.equal(
    Math.round((by[TAX_ACCOUNTS.outputCgst] + by[TAX_ACCOUNTS.outputSgst]) * 100) / 100,
    -d.tax,
    "the two halves must add back to the tax exactly"
  );
});

test("inter-state is read from taxType, defaulting to local", () => {
  assert.equal(isInterState({ taxType: "central" }), true);
  assert.equal(isInterState({ taxType: "Inter-State" }), true);
  assert.equal(isInterState({ taxType: "local" }), false);
  // Anything unrecognised is local: splitting a tax that should be IGST puts
  // the same total in two heads of one group, while the reverse misstates a
  // return.
  assert.equal(isInterState({ taxType: "" }), false);
  assert.equal(isInterState({}), false);
});

console.log("\n--- the figures come from the lines ---");

test("taxable and tax are summed from the items, not read off the totals", () => {
  // `save-invoice` spreads the request body, and the AI upload path passes an
  // extractor's numbers straight through -- so `totalAmount` and `gst` on the
  // document are not evidence. The same conclusion lib/hsnTotals.mjs reached.
  const lying = invoice({ totalAmount: 1, gst: 1 });
  const { taxable, tax } = lineTotals(lying);
  assert.equal(taxable, 10000);
  assert.equal(tax, 1800);
});

test("a free line is taken at nil, not at cost times quantity", () => {
  const free = invoice({
    finalAmount: 0,
    items: [{ taxableAmount: 0, cost: 500, quantity: 2, gstRate: 18, hsn: "x", total: 0 }],
  });
  assert.deepEqual(lineTotals(free), { taxable: 0, tax: 0 });
});

test("an invoice with no lines posts no contra", () => {
  const empty = invoice({ finalAmount: 0, items: [] });
  assert.deepEqual(glDeltas(empty).moves, []);
  assert.deepEqual(glRows({ invoice: empty, invoiceNo: 7, date: new Date(), voucherId: "v" }), []);
});

console.log("\n--- every entry sums to zero ---");

const CASES = [
  ["sale, credit", invoice(), 0],
  ["sale, paid in full", invoice(), 11800],
  ["sale, part paid", invoice(), 5000],
  ["sale, inter-state", invoice({ taxType: "central" }), 0],
  ["sale return", invoice({ return: true }), 0],
  ["sale return, refunded", invoice({ return: true }), 11800],
  ["purchase", invoice({ type: "Purchase" }), 0],
  ["purchase, paid", invoice({ type: "Purchase" }), 11800],
  ["purchase return", invoice({ type: "Purchase", return: true }), 0],
  ["sale with freight", invoice({ finalAmount: 12300 }), 0],
  ["sale rounded down", invoice({ finalAmount: 11799.6 }), 0],
  ["odd paisa", invoice({ finalAmount: 5900.08, items: [{ taxableAmount: 5000.07, gstRate: 18, hsn: "x", total: 5900.08 }] }), 0],
  ["nil invoice", invoice({ finalAmount: 0, items: [] }), 0],
  ["zero tax", invoice({ finalAmount: 10000, items: [{ taxableAmount: 10000, gstRate: 0, hsn: "x", total: 10000 }] }), 0],
];

for (const [label, inv, received] of CASES) {
  test(`${label}: the deltas sum to zero`, () => {
    const d = glDeltas({ ...inv, received });
    const sum = d.moves.reduce((t, m) => Math.round((t + m.delta) * 100) / 100, 0);
    assert.equal(sum, 0, `moves: ${JSON.stringify(d.moves)}`);
  });

  test(`${label}: the written rows balance`, () => {
    // Through the real row builder, so this covers the party and receipt rows
    // too -- not just the contra this module adds.
    assert.equal(rowsImbalance(allRows(inv, { received })), 0);
  });
}

test("the imbalance check actually detects an imbalance", () => {
  // Every "the rows balance" assertion above goes through this helper, so a
  // helper that always answered zero would make all of them pass while
  // proving nothing.
  assert.equal(rowsImbalance([{ debit: 100, credit: 0 }]), 100);
  assert.equal(rowsImbalance([{ debit: 0, credit: 100 }]), -100);
  assert.equal(rowsImbalance([{ debit: 100, credit: 0 }, { debit: 0, credit: 100 }]), 0);
  assert.equal(rowsImbalance([]), 0);
});

test("the party's rows still sum to exactly what they used to", () => {
  // The one thing this change must NOT do is move a party balance. The
  // party's own rows are untouched; their sum is `deltas.partyDelta`, which
  // is what the balance was moved by before any of this existed.
  for (const [, inv, received] of CASES) {
    const deltas = invoicePostingDeltas({
      type: inv.type,
      isReturn: Boolean(inv.return),
      finalAmount: inv.finalAmount,
      received,
    });
    const moves = balanceMovesFromRows(allRows(inv, { received }));
    const party = moves.get(inv.customer.name) ?? 0;
    assert.equal(party, deltas.partyDelta, `${inv.type} received ${received}`);
  }
});

test("a zero net movement is not posted as a balance update", () => {
  // A fully-paid cash sale leaves the party at nil. Spending a round trip on
  // an update that changes nothing is waste, and a zero row in the map reads
  // as a movement.
  const moves = balanceMovesFromRows([
    { customerName: "Acme", debit: 100, credit: 0 },
    { customerName: "Acme", debit: 0, credit: 100 },
  ]);
  assert.equal(moves.has("Acme"), false);
});

test("a row with no owner moves no balance", () => {
  // It would otherwise create a movement against an account called "".
  const moves = balanceMovesFromRows([
    { customerName: "", debit: 500, credit: 0 },
    { customerName: "   ", debit: 500, credit: 0 },
  ]);
  assert.equal(moves.size, 0);
});

test("the same account twice nets rather than overwriting", () => {
  // An invoice billed TO the cash account names the same document twice.
  const moves = balanceMovesFromRows([
    { customerName: "Cash", debit: 500, credit: 0 },
    { customerName: "Cash", debit: 200, credit: 0 },
  ]);
  assert.equal(moves.get("Cash"), 700);
});

console.log("\n--- the round-off head ---");

test("the difference lands on Round Off, not in Sales", () => {
  // A Sales figure quietly inflated by freight stops agreeing with the GST
  // returns, which is the one number a client checks against something
  // external.
  const by = Object.fromEntries(
    glDeltas(invoice({ finalAmount: 12300 })).moves.map((m) => [m.account, m.delta])
  );
  assert.equal(by[SALES_ACCOUNT], -10000, "sales is the taxable value and nothing else");
  assert.equal(by[ROUND_OFF_ACCOUNT], -500);
});

test("no difference means no round-off row at all", () => {
  const accounts = glDeltas(invoice()).moves.map((m) => m.account);
  assert.equal(accounts.includes(ROUND_OFF_ACCOUNT), false);
});

test("a gap over a rupee is flagged, a rounding is not", () => {
  assert.equal(isMaterialDifference(0), false);
  assert.equal(isMaterialDifference(0.4), false);
  assert.equal(isMaterialDifference(ROUNDING_TOLERANCE), false, "exactly a rupee is still rounding");
  assert.equal(isMaterialDifference(1.01), true);
  assert.equal(isMaterialDifference(-500), true, "a negative gap is just as material");
});

console.log("\n--- the rows themselves ---");

test("a contra row belongs to the head and names the party", () => {
  // The convention the whole ledger follows: `customerName` is the account the
  // row belongs to, `account` is its contra. So the Sales ledger reads as a
  // list of customers.
  const rows = glRows({ invoice: invoice(), invoiceNo: 7, date: new Date(), voucherId: "v7" });
  const sales = rows.find((r) => r.customerName === SALES_ACCOUNT);
  assert.equal(sales.account, "Acme Traders");
  assert.equal(sales.credit, 10000);
  assert.equal(sales.debit, 0);
});

test("the party's own row is NOT duplicated by the contra builder", () => {
  // Writing it twice would double the party's movement -- the one mistake
  // here that moves a real balance.
  const rows = glRows({ invoice: invoice(), invoiceNo: 7, date: new Date(), voucherId: "v7" });
  assert.equal(rows.some((r) => r.customerName === "Acme Traders"), false);
});

test("every row carries the voucher id, so a delete finds it", () => {
  // `delete-invoice` and `sale-alter` both work by voucherId. A contra row
  // without one would survive the invoice it belongs to.
  for (const row of allRows(invoice(), { received: 5000 })) {
    assert.ok(row.voucherId, `${row.customerName} has no voucherId`);
  }
});

test("a contra row's running balance is left at nil, not guessed", () => {
  // recomputeLedgerBalances rewrites it end to end, and every report derives
  // it on read. A guess here would be a stale guess.
  const rows = glRows({ invoice: invoice(), invoiceNo: 7, date: new Date(), voucherId: "v7" });
  for (const row of rows) assert.equal(row.balance, 0);
});

test("a purchase posts to the Purchase head", () => {
  const by = Object.fromEntries(
    glDeltas(invoice({ type: "Purchase" })).moves.map((m) => [m.account, m.delta])
  );
  assert.equal(by[PURCHASE_ACCOUNT], 10000, "a purchase is a debit");
  assert.equal(by[SALES_ACCOUNT], undefined);
});

test("every head has a group, and it is a real one", () => {
  for (const name of GL_ACCOUNTS) {
    const group = GL_ACCOUNT_GROUPS[name];
    assert.ok(group, `${name} has no group`);
    assert.ok(groupByName(group), `${name} is filed under "${group}", which is not a group`);
  }
});

test("the heads land in the groups the statements expect", () => {
  assert.equal(groupByName(GL_ACCOUNT_GROUPS[SALES_ACCOUNT]).statement, "T");
  assert.equal(groupByName(GL_ACCOUNT_GROUPS[PURCHASE_ACCOUNT]).statement, "T");
  assert.equal(groupByName(GL_ACCOUNT_GROUPS[ROUND_OFF_ACCOUNT]).statement, "P");
  // Duties And Taxes is a liability, on the balance sheet -- not a P&L item.
  assert.equal(groupByName(GL_ACCOUNT_GROUPS[TAX_ACCOUNTS.outputCgst]).statement, "B");
  assert.equal(groupByName(GL_ACCOUNT_GROUPS[TAX_ACCOUNTS.outputCgst]).left, true);
});

console.log("\n--- positions ---");

/** A small book: a credit sale, a cash purchase, an expense. */
const book = () => {
  const accounts = [
    { name: "Acme Traders", group: "Sundry Debtors", openingBal: 0 },
    { name: "Bharat Steel", group: "Sundry Creditors", openingBal: 0 },
    { name: "Cash", group: "cash", openingBal: 5000 },
    { name: "Capital", group: "Capital A/c", openingBal: -5000 },
    { name: SALES_ACCOUNT, group: "Sales Account", openingBal: 0 },
    { name: PURCHASE_ACCOUNT, group: "Purchase Account", openingBal: 0 },
    { name: TAX_ACCOUNTS.outputCgst, group: "Duties And Taxes", openingBal: 0 },
    { name: TAX_ACCOUNTS.outputSgst, group: "Duties And Taxes", openingBal: 0 },
    { name: TAX_ACCOUNTS.inputCgst, group: "Duties And Taxes", openingBal: 0 },
    { name: TAX_ACCOUNTS.inputSgst, group: "Duties And Taxes", openingBal: 0 },
    { name: "Rent", group: "Indirect Expenses", openingBal: 0 },
  ];

  const rows = [
    ...allRows(invoice(), { received: 0 }),
    ...allRows(
      invoice({
        invoiceNo: 8,
        type: "Purchase",
        customer: { name: "Bharat Steel" },
        finalAmount: 5900,
        items: [{ taxableAmount: 5000, gstRate: 18, hsn: "x", total: 5900 }],
      }),
      { received: 0 }
    ),
    // An expense voucher: rent paid in cash.
    { customerName: "Rent", date: new Date("2026-07-10"), account: "Cash", debit: 2000, credit: 0 },
    { customerName: "Cash", date: new Date("2026-07-10"), account: "Rent", debit: 0, credit: 2000 },
  ];

  return { accounts, rows };
};

const positions = () => {
  const { accounts, rows } = book();
  return accountPositions({ accounts, rows, from: "2026-04-01", to: "2027-03-31" });
};

test("a position is the opening balance plus the movements", () => {
  const pos = positions();
  const cash = pos.find((p) => p.name === "Cash");
  assert.equal(cash.opening, 5000);
  assert.equal(cash.movement, -2000, "rent paid");
  assert.equal(cash.closing, 3000);
});

test("positions split into before and within the window", () => {
  const { accounts, rows } = book();
  const pos = accountPositions({ accounts, rows, from: "2026-08-01", to: "2027-03-31" });
  const cash = pos.find((p) => p.name === "Cash");
  assert.equal(cash.opening, 3000, "the July rent is now before the window");
  assert.equal(cash.movement, 0);
  assert.equal(cash.closing, 3000);
});

test("rows after the window are excluded entirely", () => {
  const { accounts, rows } = book();
  const pos = accountPositions({ accounts, rows, from: "2026-04-01", to: "2026-06-30" });
  assert.equal(pos.find((p) => p.name === "Cash").closing, 5000, "nothing had happened yet");
});

test("every position derives from the rows, not from lastBal", () => {
  // A trial balance must not foot on a cache. Absurd lastBal values prove
  // nothing reads them.
  const { accounts, rows } = book();
  const poisoned = accounts.map((a) => ({ ...a, lastBal: 999999, lastMode: "Dr" }));
  const pos = accountPositions({ accounts: poisoned, rows, from: "2026-04-01", to: "2027-03-31" });
  assert.equal(pos.find((p) => p.name === "Cash").closing, 3000);
});

test("an account with an unknown group goes to Suspense, named", () => {
  // Filing it under Sundry Debtors would put it on the balance sheet as an
  // asset on no evidence at all.
  const pos = accountPositions({
    accounts: [{ name: "Mystery", group: "Mumbai Party", openingBal: 100 }],
    rows: [],
  });
  assert.equal(pos[0].group, SUSPENSE_GROUP);
  assert.equal(pos[0].mapped, false);
  assert.equal(pos[0].statedGroup, "Mumbai Party");
});

test("a name with rows but no account record still appears", () => {
  // Money that moved is money that moved. Dropping it would make the trial
  // balance fail to foot with nothing to show why.
  const pos = accountPositions({
    accounts: [],
    rows: [{ customerName: "Ghost", date: new Date("2026-07-05"), debit: 500, credit: 0 }],
  });
  assert.equal(pos.length, 1);
  assert.equal(pos[0].orphan, true);
  assert.equal(pos[0].closing, 500);
});

test("a ledger row with no owner does not become an account", () => {
  // Found by a mutation that landed on this line by accident. A blank
  // `customerName` would otherwise produce a position named "" -- an account
  // that appears on the trial balance, has a balance, and does not exist.
  const pos = accountPositions({
    accounts: [],
    rows: [
      { customerName: "", date: new Date("2026-07-05"), debit: 500, credit: 0 },
      { customerName: "   ", date: new Date("2026-07-05"), debit: 500, credit: 0 },
    ],
  });
  assert.deepEqual(pos, []);
});

test("the free text the account master holds today still resolves", () => {
  const pos = accountPositions({
    accounts: [{ name: "Cash", group: "cash", openingBal: 0 }],
    rows: [],
  });
  assert.equal(pos[0].group, "Cash In Hand");
  assert.equal(pos[0].mapped, true);
});

test("positions are split by statement", () => {
  const pos = positions();
  assert.ok(positionsFor(pos, "T").some((p) => p.name === SALES_ACCOUNT));
  assert.ok(positionsFor(pos, "P").some((p) => p.name === "Rent"));
  assert.ok(positionsFor(pos, "B").some((p) => p.name === "Cash"));
  assert.equal(positionsFor(pos, "B").some((p) => p.name === SALES_ACCOUNT), false);
});

test("all positions together sum to zero", () => {
  // The fact everything else rests on.
  assert.equal(sumOf(positions(), "closing"), 0);
});

console.log("\n--- Trial Balance ---");

test("it foots", () => {
  const t = trialBalance(positions());
  assert.equal(t.totals.debit, t.totals.credit);
  assert.equal(t.difference, 0);
  assert.equal(t.balanced, true);
});

test("a one-sided entry shows up, and says by how much", () => {
  // The state the app was actually in: the party posted, sales not.
  const pos = accountPositions({
    accounts: [{ name: "Acme", group: "Sundry Debtors", openingBal: 0 }],
    rows: [{ customerName: "Acme", date: new Date("2026-07-05"), debit: 11800, credit: 0 }],
  });
  const t = trialBalance(pos);
  assert.equal(t.balanced, false);
  assert.equal(t.difference, 11800);
});

/**
 * A book whose Sundry Debtors group holds one Dr and one Cr account.
 *
 * Needed because a group with a single account, or with all its accounts on
 * one side, nets to the same figure either way -- so it cannot tell a
 * per-account total from a group total. That is precisely how the two
 * surviving mutants slipped through the first version of these tests.
 */
const mixedGroupPositions = () => [
  { name: "Owes Us", group: "Sundry Debtors", mapped: true, opening: 0, movement: 0, closing: 8000 },
  { name: "Paid Ahead", group: "Sundry Debtors", mapped: true, opening: 0, movement: 0, closing: -3000 },
  { name: "Capital", group: "Capital A/c", mapped: true, opening: 0, movement: 0, closing: -5000 },
];

test("the totals are the sum of the ACCOUNTS, not of the group nets", () => {
  // Asserted on the figures, not merely on the two columns being equal: a
  // netted total foots just as neatly, which is what makes it invisible.
  // Per account: Dr 8000, Cr 3000 + 5000. Netted by group: Dr 5000, Cr 5000.
  const t = trialBalance(mixedGroupPositions());
  assert.equal(t.totals.debit, 8000);
  assert.equal(t.totals.credit, 8000);
  assert.notEqual(t.totals.debit, 5000, "the group's net is not the column total");
});

test("collapsing a group does not change the totals", () => {
  // A reported figure must not move because somebody clicked something. Both
  // versions foot, which is what makes that kind of bug invisible -- so the
  // fixture puts a Dr and a Cr inside the collapsed group, where netting and
  // not netting give different answers.
  const pos = mixedGroupPositions();
  const collapsed = trialBalance(pos);
  const expanded = trialBalance(pos, { expand: true });
  assert.equal(collapsed.groups.find((g) => g.group === "Sundry Debtors").collapsed, true);
  assert.equal(expanded.groups.find((g) => g.group === "Sundry Debtors").collapsed, false);
  assert.deepEqual(collapsed.totals, expanded.totals);
  assert.equal(collapsed.totals.debit, 8000, "and they are the per-account figures");
  assert.equal(collapsed.balanced && expanded.balanced, true);
});

test("the columns are summed per ACCOUNT, so a mixed group shows both sides", () => {
  // Duties And Taxes holds output tax Cr and input tax Dr. Summing the group's
  // net into one column would understate both sides of the book.
  const t = trialBalance(positions());
  const tax = t.groups.find((g) => g.group === "Duties And Taxes");
  assert.equal(tax.debit, 900, "input CGST + SGST");
  assert.equal(tax.credit, 1800, "output CGST + SGST");
  assert.equal(tax.total, -900, "and the group's own net");
});

test("groups come out in Sigfa's order, parents before their children", () => {
  // The fixture files an account DIRECTLY under a primary group, so the
  // primary actually appears in the list. Without one, the earlier version of
  // this test passed by asserting "the parent comes first, or is absent",
  // which is vacuously true and tested nothing.
  const pos = [
    { name: "Sundry Thing", group: "Current Assets", mapped: true, opening: 0, movement: 0, closing: 1000 },
    { name: "Cash", group: "Cash In Hand", mapped: true, opening: 0, movement: 0, closing: 500 },
    { name: "Capital", group: "Capital A/c", mapped: true, opening: 0, movement: 0, closing: -1500 },
  ];
  const names = trialBalance(pos).groups.map((g) => g.group);
  assert.ok(names.includes("Current Assets"), "the primary group must be in the list");
  assert.ok(
    names.indexOf("Current Assets") < names.indexOf("Cash In Hand"),
    `a sub-group must follow its parent; got ${names.join(" | ")}`
  );
  assert.ok(
    names.indexOf("Capital A/c") < names.indexOf("Current Assets"),
    "liabilities before assets, as Sigfa sequences them"
  );
});

test("the collapsed line still carries both columns", () => {
  // So a reader can see that the one line standing for eighty debtors is a net
  // of both sides.
  const t = trialBalance(positions());
  const debtors = t.groups.find((g) => g.group === "Sundry Debtors");
  assert.equal(debtors.collapsed, true);
  assert.deepEqual(debtors.accounts, []);
  assert.equal(debtors.accountCount, 1);
  assert.equal(debtors.debit, 11800);
});

test("an unfiled account is reported separately and never hidden", () => {
  const pos = [
    ...positions(),
    { name: "Mystery", group: SUSPENSE_GROUP, mapped: false, opening: 0, movement: 0, closing: 0 },
  ];
  assert.equal(trialBalance(pos).unfiled.length, 1);
});

console.log("\n--- Trading Account ---");

test("purchases and opening stock against sales and closing stock", () => {
  const t = tradingAccount({ positions: positions(), openingStock: 0, closingStock: 3000 });
  assert.equal(t.left.find((r) => r.label === "Opening Stock").amount, 0);
  assert.equal(t.left.find((r) => r.label === PURCHASE_ACCOUNT).amount, 5000);
  assert.equal(t.right.find((r) => r.label === SALES_ACCOUNT).amount, 10000);
  assert.equal(t.right.find((r) => r.label === "Closing Stock").amount, 3000);
  assert.equal(t.gross, 8000);
  assert.equal(t.grossProfit, 8000);
  assert.equal(t.grossLoss, 0);
});

test("income is presented as a magnitude, not as a credit balance", () => {
  const t = tradingAccount({ positions: positions(), closingStock: 0 });
  assert.ok(t.right.every((r) => r.amount >= 0 || r.label !== SALES_ACCOUNT));
  assert.equal(t.right.find((r) => r.label === SALES_ACCOUNT).amount, 10000);
});

test("closing stock raises the gross profit one for one", () => {
  const without = tradingAccount({ positions: positions(), closingStock: 0 });
  const with3k = tradingAccount({ positions: positions(), closingStock: 3000 });
  assert.equal(with3k.gross - without.gross, 3000);
});

test("opening stock reduces it one for one", () => {
  const a = tradingAccount({ positions: positions(), openingStock: 0, closingStock: 3000 });
  const b = tradingAccount({ positions: positions(), openingStock: 1000, closingStock: 3000 });
  assert.equal(a.gross - b.gross, 1000);
});

test("a loss comes out as a loss, not a negative profit", () => {
  const t = tradingAccount({ positions: positions(), openingStock: 50000, closingStock: 0 });
  assert.ok(t.gross < 0);
  assert.equal(t.grossProfit, 0);
  assert.ok(t.grossLoss > 0);
  assert.equal(t.grossLoss, Math.abs(t.gross));
});

test("the trading account uses the period's MOVEMENT, not the position", () => {
  // It answers "what happened between these dates". Both sides are asserted:
  // checking only the credit side let a mutant that read the debit side's
  // closing position straight through.
  const { accounts, rows } = book();
  const later = accountPositions({ accounts, rows, from: "2026-08-01", to: "2027-03-31" });
  const t = tradingAccount({ positions: later, closingStock: 0 });
  assert.equal(t.right.find((r) => r.label === SALES_ACCOUNT)?.amount ?? 0, 0, "July's sale is outside");
  assert.equal(
    t.left.find((r) => r.label === PURCHASE_ACCOUNT)?.amount ?? 0,
    0,
    "and so is July's purchase -- its closing position is 5000"
  );
  assert.equal(t.gross, 0, "an empty period traded nothing");
});

console.log("\n--- Profit & Loss ---");

test("the gross result is carried in, not recomputed", () => {
  const trading = tradingAccount({ positions: positions(), closingStock: 3000 });
  const pl = profitAndLoss({ positions: positions(), gross: trading.gross });
  assert.equal(pl.right.find((r) => r.carried).amount, trading.gross);
  assert.equal(pl.left.find((r) => r.label === "Rent").amount, 2000);
  assert.equal(pl.net, 6000, "8000 gross less 2000 rent");
});

test("a gross loss is carried to the debit side", () => {
  const pl = profitAndLoss({ positions: positions(), gross: -4000 });
  assert.equal(pl.left.find((r) => r.carried).label, "Gross Loss b/d");
  assert.equal(pl.right.some((r) => r.carried), false);
});

test("a net loss comes out as a loss", () => {
  const pl = profitAndLoss({ positions: positions(), gross: -10000 });
  assert.ok(pl.net < 0);
  assert.equal(pl.netProfit, 0);
  assert.equal(pl.netLoss, Math.abs(pl.net));
});

test("the round-off head lands in the P&L, not in Sales", () => {
  const pos = accountPositions({
    accounts: [{ name: ROUND_OFF_ACCOUNT, group: GL_ACCOUNT_GROUPS[ROUND_OFF_ACCOUNT], openingBal: 0 }],
    rows: [{ customerName: ROUND_OFF_ACCOUNT, date: new Date("2026-07-05"), debit: 0, credit: 500 }],
  });
  const pl = profitAndLoss({ positions: pos, gross: 0 });
  // Its GROUP decides its side, uniformly -- Indirect Expenses is the debit
  // side, so a round-off that came out in the firm's favour shows there as a
  // NEGATIVE rather than being moved to the income column. The same rule the
  // Trading account follows for a sales head sitting Dr: moving it would hide
  // what happened, and one head made special would break the rule everywhere.
  const row = pl.left.find((r) => r.label === ROUND_OFF_ACCOUNT);
  assert.equal(row.amount, -500);
  assert.equal(pl.right.some((r) => r.label === ROUND_OFF_ACCOUNT), false);
  // And it still reaches the bottom line the right way round.
  assert.equal(pl.net, 500, "a credit round-off increases the profit");
});

console.log("\n--- Balance Sheet ---");

test("it balances", () => {
  const sheet = balanceSheet({ positions: positions(), closingStock: 3000 });
  assert.equal(sheet.assetsTotal, sheet.liabilitiesTotal);
  assert.equal(sheet.difference, 0);
  assert.equal(sheet.balanced, true);
});

test("it balances at any stock value, including none", () => {
  // Closing stock is credited in the Trading account AND debited here -- two
  // halves of one entry. Dropping either breaks the sheet by exactly the
  // stock value, which is why this is checked across a range.
  for (const stock of [0, 1, 3000, 999999.99, -500]) {
    const sheet = balanceSheet({ positions: positions(), closingStock: stock });
    assert.equal(sheet.balanced, true, `stock ${stock} left it out by ${sheet.difference}`);
  }
});

test("a sheet that does not balance says so", () => {
  // Every other fixture here balances, so forcing `balanced` to true changed
  // nothing and the flag was never actually tested. Handing it a profit figure
  // that is wrong is the cleanest way to produce a sheet that is genuinely out.
  const sheet = balanceSheet({ positions: positions(), closingStock: 3000, profit: 0 });
  assert.equal(sheet.balanced, false);
  assert.equal(sheet.difference, 6000, "and the number says by how much");
});

test("liabilities are left and assets right -- the Indian form", () => {
  // Swapping them produces a sheet that still balances with the halves
  // exchanged, which is why the sides are asserted by name.
  const sheet = balanceSheet({ positions: positions(), closingStock: 3000 });
  const liab = sheet.liabilities.map((r) => r.label);
  const assets = sheet.assets.map((r) => r.label);
  assert.ok(liab.includes("Capital"));
  assert.ok(liab.includes("Bharat Steel"), "a creditor is a liability");
  assert.ok(assets.includes("Cash"));
  assert.ok(assets.includes("Acme Traders"), "a debtor is an asset");
  assert.ok(assets.includes("Closing Stock"));
});

test("the GST heads sit on the liabilities side", () => {
  const sheet = balanceSheet({ positions: positions(), closingStock: 0 });
  assert.ok(sheet.liabilities.some((r) => r.label === TAX_ACCOUNTS.outputCgst));
  assert.equal(sheet.assets.some((r) => r.label === TAX_ACCOUNTS.outputCgst), false);
});

test("accumulated profit is every nominal account plus closing stock", () => {
  const pos = positions();
  // Sales -10000, Purchase +5000, Rent +2000  ->  nominal sum -3000
  assert.equal(sumOf([...positionsFor(pos, "T"), ...positionsFor(pos, "P")], "closing"), -3000);
  assert.equal(accumulatedProfit({ positions: pos, closingStock: 3000 }), 6000);
  assert.equal(accumulatedProfit({ positions: pos, closingStock: 0 }), 3000);
});

test("the sheet's profit and the period's profit are both reported", () => {
  // They are not the same arithmetic. Nothing closes a nominal account at
  // year end here, so a mid-year window differs by the earlier profit --
  // which is what retained earnings means.
  const pos = positions();
  const trading = tradingAccount({ positions: pos, closingStock: 3000 });
  const pl = profitAndLoss({ positions: pos, gross: trading.gross });
  const accumulated = accumulatedProfit({ positions: pos, closingStock: 3000 });
  assert.equal(pl.net, accumulated, "for a since-inception window they agree");
  assert.equal(profitDiffers(pl.net, accumulated), false);
  assert.equal(profitDiffers(1000, 2000), true);
});

test("a mid-year window makes the two differ, and says so", () => {
  const { accounts, rows } = book();
  const later = accountPositions({ accounts, rows, from: "2026-08-01", to: "2027-03-31" });
  const trading = tradingAccount({ positions: later, closingStock: 3000 });
  const pl = profitAndLoss({ positions: later, gross: trading.gross });
  const accumulated = accumulatedProfit({ positions: later, closingStock: 3000 });
  assert.equal(profitDiffers(pl.net, accumulated), true);
  // And the sheet still balances, because it uses the accumulated figure.
  assert.equal(balanceSheet({ positions: later, closingStock: 3000 }).balanced, true);
});

test("an explicit profit figure is used rather than recomputed", () => {
  // The route passes the one it already computed, so the two cannot disagree.
  const sheet = balanceSheet({ positions: positions(), closingStock: 3000, profit: 6000 });
  assert.equal(sheet.profit, 6000);
});

console.log("\n--- valuing the stock ---");

test("stock is valued at the item master's cost", () => {
  const v = stockValue({
    stock: [{ name: "MS Sheet", quantity: 100 }],
    items: [{ name: "MS Sheet", cost: 40 }],
  });
  assert.equal(v.value, 4000);
  assert.equal(v.valued, 1);
  assert.deepEqual(v.missingCosts, []);
});

test("an unpriced item is NAMED rather than valued at nil", () => {
  // It feeds straight into gross profit, where nobody can see the hole.
  const v = stockValue({
    stock: [{ name: "MS Sheet", quantity: 100 }, { name: "Mystery", quantity: 5 }],
    items: [{ name: "MS Sheet", cost: 40 }, { name: "Mystery", cost: 0 }],
  });
  assert.equal(v.value, 4000);
  assert.deepEqual(v.missingCosts, ["Mystery"]);
  assert.equal(v.valued, 1);
  assert.equal(v.held, 2);
});

test("an item with no stock is not a gap in the valuation", () => {
  const v = stockValue({
    stock: [{ name: "Empty", quantity: 0 }],
    items: [{ name: "Empty", cost: 0 }],
  });
  assert.deepEqual(v.missingCosts, []);
  assert.equal(v.held, 0);
});

test("negative stock is valued, not ignored", () => {
  // The stock report shows negatives honestly, and so must the balance sheet.
  const v = stockValue({
    stock: [{ name: "MS Sheet", quantity: -10 }],
    items: [{ name: "MS Sheet", cost: 40 }],
  });
  assert.equal(v.value, -400);
});

test("names are matched case-insensitively", () => {
  const v = stockValue({
    stock: [{ name: "ms sheet", quantity: 10 }],
    items: [{ name: "MS Sheet", cost: 40 }],
  });
  assert.equal(v.value, 400);
});

test("the valuation is rounded to paise", () => {
  // It feeds the closing stock, which feeds gross profit, which feeds the
  // balance sheet. Float dust carried that far shows up as a sheet that is out
  // by a fraction of a paisa -- and `balanced` is an exact comparison.
  const v = stockValue({
    stock: [{ name: "Wire", quantity: 1.1 }, { name: "Pin", quantity: 1.1 }],
    items: [{ name: "Wire", cost: 1.1 }, { name: "Pin", cost: 1.1 }],
  });
  assert.equal(v.value, 2.42, "1.21 + 1.21, not 2.4200000000000004");
  assert.equal(String(v.value).length <= 5, true, `got ${v.value}`);
});

console.log("\n--- what the statements admit to ---");

test("an unbalanced trial balance is said out loud, with the fix", () => {
  const pos = accountPositions({
    accounts: [{ name: "Acme", group: "Sundry Debtors", openingBal: 0 }],
    rows: [{ customerName: "Acme", date: new Date("2026-07-05"), debit: 11800, credit: 0 }],
  });
  const warnings = statementWarnings({ positions: pos, trial: trialBalance(pos) });
  assert.ok(warnings.some((w) => /out by 11800/i.test(w)));
  assert.ok(warnings.some((w) => /backfill:gl-legs/.test(w)));
});

test("unfiled accounts and orphan names are both named", () => {
  const pos = accountPositions({
    accounts: [{ name: "Mystery", group: "Mumbai Party", openingBal: 0 }],
    rows: [{ customerName: "Ghost", date: new Date("2026-07-05"), debit: 1, credit: 0 }],
  });
  const warnings = statementWarnings({ positions: pos, trial: trialBalance(pos) });
  assert.ok(warnings.some((w) => /not filed under a known group/.test(w) && /Mystery/.test(w)));
  assert.ok(warnings.some((w) => /no account record/.test(w) && /Ghost/.test(w)));
});

test("stock booked as an account balance is called out as double counting", () => {
  const pos = accountPositions({
    accounts: [{ name: "Stock A/c", group: "Stock In Hand", openingBal: 5000 }],
    rows: [],
  });
  const warnings = statementWarnings({ positions: pos, closingStock: 3000 });
  assert.ok(warnings.some((w) => /counted twice/.test(w)));
});

test("nil closing stock against real purchases is questioned", () => {
  const warnings = statementWarnings({ positions: positions(), closingStock: 0 });
  assert.ok(warnings.some((w) => /Closing stock is nil/.test(w)));
});

test("a balanced book with nothing odd warns about nothing", () => {
  // A page that always shows a warning teaches people to ignore warnings.
  const pos = positions();
  const trading = tradingAccount({ positions: pos, closingStock: 3000 });
  const pl = profitAndLoss({ positions: pos, gross: trading.gross });
  const warnings = statementWarnings({
    positions: pos,
    trial: trialBalance(pos),
    openingStock: 0,
    closingStock: 3000,
    periodNet: pl.net,
    accumulated: accumulatedProfit({ positions: pos, closingStock: 3000 }),
  });
  assert.deepEqual(warnings, []);
});

test("the four statements are named", () => {
  assert.deepEqual(STATEMENT_KINDS, ["trial", "trading", "pl", "balance"]);
  for (const k of STATEMENT_KINDS) assert.equal(typeof STATEMENT_TITLES[k], "string");
  assert.equal(isStatementKind("trial"), true);
  assert.equal(isStatementKind("cashbook"), false);
});

console.log("\n--- the backfill plan ---");

const planFor = (invoices, rowsByInvoice = new Map()) =>
  planBackfill({ allInvoices: invoices, rowsByInvoice });

test("an invoice with no contra rows is planned", () => {
  const r = planFor([{ ...invoice(), _id: "i1" }]);
  assert.equal(r.counts.toPost, 1);
  assert.equal(r.plan[0].rows.length, 3, "sales + two tax heads");
});

test("an already-posted invoice is skipped", () => {
  const r = planFor(
    [{ ...invoice(), _id: "i1" }],
    new Map([["i1", [{ customerName: SALES_ACCOUNT, debit: 0, credit: 10000 }]]])
  );
  assert.equal(r.counts.toPost, 0);
  assert.equal(r.counts.alreadyComplete, 1);
});

test("coverage is judged on the row's OWNER, not its contra column", () => {
  // "Sales Account" has sat in the contra column of every party row since the
  // beginning. Reading that as evidence of a Sales row would make the script
  // decide every invoice was already done -- and back-fill nothing.
  const partyRowOnly = new Map([
    ["i1", [{ customerName: "Acme Traders", account: SALES_ACCOUNT, debit: 11800, credit: 0 }]],
  ]);
  const r = planFor([{ ...invoice(), _id: "i1" }], partyRowOnly);
  assert.equal(r.counts.toPost, 1, "the party row is not a sales row");
});

test("a partly posted invoice is skipped AND flagged", () => {
  // Topping it up would double the head's movement. A half-posted invoice is
  // a thing to look at, not to guess at.
  const r = planFor(
    [{ ...invoice(), _id: "i1" }],
    new Map([["i1", [{ customerName: TAX_ACCOUNTS.outputCgst, debit: 0, credit: 900 }]]])
  );
  assert.equal(r.counts.toPost, 0);
  assert.ok(r.skipped.some((s) => s.partial && /PARTLY/.test(s.reason)));
});

test("a nil invoice needs nothing and is not an error", () => {
  const r = planFor([{ ...invoice({ finalAmount: 0, items: [] }), _id: "i1" }]);
  assert.equal(r.counts.noContraNeeded, 1);
  assert.equal(r.counts.toPost, 0);
  assert.deepEqual(r.material, []);
});

test("a material gap is posted and named", () => {
  const r = planFor([{ ...invoice({ finalAmount: 12300 }), _id: "i1" }]);
  assert.equal(r.counts.toPost, 1, "still posted -- the books balance either way");
  assert.equal(r.material.length, 1);
  assert.equal(r.material[0].difference, 500);
});

test("a rounding gap is posted silently", () => {
  const r = planFor([{ ...invoice({ finalAmount: 11800.4 }), _id: "i1" }]);
  assert.equal(r.counts.toPost, 1);
  assert.deepEqual(r.material, []);
});

test("the net movement per head is summed across the whole plan", () => {
  // One update per head, not one per invoice: ten thousand invoices touch six
  // heads, not sixty thousand.
  const r = planFor([
    { ...invoice(), _id: "i1" },
    { ...invoice({ invoiceNo: 8 }), _id: "i2" },
  ]);
  const moves = netMoves(r.plan);
  assert.equal(moves.get(SALES_ACCOUNT), -20000);
  assert.equal(moves.get(TAX_ACCOUNTS.outputCgst), -1800);
});

test("the planned rows balance against the party's existing row", () => {
  // The backfill's whole job: the contra it writes must be exactly the other
  // half of what is already there.
  const r = planFor([{ ...invoice(), _id: "i1" }]);
  const party = { customerName: "Acme Traders", debit: 11800, credit: 0 };
  assert.equal(rowsImbalance([party, ...r.plan[0].rows]), 0);
});

test("postedAccounts reads owners and ignores blanks", () => {
  const set = postedAccounts([
    { customerName: "Cash" },
    { customerName: "  " },
    { customerName: null },
  ]);
  assert.deepEqual([...set], ["Cash"]);
});

console.log("\n--- wiring ---");

test("both billing routes pass the invoice, so neither writes half an entry", () => {
  for (const route of ["../app/api/save-invoice/route.js", "../app/api/sale-alter/route.js"]) {
    const src = read(route);
    assert.ok(/invoice: \{/.test(src), `${route} does not pass the invoice to the row builder`);
    assert.ok(/resolveGlAccounts/.test(src), `${route} does not create the heads`);
  }
});

test("both billing routes drive their balances from the rows", () => {
  // delete-invoice reverses by reading the rows back. Posting a different way
  // from how deleting unmoves is how the two drift -- the bug that was found
  // when deleting reversed by `balanceDue` while posting moved the party by
  // finalAmount - received.
  for (const route of ["../app/api/save-invoice/route.js", "../app/api/sale-alter/route.js"]) {
    assert.ok(/balanceMovesFromRows/.test(read(route)), `${route} does not`);
  }
});

test("sale-alter reverses by what was actually posted", () => {
  const src = read("../app/api/sale-alter/route.js");
  assert.ok(/Ledger\.find\(\s*\{ voucherId/.test(src), "it must read the old rows first");
  assert.ok(/reverse\.delete\(previousName\)/.test(src), "the party is handled separately");
});

test("sale-alter settles through the invoice's own payment type", () => {
  // It used to call resolveCashAccount, which always answers "Cash" -- so
  // editing a cheque invoice moved the money into the till, and the two
  // billing routes disagreed about where the same bill settled.
  const src = read("../app/api/sale-alter/route.js");
  assert.ok(/resolvePaymentAccount\(invoiceData\.paymentType/.test(src));
  // On the CALL, not on any mention: the comment beside it names the function
  // it replaced, which is worth keeping.
  assert.equal(/resolveCashAccount\(/.test(src), false);
});

test("the rules modules stay free of Mongoose", () => {
  for (const f of ["../lib/invoiceGl.mjs", "../lib/financials.mjs", "../lib/glBackfill.mjs"]) {
    const src = read(f);
    assert.equal(/from ["']mongoose["']/.test(src), false, `${f} imports Mongoose`);
    assert.equal(/\.\.\/models\//.test(src), false, `${f} imports a model`);
  }
});

test("the backfill's planning is pure, so it can be tested at all", () => {
  // The four existing backfill suites import their logic from their scripts,
  // and every one needs a real node_modules to run. A migration that rewrites
  // a client's books should not be the hard one to test.
  const script = read("../scripts/backfill-gl-legs.mjs");
  assert.ok(/from ["']\.\.\/lib\/glBackfill\.mjs["']/.test(script));
  assert.equal(/export function planBackfill/.test(script), false, "it still holds a copy");
});

test("the backfill moves the head balances as well as writing rows", () => {
  // A backfilled invoice whose head balances were never moved would, on
  // deletion, reverse a movement that had not happened.
  const src = read("../scripts/backfill-gl-legs.mjs");
  assert.ok(/lastBal/.test(src), "it does not touch the head balances");
  assert.ok(/lastMode/.test(src), "lastMode must be kept in step with lastBal");
  assert.ok(/writeBackup/.test(src), "it writes nothing without a backup");
});

test("the backfill stamps each row with its invoice's firm", () => {
  // These scripts run outside the tenant context, so the plugin does not
  // scope them. A row written without a companyId belongs to nobody.
  assert.ok(/companyId: invoice\?\.companyId/.test(read("../scripts/backfill-gl-legs.mjs")));
});

test("the statements are behind report:read", () => {
  assert.equal(permissionForPath("/api/financials"), "report:read");
  assert.equal(permissionForPath("/financials"), "report:read");
  assert.equal(canAccessPath("accountant", "/api/financials"), true);
  assert.equal(canAccessPath("owner", "/financials"), true);
  assert.equal(canAccessPath("biller", "/api/financials"), false);
});

test("the financials route computes nothing itself", () => {
  const src = read("../app/api/financials/route.js");
  for (const fn of ["trialBalance(", "tradingAccount(", "profitAndLoss(", "balanceSheet("]) {
    assert.ok(src.includes(fn), `${fn} is not used`);
  }
  assert.equal(/row\.debit\s*-\s*row\.credit/.test(src), false, "the route is summing rows itself");
});

test("the route hands the P&L the Trading account's own gross figure", () => {
  // Recomputing it would let the two statements disagree about one number.
  assert.ok(/gross: trading\.gross/.test(read("../app/api/financials/route.js")));
});

test("a blank stock override does not wipe the valuation", () => {
  // Number("") is 0, which would silently replace a real valuation with nil
  // and charge the whole purchase against the period.
  const src = read("../app/api/financials/route.js");
  assert.ok(/\.trim\(\) !== ""/.test(src));
});

test("the page does no arithmetic of its own", () => {
  const src = read("../app/financials/page.js");
  assert.equal(/trialBalance\(|tradingAccount\(|balanceSheet\(/.test(src), false);
  assert.ok(/loadedFor/.test(src), "and it guards against drawing stale figures");
});

test("the dashboard reaches the statements", () => {
  assert.ok(/router\.push\(['"]\/financials['"]\)/.test(read("../app/page.js")));
});

console.log(`\n${passed} checks passed`);
