/**
 * End-to-end invariant tests for the posting routes.
 *
 *   node scripts/posting-invariants.test.mjs
 *
 * The other test files check the builders in isolation. This one replays the
 * ROUTES -- save-invoice, sale-alter, delete-invoice, voucher-add,
 * voucher-alter, delete-voucher -- against an in-memory stand-in for Mongo,
 * using the real lib modules, and then asserts the things that must be true of
 * a set of books no matter what was done to them:
 *
 *   1. posting a document and then deleting it leaves every balance where it
 *      started, and leaves no rows behind
 *   2. every account's stored balance equals its opening balance plus the
 *      debits and credits of its own ledger rows
 *   3. an edit and its reversal cancel exactly
 *
 * Every failure these caught was a case of one code path deriving a figure
 * differently from another. Keep the replay below in step with the routes: if
 * a route changes how it posts, change it here too, or these stop meaning
 * anything.
 */

import assert from "node:assert/strict";
import { applyDelta, modeOf, round2, voucherDelta } from "../lib/balance.mjs";
import { buildInvoiceLedgerRows, invoicePostingDeltas } from "../lib/invoicePosting.mjs";
import { buildVoucherBalanceDeltas, buildVoucherLedgerRows } from "../lib/voucherLedger.mjs";
import { defaultAccountName, paymentAccountGroup } from "../lib/paymentType.mjs";
import { splitGst } from "../lib/gst.mjs";

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

const newDb = () => ({ customers: new Map(), ledger: [], invoices: new Map(), vouchers: new Map(), seq: 1 });

const addAccount = (db, name, openingBal = 0, group = "") => {
  db.customers.set(name, {
    name, group,
    openingBal: round2(openingBal),
    lastBal: round2(openingBal),
    lastMode: modeOf(openingBal),
  });
  return db.customers.get(name);
};

/** Mirrors lib/cashAccount.mjs: name match, then group, then default, then create. */
const findPaymentAccount = (db, paymentType) => {
  const label = String(paymentType || "").trim();
  if (label && db.customers.has(label)) return db.customers.get(label);

  const group = paymentAccountGroup(paymentType);
  for (const c of db.customers.values()) {
    if (new RegExp(`^${group}$`, "i").test(c.group || "")) return c;
  }
  return db.customers.get(defaultAccountName(paymentType)) || null;
};

const resolvePaymentAccount = (db, paymentType) =>
  findPaymentAccount(db, paymentType) ||
  addAccount(db, defaultAccountName(paymentType), 0, defaultAccountName(paymentType));

/** Mirrors the routes: net every movement per account name before applying. */
const applyMoves = (db, moves) => {
  const balances = new Map();
  for (const [name, delta] of moves) {
    const account = db.customers.get(name);
    if (!account) continue;
    applyDelta(account, delta);
    balances.set(name, account.lastBal);
  }
  return balances;
};

const moveInto = (moves, name, delta) => {
  if (!name || !delta) return;
  moves.set(name, round2((moves.get(name) || 0) + delta));
};

/* --------------------------------------------------- route stand-ins ---- */

function saveInvoice(db, body) {
  const _id = `oid${db.seq++}`;

  const finalAmount = round2(body.finalAmount ?? Number(body.balanceDue || 0) + Number(body.received || 0));
  const received = round2(body.received);
  const balanceDue = round2(finalAmount - received);   // DERIVED, never trusted

  const invoice = { ...body, _id, finalAmount, received, balanceDue };
  db.invoices.set(invoice.invoiceNo, invoice);

  const customer = db.customers.get(body.customer.name);
  if (!customer) throw new Error("Customer not found");

  const deltas = invoicePostingDeltas({
    type: body.type, isReturn: Boolean(body.return), finalAmount, received,
  });

  let payName;
  if (deltas.settled !== 0) payName = resolvePaymentAccount(db, body.paymentType).name;

  const moves = new Map();
  moveInto(moves, customer.name, deltas.partyDelta);
  moveInto(moves, payName, deltas.cashDelta);
  const balances = applyMoves(db, moves);

  db.ledger.push(...buildInvoiceLedgerRows({
    type: body.type, customerName: customer.name, cashAccountName: payName,
    invoiceNo: invoice.invoiceNo, date: body.date, paymentType: body.paymentType,
    voucherId: _id, deltas,
    partyBalance: balances.get(customer.name) ?? 0,
    cashBalance: balances.get(payName) ?? 0,
  }));

  return invoice;
}

function alterInvoice(db, data) {
  const lookupNo = Number(data.originalInvoiceNo ?? data.invoiceNo);
  const nextNo = Number(data.invoiceNo);
  const previous = db.invoices.get(lookupNo);
  if (!previous) throw new Error("Invoice not found");

  const customer = db.customers.get(data.customer.name);
  if (!customer) throw new Error("Customer not found");

  const finalAmount = round2(data.finalAmount ?? Number(data.balanceDue || 0) + Number(data.received || 0));
  const received = round2(data.received);
  const balanceDue = round2(finalAmount - received);

  const updated = { ...previous, ...data, invoiceNo: nextNo, _id: previous._id, finalAmount, received, balanceDue };
  db.invoices.delete(lookupNo);
  db.invoices.set(nextNo, updated);

  const before = invoicePostingDeltas({
    type: previous.type, isReturn: previous.return,
    finalAmount: previous.finalAmount ?? Number(previous.balanceDue || 0) + Number(previous.received || 0),
    received: previous.received,
  });
  const after = invoicePostingDeltas({
    type: data.type, isReturn: Boolean(data.return), finalAmount, received,
  });

  const previousName = previous.customer?.name;
  const previousPayName = before.cashDelta !== 0 ? findPaymentAccount(db, previous.paymentType)?.name : undefined;
  const nextPayName = after.cashDelta !== 0 ? resolvePaymentAccount(db, data.paymentType).name : undefined;

  const moves = new Map();
  moveInto(moves, previousName, -before.partyDelta);
  moveInto(moves, previousPayName, -before.cashDelta);
  moveInto(moves, customer.name, after.partyDelta);
  moveInto(moves, nextPayName, after.cashDelta);
  const balances = applyMoves(db, moves);

  db.ledger = db.ledger.filter((r) => r.voucherId !== updated._id);
  db.ledger.push(...buildInvoiceLedgerRows({
    type: data.type, customerName: customer.name, cashAccountName: nextPayName,
    invoiceNo: nextNo, date: updated.date, paymentType: data.paymentType,
    voucherId: updated._id, deltas: after,
    partyBalance: balances.get(customer.name) ?? 0,
    cashBalance: balances.get(nextPayName) ?? 0,
  }));

  return updated;
}

function deleteInvoice(db, invoiceNo) {
  const invoice = db.invoices.get(Number(invoiceNo));
  if (!invoice) throw new Error("Invoice not found.");
  db.invoices.delete(Number(invoiceNo));

  // Rows are identified by voucherId ALONE. Matching on narration as well
  // swallowed the rows of receipt vouchers raised against the same bill.
  const rows = db.ledger.filter((r) => r.voucherId === invoice._id);
  const partyName = invoice.customer?.name;

  const settlement = new Map();
  for (const row of rows) {
    if (!row.customerName || row.customerName === partyName) continue;
    settlement.set(row.customerName, round2(
      (settlement.get(row.customerName) || 0) + voucherDelta({ debit: row.debit, credit: row.credit })
    ));
  }

  db.ledger = db.ledger.filter((r) => r.voucherId !== invoice._id);

  // Reversed from the same function the posting used, not from a stored figure.
  const deltas = invoicePostingDeltas({
    type: invoice.type, isReturn: invoice.return,
    finalAmount: invoice.finalAmount ?? Number(invoice.balanceDue || 0) + Number(invoice.received || 0),
    received: invoice.received,
  });

  const moves = new Map();
  moveInto(moves, partyName, -deltas.partyDelta);
  for (const [name, posted] of settlement) moveInto(moves, name, -posted);
  applyMoves(db, moves);

  return invoice;
}

function addVoucher(db, body) {
  const _id = `oid${db.seq++}`;
  db.vouchers.set(_id, { ...body, _id });
  db.ledger.push(...buildVoucherLedgerRows({ ...body, voucherId: _id }));
  for (const { name, delta } of buildVoucherBalanceDeltas(body)) {
    if (!db.customers.has(name)) throw new Error(`No account found for: ${name}`);
    applyDelta(db.customers.get(name), delta);
  }
  return { ...body, _id };
}

function alterVoucher(db, id, body) {
  const previous = db.vouchers.get(id);
  if (!previous) throw new Error("Voucher not found");
  for (const { name, delta } of buildVoucherBalanceDeltas({ acName: previous.acName, customers: previous.customers })) {
    if (db.customers.has(name)) applyDelta(db.customers.get(name), -delta);
  }
  db.ledger = db.ledger.filter((r) => r.voucherId !== id);
  db.vouchers.set(id, { ...previous, ...body, _id: id });
  db.ledger.push(...buildVoucherLedgerRows({ ...body, voucherId: id }));
  for (const { name, delta } of buildVoucherBalanceDeltas(body)) {
    if (!db.customers.has(name)) throw new Error(`No account found for: ${name}`);
    applyDelta(db.customers.get(name), delta);
  }
}

function deleteVoucher(db, id) {
  const voucher = db.vouchers.get(id);
  if (!voucher) throw new Error("Voucher not found");
  for (const { name, delta } of buildVoucherBalanceDeltas({ acName: voucher.acName, customers: voucher.customers })) {
    if (db.customers.has(name)) applyDelta(db.customers.get(name), -delta);
  }
  db.ledger = db.ledger.filter((r) => r.voucherId !== id);
  db.vouchers.delete(id);
}

/* ----------------------------------------------------- the invariants --- */

const snapshot = (db) =>
  [...db.customers.values()].map((c) => `${c.name}=${c.lastBal}`).sort().join(" | ");

/** Every account: lastBal must equal openingBal + the sum of its own rows. */
const assertReconciles = (db, context) => {
  for (const account of db.customers.values()) {
    const fromRows = db.ledger
      .filter((r) => r.customerName === account.name)
      .reduce((sum, r) => round2(sum + (r.debit || 0) - (r.credit || 0)), 0);
    const implied = round2((account.openingBal || 0) + fromRows);
    assert.equal(
      account.lastBal, implied,
      `${context}: ${account.name} holds ${account.lastBal} but its ledger implies ${implied}`
    );
  }
};

const inv = (over) => ({
  invoiceNo: 1, date: "2026-04-01", type: "Sale", return: false,
  paymentType: "Cash", items: [], ...over,
});

const shop = () => {
  const db = newDb();
  addAccount(db, "Party", 0);
  addAccount(db, "Cash", 0, "Cash");
  addAccount(db, "HDFC Bank", 0, "bank");
  return db;
};

/* ---- 1. every document shape round-trips to nothing --------------------- */

console.log("\n--- posting then deleting leaves no trace ---");

const SHAPES = {
  "credit sale":           { type: "Sale",     return: false, finalAmount: 1000,    received: 0,      balanceDue: 1000 },
  "fully-paid sale":       { type: "Sale",     return: false, finalAmount: 1000,    received: 1000,   balanceDue: 0 },
  "part-paid sale":        { type: "Sale",     return: false, finalAmount: 1000,    received: 400,    balanceDue: 600 },
  "credit purchase":       { type: "Purchase", return: false, finalAmount: 1000,    received: 0,      balanceDue: 1000 },
  "part-paid purchase":    { type: "Purchase", return: false, finalAmount: 1000,    received: 400,    balanceDue: 600 },
  "sale return, refunded": { type: "Sale",     return: true,  finalAmount: 500,     received: 500,    balanceDue: 0 },
  "sale return on credit": { type: "Sale",     return: true,  finalAmount: 500,     received: 0,      balanceDue: 500 },
  "purchase return":       { type: "Purchase", return: true,  finalAmount: 500,     received: 500,    balanceDue: 0 },
  "awkward paise":         { type: "Sale",     return: false, finalAmount: 1000.33, received: 333.33, balanceDue: 667 },
  "paid by cheque":        { type: "Sale",     return: false, finalAmount: 1000,    received: 1000,   balanceDue: 0, paymentType: "Cheque" },
};

for (const [label, shape] of Object.entries(SHAPES)) {
  test(`${label}`, () => {
    const db = shop();
    const start = snapshot(db);
    saveInvoice(db, inv({ customer: { name: "Party" }, ...shape }));
    assertReconciles(db, `${label} (after posting)`);
    deleteInvoice(db, 1);
    assert.equal(snapshot(db), start, `balances did not return to ${start}`);
    assert.equal(db.ledger.length, 0, `${db.ledger.length} ledger rows left behind`);
  });
}

/* ---- 2. the money goes where the payment type says ---------------------- */

console.log("\n--- a receipt settles through the right account ---");

test("cash stays in the till", () => {
  const db = shop();
  saveInvoice(db, inv({ customer: { name: "Party" }, paymentType: "Cash", finalAmount: 1000, received: 1000, balanceDue: 0 }));
  assert.equal(db.customers.get("Cash").lastBal, 1000);
  assert.equal(db.customers.get("HDFC Bank").lastBal, 0);
});

test("a cheque goes to the bank, not the till", () => {
  const db = shop();
  saveInvoice(db, inv({ customer: { name: "Party" }, paymentType: "Cheque", finalAmount: 1000, received: 1000, balanceDue: 0 }));
  assert.equal(db.customers.get("HDFC Bank").lastBal, 1000, "the bank should hold the cheque");
  assert.equal(db.customers.get("Cash").lastBal, 0, "nothing should have reached the till");
});

test("switching cash to cheque on an edit moves the money across", () => {
  const db = shop();
  const base = inv({ invoiceNo: 1, customer: { name: "Party" }, paymentType: "Cash", finalAmount: 1000, received: 1000, balanceDue: 0 });
  saveInvoice(db, base);
  alterInvoice(db, { ...base, originalInvoiceNo: 1, paymentType: "Cheque" });
  assert.equal(db.customers.get("Cash").lastBal, 0, "the till should have been emptied again");
  assert.equal(db.customers.get("HDFC Bank").lastBal, 1000);
  assertReconciles(db, "payment type switched");
});

/* ---- 3. a cash sale billed to the cash account itself ------------------- */

console.log("\n--- the awkward ones ---");

test("a sale billed to the cash account does not lose a leg", () => {
  const db = newDb();
  addAccount(db, "Cash", 0, "Cash");
  saveInvoice(db, inv({ customer: { name: "Cash" }, finalAmount: 1000, received: 1000, balanceDue: 0 }));
  // Document +1000, receipt -1000, cash +1000 -- all on one account.
  assert.equal(db.customers.get("Cash").lastBal, 1000);
  assertReconciles(db, "self-billed cash sale");
});

test("a client that sends a wrong balanceDue cannot create drift", () => {
  const db = shop();
  const start = snapshot(db);
  // final 1000, received 200 -> balanceDue must be 800. The client claims 900.
  saveInvoice(db, inv({ customer: { name: "Party" }, finalAmount: 1000, received: 200, balanceDue: 900 }));
  assert.equal(db.invoices.get(1).balanceDue, 800, "the server should have recomputed it");
  deleteInvoice(db, 1);
  assert.equal(snapshot(db), start, "deleting left a residue");
});

test("deleting an invoice leaves a receipt voucher against it alone", () => {
  const db = shop();
  saveInvoice(db, inv({ invoiceNo: 12, customer: { name: "Party" }, finalAmount: 1000, received: 0, balanceDue: 1000 }));
  const voucher = addVoucher(db, {
    acName: "Cash", date: "2026-04-10", paymentType: "Cash", againstBill: true, narration: "Received",
    customers: [{ name: "Party", debit: 0, credit: 1000, narration: "Against Invoice No: 12" }],
  });
  assert.equal(db.customers.get("Party").lastBal, 0, "the bill should be settled");

  deleteInvoice(db, 12);

  const survived = db.ledger.filter((r) => r.voucherId === voucher._id).length;
  assert.equal(survived, 2, "the voucher's own rows were eaten by the invoice delete");
  assertReconciles(db, "invoice deleted while a receipt voucher names it");
});

test("deleting invoice 12 does not touch 120 or 1200", () => {
  const db = shop();
  for (const n of [12, 120, 1200]) {
    saveInvoice(db, inv({ invoiceNo: n, customer: { name: "Party" }, finalAmount: 100, received: 0, balanceDue: 100 }));
  }
  deleteInvoice(db, 12);
  assert.equal(db.ledger.length, 2, "rows belonging to other invoices were removed");
  assertReconciles(db, "similar invoice numbers");
});

/* ---- 4. edits cancel exactly -------------------------------------------- */

console.log("\n--- editing ---");

test("changing the party, then changing it back", () => {
  const db = shop();
  addAccount(db, "Other Party", 0);
  const base = inv({ invoiceNo: 1, customer: { name: "Party" }, finalAmount: 1000, received: 400, balanceDue: 600 });
  saveInvoice(db, base);
  const afterCreate = snapshot(db);
  alterInvoice(db, { ...base, originalInvoiceNo: 1, customer: { name: "Other Party" }, finalAmount: 2500, received: 1000, balanceDue: 1500 });
  assertReconciles(db, "mid-edit");
  alterInvoice(db, { ...base, originalInvoiceNo: 1 });
  assert.equal(snapshot(db), afterCreate);
  assertReconciles(db, "edit reverted");
});

for (const [label, change] of Object.entries({
  "the amount":       { finalAmount: 2500, received: 1000, balanceDue: 1500 },
  "what was paid":    { finalAmount: 1000, received: 900,  balanceDue: 100 },
  "sale to purchase": { finalAmount: 1000, received: 400,  balanceDue: 600, type: "Purchase" },
  "into a return":    { finalAmount: 1000, received: 400,  balanceDue: 600, return: true },
  "the number":       { invoiceNo: 120 },
})) {
  test(`deleting after editing ${label} still clears the books`, () => {
    const db = shop();
    const start = snapshot(db);
    const base = inv({ invoiceNo: 12, customer: { name: "Party" }, finalAmount: 1000, received: 400, balanceDue: 600 });
    saveInvoice(db, base);
    const edited = alterInvoice(db, { ...base, originalInvoiceNo: 12, ...change });
    deleteInvoice(db, edited.invoiceNo);
    assert.equal(snapshot(db), start);
    assert.equal(db.ledger.length, 0);
  });
}

/* ---- 5. vouchers --------------------------------------------------------- */

console.log("\n--- vouchers ---");

test("a voucher nets to zero and unwinds cleanly", () => {
  const db = shop();
  addAccount(db, "Other Party", 0);
  const start = snapshot(db);
  const voucher = addVoucher(db, {
    acName: "Cash", date: "2026-04-05", paymentType: "Cash", narration: "n",
    customers: [{ name: "Party", debit: 0, credit: 500 }, { name: "Other Party", debit: 200, credit: 0 }],
  });
  const totalDr = round2(db.ledger.reduce((s, r) => s + (r.debit || 0), 0));
  const totalCr = round2(db.ledger.reduce((s, r) => s + (r.credit || 0), 0));
  assert.equal(totalDr, totalCr, "a voucher must balance");
  assertReconciles(db, "voucher posted");

  deleteVoucher(db, voucher._id);
  assert.equal(snapshot(db), start);
  assert.equal(db.ledger.length, 0);
});

test("editing a voucher and editing it back", () => {
  const db = shop();
  const voucher = addVoucher(db, {
    acName: "Cash", date: "2026-04-05", paymentType: "Cash", narration: "n",
    customers: [{ name: "Party", debit: 0, credit: 500 }],
  });
  const afterAdd = snapshot(db);
  alterVoucher(db, voucher._id, { acName: "Cash", date: "2026-04-05", paymentType: "Cash", narration: "n",
    customers: [{ name: "Party", debit: 0, credit: 900 }] });
  alterVoucher(db, voucher._id, { acName: "Cash", date: "2026-04-05", paymentType: "Cash", narration: "n",
    customers: [{ name: "Party", debit: 0, credit: 500 }] });
  assert.equal(snapshot(db), afterAdd);
  assertReconciles(db, "voucher edited back");
});

/* ---- 6. a whole trading day --------------------------------------------- */

console.log("\n--- a day's trading, reconciled ---");

test("opening balances, mixed documents, an edit and a receipt all reconcile", () => {
  const db = newDb();
  addAccount(db, "Party", 1500);
  addAccount(db, "Supplier", -2000);
  addAccount(db, "Cash", 3000, "Cash");
  addAccount(db, "HDFC Bank", 25000, "bank");

  saveInvoice(db, inv({ invoiceNo: 1, customer: { name: "Party" }, finalAmount: 1234.56, received: 234.56, balanceDue: 1000 }));
  saveInvoice(db, inv({ invoiceNo: 2, customer: { name: "Supplier" }, type: "Purchase", finalAmount: 999.99, received: 99.99, balanceDue: 900, paymentType: "Cheque" }));
  saveInvoice(db, inv({ invoiceNo: 3, customer: { name: "Party" }, return: true, finalAmount: 333.33, received: 0, balanceDue: 333.33 }));
  addVoucher(db, { acName: "HDFC Bank", date: "2026-05-01", paymentType: "Bank", narration: "part payment",
    customers: [{ name: "Party", debit: 0, credit: 777.77 }] });
  alterInvoice(db, { ...inv({ invoiceNo: 1, customer: { name: "Party" }, finalAmount: 1500, received: 234.56, balanceDue: 1265.44 }), originalInvoiceNo: 1 });

  assertReconciles(db, "a day's trading");
});

/* ---- 7. the tax on the printed invoice --------------------------------- */

console.log("\n--- GST splits ---");

test("SGST and CGST always add back up to the tax charged", () => {
  // Halving and rounding each side independently disagreed with the total on
  // half of all amounts, by a paisa -- on a document that has to foot.
  const offenders = [];
  for (let paise = 1; paise <= 200000; paise += 1) {
    const total = paise / 100;
    const { sgst, cgst } = splitGst(total);
    if (Math.abs(round2(sgst + cgst) - round2(total)) > 1e-9) offenders.push(total);
    if (offenders.length > 3) break;
  }
  assert.deepEqual(offenders, [], `these do not reconcile: ${offenders.join(", ")}`);
});

test("neither half is ever more than a paisa from the other", () => {
  for (const total of [0.01, 0.03, 45.01, 1234.57, 18.99]) {
    const { sgst, cgst } = splitGst(total);
    assert.ok(Math.abs(round2(cgst - sgst)) <= 0.01, `${total} split unevenly: ${sgst} / ${cgst}`);
  }
});

console.log(`\n  ${passed} checks passed\n`);
