/**
 * End-to-end check of the invoice and voucher posting routes.
 *
 * Unit tests cover the arithmetic; this drives the real HTTP routes against a
 * real database and then asserts on what actually landed in it. That is the
 * only way to catch the class of bug these fixes were about -- a route that
 * computes the right number and then fails to write it somewhere.
 *
 *   npm run dev                  # in another terminal
 *   node scripts/posting-e2e.mjs
 *
 * Creates its own fixtures, asserts, and deletes them again. Run it against a
 * scratch database, never real books.
 */

import assert from "node:assert/strict";
import mongoose from "mongoose";
import { loadEnv } from "./_shared.mjs";

const BASE = process.env.E2E_BASE || "http://localhost:3000";
const PARTY_A = "E2E Party A";
const PARTY_B = "E2E Party B";
const ITEM = "E2E Widget";
const RENAMED = "E2E Party A Renamed";
const INVOICE_NO = 990001;
const RENUMBERED = 990002;
const OTHER_INVOICE = 9900011; // shares a prefix with INVOICE_NO on purpose

loadEnv();

let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  }
};

const post = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

await mongoose.connect(process.env.MONGO_URI, { bufferCommands: false });
const db = mongoose.connection.db;

const customers = db.collection("customers");
const items = db.collection("items");
const invoices = db.collection("invoices");
const ledgers = db.collection("ledgers");
const itemledgers = db.collection("itemledgers");
const vouchers = db.collection("vouchers");

const balanceOf = async (name) =>
  (await customers.findOne({ name }))?.lastBal ?? null;
const rowsFor = async (invoiceNo) =>
  ledgers.find({ narration: new RegExp(`Invoice No:\\s*${invoiceNo}\\s*$`) }).toArray();
const stockFor = async (invoiceNo) =>
  itemledgers.find({ invoiceNo: String(invoiceNo) }).toArray();

const cleanup = async () => {
  await customers.deleteMany({ name: { $in: [PARTY_A, PARTY_B, RENAMED, "Cash"] } });
  await items.deleteMany({ name: ITEM });
  // Also match by party: the numbering test deliberately lets the server pick
  // a number, so it is not in the fixed list above.
  await invoices.deleteMany({
    $or: [
      { invoiceNo: { $in: [INVOICE_NO, RENUMBERED, OTHER_INVOICE] } },
      { "customer.name": { $in: [PARTY_A, PARTY_B, RENAMED] } },
    ],
  });
  await itemledgers.deleteMany({ itemName: ITEM });
  await itemledgers.deleteMany({
    invoiceNo: { $in: [INVOICE_NO, RENUMBERED, OTHER_INVOICE].map(String) },
  });
  await ledgers.deleteMany({ customerName: { $in: [PARTY_A, PARTY_B, RENAMED, "Cash"] } });
  await vouchers.deleteMany({ acName: "Cash" });
};

const seed = async () => {
  await cleanup();
  for (const name of [PARTY_A, PARTY_B]) {
    await customers.insertOne({
      name, group: "Sundry Debtors", openingBal: 0, openingMode: "Dr",
      lastBal: 0, lastMode: "Dr",
    });
  }
  await items.insertOne({ name: ITEM, openingQuantity: 0 });
};

const invoicePayload = (over = {}) => ({
  invoiceNo: INVOICE_NO,
  date: "2026-09-20",
  customer: { name: PARTY_A, phone: 0, email: "" },
  return: false,
  paymentType: "Cash",
  stateOfSupply: "Delhi",
  taxType: "local",
  gst: 0,
  totalAmount: 1000,
  finalAmount: 1000,
  received: 0,
  balanceDue: 1000,
  items: [{ name: ITEM, quantity: 10, cost: 100, discount: 0, total: 1000 }],
  partyTaxes: [],
  hsnTotals: [],
  type: "Sale",
  ...over,
});

console.log(`\ndriving ${BASE}\n`);
await seed();

console.log("--- a fully-paid sale reaches the books ---");

await test("posts the full value and books the cash", async () => {
  const res = await post("/api/save-invoice", invoicePayload({ received: 1000, balanceDue: 0 }));
  assert.equal(res.body.success, true, JSON.stringify(res.body));

  // Used to be invisible: balanceDue 0 meant a zero delta and no cash row.
  const rows = await rowsFor(INVOICE_NO);
  assert.equal(rows.length, 3, "document leg + both sides of the receipt");

  assert.equal(await balanceOf(PARTY_A), 0, "party nets to nil, as before");
  assert.equal(await balanceOf("Cash"), 1000, "and the money is in cash");

  const sale = rows.find((r) => r.account === "Sales Account");
  assert.equal(sale.debit, 1000, "the sale itself reaches the ledger in full");
});

await test("stock went out", async () => {
  const stock = await stockFor(INVOICE_NO);
  assert.equal(stock.length, 1);
  assert.equal(stock[0].issueQuantity, 10);
  assert.equal(stock[0].receiptQuantity, 0);
});

console.log("\n--- editing rewrites everything it should ---");

await test("changing the amount rewrites the ledger, not just the balance", async () => {
  const res = await post("/api/sale-alter", invoicePayload({
    originalInvoiceNo: INVOICE_NO, totalAmount: 600, finalAmount: 600,
    received: 600, balanceDue: 0,
    items: [{ name: ITEM, quantity: 6, cost: 100, discount: 0, total: 600 }],
  }));
  assert.equal(res.body.success, true, JSON.stringify(res.body));

  const rows = await rowsFor(INVOICE_NO);
  const sale = rows.find((r) => r.account === "Sales Account");
  assert.equal(sale.debit, 600, "ledger follows the edit (it never used to)");
  assert.equal(await balanceOf("Cash"), 600, "cash follows the edit too");
});

await test("changing the quantity rewrites the stock ledger", async () => {
  const stock = await stockFor(INVOICE_NO);
  assert.equal(stock.length, 1);
  assert.equal(stock[0].issueQuantity, 6, "stock used to keep the pre-edit figure");
});

await test("moving the invoice to another party reverses the first one", async () => {
  const res = await post("/api/sale-alter", invoicePayload({
    originalInvoiceNo: INVOICE_NO,
    customer: { name: PARTY_B, phone: 0, email: "" },
    totalAmount: 600, finalAmount: 600, received: 0, balanceDue: 600,
    items: [{ name: ITEM, quantity: 6, cost: 100, discount: 0, total: 600 }],
  }));
  assert.equal(res.body.success, true, JSON.stringify(res.body));

  // A used to keep the charge forever while B absorbed both sides.
  assert.equal(await balanceOf(PARTY_A), 0, "the original party is left clean");
  assert.equal(await balanceOf(PARTY_B), 600, "and the new one carries it");
});

console.log("\n--- renumbering does not eat another invoice ---");

await test("refuses to renumber onto an existing invoice", async () => {
  await post("/api/save-invoice", invoicePayload({
    invoiceNo: RENUMBERED, customer: { name: PARTY_A, phone: 0, email: "" },
    totalAmount: 50, finalAmount: 50, received: 0, balanceDue: 50,
    items: [{ name: ITEM, quantity: 1, cost: 50, discount: 0, total: 50 }],
  }));

  const res = await post("/api/sale-alter", invoicePayload({
    originalInvoiceNo: INVOICE_NO, invoiceNo: RENUMBERED,
    customer: { name: PARTY_B, phone: 0, email: "" },
    totalAmount: 600, finalAmount: 600, received: 0, balanceDue: 600,
  }));

  assert.equal(res.body.success, false, "used to silently overwrite the other invoice");

  const survivor = await invoices.findOne({ invoiceNo: RENUMBERED });
  assert.equal(survivor.finalAmount, 50, "the other invoice is untouched");
});

console.log("\n--- deleting cleans up only its own rows ---");

await test("a similar invoice number keeps its ledger rows", async () => {
  await post("/api/save-invoice", invoicePayload({
    invoiceNo: OTHER_INVOICE, customer: { name: PARTY_A, phone: 0, email: "" },
    totalAmount: 70, finalAmount: 70, received: 0, balanceDue: 70,
    items: [{ name: ITEM, quantity: 1, cost: 70, discount: 0, total: 70 }],
  }));

  // 990001 is a prefix of 9900011: the unanchored regex took both.
  await post(`/api/delete-invoice?id=${INVOICE_NO}`);

  const survivors = await rowsFor(OTHER_INVOICE);
  assert.equal(survivors.length, 1, "the longer number kept its row");
  assert.equal((await rowsFor(INVOICE_NO)).length, 0, "the deleted one lost its own");
});

await test("delete reverses the balance and the stock", async () => {
  assert.equal(await balanceOf(PARTY_B), 0, "party back to nil");
  assert.equal((await stockFor(INVOICE_NO)).length, 0, "stock rows gone");
});

console.log("\n--- returns move stock the right way ---");

await test("a sale return puts stock back", async () => {
  const res = await post("/api/save-invoice", invoicePayload({
    invoiceNo: INVOICE_NO, return: true,
    customer: { name: PARTY_A, phone: 0, email: "" },
    totalAmount: 200, finalAmount: 200, received: 0, balanceDue: 200,
    items: [{ name: ITEM, quantity: 2, cost: 100, discount: 0, total: 200 }],
  }));
  assert.equal(res.body.success, true, JSON.stringify(res.body));

  const stock = await stockFor(INVOICE_NO);
  assert.equal(stock[0].receiptQuantity, 2, "goods came back IN");
  assert.equal(stock[0].issueQuantity, 0, "it used to take them out again");
});

console.log("\n--- vouchers move the account they run through ---");

await test("a receipt moves the party and the cash account", async () => {
  const before = (await balanceOf("Cash")) ?? 0;

  const res = await post("/api/voucher-add", {
    acName: "Cash", date: "2026-09-20", againstBill: false, acType: "Cash",
    paymentType: "Cash", narration: "E2E receipt",
    customers: [{ name: PARTY_A, debit: 0, credit: 300, custId: "", narration: "" }],
  });
  assert.ok(res.status < 400, JSON.stringify(res.body));

  // Cash used to sit frozen while its ledger filled up.
  assert.equal(await balanceOf("Cash"), before + 300, "cash account moved");
});

await test("a voucher naming an unknown party is refused", async () => {
  const res = await post("/api/voucher-add", {
    acName: "Cash", date: "2026-09-20", againstBill: false, acType: "Cash",
    paymentType: "Cash", narration: "E2E bad name",
    customers: [{ name: "No Such Party", debit: 0, credit: 100, custId: "", narration: "" }],
  });
  assert.equal(res.status, 400, "used to write a row and move nothing");
});

console.log("\n--- master data does not corrupt the books ---");

await test("editing a customer leaves the running balance alone", async () => {
  const before = await balanceOf(PARTY_A);
  assert.ok(before !== 0, "fixture should have a balance to protect");

  const doc = await customers.findOne({ name: PARTY_A });
  const res = await post("/api/customer-alter", {
    id: String(doc._id), name: PARTY_A, phone: 999,
    openBal: 0, openingMode: "Dr",
    // The form's "Last Year Balance" field. It used to be written straight
    // into lastBal, so this line alone rewrote the running balance.
    lastBal: 12345, lastMode: "Dr",
  });
  assert.equal(res.body.success, true, JSON.stringify(res.body));

  assert.equal(await balanceOf(PARTY_A), before, "balance survived the edit");
  const after = await customers.findOne({ name: PARTY_A });
  assert.equal(after.lastYearBal, 12345, "and last year's figure was stored separately");
});

await test("correcting the opening balance shifts the running balance with it", async () => {
  const before = await balanceOf(PARTY_A);
  const doc = await customers.findOne({ name: PARTY_A });

  const res = await post("/api/customer-alter", {
    id: String(doc._id), name: PARTY_A,
    openBal: 500, openingMode: "Dr", lastBal: 0, lastMode: "Dr",
  });
  assert.equal(res.body.success, true, JSON.stringify(res.body));

  assert.equal(await balanceOf(PARTY_A), before + 500, "invariant kept");
});

await test("renaming a customer carries their history across", async () => {
  const doc = await customers.findOne({ name: PARTY_A });
  const rowsBefore = await ledgers.countDocuments({ customerName: PARTY_A });
  assert.ok(rowsBefore > 0, "fixture should have ledger rows to carry");

  const res = await post("/api/customer-alter", {
    id: String(doc._id), name: RENAMED,
    openBal: 500, openingMode: "Dr", lastBal: 0, lastMode: "Dr",
  });
  assert.equal(res.body.success, true, JSON.stringify(res.body));

  // Ledger rows key on the NAME, so this used to strand the whole history.
  assert.equal(await ledgers.countDocuments({ customerName: PARTY_A }), 0);
  assert.equal(await ledgers.countDocuments({ customerName: RENAMED }), rowsBefore);
  assert.equal(
    await invoices.countDocuments({ "customer.name": RENAMED }),
    await invoices.countDocuments({ "customer.name": RENAMED }),
    "invoices follow too"
  );
});

await test("renaming onto an existing customer is refused", async () => {
  const doc = await customers.findOne({ name: RENAMED });
  const res = await post("/api/customer-alter", {
    id: String(doc._id), name: PARTY_B,
    openBal: 0, openingMode: "Dr", lastBal: 0, lastMode: "Dr",
  });
  assert.equal(res.status, 409, "merging two parties' history is never intended");
});

await test("a customer with ledger history cannot be deleted", async () => {
  const doc = await customers.findOne({ name: RENAMED });
  const res = await post(`/api/delete-cust?id=${doc._id}`);
  assert.equal(res.status, 409, "vouchers and ledger rows are now checked too");
});

console.log("\n--- invoice numbering ---");

await test("a clash is reassigned instead of failing the save", async () => {
  // Ask for a number that is already taken; the old code let the unique index
  // reject the whole save and the user lost the invoice.
  const res = await post("/api/save-invoice", invoicePayload({
    invoiceNo: OTHER_INVOICE,
    customer: { name: PARTY_B, phone: 0, email: "" },
    totalAmount: 10, finalAmount: 10, received: 0, balanceDue: 10,
    items: [{ name: ITEM, quantity: 1, cost: 10, discount: 0, total: 10 }],
  }));

  assert.equal(res.body.success, true, JSON.stringify(res.body));
  assert.notEqual(res.body.invoice.invoiceNo, OTHER_INVOICE, "got a fresh number");
});

console.log("\n--- stored running figures ---");

await test("ledger rows carry a correct running balance", async () => {
  const doc = await customers.findOne({ name: PARTY_B });
  const rows = await ledgers
    .find({ customerName: PARTY_B })
    .sort({ date: 1, _id: 1 })
    .toArray();

  let running = doc.openingBal || 0;
  for (const row of rows) {
    running = Math.round((running + (row.debit || 0) - (row.credit || 0)) * 100) / 100;
    assert.equal(row.balance, running, "stored figure matches a fresh recompute");
  }
});

await cleanup();
await mongoose.disconnect();
console.log(`\n${passed} passed\n`);
