/**
 * The billing request: what it may set, what the server derives, and what the
 * two invoice routes do with it.
 *
 *   node scripts/invoice-input.test.mjs
 *
 * `save-invoice` used to spread the request body into `Invoice.create()`. A
 * body naming another firm's `companyId` wrote the invoice into that firm's
 * books (the tenant plugin only stamps a document that has no firm yet), an
 * `irn` froze the bill, an `emailLog` forged its history, and every figure
 * but `balanceDue` was stored as sent. lib/invoiceInput.mjs replaced that with
 * an allowlist and the screen's own arithmetic. These tests pin both, and the
 * wiring that makes the routes use them.
 *
 * Pure node, no database, like every other test here. The cross-tenant and
 * rollback sections replay the routes against an in-memory, tenant-scoped,
 * transactional stand-in -- the same approach as
 * scripts/posting-invariants.test.mjs -- and the wiring section reads the
 * route sources, as scripts/buyer-snapshot.test.mjs does.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  ACCEPTED_FIELDS,
  DUPLICATE_WINDOW_MS,
  MAX_LINES,
  PROTECTED_FIELDS,
  TOTAL_TOLERANCE,
  invoiceTotals,
  isDuplicateSubmission,
  linesNeedingMaster,
  orderLineProblems,
  orderRefsOf,
  partyProblem,
  paymentAccountProblem,
  prepareInvoiceInput,
  submissionFingerprint,
  unknownItems,
} from "../lib/invoiceInput.mjs";
import {
  PAYLOAD_KEYS,
  buildHsnTotals,
  buildInvoicePayload,
  hsnTotalsArray,
  recalcItem,
  totalGstOf,
} from "../lib/billingMath.mjs";
import { BILLING_TYPES } from "../lib/billingTypes.mjs";
import { buildInvoiceLedgerRows, invoicePostingDeltas, balanceMovesFromRows } from "../lib/invoicePosting.mjs";
import { rowsImbalance } from "../lib/invoiceGl.mjs";
import { round2 } from "../lib/balance.mjs";
import { stampDocs } from "../lib/tenantScope.mjs";
import { prefillFromOrder } from "../lib/orderPrefill.mjs";

/* ----------------------------------------------------------- harness ---- */

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  }
};

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const NOW = Date.parse("2026-10-12T10:00:00Z");

/* ---------------------------------------------------------- fixtures ---- */

/**
 * An item master row, as `/api/get-item` serves it -- including the fields
 * the screen spreads into every line and the server must drop.
 */
const master = (name, extra = {}) => ({
  _id: `item-${name}`,
  companyId: "firm-A",
  name,
  hsn: "8471",
  cost: 0,
  salePrice: 100,
  purchasePrice: 80,
  gst: 18,
  uqc: "PCS",
  isService: false,
  createdAt: "2026-01-01T00:00:00Z",
  ...extra,
});

/** A line exactly as BillingScreen builds it: master spread, then recalcItem. */
const screenLine = (source, { quantity = 1, cost, discount = 0, gstRate } = {}) =>
  recalcItem({
    ...source,
    quantity,
    cost: cost ?? source.salePrice,
    discount,
    gstRate: gstRate ?? source.gst,
  });

/**
 * The request body exactly as the billing screen sends it: BillingScreen's
 * totals effect, then lib/billingMath.mjs buildInvoicePayload.
 */
const screenPayload = ({
  key = "sale",
  items = [screenLine(master("Widget"), { quantity: 2 })],
  partyTaxes = [],
  freight = "",
  received = 0,
  overrides = {},
} = {}) => {
  const totalAmount = items.reduce((acc, i) => acc + (parseFloat(i.total) || 0), 0).toFixed(2);
  const partyTaxTotal = partyTaxes.reduce((acc, t) => acc + parseFloat(t.total || 0), 0);
  const finalAmt = (parseFloat(totalAmount) || 0) + partyTaxTotal + (parseFloat(freight) || 0);
  const finalAmount = finalAmt.toFixed(2);
  const balanceDue = parseFloat((finalAmt - (parseFloat(received) || 0)).toFixed(2));

  const payload = buildInvoicePayload(
    {
      invoiceNo: 41,
      date: "2026-10-12",
      customer: { _id: "cust-shah", name: "Shah Traders", phone: "9876543210", email: "a@shah.in" },
      paymentType: "Cash",
      balanceDue,
      stateOfSupply: "Delhi",
      stateCode: "07",
      taxType: "local",
      gst: totalGstOf(items),
      totalAmount,
      finalAmount,
      received,
      items,
      partyTaxes,
      shippedTo: "",
      dispatchFrom: "",
      transport: "VRL",
      grNo: "GR-1",
      grDate: "2026-10-11",
      pvtMark: "",
      caseDetails: "",
      freight,
      weight: "",
      ewayBillNo: "",
      ewayBillDate: "",
      orderDate: "",
      orderNo: "",
      partyBillNo: "",
    },
    BILLING_TYPES[key]
  );
  return { ...payload, ...overrides };
};

const prepare = (body, mode = "create") => prepareInvoiceInput(body, { mode, now: NOW });
const ok = (body, mode) => {
  const result = prepare(body, mode);
  assert.equal(result.ok, true, result.error);
  return result.invoice;
};
const refused = (body, pattern, mode) => {
  const result = prepare(body, mode);
  assert.equal(result.ok, false, "expected the request to be refused");
  if (pattern) assert.match(result.error, pattern);
  return result.error;
};

/* ==================================================== allowlist ========= */

console.log("\n--- the allowlist ---");

test("the screen's own request is accepted as it is", () => {
  const result = prepare(screenPayload());
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.ignored, [], "the screen sent a key the server does not know");
});

test("every key the screen sends is one the server reads", () => {
  // The frozen payload (lib/billingMath.mjs). A key added there and not to the
  // allowlist would be dropped on save with no error.
  for (const key of PAYLOAD_KEYS) assert.ok(ACCEPTED_FIELDS.includes(key), `${key} is not accepted`);
});

test("no protected field is in the allowlist", () => {
  for (const key of PROTECTED_FIELDS) assert.ok(!ACCEPTED_FIELDS.includes(key), `${key} is accepted`);
});

for (const [field, value] of [
  ["companyId", "64f000000000000000000b0b"],
  ["_id", "64f000000000000000000001"],
  ["irn", "a".repeat(64)],
  ["ackNo", "112010036563310"],
  ["einvoiceStatus", "generated"],
  ["signedQrCode", "eyJ..."],
  ["emailLog", [{ to: ["x@y.in"], at: "2026-01-01" }]],
  ["createdAt", "2020-01-01"],
  ["againstInvoiceNo", 7],
  ["createdBy", "someone-else"],
]) {
  test(`a request setting ${field} is refused, by name`, () => {
    refused(screenPayload({ overrides: { [field]: value } }), new RegExp(`"${field}"`));
  });
}

test("operator-shaped keys are refused", () => {
  refused(screenPayload({ overrides: { $where: "1" } }), /\$where/);
  refused(screenPayload({ overrides: { "customer.name": "x" } }), /customer\.name/);
});

test("an unknown key is dropped, not stored", () => {
  const result = prepare(screenPayload({ overrides: { isAdmin: true, discountOverride: 99 } }));
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.ignored.sort(), ["discountOverride", "isAdmin"]);
  assert.ok(!("isAdmin" in result.invoice));
  assert.ok(!("discountOverride" in result.invoice));
});

test("the output carries nothing server-managed", () => {
  const invoice = ok(screenPayload());
  for (const key of PROTECTED_FIELDS) assert.ok(!(key in invoice), `${key} reached the invoice`);
});

test("a line keeps its own fields and drops the master's", () => {
  // The screen spreads the WHOLE item master into each line, companyId and
  // _id included. Refusing those would refuse every honest bill; keeping them
  // would carry another document's identity onto this one.
  const [line] = ok(screenPayload()).items;
  for (const key of ["_id", "companyId", "salePrice", "purchasePrice", "gst", "createdAt", "uqc", "isService"]) {
    assert.ok(!(key in line), `${key} survived onto the line`);
  }
  assert.deepEqual(Object.keys(line).sort(), [
    "cost", "discount", "gstAmount", "gstRate", "hsn", "name", "quantity", "taxableAmount", "total",
  ]);
});

test("the party's custId is never taken from the request", () => {
  // buyerSnapshot() prefers a typed custId over the master's own _id, so a
  // client-supplied one could name another firm's party. It is not passed on.
  const invoice = ok(screenPayload());
  assert.deepEqual(Object.keys(invoice.customer).sort(), ["email", "name", "phone"]);
});

test("a query operator in the party name is refused", () => {
  const body = screenPayload();
  body.customer = { name: { $ne: null } };
  refused(body, /customer/i);
});

test("a query operator in an item name is refused", () => {
  const body = screenPayload();
  body.items = [{ ...body.items[0], name: { $gt: "" } }];
  refused(body, /item name/);
});

test("the payment type must be text", () => {
  refused(screenPayload({ overrides: { paymentType: { $regex: ".*" } } }), /Payment type/);
});

test("figures the client sends are ignored and recomputed", () => {
  const body = screenPayload({ received: 50 });
  const honest = ok(body);
  const tampered = ok({
    ...body,
    balanceDue: 0,
    totalAmount: 1,
    gst: 0,
    hsnTotals: [{ hsn: "0000", amount: 0, total: 0 }],
    stateOfSupply: "Goa",
    stateCode: "30",
  });
  for (const key of ["balanceDue", "totalAmount", "gst", "hsnTotals", "finalAmount", "received"]) {
    assert.deepEqual(tampered[key], honest[key], `${key} followed the request`);
  }
  assert.ok(!("stateOfSupply" in tampered), "the place of supply comes from the party's master");
});

/* ================================================== invalid values ====== */

console.log("\n--- invalid values are refused ---");

const withLine = (patch) => {
  const body = screenPayload();
  body.items = [{ ...body.items[0], ...patch }];
  delete body.items[0].total; // judged on its own fields, not the stale total
  delete body.finalAmount;
  return body;
};

test("invoice type and return flag", () => {
  refused(screenPayload({ overrides: { type: "Gift" } }), /type/);
  refused(screenPayload({ overrides: { type: { $ne: "Sale" } } }), /type/);
  refused(screenPayload({ overrides: { return: "yes" } }), /Return/);
});

test("dates", () => {
  refused(screenPayload({ overrides: { date: "" } }), /date is required/);
  refused(screenPayload({ overrides: { date: "not a date" } }), /valid date/);
  refused(screenPayload({ overrides: { date: "1999-12-31" } }), /before 2000/);
  refused(screenPayload({ overrides: { date: "2029-01-01" } }), /future/);
  refused(screenPayload({ overrides: { grDate: "31/31/2026" } }), /GR date/);
  refused(screenPayload({ overrides: { date: { $gt: 0 } } }), /date/);
});

test("quantities", () => {
  refused(withLine({ quantity: 0 }), /more than zero/);
  refused(withLine({ quantity: -2 }), /more than zero/);
  refused(withLine({ quantity: "two" }), /quantity must be a number/);
  refused(withLine({ quantity: [5] }), /quantity must be a number/);
  refused(withLine({ quantity: true }), /quantity must be a number/);
  refused(withLine({ quantity: 1e12 }), /too large/);
});

test("rates, discounts and GST", () => {
  refused(withLine({ cost: -10 }), /rate cannot be less than 0/);
  refused(withLine({ discount: 150 }), /discount is too large/);
  refused(withLine({ discount: -5 }), /discount cannot be less than 0/);
  refused(withLine({ gstRate: 101 }), /GST rate is too large/);
  refused(withLine({ gstRate: -1 }), /GST rate cannot be less than 0/);
  refused(withLine({ cost: "Infinity" }), /rate must be a number/);
});

test("the line names the problem", () => {
  const error = refused(withLine({ quantity: 0 }));
  assert.match(error, /^Line 1 \(Widget\)/);
});

test("invoice numbers", () => {
  refused(screenPayload({ overrides: { invoiceNo: 0 } }), /Invoice No/);
  refused(screenPayload({ overrides: { invoiceNo: -3 } }), /Invoice No/);
  refused(screenPayload({ overrides: { invoiceNo: 1.5 } }), /whole number/);
  refused(screenPayload({ overrides: { invoiceNo: "abc" } }), /Invoice No/);
});

test("numbers are decimals as typed, not hex or binary", () => {
  refused(screenPayload({ overrides: { received: "0x10" } }), /received must be a number/);
  refused(screenPayload({ overrides: { weight: "0b11" } }), /Weight must be a number/);
  refused(withLine({ quantity: "0x2" }), /quantity must be a number/);
  assert.equal(ok(screenPayload({ overrides: { received: " 12.5 " } })).received, 12.5);
  refused(screenPayload({ overrides: { orderNo: "2.5" } }), /whole number/);
});

test("tax type is one of the screen's two choices", () => {
  assert.equal(ok(screenPayload({ overrides: { taxType: "central" } })).taxType, "central");
  assert.equal(ok(screenPayload({ overrides: { taxType: "" } })).taxType, "");
  refused(screenPayload({ overrides: { taxType: "IGST please" } }), /Tax type/);
  refused(screenPayload({ overrides: { taxType: { $ne: "" } } }), /Tax type/);
});

test("money received", () => {
  refused(screenPayload({ overrides: { received: -1 } }), /received/);
  refused(screenPayload({ overrides: { received: "lots" } }), /received/);
});

test("a bill with no lines, or too many", () => {
  refused(screenPayload({ overrides: { items: [] } }), /at least one item/);
  refused(screenPayload({ overrides: { items: "Widget" } }), /at least one item/);
  const line = screenPayload().items[0];
  refused(
    screenPayload({ overrides: { items: Array.from({ length: MAX_LINES + 1 }, () => line), finalAmount: undefined } }),
    /At most/
  );
});

test("a total that disagrees with the lines is refused", () => {
  refused(screenPayload({ overrides: { finalAmount: "100.00" } }), /does not match its lines/);
  refused(screenPayload({ overrides: { finalAmount: "abc" } }), /not a number/);
});

test("a line total that disagrees with its own rate is refused", () => {
  const body = screenPayload();
  body.items = [{ ...body.items[0], total: 1 }];
  refused(body, /Line 1 \(Widget\): the total 1\.00 does not match/);
});

test("rounding is not a disagreement", () => {
  const body = screenPayload();
  body.finalAmount = String(Number(body.finalAmount) + TOTAL_TOLERANCE / 2);
  ok(body);
});

test("order references are all three parts or none", () => {
  refused(withLine({ orderNo: 7 }), /order reference is incomplete/);
  refused(withLine({ orderNo: 7, orderType: "Sale" }), /order reference is incomplete/);
  refused(withLine({ orderNo: "x", orderType: "Sale", orderLineId: "l1" }), /incomplete/);
  refused(withLine({ orderNo: 7, orderType: "Sale", orderLineId: { $ne: "" } }), /incomplete/);
  const line = ok(withLine({ orderNo: "7", orderType: "Sale", orderLineId: "line-1", orderDate: "2026-10-01" })).items[0];
  assert.equal(line.orderNo, 7);
  assert.equal(line.orderType, "Sale");
  assert.equal(line.orderLineId, "line-1");
  assert.ok(line.orderDate instanceof Date);
});

test("a sale cannot settle a purchase order, and a return settles none", () => {
  refused(withLine({ orderNo: 7, orderType: "Purchase", orderLineId: "l1" }), /Sale cannot settle a Purchase order/);
  const ret = withLine({ orderNo: 7, orderType: "Sale", orderLineId: "l1" });
  ret.return = true;
  refused(ret, /return cannot settle an order/);
});

test("no order reference is no reference", () => {
  // What a stored line looks like after a round trip: null/0/"" everywhere.
  const line = ok(withLine({ orderNo: 0, orderType: "", orderLineId: null })).items[0];
  assert.ok(!("orderNo" in line));
});

test("freight", () => {
  refused(screenPayload({ freight: "-50" }), /Freight cannot be negative/);
  refused(screenPayload({ overrides: { freight: { amount: 5 } } }), /Freight must be text/);
  // Text that is not a number is allowed -- it prints -- and adds nothing.
  const toPay = ok(screenPayload({ freight: "To Pay" }));
  assert.equal(toPay.freight, "To Pay");
  assert.equal(toPay.finalAmount, ok(screenPayload()).finalAmount);
});

test("party taxes", () => {
  const items = [screenLine(master("Widget"), { quantity: 2 })];
  const base = items.reduce((s, i) => s + i.total, 0);
  const rated = { name: "Cartage", rate: 2, amount: "", total: ((base * 2) / 100).toFixed(2) };
  ok(screenPayload({ items, partyTaxes: [rated] }));
  refused(screenPayload({ items, partyTaxes: [{ ...rated, total: "999.00" }], overrides: { finalAmount: undefined } }), /is not 2% of the bill/);
  refused(screenPayload({ items, partyTaxes: [{ ...rated, rate: 500 }] }), /rate is too large/);
  refused(screenPayload({ items, partyTaxes: [{ name: "", total: "5" }] }), /has no name/);
  refused(screenPayload({ items, overrides: { partyTaxes: "Cartage", finalAmount: undefined } }), /must be a list/);
  // A negative fixed charge is a bill-level discount, and is allowed ...
  const discount = { name: "Discount", rate: "", amount: "-10.00", total: "-10.00" };
  const disc = ok(screenPayload({ items, partyTaxes: [discount] }));
  assert.equal(disc.finalAmount, round2(base - 10));
  // ... but not below zero for the bill as a whole.
  const tooMuch = { name: "Discount", rate: "", amount: "-99999.00", total: "-99999.00" };
  refused(screenPayload({ items, partyTaxes: [tooMuch] }), /below zero/);
});

test("over-long text is refused rather than truncated", () => {
  refused(screenPayload({ overrides: { transport: "x".repeat(5000) } }), /Transport is too long/);
});

test("a body that is not an object", () => {
  for (const body of [null, undefined, "invoice", 42, [screenPayload()]]) {
    refused(body, /not an invoice/);
  }
});

/* ================================================ legitimate zeros ====== */

console.log("\n--- legitimate zero values survive ---");

test("a free item -- sale price zero -- bills at zero", () => {
  // What the screen actually produces for a zero rate: an item whose master
  // price is 0 (recalcItem's `cost || salePrice` has nowhere else to go).
  const free = screenLine(master("Sample", { salePrice: 0 }), { quantity: 3 });
  assert.equal(free.total, 0);
  const invoice = ok(screenPayload({ items: [free] }));
  assert.equal(invoice.items[0].cost, 0);
  assert.equal(invoice.items[0].total, 0);
  assert.equal(invoice.finalAmount, 0);
  assert.equal(invoice.balanceDue, 0);
});

test("the server never reads the master's price off a line", () => {
  // salePrice is not a line field the server accepts, so a request that says
  // cost 0 is held to 0 -- and if it also claims the screen's total, the two
  // disagree and the request is refused.
  const crafted = { ...screenLine(master("Widget"), { quantity: 3 }), cost: 0 };
  refused(screenPayload({ items: [crafted] }), /does not match/);
  delete crafted.total;
  const body = screenPayload({ items: [crafted] });
  delete body.finalAmount;
  assert.equal(ok(body).items[0].total, 0);
});

test("zero discount, zero GST, zero received", () => {
  const plain = screenLine(master("Plain", { gst: 0 }), { quantity: 1, discount: 0, gstRate: 0 });
  const invoice = ok(screenPayload({ items: [plain], received: 0 }));
  assert.equal(invoice.items[0].discount, 0);
  assert.equal(invoice.items[0].gstRate, 0);
  assert.equal(invoice.gst, 0);
  assert.equal(invoice.received, 0);
  assert.equal(invoice.balanceDue, invoice.finalAmount);
});

test("fully paid is a balance of exactly zero", () => {
  const body = screenPayload();
  const invoice = ok({ ...body, received: Number(body.finalAmount) });
  assert.equal(invoice.balanceDue, 0);
  assert.equal(invoice.received, invoice.finalAmount);
});

test("a zero weight and a zero order number are kept as zero", () => {
  const invoice = ok(screenPayload({ overrides: { weight: 0, orderNo: 0 } }));
  assert.equal(invoice.weight, 0);
  assert.equal(invoice.orderNo, 0);
});

test("a zero-value bill still posts in its own direction and balances", () => {
  const free = { ...screenLine(master("Sample")), cost: 0, taxableAmount: 0, gstAmount: 0, total: 0 };
  const invoice = ok(screenPayload({ items: [free] }));
  const deltas = invoicePostingDeltas({ type: invoice.type, isReturn: invoice.return, finalAmount: invoice.finalAmount, received: invoice.received });
  const rows = buildInvoiceLedgerRows({
    type: invoice.type, customerName: "Shah Traders", invoiceNo: 1, date: invoice.date,
    deltas, invoice: { ...invoice, invoiceNo: 1 },
  });
  assert.equal(rowsImbalance(rows), 0);
});

/* =============================================== arithmetic parity ====== */

console.log("\n--- the server's figures are the screen's ---");

const LINES = [
  screenLine(master("Widget"), { quantity: 3, discount: 7.5 }),
  screenLine(master("Bolt", { hsn: "7318", salePrice: 0.33, gst: 12 }), { quantity: 1000 }),
  screenLine(master("Service", { hsn: "9987", salePrice: 1499, gst: 18 }), { quantity: 1, discount: 10 }),
  screenLine(master("Odd", { hsn: "8471", salePrice: 1 / 3, gst: 5 }), { quantity: 7 }),
];

test("each line's figures are bit-for-bit the screen's", () => {
  const invoice = ok(screenPayload({ items: LINES }));
  invoice.items.forEach((line, i) => {
    assert.equal(line.taxableAmount, LINES[i].taxableAmount);
    assert.equal(line.gstAmount, LINES[i].gstAmount);
    assert.equal(line.total, LINES[i].total);
  });
});

test("the totals, GST and HSN summary are the screen's", () => {
  const body = screenPayload({ items: LINES, freight: "250", received: 1000, partyTaxes: [
    { name: "Insurance", rate: 1, amount: "", total: ((LINES.reduce((s, l) => s + l.total, 0) * 1) / 100).toFixed(2) },
  ] });
  const invoice = ok(body);
  assert.equal(invoice.finalAmount, round2(Number(body.finalAmount)));
  assert.equal(invoice.totalAmount, Number(body.totalAmount));
  assert.equal(invoice.gst, totalGstOf(LINES));
  assert.deepEqual(invoice.hsnTotals, hsnTotalsArray(buildHsnTotals(LINES)));
  assert.equal(invoice.balanceDue, round2(Number(body.finalAmount) - 1000));
});

test("invoiceTotals agrees with itself for an empty bill", () => {
  const t = invoiceTotals({});
  assert.deepEqual([t.totalAmount, t.finalAmount, t.gst, t.balanceDue], [0, 0, 0, 0]);
});

test("every kind of document validates and posts a balanced entry", () => {
  for (const key of ["sale", "purchase", "salereturn", "purchasereturn"]) {
    const invoice = ok(screenPayload({ key, items: LINES, received: 100 }));
    assert.equal(invoice.type, BILLING_TYPES[key].type);
    assert.equal(invoice.return, BILLING_TYPES[key].isReturn);
    const deltas = invoicePostingDeltas({ type: invoice.type, isReturn: invoice.return, finalAmount: invoice.finalAmount, received: invoice.received });
    const rows = buildInvoiceLedgerRows({
      type: invoice.type, customerName: "Shah Traders", cashAccountName: "Cash", invoiceNo: 1,
      date: invoice.date, deltas, invoice: { ...invoice, invoiceNo: 1 },
    });
    assert.equal(rowsImbalance(rows), 0, `${key} does not balance`);
  }
});

/* ============================================================ edits ===== */

console.log("\n--- edits ---");

test("an edit is found by the number it was opened with", () => {
  const invoice = ok(screenPayload({ overrides: { originalInvoiceNo: "41", invoiceNo: 45 } }), "edit");
  assert.equal(invoice.originalInvoiceNo, 41);
  assert.equal(invoice.invoiceNo, 45);
});

test("an edit with no renumber keeps its number", () => {
  const body = screenPayload({ overrides: { originalInvoiceNo: 41 } });
  delete body.invoiceNo;
  const invoice = ok(body, "edit");
  assert.equal(invoice.originalInvoiceNo, 41);
  assert.equal(invoice.invoiceNo, undefined); // the route falls back to the original
});

test("an edit falls back to invoiceNo when no original is sent", () => {
  const body = screenPayload();
  delete body.originalInvoiceNo;
  assert.equal(ok(body, "edit").originalInvoiceNo, 41);
});

test("an edit must say which bill, and renumber to a real number", () => {
  const body = screenPayload();
  delete body.originalInvoiceNo;
  delete body.invoiceNo;
  refused(body, /Invoice number missing/, "edit");
  refused(screenPayload({ overrides: { originalInvoiceNo: 41, invoiceNo: 0 } }), /Invoice No/, "edit");
  refused(screenPayload({ overrides: { originalInvoiceNo: 41, invoiceNo: 2.5 } }), /whole number/, "edit");
  refused(screenPayload({ overrides: { originalInvoiceNo: "x" } }), /being edited/, "edit");
});

test("an edit is held to the same rules as a new bill", () => {
  refused(screenPayload({ overrides: { originalInvoiceNo: 41, companyId: "other" } }), /companyId/, "edit");
  refused(screenPayload({ overrides: { originalInvoiceNo: 41, finalAmount: "1.00" } }), /does not match/, "edit");
  const created = ok(screenPayload());
  const edited = ok(screenPayload({ overrides: { originalInvoiceNo: 41 } }), "edit");
  for (const key of ["finalAmount", "totalAmount", "gst", "balanceDue", "hsnTotals", "items", "partyTaxes"]) {
    assert.deepEqual(edited[key], created[key], `${key} differs between create and edit`);
  }
});

test("an edit re-sending a stored bill as the screen reloads it is accepted", () => {
  // BillingScreen's load path: lines carry their stored figures and the
  // stored _id; party taxes come back as { name, rate: null, total, _id }.
  const stored = ok(screenPayload({ items: LINES, partyTaxes: [{ name: "Packing", rate: "", amount: "40.00", total: "40.00" }] }));
  const reloaded = {
    ...screenPayload({ items: LINES, partyTaxes: [{ name: "Packing", rate: "", amount: "40.00", total: "40.00" }] }),
    originalInvoiceNo: 41,
    items: stored.items.map((l, i) => ({ ...l, _id: `line-${i}`, uqc: "PCS", isService: false })),
    partyTaxes: stored.partyTaxes.map((t) => ({ ...t, _id: "pt-1", amount: t.total, total: Number(t.total).toFixed(2) })),
  };
  const edited = ok(reloaded, "edit");
  assert.equal(edited.finalAmount, stored.finalAmount);
});

test("an old bill whose stored line disagrees with itself is named, not re-totalled", () => {
  const body = screenPayload({ overrides: { originalInvoiceNo: 41 } });
  body.items = [{ ...body.items[0], taxableAmount: 150, total: 177 }]; // extractor numbers
  refused(body, /Line 1 \(Widget\).*Re-enter the line/, "edit");
});

/* ======================================================= duplicates ===== */

console.log("\n--- duplicate submissions ---");

const storedAs = (invoice, createdAt, createdBy = "user-1") => ({
  ...invoice, invoiceNo: 41, createdAt: new Date(createdAt), createdBy, companyId: "firm-A",
});
const BY = { now: NOW, userId: "user-1" };

test("the same bill again, by the same user, within the window is a duplicate", () => {
  const first = ok(screenPayload());
  const again = ok(screenPayload());
  assert.equal(isDuplicateSubmission(storedAs(first, NOW - 5000), again, BY), true);
});

test("the same bill by a DIFFERENT user is a second sale", () => {
  // Two counters peeking the same number and billing the same counter sale
  // in the same minute. Treating the second as a duplicate would drop a sale.
  const first = storedAs(ok(screenPayload()), NOW - 5000, "user-1");
  assert.equal(isDuplicateSubmission(first, ok(screenPayload()), { now: NOW, userId: "user-2" }), false);
});

test("a bill with no recorded creator, or a request with no user, is never a duplicate", () => {
  const bill = ok(screenPayload());
  assert.equal(isDuplicateSubmission(storedAs(bill, NOW - 5000, null), bill, BY), false);
  assert.equal(isDuplicateSubmission(storedAs(bill, NOW - 5000), bill, { now: NOW }), false);
});

test("a different bill is not a duplicate", () => {
  const first = storedAs(ok(screenPayload()), NOW - 5000);
  const moreQty = ok(screenPayload({ items: [screenLine(master("Widget"), { quantity: 3 })] }));
  const otherParty = ok({ ...screenPayload(), customer: { name: "Mehta & Sons" } });
  const otherDay = ok(screenPayload({ overrides: { date: "2026-10-11" } }));
  const paid = ok(screenPayload({ received: 10 }));
  const purchase = ok(screenPayload({ key: "purchase" }));
  for (const other of [moreQty, otherParty, otherDay, paid, purchase]) {
    assert.equal(isDuplicateSubmission(first, other, BY), false);
  }
});

test("the same bill outside the window is a second sale", () => {
  const first = ok(screenPayload());
  assert.equal(
    isDuplicateSubmission(storedAs(first, NOW - DUPLICATE_WINDOW_MS - 1), ok(screenPayload()), BY),
    false
  );
});

test("no existing bill, or one with no timestamp, is never a duplicate", () => {
  const bill = ok(screenPayload());
  assert.equal(isDuplicateSubmission(null, bill, BY), false);
  assert.equal(isDuplicateSubmission({ ...bill, createdBy: "user-1", createdAt: undefined }, bill, BY), false);
  assert.equal(isDuplicateSubmission({ ...bill, createdBy: "user-1", createdAt: "garbage" }, bill, BY), false);
});

test("the fingerprint ignores the number and the identity", () => {
  const bill = ok(screenPayload());
  assert.equal(
    submissionFingerprint({ ...bill, invoiceNo: 1, _id: "a" }),
    submissionFingerprint({ ...bill, invoiceNo: 99, _id: "b" })
  );
});

/* ================================================ references (pure) ===== */

console.log("\n--- references to this firm's data ---");

test("unknown items are named", () => {
  const masters = [{ name: "Widget" }, { name: "Bolt" }];
  assert.deepEqual(unknownItems([{ name: "Widget" }, { name: "Nut" }, { name: "Nut" }], masters), ["Nut"]);
  assert.deepEqual(unknownItems([{ name: "Widget" }], masters), []);
  assert.deepEqual(unknownItems([{ name: "widget" }], masters), ["widget"], "matching is exact, as the query is");
});

test("a posting head cannot be the party", () => {
  for (const head of ["Sales Account", "Purchase Account", "Output CGST", "Input IGST", "Round Off"]) {
    assert.match(partyProblem(head), /ledger head/);
  }
  assert.match(partyProblem("round off"), /ledger head/, "heads are matched case-insensitively");
  assert.match(partyProblem("  SALES ACCOUNT "), /ledger head/);
  assert.equal(partyProblem("Shah Traders"), null);
  assert.equal(partyProblem("Cash"), null, "a counter sale billed to Cash is supported");
});

test("only a cash or bank account can receive a payment", () => {
  assert.equal(paymentAccountProblem({ name: "Cash", group: "Cash" }, "Cash"), null);
  assert.equal(paymentAccountProblem({ name: "Bank", group: "Bank" }, "Cheque"), null);
  assert.equal(paymentAccountProblem({ name: "HDFC Current", group: "Bank Account" }, "HDFC Current"), null);
  assert.equal(paymentAccountProblem({ name: "Petty", group: "Petty Cash In Hand" }, "Petty"), null);
  assert.equal(paymentAccountProblem({ name: "Cash", group: "" }, "Cash"), null, "the resolver's own default");
  assert.match(paymentAccountProblem({ name: "Mehta & Sons", group: "Sundry Debtors" }, "Mehta & Sons"), /not a cash or bank/);
  assert.match(paymentAccountProblem({ name: "Sales Account", group: "Sales Account" }, "Sales Account"), /not a cash or bank/);
  assert.match(paymentAccountProblem(null, "Cash"), /No account/);
});

const ORDER = {
  orderNo: 7,
  type: "Sale",
  date: "2026-10-01T00:00:00.000Z",
  customer: { name: "Shah Traders" },
  items: [
    { _id: "ol-1", name: "Widget", quantity: 10, invoicedQty: 4, cancelledQty: 0, cost: 95, discount: 5, hsn: "8471" },
    { _id: "ol-2", name: "Retired Part", quantity: 3, invoicedQty: 0, cancelledQty: 0, cost: 40, discount: 0, hsn: "8473" },
  ],
};
const MASTERS = [master("Widget")]; // "Retired Part" has left the item master

test("an order prefill -- including an item no longer in the master -- is accepted", () => {
  const { lines, skipped } = prefillFromOrder({ order: ORDER, items: MASTERS, recalc: recalcItem });
  assert.deepEqual(skipped, ["Retired Part"]);
  const invoice = ok(screenPayload({ items: lines }));
  assert.deepEqual(orderRefsOf(invoice.items), [{ orderNo: 7, type: "Sale" }]);
  assert.deepEqual(orderLineProblems(invoice.items, [ORDER]), []);
  // The retired item needs no master entry: the order vouches for it ...
  assert.deepEqual(unknownItems(linesNeedingMaster(invoice.items), MASTERS), []);
  // ... but an ordinary line for it would.
  assert.deepEqual(unknownItems(linesNeedingMaster([{ name: "Retired Part" }]), MASTERS), ["Retired Part"]);
});

test("an order line must exist, on this firm's order, for the same item", () => {
  const { lines } = prefillFromOrder({ order: ORDER, items: MASTERS, recalc: recalcItem });
  const invoice = ok(screenPayload({ items: lines }));
  // Another firm's order is absent from the scoped read.
  assert.match(orderLineProblems(invoice.items, []).join(" "), /Sale order 7 does not exist/);
  const swapped = invoice.items.map((l) => (l.name === "Widget" ? { ...l, orderLineId: "ol-2" } : l));
  assert.match(orderLineProblems(swapped, [ORDER]).join(" "), /ordered "Retired Part" on that line, not "Widget"/);
  const ghost = invoice.items.map((l) => ({ ...l, orderLineId: "ol-999" }));
  assert.match(orderLineProblems(ghost, [ORDER]).join(" "), /not on Sale order 7/);
  assert.deepEqual(orderLineProblems([{ name: "Widget" }], []), [], "an ordinary line has nothing to check");
});

/**
 * BillingScreen's edit load path, copied: the stored document is read back
 * and normalised exactly as the page does before it is re-sent.
 */
const screenReload = (doc) => {
  const items = (doc.items || []).map((item) => {
    const cost = Number(item.cost || item.salePrice || 0);
    const quantity = Number(item.quantity || 0);
    const discount = Number(item.discount || 0);
    const gstRate = Number(item.gstRate || item.gst || 0);
    const baseAmount = cost * quantity;
    const discountAmount = (baseAmount * discount) / 100;
    const taxableAmount = item.taxableAmount ?? baseAmount - discountAmount;
    const gstAmount = item.gstAmount ?? (taxableAmount * gstRate) / 100;
    const total = item.total ?? taxableAmount + gstAmount;
    return { ...item, cost, gstRate, taxableAmount, gstAmount, total };
  });
  const base = (doc.items || []).reduce((sum, item) => sum + Number(item.total || 0), 0);
  const partyTaxes = (doc.partyTaxes || []).map((tax) => {
    const taxRate = Number(tax.rate || 0);
    const total = tax.total ?? (taxRate ? (base * taxRate) / 100 : Number(tax.amount || 0));
    const amount = taxRate ? "" : tax.total;
    return { ...tax, amount, total: Number(total).toFixed(2) };
  });
  return { items, partyTaxes };
};

/** A stored invoice as Mongo hands it back through JSON. */
const asStored = (invoice) =>
  JSON.parse(JSON.stringify({
    ...invoice,
    _id: "inv-1",
    companyId: "firm-A",
    items: invoice.items.map((l, i) => ({ ...l, _id: `line-${i}`, uqc: "PCS", isService: false })),
    partyTaxes: invoice.partyTaxes.map((t, i) => ({ ...t, _id: `pt-${i}` })),
  }));

test("an edit of a stored bill, reloaded exactly as the screen reloads it, is accepted unchanged", () => {
  const { lines: orderLines } = prefillFromOrder({ order: ORDER, items: MASTERS, recalc: recalcItem });
  const items = [...LINES, ...orderLines];
  const base = items.reduce((s, l) => s + l.total, 0);
  const partyTaxes = [
    { name: "Insurance", rate: 1.5, amount: "", total: ((base * 1.5) / 100).toFixed(2) },
    { name: "Packing", rate: "", amount: "40.00", total: "40.00" },
  ];
  const stored = asStored(ok(screenPayload({ items, partyTaxes, freight: "120", received: 500 })));
  const { items: reItems, partyTaxes: reTaxes } = screenReload(stored);
  const resent = screenPayload({ items: reItems, partyTaxes: reTaxes, freight: stored.freight, received: stored.received, overrides: { originalInvoiceNo: 41 } });
  const edited = ok(resent, "edit");
  for (const key of ["finalAmount", "totalAmount", "gst", "balanceDue", "hsnTotals"]) {
    assert.deepEqual(edited[key], stored[key], `${key} changed on a no-op edit`);
  }
  // The stored row's own _id is Mongo's, and is not re-sent into the edit.
  assert.deepEqual(edited.partyTaxes, stored.partyTaxes.map(({ _id, ...t }) => t));
  assert.deepEqual(
    edited.items.map((l) => [l.name, l.total, l.orderLineId ?? null]),
    stored.items.map((l) => [l.name, l.total, l.orderLineId ?? null])
  );
});

/* =================================== replay: tenants and transactions ==== */
//
// An in-memory stand-in for the database with the two properties the routes
// rely on: every read is filtered to the current firm and every insert is
// stamped with it (lib/tenantPlugin.mjs, via the real stampDocs), and writes
// inside a transaction are rolled back when the callback throws
// (lib/withTransaction.mjs). The replay below follows save-invoice's order of
// operations. Keep it in step with the route, as posting-invariants asks.

class AbortTransaction extends Error {
  constructor(payload, status = 200) {
    super(payload?.error || "aborted");
    this.payload = payload;
    this.status = status;
  }
}

const newStore = () => ({
  customers: [
    { companyId: "firm-A", _id: "cust-shah", name: "Shah Traders", group: "Sundry Debtors", lastBal: 0 },
    { companyId: "firm-A", _id: "cash-A", name: "Cash", group: "Cash", lastBal: 0 },
    { companyId: "firm-B", _id: "cust-rival", name: "Rival Retail", group: "Sundry Debtors", lastBal: 0 },
    { companyId: "firm-B", _id: "cash-B", name: "Cash", group: "Cash", lastBal: 0 },
  ],
  items: [
    { companyId: "firm-A", name: "Widget", uqc: "PCS" },
    { companyId: "firm-B", name: "Secret Alloy", uqc: "KGS" },
  ],
  invoices: [],
  ledger: [],
  stock: [],
});

/** The tenant-scoped view a route sees. */
const scoped = (store, tenant) => ({
  find: (coll, pred = () => true) => store[coll].filter((d) => d.companyId === tenant && pred(d)),
  findOne: (coll, pred) => store[coll].find((d) => d.companyId === tenant && pred(d)) || null,
  insert: (coll, docs) => {
    stampDocs(docs, tenant);
    store[coll].push(...docs);
    return docs;
  },
});

/** Commit-or-rollback, as session.withTransaction does. */
const transact = (store, fn) => {
  const snapshot = structuredClone(store);
  try {
    return fn();
  } catch (err) {
    for (const key of Object.keys(store)) store[key] = snapshot[key];
    throw err;
  }
};

/** save-invoice, replayed. Returns { status, body }. `failAfterCreate` injects a fault. */
const replaySave = (store, tenant, body, { failAfterCreate = false } = {}) => {
  const prepared = prepareInvoiceInput(body, { mode: "create", now: NOW });
  if (!prepared.ok) return { status: 400, body: { success: false, error: prepared.error } };
  const input = prepared.invoice;
  const notAParty = partyProblem(input.customer.name);
  if (notAParty) return { status: 400, body: { success: false, error: notAParty } };

  const db = scoped(store, tenant);
  try {
    const invoice = transact(store, () => {
      const customer = db.findOne("customers", (c) => c.name === input.customer.name);
      if (!customer) throw new AbortTransaction({ success: false, error: "Customer not found" });

      const masters = db.find("items", (i) => input.items.some((l) => l.name === i.name));
      const missing = unknownItems(linesNeedingMaster(input.items), masters);
      if (missing.length) {
        throw new AbortTransaction({ success: false, error: `Not in your item master: ${missing.join(", ")}.` }, 400);
      }

      const deltas = invoicePostingDeltas({ type: input.type, isReturn: input.return, finalAmount: input.finalAmount, received: input.received });
      let cashName;
      if (deltas.settled !== 0) {
        const account = db.findOne("customers", (c) => c.name === (input.paymentType || "Cash"));
        const bad = paymentAccountProblem(account, input.paymentType);
        if (bad) throw new AbortTransaction({ success: false, error: bad }, 400);
        cashName = account.name;
      }

      const [doc] = db.insert("invoices", [{ ...input, invoiceNo: input.invoiceNo, customer: { ...input.customer, custId: customer._id } }]);
      if (failAfterCreate) throw new Error("simulated failure after the invoice was written");

      const rows = buildInvoiceLedgerRows({
        type: input.type, customerName: customer.name, cashAccountName: cashName, invoiceNo: doc.invoiceNo,
        date: input.date, deltas, invoice: { ...input, invoiceNo: doc.invoiceNo },
      });
      db.insert("ledger", rows);
      for (const [name, delta] of balanceMovesFromRows(rows)) {
        const account = db.findOne("customers", (c) => c.name === name);
        if (account) account.lastBal = round2(account.lastBal + delta);
      }
      db.insert("stock", input.items.map((l) => ({ itemName: l.name, issueQuantity: l.quantity })));
      return doc;
    });
    return { status: 200, body: { success: true, invoice } };
  } catch (err) {
    if (err instanceof AbortTransaction) return { status: err.status, body: err.payload };
    return { status: 500, body: { success: false, error: err.message } };
  }
};

const firmRows = (store, tenant) => ({
  invoices: store.invoices.filter((d) => d.companyId === tenant).length,
  ledger: store.ledger.filter((d) => d.companyId === tenant).length,
  stock: store.stock.filter((d) => d.companyId === tenant).length,
});

console.log("\n--- cross-tenant: replayed against a scoped store ---");

test("an honest bill lands entirely in the caller's firm", () => {
  const store = newStore();
  const result = replaySave(store, "firm-A", screenPayload());
  assert.equal(result.status, 200, result.body.error);
  assert.equal(result.body.invoice.companyId, "firm-A");
  assert.ok(store.ledger.every((r) => r.companyId === "firm-A"));
  assert.ok(store.stock.every((r) => r.companyId === "firm-A"));
  assert.deepEqual(firmRows(store, "firm-B"), { invoices: 0, ledger: 0, stock: 0 });
});

test("THE BUG: a body naming another firm writes nothing anywhere", () => {
  // Before: `{ ...body }` carried companyId onto the invoice, stampDocs left
  // it alone because it was already set, and the bill appeared in firm B
  // while its ledger rows posted to firm A.
  const store = newStore();
  const result = replaySave(store, "firm-A", screenPayload({ overrides: { companyId: "firm-B" } }));
  assert.equal(result.status, 400);
  assert.match(result.body.error, /companyId/);
  assert.deepEqual(firmRows(store, "firm-A"), { invoices: 0, ledger: 0, stock: 0 });
  assert.deepEqual(firmRows(store, "firm-B"), { invoices: 0, ledger: 0, stock: 0 });
});

test("two locks on companyId: the allowlist drops it, and the stamp refuses another firm", () => {
  // The stamp used to leave an explicit companyId alone, which made the
  // allowlist the only thing between a request body and another firm's
  // books. Inside a request it now refuses one that names a different firm
  // (lib/tenantScope.mjs); the allowlist still drops the field first.
  assert.throws(() => stampDocs([{ companyId: "firm-B" }], "firm-A"), /different firm/);
  const own = [{ companyId: "firm-A" }];
  stampDocs(own, "firm-A");
  assert.equal(own[0].companyId, "firm-A");
});

test("another firm's party is not found", () => {
  const store = newStore();
  const body = { ...screenPayload(), customer: { name: "Rival Retail" } };
  const result = replaySave(store, "firm-A", body);
  assert.equal(result.body.success, false);
  assert.match(result.body.error, /Customer not found/);
  assert.equal(store.invoices.length, 0);
});

test("another firm's item is refused by name", () => {
  const store = newStore();
  const line = screenLine(master("Secret Alloy"), { quantity: 1 });
  const result = replaySave(store, "firm-A", screenPayload({ items: [line] }));
  assert.equal(result.status, 400);
  assert.match(result.body.error, /Secret Alloy/);
  assert.equal(store.invoices.length + store.ledger.length + store.stock.length, 0);
});

test("a custId naming another firm's party does not reach the bill", () => {
  const store = newStore();
  const body = screenPayload();
  body.customer = { ...body.customer, custId: "cust-rival" };
  const result = replaySave(store, "firm-A", body);
  assert.equal(result.status, 200, result.body.error);
  assert.equal(result.body.invoice.customer.custId, "cust-shah");
});

test("a payment type naming a party is refused", () => {
  const store = newStore();
  const result = replaySave(store, "firm-A", screenPayload({ received: 10, overrides: { paymentType: "Shah Traders" } }));
  assert.equal(result.status, 400);
  assert.match(result.body.error, /not a cash or bank account/);
  assert.equal(store.invoices.length, 0);
});

test("a ledger head is refused as the party before anything is read", () => {
  const store = newStore();
  const result = replaySave(store, "firm-A", { ...screenPayload(), customer: { name: "Sales Account" } });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /ledger head/);
});

console.log("\n--- rollback ---");

test("a failure after the invoice is written leaves no trace", () => {
  const store = newStore();
  const before = structuredClone(store);
  const result = replaySave(store, "firm-A", screenPayload({ received: 50 }), { failAfterCreate: true });
  assert.equal(result.status, 500);
  assert.deepEqual(store, before, "the replayed transaction did not roll back");
});

test("every refusal happens before the first write", () => {
  for (const body of [
    screenPayload({ overrides: { irn: "x" } }),
    { ...screenPayload(), customer: { name: "Nobody" } },
    screenPayload({ items: [screenLine(master("Secret Alloy"))] }),
    screenPayload({ received: 1, overrides: { paymentType: "Shah Traders" } }),
  ]) {
    const store = newStore();
    const before = structuredClone(store);
    const result = replaySave(store, "firm-A", body);
    assert.equal(result.body.success, false);
    assert.deepEqual(store, before);
  }
});

/* ============================================================ wiring ==== */

console.log("\n--- the routes use all of the above ---");

/**
 * The route's CODE, comments removed -- the notes in these routes quote the
 * old `{ ...body }` on purpose, and a sweep reading them would fail on prose.
 */
const code = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const SAVE = code(read("app/api/save-invoice/route.js"));
const ALTER = code(read("app/api/sale-alter/route.js"));

/** The text of a call starting at `start`, through its matching paren and any `.session(...)`. */
const callAt = (src, start) => {
  let depth = 0;
  let i = src.indexOf("(", start);
  for (; i < src.length; i += 1) {
    if (src[i] === "(") depth += 1;
    else if (src[i] === ")" && --depth === 0) break;
  }
  const rest = src.slice(i + 1, i + 200);
  const chained = /^\s*(\.\s*(sort|lean|exec|session)\([^)]*\))*/.exec(rest)[0];
  return src.slice(start, i + 1) + chained;
};

const DB_CALL = /\b(Invoice|Customer|Ledger|Item|State|ItemLedger|Order|Counter)\.(find\w*|create|insertMany|update\w*|delete\w*|bulkWrite|countDocuments)\(/g;
const HELPER_CALL = /\b(resolvePaymentAccount|resolveGlAccounts|writeItemLedgerRows|recomputeLedgerBalances|recomputeItemBalances|claimOrderQty|reconcileOrderQty|getNextInvoiceNo|raiseInvoiceCounter)\(/g;

for (const [name, src] of [["save-invoice", SAVE], ["sale-alter", ALTER]]) {
  test(`${name}: validates with prepareInvoiceInput before the transaction`, () => {
    assert.match(src, /prepareInvoiceInput\(body, \{ mode: "(create|edit)" \}\)/);
    assert.ok(src.indexOf("prepareInvoiceInput(") < src.indexOf("withTransaction("), "validation runs inside the transaction");
    assert.match(src, /status: 400/);
  });

  test(`${name}: never spreads the request into a document`, () => {
    assert.doesNotMatch(src, /\.\.\.body\b/, "the raw body is spread somewhere");
    assert.doesNotMatch(src, /await req\.json\(\);/, "the raw body is used directly");
  });

  test(`${name}: checks items, party heads and the payment account`, () => {
    assert.match(src, /unknownItems\(/);
    assert.match(src, /partyProblem\(/);
    assert.match(src, /paymentAccountProblem\(/);
    assert.match(src, /orderLineProblems\(/);
    assert.match(src, /unknownItems\(linesNeedingMaster\(/);
  });

  test(`${name}: every query inside the transaction carries the session`, () => {
    const body = src.slice(src.indexOf("withTransaction("));
    let count = 0;
    for (const re of [DB_CALL, HELPER_CALL]) {
      for (const m of body.matchAll(re)) {
        count += 1;
        const call = callAt(body, m.index);
        assert.match(call, /session/, `outside the transaction: ${call.slice(0, 80)}...`);
      }
    }
    assert.ok(count > 8, `only ${count} calls found -- the sweep is not reading the route`);
  });
}

test("save-invoice builds the document field by field", () => {
  const create = callAt(SAVE, SAVE.indexOf("Invoice.create("));
  assert.doesNotMatch(create, /\.\.\./, "something is spread into Invoice.create");
  for (const field of ["companyId", "irn", "einvoiceStatus", "emailLog", "_id"]) {
    assert.doesNotMatch(create, new RegExp(`\\b${field}\\b`), `${field} is written by save-invoice`);
  }
  for (const field of ["finalAmount", "received", "balanceDue", "totalAmount", "gst", "hsnTotals", "partyTaxes", "partyBillNo"]) {
    assert.match(create, new RegExp(`\\b${field}\\b`), `${field} is no longer written`);
  }
});

test("save-invoice refuses before it writes", () => {
  const create = SAVE.indexOf("Invoice.create(");
  for (const check of ["unknownItems(", "orderLineProblems(", "paymentAccountProblem(", "Customer not found"]) {
    assert.ok(SAVE.indexOf(check) < create, `${check} runs after the invoice is written`);
  }
});

test("save-invoice returns the existing bill for a double submit, and maps a raced number", () => {
  assert.match(SAVE, /isDuplicateSubmission\(taken, input, \{ userId: auth\?\.userId \}\)/);
  assert.match(SAVE, /createdBy: auth\?\.userId/, "the creator is not recorded from the session");
  assert.match(SAVE, /duplicate: true/);
  assert.match(SAVE, /code === 11000/);
  assert.match(SAVE, /status: 409/);
});

test("sale-alter refuses an unknown party and unknown items before it updates", () => {
  const update = ALTER.indexOf("Invoice.findOneAndUpdate(");
  assert.ok(ALTER.indexOf("if (!buyer)") < update);
  assert.ok(ALTER.indexOf("unknownItems(") < update);
  assert.ok(ALTER.indexOf("orderLineProblems(") < update);
});

test("sale-alter writes no figure from the request", () => {
  const update = callAt(ALTER, ALTER.indexOf("Invoice.findOneAndUpdate("));
  assert.doesNotMatch(update, /\|\| 0|\|\| ""|Number\(invoiceData/, "a figure is still coerced from the raw request");
  // The fields the edit screen does not reload stay untouched, as before.
  for (const field of ["shippedTo", "dispatchFrom", "partyBillNo", "companyId", "irn", "emailLog"]) {
    assert.doesNotMatch(update, new RegExp(`\\b${field}:`), `${field} is now overwritten by an edit`);
  }
});

console.log(`\n${passed} checks passed.\n`);
