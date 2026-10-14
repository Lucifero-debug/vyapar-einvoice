/**
 * Sigfa's Sales and Purchase module reports.
 *
 * Run with bare node -- lib/salesReports.mjs imports only balance.mjs and
 * istDate.mjs, both pure.
 *
 *
 * WHAT THIS SUITE IS GUARDING
 * ---------------------------
 * One rule, mostly: a return subtracts. It is not a choice made here -- it is
 * Sigfa's, and its own SQL says so:
 *
 *     And S.Mkey in ('SI','SR')
 *
 *     Sum(IIF(S.Mkey='SI' or S.Mkey='SC' or S.Mkey='PI' or S.Mkey='PC', Amount, 0))
 *       - Sum(IIF(S.Mkey='SR' Or S.Mkey='PR', Amount, 0))
 *
 * Get that backwards and a month's sales are overstated by twice its returns,
 * on three sheets at once, with every row individually looking right.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  BOOK_GRAINS,
  CSV_COLUMNS,
  DEFAULT_GRAIN,
  DEFAULT_SCOPE,
  DOC_SCOPES,
  NO_PARTY,
  REPORT_SIDES,
  SALES_VIEWS,
  bookRow,
  csvFilename,
  documentSign,
  documentsFor,
  isReportSide,
  isReturn,
  isSalesView,
  isBookGrain,
  isDocScope,
  itemTotals,
  itemWise,
  netOf,
  othersOf,
  partyTotals,
  partyWise,
  periodLabel,
  periodTotals,
  periodWise,
  reportName,
  scopeName,
  sheetHeadings,
  taxableOf,
  totalsOf,
  zoomInto,
} from "../lib/salesReports.mjs";
import { istDayNumber } from "../lib/istDate.mjs";
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

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

const line = (over = {}) => ({
  name: "Plate",
  hsn: "7308",
  uqc: "KGS",
  quantity: 10,
  taxableAmount: 1000,
  gstAmount: 180,
  total: 1180,
  ...over,
});

const invoice = (over = {}) => ({
  invoiceNo: 1,
  type: "Sale",
  return: false,
  date: "2026-06-15",
  customer: { name: "Acme Traders", gstin: "07AAACA1111A1Z5" },
  stateOfSupply: "Delhi",
  taxType: "local",
  // `totalAmount` IS TAX-INCLUSIVE: the billing screen sums the lines'
  // `total`, and a line's total is its taxable plus its GST. An earlier
  // version of this fixture set it to 1000, which let a module reading the
  // field at face value look right -- and it was printing the gross in the
  // Taxable column on live data.
  totalAmount: 1180,
  gst: 180,
  finalAmount: 1180,
  received: 0,
  balanceDue: 1180,
  items: [line()],
  ...over,
});

const RETURN = invoice({
  invoiceNo: 2,
  return: true,
  totalAmount: 236,
  gst: 36,
  finalAmount: 236,
  balanceDue: 236,
  items: [line({ quantity: 2, taxableAmount: 200, gstAmount: 36, total: 236 })],
});

console.log("\n--- the six reports Sigfa has, as three shapes ---");

test("there are three shapes and two sides", () => {
  // Its menus: Sales Book / Party Wise Sales / Item Wise Sales, and the same
  // three under Purchase.
  assert.deepEqual(SALES_VIEWS, ["book", "party", "item"]);
  assert.deepEqual(REPORT_SIDES, ["Sale", "Purchase"]);
});

test("each is named as Sigfa names it", () => {
  assert.equal(reportName("book", "Sale"), "Sales Book");
  assert.equal(reportName("party", "Sale"), "Party Wise Sales");
  assert.equal(reportName("item", "Sale"), "Item Wise Sales");
  assert.equal(reportName("book", "Purchase"), "Purchase Book");
  assert.equal(reportName("party", "Purchase"), "Party Wise Purchase");
  assert.equal(reportName("item", "Purchase"), "Item Wise Purchase");
  // Sigfa's purchase menu drops the word -- "Party Wise", not "Party Wise
  // Purchase" -- because the menu above it already says Purchase. Here the
  // side is chosen separately, so a printed sheet has to say which it is.
  assert.match(reportName("party", "Purchase"), /Purchase/);
});

test("an unknown view or side is refused, not defaulted", () => {
  assert.equal(isSalesView("book"), true);
  assert.equal(isSalesView("hsn"), false);
  assert.equal(isSalesView(""), false);
  assert.equal(isReportSide("Sale"), true);
  assert.equal(isReportSide("sale"), false, "the stored value is capitalised");
  assert.equal(isReportSide("Both"), false);
  // And a view that got past the guard is not quietly labelled as the book.
  assert.equal(reportName("hsn", "Sale"), "Sales Report");
  assert.equal(reportName("hsn", "Purchase"), "Purchase Report");
});

console.log("\n--- a return subtracts: Sigfa's rule, not a choice ---");

test("an invoice adds and a return subtracts", () => {
  assert.equal(documentSign(invoice()), 1);
  assert.equal(documentSign(RETURN), -1);
  assert.equal(isReturn(RETURN), true);
  assert.equal(isReturn(invoice()), false);
  // Only `true` counts. A missing flag is an invoice, which is what every
  // row written before returns existed carries.
  assert.equal(isReturn({}), false);
  assert.equal(isReturn({ return: "yes" }), false);
});

test("a return is listed at its face value and totalled negative", () => {
  // A credit note for 500 is a credit note for 500. Printing it as -500
  // would make the book disagree with the paper in the file.
  const row = bookRow(RETURN);
  assert.equal(row.total, 236, "shown as printed");
  assert.equal(row.signedTotal, -236, "totalled as a deduction");
  assert.equal(row.taxable, 200);
  assert.equal(row.signedTaxable, -200);
  assert.equal(row.isReturn, true);
});

test("the book nets the returns off", () => {
  const rows = documentsFor({ invoices: [invoice(), RETURN], side: "Sale" });
  const totals = totalsOf(rows);
  assert.equal(totals.documents, 2);
  assert.equal(totals.returns, 1);
  assert.equal(totals.taxable, 800, "1000 less 200");
  assert.equal(totals.gst, 144, "180 less 36");
  assert.equal(totals.total, 944, "1180 less 236");
});

test("all three sheets agree on the same period", () => {
  // THE CHECK THAT MATTERS MOST. Three shapes over one body of documents: if
  // the party-wise total disagreed with the book above it, every row on each
  // would still look right.
  const invoices = [invoice(), RETURN];
  const book = totalsOf(documentsFor({ invoices, side: "Sale" }));
  const party = partyTotals(partyWise(documentsFor({ invoices, side: "Sale" })));
  const item = itemTotals(itemWise({ invoices, side: "Sale" }));

  assert.equal(book.total, party.total, "book and party-wise disagree");
  assert.equal(book.taxable, party.taxable);
  assert.equal(book.gst, party.gst);
  // Item-wise totals the LINES, so it matches only when the lines add up to
  // the document -- which is the invariant the billing suite also pins.
  assert.equal(item.taxable, book.taxable, "book and item-wise disagree");
  assert.equal(item.gst, book.gst);
});

test("a period of nothing but returns totals negative, not positive", () => {
  // Sigfa wraps its subtraction in Abs(), which turns a net of -236 into
  // +236 and reports a party as having bought what they sent back. The
  // netting is copied; the Abs is deliberately not.
  const rows = documentsFor({ invoices: [RETURN], side: "Sale" });
  assert.equal(totalsOf(rows).total, -236);
  assert.equal(partyTotals(partyWise(rows)).total, -236);
  assert.equal(itemTotals(itemWise({ invoices: [RETURN], side: "Sale" })).total, -236);
});

console.log("\n--- which documents a report covers ---");

test("only the asked-for side", () => {
  const invoices = [invoice(), invoice({ invoiceNo: 9, type: "Purchase" })];
  assert.deepEqual(
    documentsFor({ invoices, side: "Sale" }).map((r) => r.invoiceNo),
    [1]
  );
  assert.deepEqual(
    documentsFor({ invoices, side: "Purchase" }).map((r) => r.invoiceNo),
    [9]
  );
});

test("the period is inclusive at both ends", () => {
  const invoices = [
    invoice({ invoiceNo: 1, date: "2026-05-31" }),
    invoice({ invoiceNo: 2, date: "2026-06-01" }),
    invoice({ invoiceNo: 3, date: "2026-06-30" }),
    invoice({ invoiceNo: 4, date: "2026-07-01" }),
  ];
  assert.deepEqual(
    documentsFor({ invoices, side: "Sale", from: "2026-06-01", to: "2026-06-30" }).map(
      (r) => r.invoiceNo
    ),
    [2, 3],
    "the first and last day of the month are in it"
  );
});

test("the period is counted in IST days, not the server's", () => {
  // The container runs Asia/Calcutta and Vercel runs UTC. An invoice saved at
  // 19:00 IST on the 30th is 13:30 UTC the same day -- but one saved at
  // 00:30 IST on the 1st is 19:00 UTC on the 30th, and a UTC comparison puts
  // it in the wrong month.
  const invoices = [invoice({ invoiceNo: 7, date: "2026-06-30T19:00:00Z" })];
  assert.deepEqual(
    documentsFor({ invoices, side: "Sale", from: "2026-07-01", to: "2026-07-31" }).map(
      (r) => r.invoiceNo
    ),
    [7],
    "19:00 UTC on the 30th is already the 1st in IST"
  );
  assert.deepEqual(
    documentsFor({ invoices, side: "Sale", from: "2026-06-01", to: "2026-06-30" }),
    []
  );
});

test("the book row carries what the register prints, field by field", () => {
  // Deliberately four different figures, so a row that read the wrong one
  // could not come out right by accident.
  const row = bookRow(
    invoice({ invoiceNo: 44, totalAmount: 1180, gst: 180, finalAmount: 1500, received: 400, balanceDue: 1100 })
  );
  assert.equal(row.invoiceNo, 44);
  assert.equal(row.party, "Acme Traders");
  assert.equal(row.gstin, "07AAACA1111A1Z5");
  assert.equal(row.state, "Delhi");
  assert.equal(row.taxType, "local");
  assert.equal(row.taxable, 1000, "1180 tax-inclusive, less 180 of GST");
  assert.equal(row.gst, 180);
  assert.equal(row.net, 1180, "Sigfa's Net Amount: the items, GST included");
  assert.equal(row.others, 320, "1500 charged less the 1180 the items came to");
  assert.equal(row.total, 1500, "Sigfa's Bill Amount: what the party owes");
  assert.equal(row.received, 400);
  assert.equal(row.balanceDue, 1100, "what is still owed, not what came in");
  assert.equal(row.isReturn, false);
  assert.equal(row.sign, 1);
});

test("the row's day is an IST day, not the server's", () => {
  // The field the book sorts on. istDayNumber is the one clock every date in
  // this app is compared by; a local-clock day number agrees with it on the
  // container, which runs Asia/Calcutta, and disagrees on Vercel, which runs
  // UTC -- so it is pinned to the function rather than to a number.
  for (const date of ["2026-06-15", "2026-06-30T19:00:00Z", "2026-01-01T00:30:00Z"]) {
    assert.equal(bookRow(invoice({ date })).day, istDayNumber(date), date);
  }
});

test("the book runs oldest first, and ties break on the number", () => {
  const invoices = [
    invoice({ invoiceNo: 5, date: "2026-06-20" }),
    invoice({ invoiceNo: 3, date: "2026-06-10" }),
    invoice({ invoiceNo: 2, date: "2026-06-20" }),
  ];
  assert.deepEqual(
    documentsFor({ invoices, side: "Sale" }).map((r) => r.invoiceNo),
    [3, 2, 5]
  );
});

test("a document with no readable date is left out", () => {
  // Rather than sorted to the front and silently counted in every period.
  const invoices = [invoice(), invoice({ invoiceNo: 8, date: null })];
  assert.deepEqual(documentsFor({ invoices, side: "Sale" }).map((r) => r.invoiceNo), [1]);
});

test("a hole in the list does not throw", () => {
  // `.find()` on an empty result and a `[...docs, maybe]` spread both put
  // undefined into an array of invoices, and a report is not the place to
  // discover it.
  const invoices = [invoice(), null, undefined, invoice({ invoiceNo: 9 })];
  assert.deepEqual(
    documentsFor({ invoices, side: "Sale" }).map((r) => r.invoiceNo),
    [1, 9]
  );
  assert.equal(itemWise({ invoices, side: "Sale" }).length, 1);
});

test("the taxable value comes off the gross, which is what is stored", () => {
  // THE FIELD IS TAX-INCLUSIVE despite its name. This is the assertion that
  // was wrong first time round and put the gross in the Taxable column.
  assert.equal(taxableOf({ totalAmount: 1180, gst: 180, finalAmount: 1180 }), 1000);
  assert.equal(taxableOf({}), 0);
  assert.equal(taxableOf({ totalAmount: 1180 }), 1180, "no GST, nothing to take off");
});

test("a bill with overheads takes its taxable value off the items, not the total", () => {
  // `finalAmount` is `totalAmount` plus the party taxes and the freight, so
  // reading it instead would count the overheads as taxable value.
  const withFreight = { totalAmount: 1180, gst: 180, finalAmount: 1500 };
  assert.equal(taxableOf(withFreight), 1000);
  assert.equal(netOf(withFreight), 1180, "the items, GST included");
  assert.equal(othersOf(withFreight), 320, "the freight and the party taxes");
  // And finalAmount is still the fallback for a row that never stored the
  // items' total at all.
  assert.equal(taxableOf({ gst: 180, finalAmount: 1180 }), 1000);
  assert.equal(netOf({ gst: 180, finalAmount: 1180 }), 1180);
  assert.equal(othersOf({ finalAmount: 1180 }), 0, "nothing to compare against");
});

/** A return carrying freight, so `others` is not zero on a negative row. */
const RETURN_WITH_FREIGHT = invoice({
  invoiceNo: 3,
  return: true,
  totalAmount: 236,
  gst: 36,
  finalAmount: 300,
  balanceDue: 300,
  items: [line({ quantity: 2, taxableAmount: 200, gstAmount: 36, total: 236 })],
});

console.log("\n--- the book is a period summary, as Sigfa's is ---");

test("Sigfa's three grains, opening on the month it opens on", () => {
  assert.deepEqual(BOOK_GRAINS, ["month", "date", "document"]);
  assert.equal(DEFAULT_GRAIN, "month", "Sigfa's Sales Book opens by month");
  assert.equal(isBookGrain("month"), true);
  assert.equal(isBookGrain("year"), false, "it has no year grain");
  assert.equal(isBookGrain(""), false);
});

test("one row per month, oldest first", () => {
  // A book is read forwards, unlike the party and item sheets, which are
  // read biggest first.
  //
  // Built with bookRow rather than through documentsFor, which sorts: fed
  // sorted rows, a grouping that did not sort at all would come out right by
  // accident and this test would prove nothing.
  const rows = periodWise(
    [
      bookRow(invoice({ invoiceNo: 1, date: "2026-06-15" })),
      bookRow(invoice({ invoiceNo: 2, date: "2026-06-28" })),
      bookRow(invoice({ invoiceNo: 3, date: "2026-04-02" })),
      bookRow(invoice({ invoiceNo: 4, date: "2026-05-09" })),
    ],
    "month"
  );
  assert.deepEqual(rows.map((r) => r.label), ["Apr 2026", "May 2026", "Jun 2026"]);
  assert.deepEqual(rows.map((r) => r.documents), [1, 1, 2]);
  assert.equal(rows[2].total, 2360, "the two June bills");
  assert.equal(rows[2].taxable, 2000);
});

test("the dates inside a month sort by day, not as text", () => {
  // The key is padded for exactly this: "2026-06-5" sorts AFTER "2026-06-15"
  // as a string, and the sheet would run the 15th before the 5th.
  const rows = periodWise(
    [
      bookRow(invoice({ invoiceNo: 1, date: "2026-06-15" })),
      bookRow(invoice({ invoiceNo: 2, date: "2026-06-05" })),
      bookRow(invoice({ invoiceNo: 3, date: "2026-06-30" })),
    ],
    "date"
  );
  assert.deepEqual(rows.map((r) => r.key), ["2026-06-05", "2026-06-15", "2026-06-30"]);
  assert.deepEqual(rows.map((r) => r.label), ["5 Jun 2026", "15 Jun 2026", "30 Jun 2026"]);
});

test("a document with no readable date reaches no period", () => {
  // documentsFor drops these before the grouping sees them, so this goes
  // straight at the grouping: a null day grouped under one heading would be
  // a month of bills nobody can account for.
  const rows = periodWise(
    [bookRow(invoice({ invoiceNo: 1 })), bookRow(invoice({ invoiceNo: 9, date: null }))],
    "month"
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].documents, 1);
  assert.deepEqual(periodWise([bookRow(invoice({ date: null }))], "date"), []);
});

test("the month a document falls in is its IST month, not the server's", () => {
  // 19:00 UTC on 30 June is already 1 July in IST, so it belongs to July.
  const invoices = [invoice({ invoiceNo: 7, date: "2026-06-30T19:00:00Z" })];
  const rows = periodWise(documentsFor({ invoices, side: "Sale" }), "month");
  assert.deepEqual(rows.map((r) => r.key), ["2026-07"]);
  assert.equal(rows[0].label, "Jul 2026");
});

test("a month whose returns outweigh its sales reads negative", () => {
  // Sigfa wraps this in Abs() and would print +236. See the module header.
  const rows = periodWise(documentsFor({ invoices: [RETURN], side: "Sale" }), "month");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].returns, 1);
  assert.equal(rows[0].total, -236);
  assert.equal(rows[0].taxable, -200);
  // And the footer under it, which is where an Abs() would be easiest to
  // slip in unnoticed -- every other test in this file totals to a positive.
  const t = periodTotals(rows);
  assert.equal(t.total, -236, "not +236");
  assert.equal(t.taxable, -200);
  assert.equal(t.net, -236);
});

test("the overheads on a return subtract like everything else on it", () => {
  // `others` is the only column derived from a difference rather than stored,
  // so it is the one most likely to come out unsigned.
  const row = bookRow(RETURN_WITH_FREIGHT);
  assert.equal(row.others, 64, "300 charged less the 236 the items came to");
  assert.equal(row.signedOthers, -64);
  assert.equal(row.net, 236);
  assert.equal(row.signedNet, -236);

  const mixed = documentsFor({
    invoices: [invoice({ invoiceNo: 1 }), RETURN_WITH_FREIGHT],
    side: "Sale",
  });
  const t = totalsOf(mixed);
  assert.equal(t.others, -64, "nothing on the invoice, 64 off on the return");
  assert.equal(t.net, 944, "1180 less 236");
  assert.equal(t.total, 880, "1180 less 300");
  // The period sheet over the same two must agree with the book above it.
  assert.deepEqual(
    [t.net, t.others, t.total],
    [periodTotals(periodWise(mixed, "month")).net, periodTotals(periodWise(mixed, "month")).others,
      periodTotals(periodWise(mixed, "month")).total]
  );
});

test("a month row opens the dates inside it, and nothing else", () => {
  // Sigfa's zoom, which it does by dropping Month() for 'group by Vdate' and
  // writing the result to a table called ZoomD.
  const invoices = [
    invoice({ invoiceNo: 1, date: "2026-06-15" }),
    invoice({ invoiceNo: 2, date: "2026-06-15" }),
    invoice({ invoiceNo: 3, date: "2026-06-28" }),
    invoice({ invoiceNo: 4, date: "2026-07-01" }),
  ];
  const documents = documentsFor({ invoices, side: "Sale" });
  const june = zoomInto(documents, "2026-06");
  assert.deepEqual(june.map((r) => r.label), ["15 Jun 2026", "28 Jun 2026"]);
  assert.deepEqual(june.map((r) => r.documents), [2, 1]);
  assert.equal(june[0].total, 2360, "both bills of the 15th");
  // The month that was clicked, and not the one beside it.
  assert.deepEqual(zoomInto(documents, "2026-07").map((r) => r.label), ["1 Jul 2026"]);
  assert.deepEqual(zoomInto(documents, "2026-08"), []);
  assert.deepEqual(zoomInto(documents, ""), [], "no month, nothing to open");
});

test("a date sheet knows which month it came out of", () => {
  // So the screen can offer the way back without remembering it itself.
  const rows = periodWise(documentsFor({ invoices: [invoice()], side: "Sale" }), "date");
  assert.equal(rows[0].key, "2026-06-15");
  assert.equal(rows[0].month, "2026-06");
});

console.log("\n--- the book, split one row per party ---");

/**
 * Sigfa has no such sheet: its book is periods and its Party Wise is the
 * whole range, one row per party. Neither answers "who did we sell to in
 * March", which is what a period row carrying a name does.
 */

const BHARAT = { name: "Bharat Steel", gstin: "07AAACB2222B1Z5" };

test("a period splits into one row per party", () => {
  const invoices = [
    invoice({ invoiceNo: 1, date: "2026-06-05" }),
    invoice({ invoiceNo: 2, date: "2026-06-20" }),
    invoice({ invoiceNo: 3, date: "2026-06-25", customer: BHARAT }),
  ];
  const docs = documentsFor({ invoices, side: "Sale" });
  const plain = periodWise(docs, "month");
  const split = periodWise(docs, "month", { byParty: true });

  assert.equal(plain.length, 1, "one month");
  assert.equal(split.length, 2, "one month, two parties");
  assert.deepEqual(split.map((r) => r.party), ["Acme Traders", "Bharat Steel"]);
  assert.equal(split[0].gstin, "07AAACA1111A1Z5");
  assert.equal(split[0].documents, 2, "Acme's two bills");
  assert.equal(split[1].documents, 1);
  // Every row still names its period, and reads the same label as the plain
  // sheet's -- the split cuts the sheet, it does not relabel it.
  assert.deepEqual(split.map((r) => r.label), ["Jun 2026", "Jun 2026"]);
  assert.deepEqual(split.map((r) => r.period), ["2026-06", "2026-06"]);
  // And the plain sheet is untouched by any of it.
  assert.equal(plain[0].party, undefined);
});

test("the split adds up to the sheet it split", () => {
  // THE CHECK THAT MATTERS. A party-wise book that did not total to the
  // plain book would have every row on it individually looking right.
  const invoices = [
    invoice({ invoiceNo: 1, date: "2026-06-05" }),
    invoice({ invoiceNo: 2, date: "2026-07-02", customer: BHARAT }),
    RETURN,
  ];
  const docs = documentsFor({ invoices, side: "Sale" });
  const plain = periodTotals(periodWise(docs, "month"));
  const split = periodTotals(periodWise(docs, "month", { byParty: true }));

  for (const key of ["documents", "returns", "taxable", "gst", "net", "others", "total", "balanceDue"]) {
    assert.equal(split[key], plain[key], `${key} disagrees`);
  }
  // Periods are counted as periods, not as rows: party-wise, one month is
  // several rows, and a footer saying "3 periods" over one month is wrong.
  assert.equal(split.periods, plain.periods);
  assert.equal(split.periods, 2, "June and July");
  assert.equal(split.parties, 2);
  assert.equal(plain.parties, 0, "a plain period sheet has no party dimension");
});

test("a party's returns net off inside their own period row", () => {
  // RETURN is Acme's, dated 15 June, so it lands on Acme's June row and on
  // nobody else's -- the netting is per row now, not just per period.
  const invoices = [
    invoice({ invoiceNo: 1, date: "2026-06-10" }),
    invoice({ invoiceNo: 4, date: "2026-06-12", customer: BHARAT }),
    RETURN,
  ];
  const rows = periodWise(documentsFor({ invoices, side: "Sale" }), "month", { byParty: true });
  const acme = rows.find((r) => r.party === "Acme Traders");
  const bharat = rows.find((r) => r.party === "Bharat Steel");
  assert.equal(acme.returns, 1);
  assert.equal(acme.total, 944, "1180 less 236");
  assert.equal(acme.balanceDue, 944);
  assert.equal(bharat.returns, 0, "the credit note is not theirs");
  assert.equal(bharat.total, 1180);
});

test("periods run forwards, and the biggest party leads each one", () => {
  // A book is read forwards; inside a period, biggest first, which is how
  // partyWise sorts and so the two sheets rank a party the same way.
  const flat = (over) => invoice({ totalAmount: over.amount, gst: 0, finalAmount: over.amount, ...over });
  const invoices = [
    flat({ invoiceNo: 1, date: "2026-07-01", customer: { name: "Small" }, amount: 100 }),
    flat({ invoiceNo: 2, date: "2026-07-02", customer: { name: "Big" }, amount: 9000 }),
    flat({ invoiceNo: 3, date: "2026-06-02", customer: { name: "Small" }, amount: 50 }),
  ];
  const rows = periodWise(documentsFor({ invoices, side: "Sale" }), "month", { byParty: true });
  assert.deepEqual(
    rows.map((r) => `${r.label}/${r.party}`),
    ["Jun 2026/Small", "Jul 2026/Big", "Jul 2026/Small"]
  );
});

test("one party's name cannot swallow another's period", () => {
  // The key joins the period and the party on \u0000, the one character a
  // typed name cannot hold. Joined on a hyphen, "2026-06" + "-" + "A-B" and
  // "2026-06-A" + "-" + "B" are the same string and two rows merge into one.
  const invoices = [
    invoice({ invoiceNo: 1, date: "2026-06-10", customer: { name: "A-B" } }),
    invoice({ invoiceNo: 2, date: "2026-06-11", customer: { name: "A" } }),
  ];
  const rows = periodWise(documentsFor({ invoices, side: "Sale" }), "month", { byParty: true });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.party).sort(), ["A", "A-B"]);
});

test("an unnamed party is filed the same way on both sheets", () => {
  // One constant, so a party-wise book reconciles row for row against a
  // Party Wise sheet instead of calling the same bills something else.
  const docs = documentsFor({ invoices: [invoice({ customer: {} })], side: "Sale" });
  assert.equal(periodWise(docs, "month", { byParty: true })[0].party, NO_PARTY);
  assert.equal(partyWise(docs)[0].party, NO_PARTY);
  assert.equal(NO_PARTY, "(not named)");
});

test("a party's GSTIN survives a bill saved without it", () => {
  // The backfill partyWise carries, in the direction an unconditional
  // assignment gets wrong: the bill with no GSTIN arrives second.
  const invoices = [
    invoice({ invoiceNo: 1, date: "2026-06-10" }),
    invoice({ invoiceNo: 2, date: "2026-06-20", customer: { name: "Acme Traders" } }),
  ];
  const rows = periodWise(documentsFor({ invoices, side: "Sale" }), "month", { byParty: true });
  assert.equal(rows.length, 1, "one party, whatever the GSTIN says");
  assert.equal(rows[0].gstin, "07AAACA1111A1Z5", "not wiped by the second bill");
});

test("the zoom keeps the split", () => {
  // Opening a month on a party-wise book must not quietly drop the column
  // the row that was clicked had.
  const invoices = [
    invoice({ invoiceNo: 1, date: "2026-06-15" }),
    invoice({ invoiceNo: 2, date: "2026-06-15", customer: BHARAT }),
    invoice({ invoiceNo: 3, date: "2026-07-01" }),
  ];
  const docs = documentsFor({ invoices, side: "Sale" });
  const june = zoomInto(docs, "2026-06", { byParty: true });
  assert.equal(june.length, 2, "one day, two parties");
  assert.deepEqual(june.map((r) => r.label), ["15 Jun 2026", "15 Jun 2026"]);
  assert.deepEqual(june.map((r) => r.party).sort(), ["Acme Traders", "Bharat Steel"]);
  // The month it came out of, so the screen can still offer the way back.
  assert.deepEqual(june.map((r) => r.month), ["2026-06", "2026-06"]);
  // And asking without the option is still the plain zoom.
  assert.equal(zoomInto(docs, "2026-06").length, 1);
});

test("the split's captions are the period's with a party in them", () => {
  assert.deepEqual(
    CSV_COLUMNS.periodParty.map((c) => c.label),
    ["Month", "Party", "GSTIN", "Bills", "Returns", "Taxable Amount", "GST", "Net Amount", "Others", "Bill Amount"]
  );
  // Take the two new columns out and what is left IS the period sheet, in
  // the period sheet's order -- so the two cannot drift apart.
  assert.deepEqual(
    CSV_COLUMNS.periodParty.filter((c) => !["party", "gstin"].includes(c.key)).map((c) => c.key),
    CSV_COLUMNS.period.map((c) => c.key)
  );
  // Alignment is decided by key, not by position: positionally, the party
  // name and the GSTIN are right-aligned like figures.
  const shown = sheetHeadings("periodParty", "Date");
  assert.equal(shown[0].label, "Date", "the grain still relabels the first one");
  assert.deepEqual(
    shown.map((h) => h.numeric),
    [false, false, false, true, true, true, true, true, true, true]
  );
  // A plain month sheet and a party-wise one must not land under one name.
  const plain = csvFilename("book", "Sale", "2026-06-01", "2026-06-30", "month");
  const split = csvFilename("book", "Sale", "2026-06-01", "2026-06-30", "month", { byParty: true });
  assert.notEqual(plain, split);
  assert.match(split, /-party-wise-/);
});

test("a period label reads the way a date is written here", () => {
  assert.equal(periodLabel("2026-06"), "Jun 2026");
  assert.equal(periodLabel("2026-06-15"), "15 Jun 2026");
  assert.equal(periodLabel("2026-01-01"), "1 Jan 2026");
  assert.equal(periodLabel("2026-12"), "Dec 2026");
  // And an unreadable key is shown rather than silently blanked.
  assert.equal(periodLabel("2026-13"), "2026-13");
  assert.equal(periodLabel(""), "");
});

test("the period footer totals the column above it", () => {
  const invoices = [invoice({ invoiceNo: 1 }), invoice({ invoiceNo: 2, date: "2026-07-03" }), RETURN];
  const rows = periodWise(documentsFor({ invoices, side: "Sale" }), "month");
  const t = periodTotals(rows);
  assert.equal(t.periods, 2, "June and July");
  assert.equal(t.documents, 3);
  assert.equal(t.returns, 1);
  assert.equal(t.taxable, 1800, "1000 + 1000 - 200");
  assert.equal(t.gst, 324);
  assert.equal(t.net, 2124);
  assert.equal(t.total, 2124);
  assert.equal(t.total, rows.reduce((sum, r) => sum + r.total, 0));
  assert.deepEqual(periodTotals([]), {
    periods: 0, parties: 0, documents: 0, returns: 0,
    taxable: 0, gst: 0, net: 0, others: 0, total: 0, balanceDue: 0,
  });
});

test("the book's captions are Sigfa's, in Sigfa's spelling", () => {
  // It builds them by concatenation from 'Month,Bill Amount' upwards. The
  // nine pre-GST heads it can also show have no field here -- GST stands
  // where that block stood, and the module header says so.
  assert.deepEqual(
    CSV_COLUMNS.period.map((c) => c.label),
    ["Month", "Bills", "Returns", "Taxable Amount", "GST", "Net Amount", "Others", "Bill Amount"]
  );
  // A month sheet and a bill sheet of one month must not land under one name.
  assert.notEqual(
    csvFilename("book", "Sale", "2026-06-01", "2026-06-30", "month"),
    csvFilename("book", "Sale", "2026-06-01", "2026-06-30", "document")
  );
  assert.match(csvFilename("book", "Sale", "2026-06-01", "2026-06-30", "month"), /-month-/);
});

console.log("\n--- which documents: Sigfa asks, and so does this ---");

test("the printed sheet and the download share one caption list", () => {
  // Two lists is how a column comes to be called Total on screen and Bill
  // Amount in the CSV of the same sheet.
  const shown = sheetHeadings("period", "Month");
  assert.deepEqual(shown.map((h) => h.label), CSV_COLUMNS.period.map((c) => c.label));
  // The leading caption is the only one the grain changes.
  assert.equal(sheetHeadings("period", "Date")[0].label, "Date");
  assert.equal(sheetHeadings("period", "")[0].label, "Month", "no override, Sigfa's own");
  // Everything after the first column is a figure, and is set right.
  assert.deepEqual(shown.map((h) => h.numeric), [false, true, true, true, true, true, true, true]);
  assert.deepEqual(sheetHeadings("nonsense", "X"), []);
});

test("Sigfa's selector, less the challan this app has not got", () => {
  assert.deepEqual(DOC_SCOPES, ["invoices", "returns", "both"]);
  assert.equal(DEFAULT_SCOPE, "both", "the netted one, which answers 'what did we sell'");
  assert.equal(isDocScope("invoices"), true);
  assert.equal(isDocScope("challans"), false, "there are none here");
  assert.equal(isDocScope(""), false);
});

test("each scope is named as Sigfa names it", () => {
  // ' Sales Book : Sales Return : Sales And Sales Return : Sales Challan : '
  assert.equal(scopeName("invoices", "Sale"), "Sales Book");
  assert.equal(scopeName("returns", "Sale"), "Sales Return");
  assert.equal(scopeName("both", "Sale"), "Sales And Sales Return");
  assert.equal(scopeName("invoices", "Purchase"), "Purchase Book");
  assert.equal(scopeName("returns", "Purchase"), "Purchase Return");
  assert.equal(scopeName("both", "Purchase"), "Purchase And Purchase Return");
});

test("the scope decides which documents every sheet sees", () => {
  const invoices = [invoice({ invoiceNo: 1 }), RETURN];
  const nos = (scope) => documentsFor({ invoices, side: "Sale", scope }).map((r) => r.invoiceNo);
  assert.deepEqual(nos("invoices"), [1]);
  assert.deepEqual(nos("returns"), [2]);
  assert.deepEqual(nos("both"), [1, 2]);
  assert.deepEqual(nos(undefined), [1, 2], "asking for nothing gets the netted default");

  // And the item sheet, which walks the invoices itself, must agree.
  assert.equal(itemWise({ invoices, side: "Sale", scope: "invoices" })[0].quantity, 10);
  assert.equal(itemWise({ invoices, side: "Sale", scope: "returns" })[0].quantity, -2);
  assert.equal(itemWise({ invoices, side: "Sale", scope: "both" })[0].quantity, 8);
});

test("a returns-only sheet still prints its documents at face value", () => {
  // The scope changes which documents are counted, not how one is read: a
  // credit note for 236 is a credit note for 236, and it still subtracts.
  const rows = documentsFor({ invoices: [RETURN], side: "Sale", scope: "returns" });
  assert.equal(rows[0].total, 236);
  assert.equal(rows[0].signedTotal, -236);
  assert.equal(totalsOf(rows).total, -236);
});

console.log("\n--- party wise ---");

test("one row per party, however many documents", () => {
  const invoices = [
    invoice({ invoiceNo: 1 }),
    invoice({ invoiceNo: 2 }),
    invoice({ invoiceNo: 3, customer: { name: "Other" } }),
  ];
  const rows = partyWise(documentsFor({ invoices, side: "Sale" }));
  assert.equal(rows.length, 2);
  const acme = rows.find((r) => r.party === "Acme Traders");
  assert.equal(acme.documents, 2);
  assert.equal(acme.total, 2360);
});

test("the GSTIN survives a document that lacks it, whichever comes first", () => {
  // Dated rather than numbered, because the book sorts by day and then by
  // number -- an earlier version of this test set the order with the invoice
  // number and the sort put it back, so neither order was ever tried.
  const withGstin = invoice({ invoiceNo: 1, date: "2026-06-20" });
  const without = invoice({ invoiceNo: 2, date: "2026-06-10", customer: { name: "Acme Traders" } });
  // Backfilled when the blank one opened the group (it is the earlier date)...
  assert.equal(
    partyWise(documentsFor({ invoices: [without, withGstin], side: "Sale" }))[0].gstin,
    "07AAACA1111A1Z5"
  );
  // ...and NOT wiped when the blank one arrives second, which is the half an
  // unconditional assignment gets wrong.
  const flipped = [
    invoice({ invoiceNo: 1, date: "2026-06-10" }),
    invoice({ invoiceNo: 2, date: "2026-06-20", customer: { name: "Acme Traders" } }),
  ];
  assert.equal(
    partyWise(documentsFor({ invoices: flipped, side: "Sale" }))[0].gstin,
    "07AAACA1111A1Z5"
  );
});

test("a party's returns are counted and netted off their balance", () => {
  const invoices = [invoice({ invoiceNo: 1 }), RETURN];
  const rows = partyWise(documentsFor({ invoices, side: "Sale" }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].documents, 2, "both documents are in the period");
  assert.equal(rows[0].returns, 1, "and one of them is a return");
  assert.equal(rows[0].total, 944, "1180 less 236");
  // The balance column nets the same way. 1180 owed, 236 credited back.
  assert.equal(rows[0].balanceDue, 944);
});

test("an unnamed party is grouped, not dropped", () => {
  const rows = partyWise(documentsFor({ invoices: [invoice({ customer: {} })], side: "Sale" }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].party, "(not named)");
});

test("parties sort by value, biggest first", () => {
  const invoices = [
    invoice({ invoiceNo: 1, customer: { name: "Small" }, finalAmount: 100, totalAmount: 100, gst: 0 }),
    invoice({ invoiceNo: 2, customer: { name: "Big" }, finalAmount: 9000, totalAmount: 9000, gst: 0 }),

  ];
  assert.deepEqual(
    partyWise(documentsFor({ invoices, side: "Sale" })).map((r) => r.party),
    ["Big", "Small"]
  );
});

console.log("\n--- item wise ---");

test("one row per item, across every document", () => {
  const invoices = [
    invoice({ invoiceNo: 1 }),
    invoice({
      invoiceNo: 2,
      items: [line({ name: "Washer", quantity: 5, taxableAmount: 50, gstAmount: 9, total: 59 })],
    }),
  ];
  const rows = itemWise({ invoices, side: "Sale" });
  assert.deepEqual(rows.map((r) => r.item).sort(), ["Plate", "Washer"]);
  assert.equal(rows.find((r) => r.item === "Plate").quantity, 10);
});

test("the same item on two documents is one row", () => {
  const rows = itemWise({ invoices: [invoice({ invoiceNo: 1 }), invoice({ invoiceNo: 2 })], side: "Sale" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].quantity, 20);
  assert.equal(rows[0].documents, 2);
});

test("an item named with different capitals is still one row", () => {
  // Every master in this app joins by name; two rows differing only in case
  // would split one item's figures in half.
  const rows = itemWise({
    invoices: [invoice({ invoiceNo: 1 }), invoice({ invoiceNo: 2, items: [line({ name: "PLATE" })] })],
    side: "Sale",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].quantity, 20);
});

test("the item sheet covers the same documents the book does", () => {
  // itemWise walks the invoices itself rather than the book rows, because it
  // needs inside them -- so it repeats the side and period filter, and the
  // repeat is the thing that can drift.
  const invoices = [
    invoice({ invoiceNo: 1, date: "2026-06-15" }),
    invoice({ invoiceNo: 2, date: "2026-06-15", type: "Purchase" }),
    invoice({ invoiceNo: 3, date: "2026-05-31" }),
    invoice({ invoiceNo: 4, date: "2026-07-01" }),
    invoice({ invoiceNo: 5, date: null }),
  ];
  const args = { invoices, side: "Sale", from: "2026-06-01", to: "2026-06-30" };
  const rows = itemWise(args);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].documents, 1, "one document, not five");
  assert.equal(rows[0].quantity, 10);
  // And it agrees with the book, which is the whole point of checking it.
  assert.equal(totalsOf(documentsFor(args)).documents, 1);

  // Widen the period to everything and the dateless one is STILL out, as it
  // is out of the book. With a period set, the bounds hide that rule: a null
  // day compares as 0 and falls below any real start day anyway.
  const everything = itemWise({ invoices, side: "Sale" });
  assert.equal(everything[0].documents, 3, "1, 3 and 4 -- not the dateless 5");
  assert.equal(everything[0].quantity, 30);
  assert.equal(documentsFor({ invoices, side: "Sale" }).length, 3);
});

test("an item carries its HSN, its unit and its document count", () => {
  const rows = itemWise({
    invoices: [
      invoice({ invoiceNo: 1, items: [line({ uqc: "KGS", unit: "Kilogram" }), line({ name: "Plate" })] }),
      invoice({ invoiceNo: 2 }),
    ],
    side: "Sale",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hsn, "7308");
  // UQC is the GST code and `unit` is whatever was typed into the master.
  // The code is preferred, because it is the one a return has to carry.
  assert.equal(rows[0].unit, "KGS");
  assert.equal(rows[0].documents, 2, "two documents, though three lines");
});

test("an item saved without its HSN takes it from a later document", () => {
  // The case the backfill exists for, in both directions: the FIRST line is
  // the one missing them, and a LATER line missing them does not wipe what
  // the earlier one supplied.
  const bare = { name: "Plate", quantity: 1, taxableAmount: 100, gstAmount: 18, total: 118 };
  const full = line({ quantity: 1, taxableAmount: 100, gstAmount: 18, total: 118 });

  const late = itemWise({
    invoices: [invoice({ invoiceNo: 1, items: [bare] }), invoice({ invoiceNo: 2, items: [full] })],
    side: "Sale",
  });
  assert.equal(late[0].hsn, "7308", "picked up from the second document");
  assert.equal(late[0].unit, "KGS");

  const early = itemWise({
    invoices: [invoice({ invoiceNo: 1, items: [full] }), invoice({ invoiceNo: 2, items: [bare] })],
    side: "Sale",
  });
  assert.equal(early[0].hsn, "7308", "not wiped by the second document");
  assert.equal(early[0].unit, "KGS");
});

test("items sort by value, biggest first", () => {
  const rows = itemWise({
    invoices: [
      invoice({
        items: [
          line({ name: "Small", taxableAmount: 10, gstAmount: 1.8, total: 11.8 }),
          line({ name: "Big", taxableAmount: 9000, gstAmount: 1620, total: 10620 }),
          line({ name: "Middling", taxableAmount: 500, gstAmount: 90, total: 590 }),
        ],
      }),
    ],
    side: "Sale",
  });
  assert.deepEqual(rows.map((r) => r.item), ["Big", "Middling", "Small"]);
});

test("the average rate is value over quantity, and never divides by zero", () => {
  const rows = itemWise({ invoices: [invoice()], side: "Sale" });
  assert.equal(rows[0].rate, 100, "1000 over 10");
  // A period whose returns cancel the sales exactly.
  const cancelled = itemWise({
    invoices: [
      invoice({ invoiceNo: 1 }),
      invoice({ invoiceNo: 2, return: true, items: [line()] }),
    ],
    side: "Sale",
  });
  assert.equal(cancelled[0].quantity, 0);
  assert.equal(cancelled[0].rate, null, "no quantity, no rate -- not Infinity");
});

test("a line with no name is left out", () => {
  const rows = itemWise({ invoices: [invoice({ items: [line({ name: "" }), line()] })], side: "Sale" });
  assert.equal(rows.length, 1);
});

test("an invoice with no lines does not break the sheet", () => {
  assert.deepEqual(itemWise({ invoices: [invoice({ items: [] })], side: "Sale" }), []);
  assert.deepEqual(itemWise({ invoices: [invoice({ items: undefined })], side: "Sale" }), []);
  assert.deepEqual(itemWise({}), []);
});

console.log("\n--- the figures under the sheets ---");

test("the party footer totals the column above it", () => {
  const invoices = [
    invoice({ invoiceNo: 1 }),
    invoice({ invoiceNo: 2, customer: { name: "Other" }, received: 1180, balanceDue: 0 }),
    RETURN,
  ];
  const rows = partyWise(documentsFor({ invoices, side: "Sale" }));
  const t = partyTotals(rows);
  assert.equal(t.parties, 2);
  assert.equal(t.taxable, 1800, "1000 + 1000 - 200");
  assert.equal(t.gst, 324, "180 + 180 - 36");
  assert.equal(t.total, 2124, "1180 + 1180 - 236");
  assert.equal(t.balanceDue, 944, "1180 + 0 - 236");
  // The footer is the column added up, not a second calculation of it.
  assert.equal(t.total, rows.reduce((sum, r) => sum + r.total, 0));
});

test("the item footer totals the column above it", () => {
  const invoices = [
    invoice({ invoiceNo: 1 }),
    invoice({
      invoiceNo: 2,
      items: [line({ name: "Washer", quantity: 5, taxableAmount: 50, gstAmount: 9, total: 59 })],
    }),
    RETURN,
  ];
  const rows = itemWise({ invoices, side: "Sale" });
  const t = itemTotals(rows);
  assert.equal(t.items, 2);
  assert.equal(t.quantity, 13, "10 + 5 - 2");
  assert.equal(t.taxable, 850, "1000 + 50 - 200");
  assert.equal(t.gst, 153, "180 + 9 - 36");
  assert.equal(t.total, 1003, "1180 + 59 - 236");
  assert.equal(t.quantity, rows.reduce((sum, r) => sum + r.quantity, 0));
});

test("an empty period totals to zero rather than to nothing", () => {
  // The screen reads these before it knows whether anything came back.
  assert.deepEqual(totalsOf([]), {
    documents: 0, returns: 0, taxable: 0, gst: 0, net: 0, others: 0, total: 0,
  });
  assert.deepEqual(periodWise([], "month"), []);
  assert.deepEqual(partyTotals([]), { parties: 0, taxable: 0, gst: 0, total: 0, balanceDue: 0 });
  assert.deepEqual(itemTotals([]), { items: 0, quantity: 0, taxable: 0, gst: 0, total: 0 });
});

console.log("\n--- the sheets download what they show ---");

test("every view has a column set", () => {
  for (const view of SALES_VIEWS) {
    assert.ok(CSV_COLUMNS[view]?.length, `no columns for ${view}`);
  }
});

test("a return is named in the download, not just signed", () => {
  const column = CSV_COLUMNS.book.find((c) => c.key === "kind");
  assert.equal(column.value({ isReturn: true }), "Return");
  assert.equal(column.value({ isReturn: false }), "Invoice");
});

test("an item with no rate exports as blank, not as null", () => {
  const column = CSV_COLUMNS.item.find((c) => c.key === "rate");
  assert.equal(column.value({ rate: null }), "");
  assert.equal(column.value({ rate: 100 }), 100);
  assert.equal(column.value({ rate: 0 }), 0, "zero is a rate, not a blank");
});

test("the filename says which report and which period", () => {
  assert.equal(
    csvFilename("book", "Sale", "2026-06-01", "2026-06-30"),
    "sales-book-2026-06-01-to-2026-06-30.csv"
  );
  assert.match(csvFilename("item", "Purchase", "", ""), /^item-wise-purchase-all-to-all\.csv$/);
});

console.log("\n--- the wiring ---");

test("one route serves all six, and refuses anything else", () => {
  // Three routes would be three places for "what counts as a sale" to drift.
  const src = read("../app/api/sales-report/route.js");
  assert.ok(/isSalesView/.test(src) && /isReportSide/.test(src));
  assert.ok(/export const GET = tenantRoute\(/.test(src));
  assert.doesNotMatch(src, /^export\s+async\s+function\s+GET\b/m, "it must be wrapped");
});

test("the route serves the grain, the scope and the zoom, and refuses the rest", () => {
  const src = read("../app/api/sales-report/route.js");
  for (const guard of ["isDocScope", "isBookGrain"]) {
    assert.ok(src.includes(guard), `${guard} is not checked`);
  }
  // Defaults from the module, not spelled again here.
  assert.ok(src.includes("DEFAULT_SCOPE") && src.includes("DEFAULT_GRAIN"));
  // The zoom: a named month narrows to the dates inside it.
  assert.ok(/grain === "date" && month\s*\?\s*zoomInto\(/.test(src));
  // The scope reaches BOTH walkers -- the book's and the item sheet's.
  assert.ok(/itemWise\(\{[^}]*scope[^}]*\}\)/.test(src), "the item sheet ignores the scope");
  assert.ok(/documentsFor\(\{[^}]*scope[^}]*\}\)/.test(src), "the book ignores the scope");
});

test("the route computes nothing itself", () => {
  const src = read("../app/api/sales-report/route.js");
  for (const fn of ["documentsFor", "partyWise", "itemWise", "totalsOf", "periodWise", "periodTotals"]) {
    assert.ok(src.includes(fn), `${fn} is not used`);
  }
  // No arithmetic of its own: a report that totalled in the route would
  // disagree with the module the test exercises.
  assert.doesNotMatch(src, /reduce\(/, "the route is doing its own totalling");
});

test("the date filter is widened before the IST comparison", () => {
  // The stored dates are UTC midnights and the module compares IST calendar
  // days, so narrowing exactly in the database drops an invoice saved late on
  // the last day of the period before the real comparison ever sees it.
  const src = read("../app/api/sales-report/route.js");
  assert.ok(/setUTCDate\(end\.getUTCDate\(\) \+ 2\)/.test(src));
});

test("the lines are fetched only for the sheet that reads them", () => {
  // They are the bulk of an invoice's payload, and only item-wise opens them.
  const src = read("../app/api/sales-report/route.js");
  assert.ok(/view === "item" \? \{ items: 1 \}/.test(src));
});

test("the reports are owner and accountant, not biller", () => {
  // A sales book is the firm's trading position for a period, not one bill.
  for (const path of ["/sales-report", "/api/sales-report"]) {
    assert.equal(permissionForPath(path), "report:read", path);
    assert.equal(canAccessPath("owner", path), true, path);
    assert.equal(canAccessPath("accountant", path), true, path);
    assert.equal(canAccessPath("biller", path), false, path);
  }
});

test("the page computes nothing and reaches the dashboard", () => {
  const page = read("../app/sales-report/page.js");
  assert.ok(/from '@\/lib\/salesReports\.mjs'/.test(page));
  assert.doesNotMatch(page, /\.reduce\(/, "the page is doing its own totalling");
  assert.ok(/reportName\(view, side\)/.test(page), "the title comes from the module");
  assert.ok(/'\/sales-report'/.test(read("../app/page.js")), "no tile on the dashboard");
});

test("the party split reaches the rows, the columns and the filename", () => {
  const src = read("../app/api/sales-report/route.js");
  // Resolved ONCE in the route, so the rows, the columns and the filename
  // cannot disagree about whether the sheet in hand is split.
  assert.ok(
    /const splitByParty = byParty && view === "book" && grain !== "document"/.test(src),
    "the route decides the split in more than one place"
  );
  assert.ok(/zoomInto\(documents, month, \{ byParty: splitByParty \}\)/.test(src));
  assert.ok(/periodWise\(documents, grain, \{ byParty: splitByParty \}\)/.test(src));
  assert.ok(/byParty: splitByParty/.test(src), "the sheet builder is not told");
  assert.ok(/party-wise/.test(src), "the download would overwrite the plain one");

  // The workbook picks the split column set, not the plain one.
  assert.ok(/return byParty \? "periodParty" : "period"/.test(read("../lib/reportSheets.mjs")));

  // The screen offers it and switches its own columns with it.
  const page = read("../app/sales-report/page.js");
  assert.ok(/Party wise/.test(page), "no toggle on the screen");
  assert.ok(/'periodParty'/.test(page), "the screen does not switch its columns");

  // And a shared link carries it, so a party-wise book that is sent opens
  // party-wise rather than on the plain month sheet.
  assert.ok(/byparty: \{ type: "bool"/.test(read("../lib/reportQuery.mjs")));
});

test("the page offers the grain, the scope and the way back", () => {
  const page = read("../app/sales-report/page.js");
  // All three lists come from the module, so the screen cannot offer a grain
  // or a scope the route would refuse.
  for (const name of ["BOOK_GRAINS", "DOC_SCOPES", "scopeName"]) {
    assert.ok(page.includes(name), `${name} is not used`);
  }
  // Clicking a month opens it, and leaving the zoom is possible.
  assert.ok(/openMonth\(/.test(page), "a month row does not open");
  assert.ok(/Back to months/.test(page), "no way out of the zoom");
  // Sigfa's own total label, as the order reports already use.
  assert.ok(/TOTAL/.test(page));
});

test("the page prints like every other register in this app", () => {
  const page = read("../app/sales-report/page.js");
  assert.ok(/doc-sheet/.test(page) && /doc-head/.test(page) && /doc-kind/.test(page));
  assert.ok(/no-print/.test(page), "the controls must not print");
});

test("the screen says what it does with returns", () => {
  // The one thing a reader might otherwise get wrong about the totals.
  const page = read("../app/sales-report/page.js");
  assert.ok(/Returns are included and subtracted/i.test(page));
  // And what the two columns Sigfa splits into nine actually hold.
  assert.ok(/Net Amount is the bill before the overheads/i.test(page));
});

test("the module stays pure", () => {
  const src = read("../lib/salesReports.mjs");
  assert.doesNotMatch(src, /from\s+["']react["']/);
  assert.doesNotMatch(src, /from\s+["']mongoose["']/);
  assert.doesNotMatch(src, /from\s+["'][^"']*models\//);
});

console.log(`\n  ${passed} checks passed\n`);
