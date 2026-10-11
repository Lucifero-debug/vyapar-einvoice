/**
 * Fixture tests for the Cash Book, Bank Book and A/C Ledger.
 *
 *   node scripts/account-books.test.mjs
 *
 * A book is four numbers -- opening, debit, credit, closing -- and each of
 * them fails quietly rather than throwing:
 *
 *   1. THE OPENING BALANCE. A book opened from 1 July has to carry April to
 *      June forward. Get it wrong and the closing figure is wrong by exactly
 *      the part of the year nobody is looking at, which no column on the sheet
 *      reveals.
 *
 *   2. THE DATE WINDOW. Compared as IST calendar days, not with the server's
 *      clock. The container runs on Asia/Calcutta and Vercel runs UTC, so a
 *      local-clock comparison gave two different answers for the same books --
 *      measured, not supposed: the fixture below returned two rows under UTC
 *      and one under IST before this was fixed. That is the failure
 *      lib/istDate.mjs was written to stop.
 *
 *   3. THE RUNNING BALANCE. Recomputed here, never read from `Ledger.balance`,
 *      which is an all-time cache maintained for only the two accounts a
 *      posting touched. Reading it would make the first row of a mid-year book
 *      show a balance carried from April, and would leave every row a
 *      back-dated entry landed in front of permanently stale.
 *
 *   4. THE SIGN. Balances are signed: positive Dr, negative Cr. A cash account
 *      cannot go Cr in reality, but a bank on overdraft can and must read that
 *      way -- which is why Bank OD is in the bank book rather than being
 *      treated as something else.
 *
 * Sigfa's own structure is cited where it is copied: GRMAST's TPB and LeftP
 * columns, and the Cash Book / Bank Book / Account Ledger / A/C Ledger Group
 * Wise / Date Wise Cash Book menu items that this one sheet replaces.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  ACCOUNT_GROUPS,
  BANK_GROUP_CODES,
  CASH_GROUP_CODES,
  LEGACY_GROUPS,
  STATEMENTS,
  STATEMENT_NAMES,
  accountsForBook,
  groupByCode,
  groupByName,
  isBankGroup,
  isCashGroup,
  primaryGroups,
  primaryOf,
  resolveGroup,
  subGroupsOf,
} from "../lib/accountGroups.mjs";
import {
  BOOK_KINDS,
  BOOK_NAMES,
  CSV_COLUMNS,
  accountBook,
  balanceText,
  bookFilename,
  bookProblems,
  bookTitle,
  dayWise,
  groupBook,
  inOrder,
  inWindow,
  isBookKind,
  openingBefore,
  periodText,
  toCsv,
} from "../lib/accountBooks.mjs";
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

/**
 * Read a project file, for the wiring checks.
 *
 * Declared HERE, with the test helper -- a `const` is in its temporal dead
 * zone until the line declaring it runs, so a check added above would throw
 * instead of asserting. That mistake cost four silent tests in
 * scripts/orders.test.mjs.
 */
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

/** A ledger row. `_id` is a string here; ordering only needs it comparable. */
const row = (over = {}) => ({
  _id: "a1",
  customerName: "Cash",
  date: new Date("2026-07-05T00:00:00Z"),
  account: "Sales Account",
  paymentType: "Cash",
  debit: 500,
  credit: 0,
  narration: "By Invoice No: 7",
  ...over,
});

console.log("\n--- the chart of accounts (Sigfa's GRMAST) ---");

test("all thirty-five groups are there, fourteen of them primary", () => {
  assert.equal(ACCOUNT_GROUPS.length, 35);
  assert.equal(primaryGroups().length, 14);
  assert.equal(ACCOUNT_GROUPS.filter((g) => !g.main).length, 21);
});

test("Sigfa's codes are preserved, gaps included", () => {
  // 15-24 and 45-49 are unused in GRMAST. Kept rather than renumbered so a
  // firm moving off Sigfa maps across by code with no translation table.
  const codes = ACCOUNT_GROUPS.map((g) => g.code);
  assert.equal(new Set(codes).size, codes.length, "a code is used twice");
  assert.equal(codes.includes(15), false, "15 is not a Sigfa group");
  assert.equal(codes.includes(50), true, "Stock In Progress is 50");
  assert.equal(groupByCode(27).name, "Sundry Debtors");
  assert.equal(groupByCode(99), null);
});

test("every group names a statement, and only T, P or B", () => {
  for (const g of ACCOUNT_GROUPS) {
    assert.ok(STATEMENTS.includes(g.statement), `${g.name} has statement ${g.statement}`);
    assert.equal(typeof STATEMENT_NAMES[g.statement], "string");
    assert.equal(typeof g.left, "boolean", `${g.name} has no side`);
  }
});

test("every sub-group agrees with its parent on statement AND side", () => {
  // The one way this table can be internally wrong. A sub-group whose
  // statement differs from its parent's would appear in one statement while
  // rolling up into a total in another, and both would still balance.
  const wrong = [];
  for (const g of ACCOUNT_GROUPS.filter((x) => !x.main)) {
    const parent = groupByCode(g.under);
    if (!parent) wrong.push(`${g.name} has no parent`);
    else if (parent.statement !== g.statement) wrong.push(`${g.name} vs ${parent.name}: statement`);
    else if (parent.left !== g.left) wrong.push(`${g.name} vs ${parent.name}: side`);
  }
  assert.deepEqual(wrong, []);
});

test("a primary group is its own parent for roll-up purposes", () => {
  assert.equal(primaryOf("Sundry Debtors").name, "Current Assets");
  assert.equal(primaryOf("Current Assets").name, "Current Assets");
  assert.equal(primaryOf("Petty Cash Expenses").name, "Indirect Expenses");
  assert.equal(primaryOf("nonsense"), null);
});

test("the sides are the Indian horizontal form, not the IFRS one", () => {
  // Liabilities LEFT, assets RIGHT. Getting this backwards produces a balance
  // sheet that still balances, with the two halves swapped.
  assert.equal(groupByName("Capital A/c").left, true);
  assert.equal(groupByName("Current Liabilities").left, true);
  assert.equal(groupByName("Current Assets").left, false);
  assert.equal(groupByName("Fixed Assets").left, false);
  // Trading and P&L: debit side left.
  assert.equal(groupByName("Purchase Account").left, true);
  assert.equal(groupByName("Sales Account").left, false);
  assert.equal(groupByName("Indirect Expenses").left, true);
  assert.equal(groupByName("Indirect Income").left, false);
});

test("the statements split the way the four reports need", () => {
  const of = (s) => ACCOUNT_GROUPS.filter((g) => g.statement === s).map((g) => g.name);
  assert.ok(of("T").includes("Opening Stock"));
  assert.ok(of("T").includes("Sales Account"));
  assert.ok(of("T").includes("Direct Expenses"));
  assert.ok(of("P").includes("Indirect Expenses"));
  assert.ok(of("P").includes("Indirect Income"));
  assert.ok(of("B").includes("Sundry Debtors"));
  assert.equal(of("P").includes("Sales Account"), false, "sales belongs to the trading account");
  assert.equal(of("T").includes("Indirect Expenses"), false);
});

test("group names are looked up case-insensitively", () => {
  // Every name join in this app is (lib/uniqueName.mjs), and these were typed
  // by hand on the party master.
  assert.equal(groupByName("sundry debtors").code, 27);
  assert.equal(groupByName("  CASH IN HAND  ").code, 25);
  assert.equal(groupByName(""), null);
  assert.equal(groupByName(undefined), null);
});

test("sub-groups can be listed under their parent", () => {
  const under5 = subGroupsOf(5).map((g) => g.name);
  assert.ok(under5.includes("Cash In Hand"));
  assert.ok(under5.includes("Sundry Debtors"));
  assert.equal(under5.includes("Sundry Creditors"), false, "creditors sit under liabilities");
  assert.deepEqual(subGroupsOf(99), []);
});

test("the three groups Sigfa shows as a total only are marked", () => {
  // GRMAST's TrialGrp. True on exactly the groups whose account count runs to
  // hundreds, which is why the trial balance shows their total instead.
  const totalOnly = ACCOUNT_GROUPS.filter((g) => g.totalOnly).map((g) => g.name);
  assert.deepEqual(totalOnly.sort(), ["Local Purchase", "Sundry Creditors", "Sundry Debtors"]);
});

console.log("\n--- which accounts belong to which book ---");

test("cash and bank are resolved from the group, not the name", () => {
  assert.equal(isCashGroup("Cash In Hand"), true);
  assert.equal(isCashGroup("Petty Cash In Hand"), true);
  assert.equal(isBankGroup("Bank Account"), true);
  assert.equal(isCashGroup("Bank Account"), false);
  assert.equal(isBankGroup("Cash In Hand"), false);
});

test("an overdrawn bank account is still a bank account", () => {
  // Leaving Bank OD out would mean a firm running on an overdraft limit had no
  // bank book at all.
  assert.equal(isBankGroup("Bank OD A/c"), true);
  assert.ok(BANK_GROUP_CODES.includes(32));
  assert.ok(CASH_GROUP_CODES.includes(30), "petty cash is a cash book too");
});

test("the free text the app stores today still works", () => {
  // lib/paymentType.mjs writes the literal 'cash' and 'bank'. The books ship
  // before the groups are seeded onto the account master, so both spellings
  // have to resolve or the cash book is empty on day one.
  assert.equal(isCashGroup("cash"), true);
  assert.equal(isBankGroup("bank"), true);
  assert.equal(resolveGroup("cash").name, "Cash In Hand");
  assert.equal(resolveGroup("suppliers").name, "Sundry Creditors");
});

test("an unrecognised group resolves to nothing rather than a guess", () => {
  // An account filed under "Mumbai Party" is not evidence of anything, and
  // calling it a debtor would put it on the balance sheet as an asset.
  assert.equal(resolveGroup("Mumbai Party"), null);
  assert.equal(resolveGroup(""), null);
  assert.equal(isCashGroup("Mumbai Party"), false);
  assert.equal(isBankGroup(undefined), false);
});

test("every legacy spelling maps to a group that exists", () => {
  for (const [spelling, target] of Object.entries(LEGACY_GROUPS)) {
    assert.ok(groupByName(target), `${spelling} maps to "${target}", which is not a group`);
  }
});

test("each book offers only its own accounts, in name order", () => {
  const accounts = [
    { name: "Zenith Bank", group: "bank" },
    { name: "Cash", group: "cash" },
    { name: "Acme Traders", group: "Sundry Debtors" },
    { name: "Axis Bank", group: "Bank Account" },
  ];
  assert.deepEqual(accountsForBook(accounts, "cash").map((a) => a.name), ["Cash"]);
  assert.deepEqual(
    accountsForBook(accounts, "bank").map((a) => a.name),
    ["Axis Bank", "Zenith Bank"],
    "sorted, so the book opens on the same account every time"
  );
  assert.equal(accountsForBook(accounts, "ledger").length, 4, "the A/C ledger shows any account");
});

test("a nameless account is left out of every book", () => {
  const accounts = [{ name: "", group: "cash" }, { name: "   ", group: "cash" }];
  assert.deepEqual(accountsForBook(accounts, "cash"), []);
  assert.deepEqual(accountsForBook(accounts, "ledger"), []);
});

console.log("\n--- the date window, as IST calendar days ---");

test("both ends of the range are inclusive", () => {
  assert.equal(inWindow("2026-07-01", "2026-07-01", "2026-07-31"), true);
  assert.equal(inWindow("2026-07-31", "2026-07-01", "2026-07-31"), true);
  assert.equal(inWindow("2026-06-30", "2026-07-01", "2026-07-31"), false);
  assert.equal(inWindow("2026-08-01", "2026-07-01", "2026-07-31"), false);
});

test("an open-ended range means what it says", () => {
  assert.equal(inWindow("2020-01-01", null, "2026-07-31"), true);
  assert.equal(inWindow("2030-01-01", "2026-07-01", null), true);
  assert.equal(inWindow("2026-07-15", null, null), true);
  assert.equal(inWindow(null, null, null), false, "a row with no date is in no window");
});

test("the window is Delhi's day, not the server's", () => {
  // 7pm UTC on the 31st is half past midnight on the 1st in Delhi, so it falls
  // OUTSIDE a range ending on the 31st. Before this was fixed the same fixture
  // gave two rows under UTC and one under IST -- the books disagreed with
  // themselves depending on which host drew them.
  assert.equal(inWindow("2026-07-31T19:00:00Z", "2026-07-01", "2026-07-31"), false);
  // And the other edge: 7pm UTC on the 30th is the 31st in Delhi, so a range
  // that STARTS on the 31st includes it.
  assert.equal(inWindow("2026-07-30T19:00:00Z", "2026-07-31", "2026-08-31"), true);
});

test("rows read in date order, then insertion order", () => {
  // `_id` as the tie-break, not an arbitrary sort: an ObjectId begins with a
  // timestamp, so it orders same-day rows the way they were written. The same
  // ordering recomputeLedgerBalances uses, which is what lets the recomputed
  // column agree with the cached one.
  const rows = [
    row({ _id: "c", date: new Date("2026-07-05") }),
    row({ _id: "a", date: new Date("2026-07-05") }),
    row({ _id: "b", date: new Date("2026-07-01") }),
  ];
  assert.deepEqual(inOrder(rows).map((r) => r._id), ["b", "a", "c"]);
});

test("ordering does not mutate what it was given", () => {
  const rows = [row({ _id: "c" }), row({ _id: "a", date: new Date("2026-07-01") })];
  inOrder(rows);
  assert.equal(rows[0]._id, "c", "the caller's array was re-ordered in place");
});

console.log("\n--- the opening balance ---");

test("a mid-year book carries the earlier movements forward", () => {
  // The number nothing on the sheet reveals if it is wrong.
  const rows = [
    row({ _id: "1", date: new Date("2026-04-10"), debit: 1000, credit: 0 }),
    row({ _id: "2", date: new Date("2026-05-20"), debit: 0, credit: 400 }),
    row({ _id: "3", date: new Date("2026-07-05"), debit: 500, credit: 0 }),
  ];
  assert.equal(openingBefore({ rows, openingBal: 2000, from: "2026-07-01" }), 2600);
});

test("the master's opening balance is included", () => {
  assert.equal(openingBefore({ rows: [], openingBal: 2000, from: "2026-07-01" }), 2000);
  assert.equal(openingBefore({ rows: [], openingBal: -750, from: "2026-07-01" }), -750);
});

test("with no start date the opening IS the master's figure", () => {
  // There is nothing before the beginning, so no row may be absorbed into it.
  const rows = [row({ debit: 999, credit: 0 })];
  assert.equal(openingBefore({ rows, openingBal: 100 }), 100);
});

test("a row dated ON the start date is not absorbed into the opening", () => {
  // It belongs in the window, where the reader can see it. Absorbing it would
  // leave the closing figure right and the first line missing.
  const rows = [row({ date: new Date("2026-07-01"), debit: 500, credit: 0 })];
  assert.equal(openingBefore({ rows, openingBal: 0, from: "2026-07-01" }), 0);
});

test("the opening balance reads Delhi's day too", () => {
  // 7pm UTC on 30 June is 1 July in Delhi, so it is NOT earlier than a book
  // starting 1 July.
  const rows = [row({ date: new Date("2026-06-30T19:00:00Z"), debit: 500, credit: 0 })];
  assert.equal(openingBefore({ rows, openingBal: 0, from: "2026-07-01" }), 0);
});

test("a row with no date is ignored rather than counted as ancient", () => {
  const rows = [row({ date: null, debit: 500, credit: 0 })];
  assert.equal(openingBefore({ rows, openingBal: 100, from: "2026-07-01" }), 100);
});

console.log("\n--- the book itself ---");

const book = () =>
  accountBook({
    account: { name: "Cash", group: "cash" },
    openingBal: 1000,
    rows: [
      row({ _id: "0", date: new Date("2026-06-30"), debit: 300, credit: 0 }),
      row({ _id: "1", date: new Date("2026-07-05"), debit: 500, credit: 0 }),
      row({ _id: "2", date: new Date("2026-07-05"), account: "Rent", debit: 0, credit: 200 }),
      row({ _id: "3", date: new Date("2026-07-20"), account: "Acme", debit: 0, credit: 100 }),
      row({ _id: "9", date: new Date("2026-08-02"), debit: 999, credit: 0 }),
    ],
    from: "2026-07-01",
    to: "2026-07-31",
  });

test("the four figures hang together", () => {
  const b = book();
  assert.equal(b.opening, 1300, "1000 master + 300 in June");
  assert.deepEqual(b.totals, { debit: 500, credit: 300 });
  assert.equal(b.closing, 1500, "1300 + 500 - 300");
  assert.equal(b.lines.length, 3, "June and August are outside the window");
});

test("the closing figure equals opening plus the movement, always", () => {
  // The invariant the whole sheet rests on. Asserted as a relationship rather
  // than a number, so it holds for any fixture.
  const b = book();
  assert.equal(b.closing, Math.round((b.opening + b.totals.debit - b.totals.credit) * 100) / 100);
});

test("the running balance is recomputed, not carried from the stored cache", () => {
  // `Ledger.balance` is an all-time figure maintained for only the two
  // accounts a posting touched. Feeding deliberately absurd values proves
  // nothing reads them.
  const b = accountBook({
    account: { name: "Cash" },
    openingBal: 0,
    rows: [
      row({ _id: "1", debit: 100, credit: 0, balance: 999999 }),
      row({ _id: "2", debit: 0, credit: 40, balance: -999999 }),
    ],
    from: "2026-07-01",
    to: "2026-07-31",
  });
  assert.deepEqual(b.lines.map((l) => l.balance), [100, 60]);
  assert.equal(b.closing, 60);
});

test("each line's balance is the running total after it", () => {
  const b = book();
  assert.deepEqual(b.lines.map((l) => l.balance), [1800, 1600, 1500]);
});

test("particulars is the CONTRA account, not the book's own name", () => {
  // What makes a book readable: a cash book line says what the money was for,
  // not the name of the book you are already looking at.
  const b = book();
  assert.deepEqual(b.lines.map((l) => l.particulars), ["Sales Account", "Rent", "Acme"]);
});

test("a row with no contra account says so rather than showing blank", () => {
  const b = accountBook({
    account: { name: "Cash" },
    rows: [row({ account: "" })],
    from: "2026-07-01",
    to: "2026-07-31",
  });
  assert.equal(b.lines[0].particulars, "(no contra account)");
});

test("an empty window still reports the carried-forward position", () => {
  // Not zero, and not undefined: the closing of a month with no entries is
  // whatever came in, and a book that showed 0 would read as a cleared account.
  const b = accountBook({
    account: { name: "Cash" },
    openingBal: 1000,
    rows: [row({ date: new Date("2026-04-10"), debit: 300, credit: 0 })],
    from: "2026-07-01",
    to: "2026-07-31",
  });
  assert.deepEqual(b.lines, []);
  assert.equal(b.opening, 1300);
  assert.equal(b.closing, 1300);
  assert.deepEqual(b.totals, { debit: 0, credit: 0 });
});

test("an account with no history at all is a book of nothing", () => {
  const b = accountBook({ account: { name: "New A/c" }, rows: [] });
  assert.equal(b.opening, 0);
  assert.equal(b.closing, 0);
  assert.deepEqual(b.lines, []);
});

test("a credit position reads Cr, including on a bank overdraft", () => {
  const b = accountBook({
    account: { name: "Axis Bank", group: "Bank OD A/c" },
    openingBal: 0,
    rows: [row({ debit: 0, credit: 5000 })],
    from: "2026-07-01",
    to: "2026-07-31",
  });
  assert.equal(b.closing, -5000);
  assert.equal(b.closingMode, "Cr");
  assert.equal(b.lines[0].mode, "Cr");
});

test("a line amount is rounded to paise, so the sheet adds up", () => {
  // The column total rounds as it accumulates, so dropping the rounding on
  // each LINE leaves a sheet whose rows do not add to its own total -- two
  // rows of 0.005 printing as 0.005 under a total of 0.02. A printed book a
  // client reconciles by hand has to agree with itself.
  const b = accountBook({
    account: { name: "Cash" },
    openingBal: 0,
    rows: [row({ _id: "1", debit: 0.005, credit: 0 }), row({ _id: "2", debit: 0.005, credit: 0 })],
    from: "2026-07-01",
    to: "2026-07-31",
  });
  assert.deepEqual(b.lines.map((l) => l.debit), [0.01, 0.01]);
  assert.equal(
    b.lines.reduce((t, l) => Math.round((t + l.debit) * 100) / 100, 0),
    b.totals.debit,
    "the rows must add up to the total printed beneath them"
  );
});

test("float dust does not survive into a balance", () => {
  const b = accountBook({
    account: { name: "Cash" },
    openingBal: 0,
    rows: [row({ _id: "1", debit: 0.1, credit: 0 }), row({ _id: "2", debit: 0.2, credit: 0 })],
    from: "2026-07-01",
    to: "2026-07-31",
  });
  assert.equal(b.closing, 0.3, "0.1 + 0.2 must not be 0.30000000000000004");
  assert.equal(b.totals.debit, 0.3);
});

console.log("\n--- Sigfa's Date Wise Cash Book ---");

test("one line per day, with the day's totals", () => {
  const d = dayWise(book());
  assert.equal(d.length, 2, "two days had entries");
  assert.deepEqual(d.map((x) => x.entries), [2, 1]);
  assert.deepEqual(d.map((x) => x.debit), [500, 0]);
  assert.deepEqual(d.map((x) => x.credit), [200, 100]);
});

test("collapsing the rows cannot change the closing figure", () => {
  // The one way a summary can lie. The last day's balance must be the book's
  // closing balance, or the summary and the detail disagree about the money.
  const b = book();
  const d = dayWise(b);
  assert.equal(d[d.length - 1].balance, b.closing);
});

test("a day's balance is the running total after its LAST entry", () => {
  const d = dayWise(book());
  assert.equal(d[0].balance, 1600, "not 1800, which is after the first of the two");
});

test("the days come out in order", () => {
  const b = accountBook({
    account: { name: "Cash" },
    openingBal: 0,
    rows: [
      row({ _id: "2", date: new Date("2026-07-20"), debit: 10, credit: 0 }),
      row({ _id: "1", date: new Date("2026-07-05"), debit: 20, credit: 0 }),
    ],
    from: "2026-07-01",
    to: "2026-07-31",
  });
  const d = dayWise(b);
  assert.ok(d[0].date < d[1].date);
  assert.deepEqual(d.map((x) => x.debit), [20, 10]);
});

test("the summary orders its own days, whatever it is handed", () => {
  // `accountBook` already sorts, so a summary built from one of its books is
  // in order whether or not this sorts. But `dayWise` is exported and takes a
  // plain { lines }, so its ordering is its own contract -- and a summary that
  // inherited its caller's order would read as a book that went backwards.
  const d = dayWise({
    lines: [
      { date: new Date("2026-07-20"), debit: 10, credit: 0, balance: 30 },
      { date: new Date("2026-07-05"), debit: 20, credit: 0, balance: 20 },
    ],
  });
  assert.deepEqual(d.map((x) => x.debit), [20, 10], "5 July must come before 20 July");
});

test("a day-wise summary of nothing is nothing", () => {
  assert.deepEqual(dayWise({ lines: [] }), []);
  assert.deepEqual(dayWise(null), []);
});

console.log("\n--- Sigfa's A/C Ledger Group Wise ---");

test("a group total is the sum of the closing POSITIONS", () => {
  // Not the sum of the debit and credit columns: those are the movement in the
  // window, while a group total is a position -- and the trial balance will
  // take it from here.
  const a = accountBook({
    account: { name: "Acme" },
    openingBal: 1000,
    rows: [row({ _id: "1", debit: 500, credit: 0 })],
    from: "2026-07-01",
    to: "2026-07-31",
  });
  const b = accountBook({
    account: { name: "Bharat" },
    openingBal: -200,
    rows: [row({ _id: "2", debit: 0, credit: 300 })],
    from: "2026-07-01",
    to: "2026-07-31",
  });
  const g = groupBook("Sundry Debtors", [a, b]);
  assert.equal(g.accounts, 2);
  assert.equal(g.opening, 800, "1000 + -200");
  assert.equal(g.closing, 1000, "1500 + -500");
  assert.deepEqual(g.totals, { debit: 500, credit: 300 });
  assert.equal(g.closingMode, "Dr");
});

test("a group of no accounts totals to nothing, not to NaN", () => {
  const g = groupBook("Sundry Debtors", []);
  assert.equal(g.accounts, 0);
  assert.equal(g.opening, 0);
  assert.equal(g.closing, 0);
  assert.equal(Number.isFinite(g.closing), true);
});

test("opposite positions net inside a group", () => {
  // Two debtors, one in credit because they have paid in advance. The group
  // closing is the net, which is what a balance sheet line shows.
  const dr = accountBook({ account: { name: "A" }, openingBal: 5000, rows: [] });
  const cr = accountBook({ account: { name: "B" }, openingBal: -2000, rows: [] });
  assert.equal(groupBook("Sundry Debtors", [dr, cr]).closing, 3000);
});

console.log("\n--- what the sheet prints ---");

test("the three books are named, and nothing else is a book", () => {
  assert.deepEqual(BOOK_KINDS, ["cash", "bank", "ledger"]);
  assert.equal(BOOK_NAMES.cash, "Cash Book");
  assert.equal(BOOK_NAMES.bank, "Bank Book");
  assert.equal(isBookKind("cash"), true);
  assert.equal(isBookKind("trial"), false);
  assert.equal(isBookKind(""), false);
});

test("the heading says which book and which account", () => {
  assert.equal(bookTitle("cash", "Cash"), "Cash Book -- Cash");
  assert.equal(bookTitle("bank", "Axis Bank"), "Bank Book -- Axis Bank");
  assert.equal(bookTitle("ledger", "", "Sundry Debtors"), "A/C Ledger -- Sundry Debtors");
  assert.equal(bookTitle("ledger", ""), "A/C Ledger");
  assert.equal(bookTitle("nonsense", ""), "A/C Ledger", "an unknown kind does not print blank");
});

test("a group heading wins over an account name", () => {
  // Group-wise shows many accounts; naming one of them in the heading would
  // be wrong about the other eighty.
  assert.equal(bookTitle("ledger", "Acme", "Sundry Debtors"), "A/C Ledger -- Sundry Debtors");
});

test("the period line covers every combination of dates", () => {
  const f = (d) => d.toISOString().slice(0, 10);
  assert.equal(periodText("2026-07-01", "2026-07-31", f), "2026-07-01 to 2026-07-31");
  assert.equal(periodText("2026-07-01", null, f), "from 2026-07-01");
  assert.equal(periodText(null, "2026-07-31", f), "up to 2026-07-31");
  assert.equal(periodText(null, null, f), "all dates");
});

test("a balance prints with its side, and a flat zero prints flat", () => {
  assert.equal(balanceText(1500), "1500.00 Dr");
  assert.equal(balanceText(-1500), "1500.00 Cr");
  // modeOf calls zero Dr, but "0.00 Dr" reads as a decision somebody made.
  assert.equal(balanceText(0), "0.00");
  assert.equal(balanceText(null), "0.00");
});

test("a download file name survives an awkward party name", () => {
  // "Acme Traders, Delhi (HO)" would otherwise produce a name a browser
  // quietly mangles or refuses.
  const name = bookFilename("cash", "Acme Traders, Delhi (HO)", Date.parse("2026-10-11"));
  assert.equal(name, "cash-book-acme-traders-delhi-ho-2026-10-11.csv");
  assert.equal(/[^a-z0-9.\-]/.test(name), false, `${name} has an awkward character`);
});

test("a file name without an account still says which book", () => {
  assert.equal(bookFilename("bank", "", Date.parse("2026-10-11")), "bank-book-2026-10-11.csv");
  assert.equal(bookFilename("nonsense", "", Date.parse("2026-10-11")), "ledger-book-2026-10-11.csv");
});

test("the CSV quotes a party name containing a comma", () => {
  // The case that silently shifts every later column by one. The writer comes
  // from orderReports.mjs rather than being copied.
  const csv = toCsv(CSV_COLUMNS.entries, [
    { date: "2026-07-05", particulars: "Acme Traders, Delhi", narration: "", debit: 500, credit: 0, balance: 500, mode: "Dr" },
  ]);
  assert.ok(csv.includes('"Acme Traders, Delhi"'));
  assert.ok(csv.startsWith("Date,Particulars,Narration,Debit,Credit,Balance,Dr/Cr"));
});

test("the CSV defuses a name Excel would evaluate", () => {
  const csv = toCsv(CSV_COLUMNS.entries, [{ particulars: "=1+1", debit: 0, credit: 0 }]);
  assert.ok(csv.includes("'=1+1"), "a leading = must be quoted out");
});

test("both column sets exist and name their keys", () => {
  for (const set of ["entries", "daywise"]) {
    assert.ok(Array.isArray(CSV_COLUMNS[set]), `${set} is missing`);
    for (const col of CSV_COLUMNS[set]) {
      assert.equal(typeof col.key, "string");
      assert.equal(typeof col.label, "string");
    }
  }
});

console.log("\n--- what the request must satisfy ---");

test("a well-formed request has nothing wrong with it", () => {
  assert.deepEqual(
    bookProblems({ kind: "cash", account: "Cash", from: "2026-07-01", to: "2026-07-31" }),
    []
  );
});

test("a book and an account are both required", () => {
  assert.ok(bookProblems({ kind: "", account: "Cash" }).some((p) => /Pick a book/.test(p)));
  assert.ok(bookProblems({ kind: "cash", account: "" }).some((p) => /Pick an account/.test(p)));
});

test("a range typed backwards is refused", () => {
  // It returns nothing at all, which looks exactly like an account that has
  // had no entries -- so it has to be said out loud.
  const problems = bookProblems({
    kind: "cash",
    account: "Cash",
    from: "2026-07-31",
    to: "2026-07-01",
  });
  assert.ok(problems.some((p) => /after the end date/.test(p)));
});

test("the same day at both ends is a valid range, not a backwards one", () => {
  assert.deepEqual(
    bookProblems({ kind: "cash", account: "Cash", from: "2026-07-05", to: "2026-07-05" }),
    []
  );
});

test("an unparseable date is reported as such", () => {
  assert.ok(
    bookProblems({ kind: "cash", account: "Cash", from: "not a date" }).some((p) =>
      /start date is not valid/.test(p)
    )
  );
  assert.ok(
    bookProblems({ kind: "cash", account: "Cash", to: "32/13/2026" }).some((p) =>
      /end date is not valid/.test(p)
    )
  );
});

test("omitting the dates entirely is allowed", () => {
  assert.deepEqual(bookProblems({ kind: "ledger", account: "Acme" }), []);
});

console.log("\n--- wiring ---");

test("the books are filed with the other ledgers", () => {
  assert.equal(permissionForPath("/api/account-book"), "ledger:read");
  assert.equal(permissionForPath("/account-book"), "ledger:read");
  assert.equal(canAccessPath("accountant", "/api/account-book"), true);
  assert.equal(canAccessPath("owner", "/account-book"), true);
  // A biller is already kept out of /api/ledger; the cash book is no different.
  assert.equal(canAccessPath("biller", "/api/account-book"), false);
});

test("no local-clock call survives in the book rules", () => {
  // The bug this module was fixed for. `setHours` reads the SERVER's day, so
  // the container (Asia/Calcutta) and Vercel (UTC) gave different books. The
  // check is on the CALL, because the comment above it legitimately describes
  // the approach it replaced.
  const src = read("../lib/accountBooks.mjs");
  // Every local-time accessor and formatter, not just the obvious one. This
  // list IS the test: the container runs on Asia/Calcutta, so a server-day
  // comparison returns the right answer here and the wrong one on Vercel --
  // which means no fixture run inside this timezone can tell the two apart.
  // The invariant that actually protects the books is "this module never asks
  // the host what day it is", and that can only be checked structurally.
  for (const bad of [
    "setHours(",
    "getHours(",
    "getDate(",
    "getMonth(",
    "getFullYear(",
    "toDateString(",
    "toLocaleDateString(",
    "toLocaleString(",
    "getTimezoneOffset(",
  ]) {
    assert.equal(src.includes(bad), false, `${bad} reads the server's clock`);
  }
  assert.ok(/istDayNumber/.test(src), "the window must compare IST calendar days");
});

test("the rules modules stay free of Mongoose", () => {
  for (const f of ["../lib/accountBooks.mjs", "../lib/accountGroups.mjs"]) {
    const src = read(f);
    assert.equal(/from ["']mongoose["']/.test(src), false, `${f} imports Mongoose`);
    assert.equal(/\.\.\/models\//.test(src), false, `${f} imports a model`);
  }
});

test("the CSV writer is imported, not copied", () => {
  // A second copy is a second thing to remember to harden against formula
  // injection and comma-bearing party names.
  const src = read("../lib/accountBooks.mjs");
  assert.ok(/from ["']\.\/orderReports\.mjs["']/.test(src));
  assert.equal(/^export const csvCell = /m.test(src), false, "csvCell is redefined here");
});

test("the route matches on customerName only, never on the contra", () => {
  // Matching both pulled a cash account's own aggregate row PLUS every party
  // row naming it as the contra -- the same money twice, the second time from
  // the other side's point of view. /api/ledger carries the same warning.
  const src = read("../app/api/account-book/route.js");
  assert.ok(/customerName: \{ \$in: names \}/.test(src));
  assert.equal(/account: \{ \$in/.test(src), false, "the contra side is being matched");
});

test("the route fetches every account's rows in one query", () => {
  // A group-wise ledger over Sundry Debtors is eighty accounts; eighty
  // queries would be eighty round trips to draw one sheet.
  const src = read("../app/api/account-book/route.js");
  assert.equal((src.match(/Ledger\.find\(/g) || []).length, 1);
  assert.ok(/\$in/.test(src));
});

test("the route does no arithmetic of its own", () => {
  // Everything comes from lib/accountBooks.mjs, so what the page prints is
  // what the trial balance will later take from the same function.
  const src = read("../app/api/account-book/route.js");
  assert.ok(/accountBook\(/.test(src));
  assert.ok(/groupBook\(/.test(src));
  assert.ok(/dayWise\(/.test(src));
  assert.equal(/row\.debit\s*-\s*row\.credit/.test(src), false, "the route is summing rows itself");
});

test("the route is scoped to a firm", () => {
  assert.ok(/tenantRoute\(/.test(read("../app/api/account-book/route.js")));
});

test("the page renders rows only for what they were loaded for", () => {
  // The guard the order report needed: `kind` changes the instant a tab is
  // clicked while `books` changes only when the fetch returns, so for one
  // render the cash book's rows would be drawn under the bank book's heading.
  const src = read("../app/account-book/page.js");
  assert.ok(/loadedFor/.test(src));
  assert.ok(/loadedFor === signature \? books : \[\]/.test(src));
  // Stamped on every path, failures included, or a failure leaves stale rows
  // under the new heading.
  assert.ok(/finally \{[\s\S]*setLoadedFor\(signature\)/.test(src));
});

test("field-check is only ever put on a checkbox input", () => {
  // It styles the INPUT -- `h-[18px] w-[18px]` in globals.css. Put on the
  // <label> wrapping an input and its text, it squeezes the label to 18px
  // wide: the caption wraps one word per line and overflows its own box onto
  // whatever is beneath. That shipped on four screens before anyone opened
  // them, because nothing in a parse check or a unit test looks at a class
  // name's meaning.
  //
  // Swept across the whole app, not just these pages: the next person to
  // reach for this class will reach for it somewhere else.
  const offenders = [];
  const walk = (dir) => {
    const url = new URL(dir, import.meta.url);
    let entries;
    try {
      entries = fs.readdirSync(url, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = `${dir}${entry.name}`;
      if (entry.isDirectory()) walk(`${rel}/`);
      else if (/\.(js|jsx)$/.test(entry.name)) {
        const src = fs.readFileSync(new URL(rel, import.meta.url), "utf8");
        // The tag name, then anything that is not a ">" -- which spans the
        // newlines inside a multi-line JSX tag but cannot leave it.
        for (const m of src.matchAll(/<([A-Za-z][\w.]*)[^>]*className=["'`][^"'`]*\bfield-check\b/g)) {
          if (m[1] !== "input") offenders.push(`${rel}: <${m[1]}>`);
        }
      }
    }
  };
  walk("../app/");
  walk("../components/");
  assert.deepEqual(offenders, [], `field-check belongs on an input:\n  ${offenders.join("\n  ")}`);
});

test("the checkbox sweep is actually looking at files", () => {
  // Guards the guard: a walk that silently found nothing would make the check
  // above pass without reading a line.
  const src = read("../app/account-book/page.js");
  assert.ok(/field-check/.test(src), "the page it was written for no longer uses the class");
});

test("the dashboard reaches the books", () => {
  assert.ok(/router\.push\(['"]\/account-book['"]\)/.test(read("../app/page.js")));
});

console.log(`\n${passed} checks passed`);
