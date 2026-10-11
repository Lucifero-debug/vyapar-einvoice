/**
 * Fixture tests for the four order reports and the reconciliation.
 *
 *   node scripts/order-reports.test.mjs
 *
 * The reports themselves are arithmetic over lib/orderStatus.mjs, which has
 * its own suite. What is worth guarding here is everything the live Sigfa
 * data proved would otherwise be guessed wrong, plus the two places a report
 * quietly lies:
 *
 *   1. THE PROMISED DATE IS ON THE LINE. Their header DESPDATE is filled on
 *      0 of 212 orders; the line's on 529 of 702. A report aged off the
 *      header shows no due dates at all and never flags anything overdue.
 *
 *   2. BOTH PENDING VIEWS MUST AGREE. Party-wise and item-wise are the same
 *      lines grouped two ways, so their totals have to come out identical.
 *      Two separate implementations of "pending" is how they drift apart.
 *
 *   3. RECONCILIATION MUST CATCH BOTH DIRECTIONS, and must not count a
 *      credit note -- a return carries the same order reference as the bill
 *      it reverses, so counting it subtracts the quantity twice.
 *
 *   4. CSV MUST SURVIVE A PARTY NAME WITH A COMMA IN IT. "Acme Traders,
 *      Delhi" is the ordinary case, and unquoted it shifts every later
 *      column by one without erroring.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  AGEING_BUCKETS,
  billingInvoices,
  billingSummary,
  CSV_COLUMNS,
  REPORTS,
  ageingBucket,
  csvCell,
  csvFilename,
  daysOverdue,
  isOverdue,
  itemPending,
  partyPending,
  pendingLineRows,
  pendingSummary,
  promisedOn,
  reconcileOrders,
  registerRows,
  reportTitle,
  toCsv,
  CONSOLIDATION_LABEL,
  SIGFA_ITEM_HEADERS,
  STOCK_HEADER,
  TOTAL_LABEL,
  sigfaItemTitle,
  sigfaItemTotals,
  sigfaPeriodLine,
} from "../lib/orderReports.mjs";

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
 * Declared HERE, with the test helper, rather than beside the first wiring
 * check that used it -- a `const` is in its temporal dead zone until the line
 * that declares it runs, so a check added anywhere above threw "Cannot access
 * 'read' before initialization" instead of asserting anything.
 */
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

/** Noon on 10 October 2026, so day arithmetic cannot straddle a boundary. */
const NOW = Date.parse("2026-10-10T12:00:00Z");
const day = (n) => new Date(NOW - n * 86400000);

const line = (over = {}) => ({
  _id: "l1",
  name: "M8 Bolt",
  hsn: "7318",
  uqc: "NOS",
  quantity: 10,
  cancelledQty: 0,
  invoicedQty: 0,
  cost: 50,
  discount: 0,
  ...over,
});

const order = (over = {}) => ({
  orderNo: 7,
  type: "Sale",
  date: day(5),
  customer: { name: "Acme Traders" },
  reference: "PO/88",
  items: [line()],
  ...over,
});

console.log("\n--- the promised date lives on the line ---");

test("the line's own date wins", () => {
  const o = order({ deliveryDate: day(-30) });
  const got = promisedOn(o, line({ deliveryDate: day(-2) }));
  assert.equal(got.getTime(), day(-2).getTime());
});

test("the header's date is the fallback", () => {
  // 75% of their lines carry one; the other 25% have to age off something.
  const o = order({ deliveryDate: day(3) });
  assert.equal(promisedOn(o, line()).getTime(), day(3).getTime());
});

test("a line with no date anywhere is not overdue", () => {
  // Their header date is filled 0 times out of 212. Guessing a due date here
  // would mark every order in a migrated book as late.
  assert.equal(promisedOn(order(), line()), null);
  assert.equal(daysOverdue(order(), line(), NOW), null);
  assert.equal(isOverdue(order(), line(), NOW), false);
});

test("days overdue counts only past due", () => {
  assert.equal(daysOverdue(order(), line({ deliveryDate: day(7) }), NOW), 7);
  assert.equal(daysOverdue(order(), line({ deliveryDate: day(-7) }), NOW), 0);
  assert.equal(isOverdue(order(), line({ deliveryDate: day(7) }), NOW), true);
  assert.equal(isOverdue(order(), line({ deliveryDate: day(-7) }), NOW), false);
});

test("a due date today is not yet late", () => {
  assert.equal(daysOverdue(order(), line({ deliveryDate: new Date(NOW) }), NOW), 0);
});

test("an unreadable date is treated as no date, not as 1970", () => {
  assert.equal(promisedOn(order(), line({ deliveryDate: "not a date" })), null);
  assert.equal(promisedOn(order(), line({ deliveryDate: "" })), null);
});

console.log("\n--- ageing ---");

test("the buckets are the four the ledger already uses", () => {
  assert.deepEqual(AGEING_BUCKETS, ["0-30", "31-60", "61-90", "90+"]);
});

test("an order ages by its own date", () => {
  assert.equal(ageingBucket(order({ date: day(1) }), NOW), "0-30");
  assert.equal(ageingBucket(order({ date: day(30) }), NOW), "0-30");
  assert.equal(ageingBucket(order({ date: day(31) }), NOW), "31-60");
  assert.equal(ageingBucket(order({ date: day(61) }), NOW), "61-90");
  assert.equal(ageingBucket(order({ date: day(400) }), NOW), "90+");
});

test("an order with no date lands in the newest bucket, not the oldest", () => {
  // Their file spans 1,652 days. A missing date defaulting to 90+ would put
  // a brand-new order at the top of a chase list.
  assert.equal(ageingBucket({}, NOW), "0-30");
  assert.equal(ageingBucket(null, NOW), "0-30");
});

console.log("\n--- the register ---");

test("one row per order, newest first", () => {
  const rows = registerRows(
    [order({ orderNo: 1, date: day(10) }), order({ orderNo: 2, date: day(1) })],
    NOW
  );
  assert.deepEqual(rows.map((r) => r.orderNo), [2, 1]);
});

test("same-day orders fall back to the number, descending", () => {
  const rows = registerRows(
    [order({ orderNo: 5, date: day(3) }), order({ orderNo: 9, date: day(3) })],
    NOW
  );
  assert.deepEqual(rows.map((r) => r.orderNo), [9, 5]);
});

test("a row separates order value from what is still to bill", () => {
  const [row] = registerRows(
    [order({ items: [line({ quantity: 10, cost: 50, invoicedQty: 4 })] })],
    NOW
  );
  assert.equal(row.orderValue, 500);
  assert.equal(row.pendingValue, 300);
  assert.equal(row.pendingCount, 1);
  assert.equal(row.status, "partial");
});

test("a closed order shows its value but nothing pending", () => {
  const [row] = registerRows([order({ items: [line({ invoicedQty: 10 })] })], NOW);
  assert.equal(row.orderValue, 500);
  assert.equal(row.pendingValue, 0);
  assert.equal(row.pendingCount, 0);
  assert.equal(row.status, "closed");
});

test("only PENDING lines can be overdue", () => {
  // A line billed last month is not late, however old its promised date.
  const [row] = registerRows(
    [order({ items: [line({ invoicedQty: 10, deliveryDate: day(60) })] })],
    NOW
  );
  assert.equal(row.overdueCount, 0);
  assert.equal(row.oldestOverdue, 0);
});

test("the register reports the worst overdue line on the order", () => {
  const [row] = registerRows(
    [
      order({
        items: [
          line({ _id: "a", deliveryDate: day(3) }),
          line({ _id: "b", deliveryDate: day(40) }),
        ],
      }),
    ],
    NOW
  );
  assert.equal(row.overdueCount, 2);
  assert.equal(row.oldestOverdue, 40);
});

test("the status shown is derived, not the stored column", () => {
  // A stored status that has drifted must not be what the report prints.
  const o = order({ status: "open", items: [line({ invoicedQty: 10 })] });
  assert.equal(registerRows([o], NOW)[0].status, "closed");
});

test("an empty or junk input is an empty register", () => {
  assert.deepEqual(registerRows([], NOW), []);
  assert.deepEqual(registerRows(null, NOW), []);
  assert.deepEqual(registerRows([null], NOW), []);
});

console.log("\n--- pending lines ---");

test("settled lines are left out", () => {
  const rows = pendingLineRows(
    [order({ items: [line({ _id: "a", invoicedQty: 10 }), line({ _id: "b" })] })],
    NOW
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].item, "M8 Bolt");
  assert.equal(rows[0].pending, 10);
});

test("a row carries both quantities, so the reader can see the split", () => {
  const [row] = pendingLineRows(
    [order({ items: [line({ quantity: 10, invoicedQty: 3, cancelledQty: 2 })] })],
    NOW
  );
  assert.equal(row.ordered, 10);
  assert.equal(row.billed, 3);
  assert.equal(row.cancelled, 2);
  assert.equal(row.pending, 5);
  assert.equal(row.value, 250);
});

test("a held order is included but flagged", () => {
  // Omitting it makes the order vanish from every report, which is a worse
  // question to answer than "why does this say on hold".
  const rows = pendingLineRows([order({ hold: true })], NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].hold, true);
});

console.log("\n--- party-wise and item-wise ---");

const twoParties = [
  order({
    orderNo: 1,
    customer: { name: "Acme Traders" },
    items: [
      line({ _id: "a", name: "M8 Bolt", quantity: 10, cost: 50 }),
      line({ _id: "b", name: "M6 Nut", quantity: 20, cost: 10 }),
    ],
  }),
  order({
    orderNo: 2,
    customer: { name: "Bharat Steel" },
    items: [line({ _id: "c", name: "M8 Bolt", quantity: 4, cost: 50 })],
  }),
];

test("party-wise groups and totals", () => {
  const rows = partyPending(twoParties, NOW);
  assert.equal(rows.length, 2);
  const acme = rows.find((r) => r.party === "Acme Traders");
  assert.equal(acme.pendingValue, 700);
  assert.equal(acme.lineCount, 2);
  assert.equal(acme.orderCount, 1);
});

test("item-wise groups the same lines the other way", () => {
  const rows = itemPending(twoParties, NOW);
  assert.equal(rows.length, 2);
  const bolt = rows.find((r) => r.item === "M8 Bolt");
  assert.equal(bolt.pendingQty, 14);
  assert.equal(bolt.pendingValue, 700);
  assert.equal(bolt.orderCount, 2, "the same item across two orders");
});

test("THE TWO VIEWS TOTAL THE SAME", () => {
  // They are one set of lines grouped twice. A second implementation of
  // "pending" is exactly how the party report and the item report start
  // disagreeing about the same book.
  const byParty = partyPending(twoParties, NOW).reduce((s, r) => s + r.pendingValue, 0);
  const byItem = itemPending(twoParties, NOW).reduce((s, r) => s + r.pendingValue, 0);
  assert.equal(byParty, byItem);
  assert.equal(byParty, 900);
});

test("the biggest exposure sorts to the top", () => {
  // 130 parties and 588 items in their live file: an unsorted list is not a
  // report, it is a dump.
  assert.deepEqual(
    partyPending(twoParties, NOW).map((r) => r.party),
    ["Acme Traders", "Bharat Steel"]
  );
});

test("equal values tie-break by name, not by insertion order", () => {
  const rows = partyPending(
    [
      order({ orderNo: 1, customer: { name: "Zenith" }, items: [line({ quantity: 1, cost: 100 })] }),
      order({ orderNo: 2, customer: { name: "Apex" }, items: [line({ quantity: 1, cost: 100 })] }),
    ],
    NOW
  );
  assert.deepEqual(rows.map((r) => r.party), ["Apex", "Zenith"]);
});

test("a party with no name is grouped, not dropped", () => {
  const rows = partyPending([order({ customer: {} })], NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].party, "(not named)");
});

test("a group reports its worst overdue line", () => {
  const rows = partyPending(
    [
      order({
        items: [
          line({ _id: "a", deliveryDate: day(2) }),
          line({ _id: "b", deliveryDate: day(55) }),
        ],
      }),
    ],
    NOW
  );
  assert.equal(rows[0].overdueLines, 2);
  assert.equal(rows[0].oldestOverdue, 55);
});

test("the order list on a group survives JSON", () => {
  // It is built as a Set, and a Set serialises to {}. The route sends this
  // straight to the browser.
  const rows = partyPending(twoParties, NOW);
  const back = JSON.parse(JSON.stringify(rows));
  assert.ok(Array.isArray(back[0].orders));
  assert.equal(back[0].orderCount, 1);
});

console.log("\n--- the summary strip ---");

test("the summary counts distinct orders, parties and items", () => {
  const s = pendingSummary(twoParties, NOW);
  assert.equal(s.lines, 3);
  assert.equal(s.orders, 2);
  assert.equal(s.parties, 2);
  assert.equal(s.items, 2);
  assert.equal(s.pendingValue, 900);
});

test("the ageing split adds back to the total", () => {
  const s = pendingSummary(twoParties, NOW);
  const summed = AGEING_BUCKETS.reduce((t, b) => t + s.byAgeing[b], 0);
  assert.equal(summed, s.pendingValue);
});

test("every bucket is present even when empty", () => {
  // A missing key renders as "undefined" in the strip.
  const s = pendingSummary([], NOW);
  assert.deepEqual(Object.keys(s.byAgeing), AGEING_BUCKETS);
  assert.equal(s.pendingValue, 0);
});

test("overdue is counted and valued separately", () => {
  // A MIX, deliberately. With every line overdue, the overdue total and the
  // pending total come out the same and a report that summed the wrong array
  // would still pass -- which is exactly what mutation testing caught.
  const s = pendingSummary(
    [
      order({
        orderNo: 1,
        items: [
          line({ _id: "late", deliveryDate: day(10), quantity: 2, cost: 100 }),
          line({ _id: "soon", deliveryDate: day(-10), quantity: 5, cost: 100 }),
          line({ _id: "undated", quantity: 1, cost: 100 }),
        ],
      }),
    ],
    NOW
  );
  assert.equal(s.lines, 3);
  assert.equal(s.pendingValue, 800);
  assert.equal(s.overdueLines, 1, "only the one past its promised date");
  assert.equal(s.overdueValue, 200, "not the whole pending value");
});

test("the summary describes the rows it was HANDED, not the whole book", () => {
  // The route narrows the lines for an item filter and passes them in, so
  // the heading total matches the column under it. Recomputing from the
  // orders instead would show one item's rows beneath the book's total --
  // and nothing caught that until this test.
  const orders = [
    order({
      orderNo: 1,
      items: [
        line({ _id: "a", name: "M8 Bolt", quantity: 10, cost: 50 }),
        line({ _id: "b", name: "M6 Nut", quantity: 20, cost: 10 }),
      ],
    }),
  ];
  const everything = pendingSummary(orders, NOW);
  assert.equal(everything.pendingValue, 700);
  assert.equal(everything.items, 2);

  const boltsOnly = pendingLineRows(orders, NOW).filter((r) => r.item === "M8 Bolt");
  const narrowed = pendingSummary(orders, NOW, boltsOnly);
  assert.equal(narrowed.pendingValue, 500);
  assert.equal(narrowed.lines, 1);
  assert.equal(narrowed.items, 1);
});

console.log("\n--- reconciliation ---");

const invLine = (over = {}) => ({
  name: "M8 Bolt",
  quantity: 4,
  orderNo: 7,
  orderType: "Sale",
  orderLineId: "l1",
  isReturn: false,
  ...over,
});

test("agreement reports nothing", () => {
  const problems = reconcileOrders({
    orders: [order({ items: [line({ invoicedQty: 4 })] })],
    invoiceLines: [invLine({ quantity: 4 })],
  });
  assert.deepEqual(problems, []);
});

test("invoices billing MORE than the counter is caught", () => {
  const problems = reconcileOrders({
    orders: [order({ items: [line({ invoicedQty: 4 })] })],
    invoiceLines: [invLine({ quantity: 6 })],
  });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].stored, 4);
  assert.equal(problems[0].derived, 6);
  assert.equal(problems[0].difference, 2);
  assert.match(problems[0].reason, /bill more than the order records/);
});

test("the counter claiming MORE than the invoices is caught", () => {
  const problems = reconcileOrders({
    orders: [order({ items: [line({ invoicedQty: 9 })] })],
    invoiceLines: [invLine({ quantity: 4 })],
  });
  assert.equal(problems[0].difference, -5);
  assert.match(problems[0].reason, /records more as billed/);
});

test("a counter with no invoice behind it at all is caught", () => {
  const problems = reconcileOrders({
    orders: [order({ items: [line({ invoicedQty: 4 })] })],
    invoiceLines: [],
  });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].derived, 0);
});

test("two invoice lines against one order line ADD UP", () => {
  // The split-line case. Comparing against only the last one would report a
  // phantom shortfall on every partially-split bill.
  const problems = reconcileOrders({
    orders: [order({ items: [line({ invoicedQty: 10 })] })],
    invoiceLines: [invLine({ quantity: 6 }), invLine({ quantity: 4 })],
  });
  assert.deepEqual(problems, []);
});

test("A RETURN IS NOT COUNTED", () => {
  // A credit note's lines carry the order reference of the bill they reverse,
  // because that is how the form prefilled them. Counting them would subtract
  // the quantity a second time and report every returned order as broken.
  const problems = reconcileOrders({
    orders: [order({ items: [line({ invoicedQty: 4 })] })],
    invoiceLines: [invLine({ quantity: 4 }), invLine({ quantity: 4, isReturn: true })],
  });
  assert.deepEqual(problems, []);
});

test("an invoice pointing at a line that no longer exists is caught", () => {
  const problems = reconcileOrders({
    orders: [order({ items: [line({ _id: "l1", invoicedQty: 0 })] })],
    invoiceLines: [invLine({ orderLineId: "vanished", quantity: 3 })],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0].reason, /no longer exists/);
  assert.equal(problems[0].derived, 3);
});

test("plain invoice lines with no order reference are ignored", () => {
  const problems = reconcileOrders({
    orders: [order({ items: [line({ invoicedQty: 0 })] })],
    invoiceLines: [
      { name: "Freight", quantity: 1 },
      invLine({ orderNo: 0, quantity: 5 }),
      invLine({ orderType: "Quotation", quantity: 5 }),
      invLine({ orderLineId: "", quantity: 5 }),
    ],
  });
  assert.deepEqual(problems, []);
});

test("sale 7 and purchase 7 are reconciled apart", () => {
  const problems = reconcileOrders({
    orders: [
      order({ orderNo: 7, type: "Sale", items: [line({ _id: "l1", invoicedQty: 4 })] }),
      order({ orderNo: 7, type: "Purchase", items: [line({ _id: "l1", invoicedQty: 0 })] }),
    ],
    invoiceLines: [invLine({ orderType: "Sale", quantity: 4 })],
  });
  assert.deepEqual(problems, []);
});

test("the worst disagreement sorts first", () => {
  const problems = reconcileOrders({
    orders: [
      order({ orderNo: 1, items: [line({ _id: "a", invoicedQty: 1 })] }),
      order({ orderNo: 2, items: [line({ _id: "b", invoicedQty: 50 })] }),
    ],
    invoiceLines: [],
  });
  assert.deepEqual(problems.map((p) => p.orderNo), [2, 1]);
});

test("float dust is not a disagreement", () => {
  const problems = reconcileOrders({
    orders: [order({ items: [line({ invoicedQty: 0.1 + 0.2 })] })],
    invoiceLines: [invLine({ quantity: 0.3 })],
  });
  assert.deepEqual(problems, []);
});

test("junk input reconciles to nothing rather than throwing", () => {
  assert.deepEqual(reconcileOrders({}), []);
  assert.deepEqual(reconcileOrders({ orders: null, invoiceLines: null }), []);
  assert.deepEqual(reconcileOrders({ orders: [null], invoiceLines: [null] }), []);
});

console.log("\n--- what billed an order ---");

const bill = (over = {}) => ({
  invoiceNo: 101,
  date: day(2),
  return: false,
  items: [
    { name: "M8 Bolt", quantity: 4, orderNo: 7, orderType: "Sale", orderLineId: "l1" },
  ],
  ...over,
});

test("an invoice that billed the order is listed", () => {
  const rows = billingInvoices([bill()], { orderNo: 7, type: "Sale" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].invoiceNo, 101);
  assert.equal(rows[0].quantity, 4);
  assert.equal(rows[0].lines.length, 1);
});

test("ONLY the lines belonging to this order are counted", () => {
  // A bill carries freight, counter sales and sometimes a second order.
  // Reporting its whole value against this order would overstate what the
  // order accounts for.
  const rows = billingInvoices(
    [
      bill({
        items: [
          { name: "M8 Bolt", quantity: 4, orderNo: 7, orderType: "Sale", orderLineId: "l1" },
          { name: "Freight", quantity: 1 },
          { name: "M6 Nut", quantity: 9, orderNo: 8, orderType: "Sale", orderLineId: "l9" },
        ],
      }),
    ],
    { orderNo: 7, type: "Sale" }
  );
  assert.equal(rows[0].lines.length, 1);
  assert.equal(rows[0].quantity, 4);
});

test("an invoice against a different order is not listed at all", () => {
  const rows = billingInvoices(
    [bill({ items: [{ name: "x", quantity: 1, orderNo: 8, orderType: "Sale", orderLineId: "l1" }] })],
    { orderNo: 7, type: "Sale" }
  );
  assert.deepEqual(rows, []);
});

test("sale 7 and purchase 7 do not show each other's bills", () => {
  const rows = billingInvoices(
    [bill({ items: [{ name: "x", quantity: 1, orderNo: 7, orderType: "Purchase", orderLineId: "l1" }] })],
    { orderNo: 7, type: "Sale" }
  );
  assert.deepEqual(rows, []);
});

test("two lines of one invoice against the same order are summed", () => {
  const rows = billingInvoices(
    [
      bill({
        items: [
          { name: "M8 Bolt", quantity: 6, orderNo: 7, orderType: "Sale", orderLineId: "l1" },
          { name: "M8 Bolt", quantity: 4, orderNo: 7, orderType: "Sale", orderLineId: "l1" },
        ],
      }),
    ],
    { orderNo: 7, type: "Sale" }
  );
  assert.equal(rows[0].quantity, 10);
  assert.equal(rows[0].lines.length, 2, "both lines are still shown");
});

test("A RETURN IS FLAGGED, NOT NETTED OFF", () => {
  // It never moved the order's counter -- orderClaims only acts on the
  // original sale -- so subtracting it here would make this list disagree
  // with the pending quantity printed beside it.
  const rows = billingInvoices(
    [bill({ invoiceNo: 101 }), bill({ invoiceNo: 102, return: true })],
    { orderNo: 7, type: "Sale" }
  );
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.invoiceNo === 102).isReturn, true);
  assert.equal(rows.find((r) => r.invoiceNo === 102).quantity, 4, "not negative");
});

test("invoices are listed in number order", () => {
  const rows = billingInvoices(
    [bill({ invoiceNo: 110 }), bill({ invoiceNo: 102 })],
    { orderNo: 7, type: "Sale" }
  );
  assert.deepEqual(rows.map((r) => r.invoiceNo), [102, 110]);
});

test("the flag is read from either shape the callers use", () => {
  // get-order passes raw documents (`return`); the reconcile route flattens
  // and renames it to `isReturn`.
  assert.equal(billingInvoices([bill({ return: true })], { orderNo: 7, type: "Sale" })[0].isReturn, true);
  const flat = bill();
  delete flat.return;
  flat.isReturn = true;
  assert.equal(billingInvoices([flat], { orderNo: 7, type: "Sale" })[0].isReturn, true);
});

test("junk input lists nothing rather than throwing", () => {
  assert.deepEqual(billingInvoices(null, { orderNo: 7, type: "Sale" }), []);
  assert.deepEqual(billingInvoices([null], { orderNo: 7, type: "Sale" }), []);
  assert.deepEqual(billingInvoices([bill()], {}), []);
  assert.deepEqual(billingInvoices([{ invoiceNo: 1 }], { orderNo: 7, type: "Sale" }), []);
});

test("the one-line summary says what happened", () => {
  assert.equal(billingSummary([]), "Nothing billed against this order yet");
  assert.equal(billingSummary(null), "Nothing billed against this order yet");
  assert.equal(billingSummary([{ isReturn: false }]), "Billed by 1 invoice");
  assert.equal(billingSummary([{ isReturn: false }, { isReturn: false }]), "Billed by 2 invoices");
  assert.equal(
    billingSummary([{ isReturn: false }, { isReturn: true }]),
    "Billed by 1 invoice and 1 return"
  );
});

test("get-order hands the shaping to this module, not its own loop", () => {
  const route = read("../app/api/get-order/route.js");
  assert.match(route, /billingInvoices\(/);
  assert.ok(
    !/\.items \|\| \[\]\)\.filter\(\s*\(l\) => Number\(l\?\.orderNo\)/.test(route),
    "the route must not re-implement the line matching"
  );
});

test("the invoice lookup is indexed per firm", () => {
  // get-order runs it on every expand. Unindexed it scans the whole book,
  // and it must be led by companyId like every other index on that schema.
  const model = read("../models/invoiceModel.js");
  assert.match(model, /companyId:\s*1,\s*"items\.orderNo":\s*1/);
});

test("the order register shows what billed each order", () => {
  const page = read("../app/order/page.js");
  assert.match(page, /billingSummary/);
  assert.match(page, /get-order\?orderNo=/);
});

console.log("\n--- CSV ---");

test("A PARTY NAME WITH A COMMA IS QUOTED", () => {
  // The ordinary case, and unquoted it shifts every later column by one
  // without erroring anywhere.
  assert.equal(csvCell("Acme Traders, Delhi"), '"Acme Traders, Delhi"');
});

test("an embedded quote is doubled", () => {
  assert.equal(csvCell('6" pipe'), '"6"" pipe"');
});

test("a newline inside a cell is quoted", () => {
  assert.equal(csvCell("line one\nline two"), '"line one\nline two"');
});

test("leading or trailing space is preserved by quoting", () => {
  assert.equal(csvCell(" padded "), '" padded "');
});

test("a cell that Excel would run as a formula is defused", () => {
  // A party name starting with "-" is plausible, and "=cmd|..." is the
  // injection this prevents.
  assert.equal(csvCell("=SUM(A1:A9)"), "'=SUM(A1:A9)");
  assert.equal(csvCell("-Trading Co"), "'-Trading Co");
  assert.equal(csvCell("+91 Supplies"), "'+91 Supplies");
  assert.equal(csvCell("@home"), "'@home");
});

test("a plain cell is left alone", () => {
  assert.equal(csvCell("M8 Bolt"), "M8 Bolt");
  assert.equal(csvCell(1234.5), "1234.5");
  assert.equal(csvCell(0), "0", "zero must not come out blank");
});

test("null and undefined are empty, not the words", () => {
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
});

test("a date is written as a plain day", () => {
  assert.equal(csvCell(new Date("2026-10-10T18:30:00Z")), "2026-10-10");
});

test("the file has a header row and CRLF endings", () => {
  const csv = toCsv(CSV_COLUMNS["party-pending"], partyPending(twoParties, NOW));
  const lines = csv.split("\r\n");
  assert.equal(lines.length, 3, "header plus two parties");
  assert.match(lines[0], /^Party,Orders,Lines,Pending Qty,Pending Value/);
  assert.ok(lines[1].startsWith("Acme Traders,"));
});

test("a column may compute its own cell", () => {
  const csv = toCsv(
    [{ key: "party", label: "Party" }, { label: "Shout", value: (r) => r.party.toUpperCase() }],
    partyPending(twoParties, NOW)
  );
  assert.match(csv, /Acme Traders,ACME TRADERS/);
});

test("an empty report still produces its header", () => {
  const csv = toCsv(CSV_COLUMNS["item-pending"], []);
  assert.equal(csv.split("\r\n").length, 1);
  // "ITEM NAME", not "Item": the item-wise sheet now carries Sigfa's own
  // headings so it can be read against its printed output.
  assert.match(csv, /^ITEM NAME,/);
});

test("every report has a column set", () => {
  for (const report of REPORTS) {
    const key = report === "register" ? "register" : report;
    assert.ok(CSV_COLUMNS[key]?.length, `no CSV columns for ${report}`);
  }
  assert.ok(CSV_COLUMNS.detail.length, "the line-level export needs columns too");
});

test("the file name says which report, which document, and when", () => {
  assert.equal(csvFilename("party-pending", "Sale", NOW), "sale-order-party-pending-2026-10-10.csv");
  assert.equal(csvFilename("register", "Purchase", NOW), "purchase-order-register-2026-10-10.csv");
  assert.equal(csvFilename("register", "", NOW), "all-order-register-2026-10-10.csv");
});

console.log("\n--- headings ---");

test("each report names itself and its document", () => {
  assert.equal(reportTitle("register", "Sale"), "Sales Order Register");
  assert.equal(reportTitle("register", "Purchase"), "Purchase Order Register");
  assert.equal(reportTitle("party-pending", "Sale"), "Party-wise Pending Sales Orders");
  assert.equal(reportTitle("item-pending", "Purchase"), "Item-wise Pending Purchase Orders");
  assert.equal(reportTitle("reconcile", "Sale"), "Sales Order Reconciliation");
});

test("an unknown report still gets a heading", () => {
  assert.equal(reportTitle("nonsense", "Sale"), "Sales Order Report");
});

test("the four reports plus reconcile are the whole set", () => {
  assert.deepEqual(REPORTS, ["register", "party-pending", "item-pending", "reconcile"]);
});

console.log("\n--- the views have different row shapes ---");

test("THE REGISTER AND THE PENDING VIEWS RETURN DIFFERENT SHAPES", () => {
  // This is the hazard behind the crash. `view` changes the instant a tab is
  // clicked; `rows` only changes when the fetch returns. For the render in
  // between, the grouped branch ran against register rows and reached into
  // `r.lines`, which a register row has no such field -- hence
  // "Cannot read properties of undefined (reading 'map')".
  const orders = [order()];
  const [reg] = registerRows(orders, NOW);
  const [grp] = partyPending(orders, NOW);

  assert.equal(reg.lines, undefined, "a register row carries no lines array");
  assert.ok(Array.isArray(grp.lines), "a grouped row does");
  assert.equal(grp.orderNo, undefined, "and carries no order number");
  assert.ok(Number.isFinite(reg.orderNo), "which a register row does");
});

test("the report page renders rows only for the view they were loaded for", () => {
  // The fix is not a `|| []` on each access -- that would hide the mismatch
  // while still rendering one view's branch against another view's data. The
  // rows carry the view they were fetched for, and the body is gated on it.
  const page = read("../app/order-report/page.js");
  assert.match(page, /loadedView/, "the page must remember which view its rows are for");
  assert.match(page, /loadedView !== view/, "and gate the body on it");
  assert.match(page, /loadedView === view \? rows : \[\]/, "and show nothing when they disagree");

  // No bare `rows.` read may survive in the table body.
  const body = page.slice(page.indexOf("the report \u2500"));
  assert.ok(body.length > 0, "found the table section");
  assert.ok(
    !/\brows\.(map|length|reduce)\b/.test(body),
    "the body must read the gated rows, not the raw state"
  );
});

test("every load path stamps the view, including the failures", () => {
  // A failed fetch that left the previous view's rows in place, still
  // claiming to be this view's, would reopen the same hole.
  const page = read("../app/order-report/page.js");
  const stamps = (page.match(/setLoadedView\(view\)/g) || []).length;
  assert.ok(stamps >= 4, `expected a stamp on both successes and both failures, found ${stamps}`);
});


console.log("\n--- the wiring ---");


test("every report route is permission-checked and read-only", () => {
  const roles = read("../lib/roles.mjs");
  for (const path of [
    "/api/order-report",
    "/api/order-reconcile",
    "/order-report",
  ]) {
    assert.ok(roles.includes(`"${path}"`), `roles.mjs has no rule for ${path}`);
  }
  // Reports read; none of them writes. A report behind invoice:write would
  // lock out the accountant who most needs it.
  assert.match(roles, /\["\/api\/order-report",\s*"invoice:read"\]/);
  assert.match(roles, /\["\/api\/order-reconcile",\s*"invoice:read"\]/);
});

test("the report routes go through the tenant wrapper", () => {
  for (const route of ["order-report", "order-reconcile"]) {
    assert.match(read(`../app/api/${route}/route.js`), /tenantRoute/);
  }
});

test("the reports compute nothing themselves", () => {
  // Every figure has to come from this module, or the register and the
  // pending views start disagreeing about the same book.
  for (const route of ["order-report", "order-reconcile"]) {
    assert.match(read(`../app/api/${route}/route.js`), /orderReports\.mjs/);
  }
  const page = read("../app/order-report/page.js");
  assert.match(page, /orderReports\.mjs/);
  assert.ok(
    !/pendingQty\s*\(/.test(page),
    "the page must not do the pending subtraction itself"
  );
});

test("the printed sheet uses the app's report styling", () => {
  // Same as the ledger and voucher registers, so one Ctrl+P behaves the same
  // everywhere: doc-sheet for the page, no-print on the controls.
  const page = read("../app/order-report/page.js");
  assert.match(page, /doc-sheet/);
  assert.match(page, /no-print/);
});

console.log("\n--- the item-wise sheet, headed as Sigfa heads it ---");

const sigfaOrder = (over = {}) => ({
  orderNo: 1,
  type: "Sale",
  date: "2026-06-01",
  customer: { name: "MCS Fasteners" },
  items: [],
  ...over,
});
const sigfaLine = (over = {}) => ({
  name: "FINISHED GOODS NO.1",
  uqc: "PCS",
  quantity: 500,
  invoicedQty: 200,
  cancelledQty: 0,
  cost: 10,
  ...over,
});

test("the headings are Sigfa's own, spelled its way", () => {
  // Read off its printed sheet. The full stops are where Sigfa puts them --
  // "ORDER.QTY" with one in the middle, "DESP QTY." with one at the end --
  // and "DESP" is not spelled out. The shop reads this screen with that
  // paper beside it, so a tidier wording would be a worse heading.
  assert.deepEqual(SIGFA_ITEM_HEADERS, [
    "ITEM NAME",
    "UNIT",
    "ORDER.QTY",
    "DESP QTY.",
    "BALANCE",
  ]);
  assert.equal(STOCK_HEADER, "CURRENT STOCK");
  assert.equal(CONSOLIDATION_LABEL, "(SUPER CONSOLIDATED)");
  assert.equal(TOTAL_LABEL, "TOTAL  :-");
});

test("the title names the side the orders are on", () => {
  assert.equal(sigfaItemTitle("Sale"), "ITEM WISE SALES PENDING ORDERS");
  assert.equal(sigfaItemTitle("Purchase"), "ITEM WISE PURCHASE PENDING ORDERS");
  // SALES, not SALE -- Sigfa's own plural.
  assert.match(sigfaItemTitle("Sale"), /SALES/);
});

test("the period line is dated the way Sigfa dates it", () => {
  assert.equal(
    sigfaPeriodLine("2026-04-01", "2027-03-31"),
    "FOR THE PERIOD FROM  01-04-2026 TO 31-03-2027"
  );
  // Two spaces after FROM, as on the sheet.
  assert.match(sigfaPeriodLine("2026-04-01", "2027-03-31"), /FROM {2}01-04-2026/);
});

test("a half-set period says what it knows, and no period says nothing", () => {
  // A sheet claiming a period it does not have is worse than one claiming
  // none, so the line is left off entirely rather than printed with blanks.
  assert.equal(sigfaPeriodLine("", ""), "");
  assert.equal(sigfaPeriodLine(null, undefined), "");
  assert.equal(sigfaPeriodLine("2026-04-01", ""), "FOR THE PERIOD FROM  01-04-2026");
  assert.equal(sigfaPeriodLine("", "2027-03-31"), "UP TO  31-03-2027");
  assert.equal(sigfaPeriodLine("nonsense", "rubbish"), "");
});

test("the figures match Sigfa's own sheet, line for line", () => {
  // Straight off the screenshot: FINISHED GOODS NO.1, PCS., 500 ordered,
  // 200 despatched, 300 balance.
  const rows = itemPending([sigfaOrder({ items: [sigfaLine()] })]);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.item, "FINISHED GOODS NO.1");
  assert.equal(r.unit, "PCS");
  assert.equal(r.orderQty, 500);
  assert.equal(r.despQty, 200);
  assert.equal(r.balance, 300);
});

test("ORDER.QTY minus DESP QTY. equals BALANCE, always", () => {
  // THE IDENTITY THE WHOLE COLUMN SET RESTS ON. Sigfa prints BALANCE as that
  // subtraction, and its cancellation amends the order quantity itself. Here
  // a cancellation is held separately, so printing the ORIGINAL ordered
  // figure would give rows where 500 - 200 came to 250 with nothing on the
  // page to explain the gap. Netting it into ORDER.QTY restores the identity.
  for (const [ordered, billed, cancelled] of [
    [500, 200, 0],
    [500, 200, 50],
    [100, 0, 0],
    [100, 0, 99],
    [10.5, 2.25, 1.25],
  ]) {
    const rows = itemPending([
      sigfaOrder({
        items: [sigfaLine({ quantity: ordered, invoicedQty: billed, cancelledQty: cancelled })],
      }),
    ]);
    if (!rows.length) continue;
    const r = rows[0];
    // Compared with a tolerance rather than by re-rounding: the point is
    // that the printed row adds up, not that two roundings agree.
    assert.ok(
      Math.abs(r.orderQty - r.despQty - r.balance) < 1e-9,
      `${ordered} ordered, ${billed} billed, ${cancelled} cancelled`
    );
  }
});

test("BALANCE is the pending quantity under another name", () => {
  // Named twice on purpose, so the sheet can carry Sigfa's heading without
  // anything downstream having to learn that the two are one thing. If they
  // ever diverge, the report and the order register disagree.
  const rows = itemPending([
    sigfaOrder({ items: [sigfaLine(), sigfaLine({ name: "WASHER", quantity: 20, invoicedQty: 5 })] }),
  ]);
  for (const r of rows) assert.equal(r.balance, r.pendingQty, r.item);
});

test("a cancelled quantity is reported, not hidden", () => {
  // It comes off ORDER.QTY, so without this the sheet would silently show a
  // smaller order than was placed.
  const rows = itemPending([
    sigfaOrder({ items: [sigfaLine({ cancelledQty: 50 })] }),
  ]);
  assert.equal(rows[0].cancelledQty, 50);
  assert.equal(rows[0].orderQty, 450, "net of the cancellation");
});

test("quantities are totalled across every order and party", () => {
  // Sigfa calls this "SUPER CONSOLIDATED": one row per item, however many
  // orders and parties it appears on.
  const rows = itemPending([
    sigfaOrder({ orderNo: 1, items: [sigfaLine({ quantity: 500, invoicedQty: 200 })] }),
    sigfaOrder({ orderNo: 2, customer: { name: "Other" }, items: [sigfaLine({ quantity: 100, invoicedQty: 0 })] }),
  ]);
  assert.equal(rows.length, 1, "one row for the item, not one per order");
  assert.equal(rows[0].orderQty, 600);
  assert.equal(rows[0].despQty, 200);
  assert.equal(rows[0].balance, 400);
  assert.equal(rows[0].orderCount, 2);
});

test("the unit comes off the lines, and a clash is kept rather than hidden", () => {
  // invoicedQty reset on the second line: it inherits 200 from the base
  // fixture otherwise, which leaves 10 - 200 = nothing pending, and
  // pendingLineRows drops the line before it ever reaches the grouping.
  const same = itemPending([
    sigfaOrder({ items: [sigfaLine(), sigfaLine({ quantity: 10, invoicedQty: 0 })] }),
  ]);
  assert.equal(same[0].unit, "PCS");
  assert.deepEqual(same[0].units, ["PCS"]);

  // One item ordered in two units is a master-data problem; the sheet shows
  // the first but keeps both, so the report can say so rather than picking
  // one silently.
  const clash = itemPending([
    sigfaOrder({ items: [sigfaLine(), sigfaLine({ uqc: "KGS", quantity: 10, invoicedQty: 0 })] }),
  ]);
  assert.equal(clash[0].unit, "PCS");
  assert.deepEqual([...clash[0].units].sort(), ["KGS", "PCS"]);
});

test("a line with no unit does not blank out one that has one", () => {
  const rows = itemPending([
    sigfaOrder({
      items: [sigfaLine({ uqc: "" }), sigfaLine({ uqc: "PCS", quantity: 10, invoicedQty: 0 })],
    }),
  ]);
  assert.equal(rows[0].unit, "PCS");
});

test("the totals row adds the quantity columns and leaves stock alone", () => {
  const totals = sigfaItemTotals([
    { orderQty: 500, despQty: 200, balance: 300, stock: 40 },
    { orderQty: 100, despQty: 25, balance: 75, stock: 9000 },
  ]);
  assert.equal(totals.orderQty, 600);
  assert.equal(totals.despQty, 225);
  assert.equal(totals.balance, 375);
  // Adding a tonne of steel to four hundred washers gives a number that
  // answers nothing, so Sigfa leaves its stock columns untotalled too.
  assert.equal(totals.stock, null);
});

test("the totals row survives an empty or ragged sheet", () => {
  assert.deepEqual(sigfaItemTotals([]), { orderQty: 0, despQty: 0, balance: 0, stock: null });
  assert.deepEqual(sigfaItemTotals(), { orderQty: 0, despQty: 0, balance: 0, stock: null });
  assert.equal(sigfaItemTotals([{}, { orderQty: "5" }]).orderQty, 5);
});

test("the download carries Sigfa's headings first, then this app's own", () => {
  const labels = CSV_COLUMNS["item-pending"].map((c) => c.label);
  assert.deepEqual(labels.slice(0, 6), [...SIGFA_ITEM_HEADERS, STOCK_HEADER]);
  // Pending value and the overdue counts came off the header row so it could
  // match the paper. They must still be IN the download -- relocated, not
  // dropped.
  for (const label of ["Pending Value", "Overdue Lines", "Short By"]) {
    assert.ok(labels.includes(label), `${label} was dropped from the download`);
  }
});

test("an item missing from the master exports as words, not as zero", () => {
  // 0 is falsy, so a truthiness test would turn "none on the shelf" into
  // "not in master" -- two quite different facts.
  const column = CSV_COLUMNS["item-pending"].find((c) => c.key === "stock");
  assert.equal(column.value({ known: true, stock: 0 }), 0);
  assert.equal(column.value({ known: false, stock: 0 }), "not in master");
});

console.log("\n--- the sheet on screen matches the column set ---");

test("the item view's header row is built from the shared list", () => {
  // Not retyped into the JSX, or the screen and the download drift the first
  // time a heading changes.
  const src = read("../app/order-report/page.js");
  assert.ok(/SIGFA_ITEM_HEADERS\.map/.test(src));
  assert.ok(/\{STOCK_HEADER\}/.test(src));
  assert.doesNotMatch(src, /<th[^>]*>ORDER\.QTY</, "a heading is hardcoded in the markup");
});

test("every row in the item view has as many cells as the header", () => {
  // A mismatched colSpan does not throw. It silently shifts every figure one
  // column left, which on this sheet means reading a despatched quantity as
  // an ordered one.
  const src = read("../app/order-report/page.js");
  const columns = SIGFA_ITEM_HEADERS.length + 1;
  assert.equal(columns, 6);
  // The empty and loading rows span the whole sheet.
  assert.equal(
    (src.match(/colSpan=\{isItemView \? 6 : 9\}/g) || []).length,
    2,
    "the empty and busy rows must span all six"
  );
});

test("the printed sheet carries Sigfa's three heading lines", () => {
  const src = read("../app/order-report/page.js");
  assert.ok(/sigfaItemTitle\(type\)/.test(src));
  assert.ok(/\{CONSOLIDATION_LABEL\}/.test(src));
  assert.ok(/sigfaPeriodLine\(from, to\)/.test(src));
  // And the totals row.
  assert.ok(/\{TOTAL_LABEL\}/.test(src));
  assert.ok(/itemTotals\.orderQty/.test(src));
});

test("nothing was dropped when the header row was trimmed", () => {
  // Pending value and the overdue counts left the header row so it could
  // match Sigfa's. They have to still be on the page somewhere.
  const src = read("../app/order-report/page.js");
  assert.ok(/pending value/i.test(src));
  assert.ok(/overdue line/i.test(src));
  assert.ok(/short by \{trim\(r\.shortBy\)\}/.test(src), "the shortfall is still shown");
});

console.log(`\n${passed} checks passed.`);
