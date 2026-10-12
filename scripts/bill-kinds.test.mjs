/**
 * Reading ANY bill, not only purchases: sales, purchases and returns of both
 * (lib/invoiceImport.mjs resolveKind and the draft built from it), the route's
 * `kind` and re-draft path, and the upload page.
 *
 * Bare node: `node scripts/bill-kinds.test.mjs`.
 */

import assert from "node:assert/strict";
import fs from "node:fs";

import {
  AUTO_KIND,
  EXTRACTION_FIELD_NAMES,
  IMPORT_KINDS,
  MATCH_APPLIED,
  documentKindOf,
  draftFromExtraction,
  extractionPrompt,
  importParcel,
  importParcelVerdict,
  importWarnings,
  kindFrom,
  newMasters,
  ourSide,
  resolveKind,
} from "../lib/invoiceImport.mjs";
import { BILLING_TYPES } from "../lib/billingTypes.mjs";
import { limitFor } from "../lib/rateLimit.mjs";

let passed = 0;
const test = (name, fn) => {
  try {
    const result = fn();
    assert.equal(result, undefined, "this test body is async -- make it synchronous");
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    process.exitCode = 1;
    console.log(`  FAIL  ${name}\n        ${err.message.split("\n").join("\n        ")}`);
  }
};
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

const COMPANY = { name: "Shah Brothers", stateCode: "07", gstin: "07AAACS9999S1Z1" };

const PARTIES = [
  { _id: "s1", name: "Bharat Steel Corporation", group: "supplier", gstIn: "27AAACB2222B1Z6", stateCode: "27" },
  { _id: "c1", name: "Gupta Hardware", group: "customer", gstIn: "09AABCG1111G1Z2", stateCode: "09" },
  { _id: "c2", name: "Mehta Traders", group: "customer", stateCode: "07" },
];
const ITEMS = [{ _id: "i1", name: "MS Angle 50x50", hsn: "7216", unit: "KG", gst: 18 }];
const LINES = [{ name: "MS Angle 50x50", hsn: "7216", unit: "KG", quantity: "10", rate: "150", gstRate: "18" }];

/** Our own tax invoice, to a customer. */
const OUR_SALE = {
  documentKind: "Tax Invoice",
  supplierName: "Shah Brothers",
  supplierGstin: "07AAACS9999S1Z1",
  buyerName: "Gupta Hardware",
  buyerGstin: "09AABCG1111G1Z2",
  supplierInvoiceNo: "SB/112",
  date: "2026-10-05",
  lines: LINES,
};
/** A supplier's tax invoice, to us. */
const THEIR_BILL = {
  documentKind: "Invoice",
  supplierName: "Bharat Steel Corporation",
  supplierGstin: "27AAACB2222B1Z6",
  buyerName: "Shah Brothers",
  buyerGstin: "07AAACS9999S1Z1",
  supplierInvoiceNo: "BS/4417",
  lines: LINES,
};

const draft = (extraction, kind = AUTO_KIND, company = COMPANY) =>
  draftFromExtraction({ extraction, parties: PARTIES, items: ITEMS, company, kind });

/* ───────────────────────────── which side ────────────────────────────── */

console.log("\n--- which side of the bill is us ---");

test("by GSTIN first, on either side", () => {
  assert.deepEqual(ourSide(OUR_SALE, COMPANY), { side: "issuer", by: "gstin" });
  assert.deepEqual(ourSide(THEIR_BILL, COMPANY), { side: "addressee", by: "gstin" });
});

test("by name when no GSTIN is printed or the firm has none", () => {
  const noGstins = { supplierName: "SHAH BROTHERS ", buyerName: "Mehta Traders" };
  assert.deepEqual(ourSide(noGstins, COMPANY), { side: "issuer", by: "name" });
  assert.deepEqual(ourSide(THEIR_BILL, { name: "Shah Brothers" }), { side: "addressee", by: "name" });
});

test("a near-miss of our own name is NOT us (it would turn a purchase into a sale)", () => {
  assert.equal(ourSide({ supplierName: "Shah Brother", buyerName: "" }, { name: "Shah Brothers" }), null);
  assert.equal(ourSide({ supplierName: "Shah Steels", buyerName: "" }, { name: "Shah Brothers" }), null);
});

test("the legal name a GST bill prints counts as us too", () => {
  const firm = { name: "Shah Bros", legalName: "Shah Brothers Private Limited" };
  assert.deepEqual(ourSide({ supplierName: "Bharat Steel", buyerName: "Shah Brothers Private Limited" }, firm), {
    side: "addressee",
    by: "name",
  });
});

test("not on the bill, or on both sides: no answer", () => {
  assert.equal(ourSide({ supplierName: "A", buyerName: "B" }, COMPANY), null);
  assert.equal(ourSide({ supplierName: "Shah Brothers", buyerName: "Shah Brothers" }, { name: "Shah Brothers" }), null);
  assert.equal(ourSide(OUR_SALE, null), null);
});

test("what a document calls itself", () => {
  assert.equal(documentKindOf("TAX INVOICE"), "invoice");
  assert.equal(documentKindOf("Cash Memo"), "invoice");
  assert.equal(documentKindOf("Bill of Supply"), "invoice");
  assert.equal(documentKindOf("Credit Note"), "credit note");
  assert.equal(documentKindOf("debit note"), "debit note");
  assert.equal(documentKindOf(""), "");
  assert.equal(documentKindOf("Estimate"), "");
});

test("the kind table: invoice, credit note and debit note, from either side", () => {
  assert.equal(kindFrom("invoice", "issuer"), "sale");
  assert.equal(kindFrom("invoice", "addressee"), "purchase");
  assert.equal(kindFrom("", "addressee"), "purchase", "unnamed is an invoice");
  assert.equal(kindFrom("credit note", "issuer"), "salereturn");
  assert.equal(kindFrom("credit note", "addressee"), "purchasereturn");
  // A debit note is a supplier's price rise under GST or a buyer's return
  // in trade -- opposite postings -- so it is never guessed.
  assert.equal(kindFrom("debit note", "issuer"), null);
  assert.equal(kindFrom("debit note", "addressee"), null);
  assert.equal(kindFrom("invoice", null), null);
});

test("every kind is one of the four billing screens", () => {
  assert.deepEqual([...IMPORT_KINDS].sort(), Object.keys(BILLING_TYPES).sort());
});

/* ──────────────────────────── each kind ──────────────────────────────── */

console.log("\n--- a sale bill ---");

const sale = draft(OUR_SALE);

test("our own invoice is a sale, for the sale screen", () => {
  assert.equal(sale.kind, "sale");
  assert.equal(sale.kindDetectedBy, "gstin");
  assert.deepEqual(sale.target, { type: "Sale", isReturn: false });
  assert.equal(sale.route, BILLING_TYPES.sale.route);
});

test("the party is the CUSTOMER it is addressed to, matched by GSTIN", () => {
  assert.equal(sale.partySide, "addressee");
  assert.equal(sale.partyRole, "customer");
  assert.equal(sale.party.how, MATCH_APPLIED);
  assert.equal(sale.party.by, "gstin");
  assert.equal(sale.party.name, "Gupta Hardware");
});

test("the bill's number is ours, so it is not put in as the party's", () => {
  assert.equal(sale.partyBillNo, "");
  assert.equal(sale.printedNo, "SB/112");
  const w = importWarnings(sale).find((x) => x.field === "printedNo");
  assert.ok(w && w.severity === "check" && /SB\/112/.test(w.message));
  assert.ok(!importWarnings(sale).some((x) => x.field === "partyBillNo"));
});

test("IGST from our state (07) to the customer's (09)", () => {
  assert.equal(sale.taxType, "central");
  const local = draft({ ...OUR_SALE, buyerName: "Mehta Traders", buyerGstin: "" });
  assert.equal(local.party.name, "Mehta Traders");
  assert.equal(local.taxType, "local", "a customer without a GSTIN takes their master's state");
});

test("a new customer is proposed as a customer, and its items seed the SALE price", () => {
  const fresh = draft({ ...OUR_SALE, buyerName: "Naya Grahak", buyerGstin: "", lines: [{ ...LINES[0], name: "Brand New Item" }] });
  assert.equal(fresh.party.proposed.group, "customer");
  assert.equal(fresh.party.proposed.name, "Naya Grahak");
  const masters = newMasters(fresh);
  assert.deepEqual(masters.customers, [fresh.party.proposed]);
  assert.deepEqual(masters.suppliers, []);
  assert.equal(masters.items[0].salePrice, 150);
  assert.equal("purchasePrice" in masters.items[0], false);
  assert.match(importWarnings(fresh).find((w) => w.field === "party").message, /Create the customer/);
});

console.log("\n--- a purchase bill, as before ---");

const purchase = draft(THEIR_BILL);

test("a supplier's invoice to us is a purchase, party the issuer, their number kept", () => {
  assert.equal(purchase.kind, "purchase");
  assert.equal(purchase.partySide, "issuer");
  assert.equal(purchase.party.name, "Bharat Steel Corporation");
  assert.equal(purchase.partyBillNo, "BS/4417");
  assert.equal(purchase.route, "/purchaseadd");
  assert.equal(purchase.taxType, "central");
});

test("a draft built with no kind is still a purchase (the old callers)", () => {
  const old = draftFromExtraction({ extraction: THEIR_BILL, parties: PARTIES, items: ITEMS, company: {} });
  assert.equal(old.kind, "purchase");
  assert.equal(old.party.name, "Bharat Steel Corporation");
});

console.log("\n--- returns ---");

test("our credit note is a sale return, to the customer", () => {
  const d = draft({ ...OUR_SALE, documentKind: "Credit Note" });
  assert.equal(d.kind, "salereturn");
  assert.equal(d.route, "/salereturn");
  assert.equal(d.party.name, "Gupta Hardware");
  assert.deepEqual(d.target, { type: "Sale", isReturn: true });
});

test("a supplier's credit note to us is a purchase return, their number kept", () => {
  const d = draft({ ...THEIR_BILL, documentKind: "Credit Note", supplierInvoiceNo: "CN/7" });
  assert.equal(d.kind, "purchasereturn");
  assert.equal(d.party.name, "Bharat Steel Corporation");
  assert.equal(d.partyBillNo, "CN/7");
  assert.deepEqual(d.target, { type: "Purchase", isReturn: true });
});

const OUR_DEBIT_NOTE = {
  documentKind: "Debit Note",
  supplierName: "Shah Brothers",
  supplierGstin: COMPANY.gstin,
  buyerName: "Bharat Steel Corporation",
  buyerGstin: "27AAACB2222B1Z6",
  lines: LINES,
};

test("a debit note is not guessed: the person is asked, and told why", () => {
  const d = draft(OUR_DEBIT_NOTE);
  assert.equal(d.kind, null);
  const w = importWarnings(d).find((x) => x.field === "kind");
  assert.equal(w.severity, "blocking");
  assert.match(w.message, /debit note/);
});

test("our debit note, chosen as a purchase return: the party is the supplier it is addressed to", () => {
  const d = draft(OUR_DEBIT_NOTE, "purchasereturn");
  assert.equal(d.kind, "purchasereturn");
  assert.equal(d.partySide, "addressee");
  assert.equal(d.party.name, "Bharat Steel Corporation");
  assert.equal(d.party.proposed, null);
});

test("a customer's debit note to us, chosen as a sale return, when we are not found: the party is the issuer", () => {
  const d = draft(
    { documentKind: "Debit Note", supplierName: "Gupta Hardware", buyerName: "Shah Bros (unreadable)", lines: LINES },
    "salereturn",
    { name: "Shah Brothers" }
  );
  assert.equal(d.partySide, "issuer");
  assert.equal(d.party.name, "Gupta Hardware");
});

test("a party whose account is on the other side is flagged", () => {
  // Bharat Steel is a supplier; chosen as a sale, the bill also says it is a
  // purchase -- and the party's group disagrees with the kind.
  const asSale = draft({ ...OUR_SALE, buyerName: "Bharat Steel Corporation", buyerGstin: "27AAACB2222B1Z6" });
  assert.equal(asSale.kind, "sale");
  assert.equal(asSale.party.groupMismatch, true);
  const w = importWarnings(asSale).find((x) => x.field === "party");
  assert.equal(w.severity, "check");
  assert.match(w.message, /as a supplier, but this is a sale/);
  assert.equal(sale.party.groupMismatch, false);
});

test("a reading is capped: long text and endless rows are cut", () => {
  const d = draft({ ...OUR_SALE, buyerName: "x".repeat(5000), lines: Array.from({ length: 1000 }, () => LINES[0]) });
  assert.ok(d.read.buyerName.length <= 200);
  assert.ok(d.lines.length <= 300);
});

/* ───────────────────────── chosen, or unknown ────────────────────────── */

console.log("\n--- when the person chooses, or nobody can tell ---");

const unknown = { supplierName: "Some Shop", buyerName: "Gupta Hardware", lines: LINES };

test("auto with no way to tell: no kind, no screen, and one question", () => {
  const d = draft(unknown, AUTO_KIND, { name: "Shah Brothers" });
  assert.equal(d.kind, null);
  assert.equal(d.target, null);
  assert.equal(d.route, "");
  const warnings = importWarnings(d);
  assert.equal(warnings[0].field, "kind");
  assert.equal(warnings[0].severity, "blocking");
  assert.ok(!warnings.some((w) => w.field === "party"), "no party question before the kind is known");
  assert.deepEqual(newMasters(d), { suppliers: [], customers: [], items: [] });
});

test("a chosen kind is used, with the usual layout for whose bill it is", () => {
  const asSale = draft(unknown, "sale", { name: "Shah Brothers" });
  assert.equal(asSale.kind, "sale");
  assert.equal(asSale.party.name, "Gupta Hardware", "a sale is addressed to the customer");
  const asPurchase = draft(unknown, "purchase", { name: "Shah Brothers" });
  assert.equal(asPurchase.partySide, "issuer");
  assert.equal(asPurchase.party.read.name, "Some Shop");
});

test("a choice that disagrees with the bill is kept and reported", () => {
  const d = draft(THEIR_BILL, "sale");
  assert.equal(d.kind, "sale");
  assert.equal(d.kindConflict, true);
  assert.equal(d.kindDetected, "purchase");
  // The party is still whoever is NOT us -- the bill's facts do not change.
  assert.equal(d.party.name, "Bharat Steel Corporation");
  const w = importWarnings(d).find((x) => x.field === "kind");
  assert.equal(w.severity, "check");
  assert.match(w.message, /reads like a purchase/);
});

test("an unknown kind is treated as auto, never as a sale", () => {
  assert.equal(resolveKind({ read: unknown, company: {}, chosen: "sales" }).kind, null);
  assert.equal(resolveKind({ read: unknown, company: {}, chosen: "sales" }).chosen, AUTO_KIND);
});

/* ─────────────────────────── the hand-off ────────────────────────────── */

console.log("\n--- the draft lands on its own screen ---");

const scope = { companyId: "f1", user: "a@b.in" };

test("the parcel names the sale screen, and only it accepts the draft", () => {
  const parcel = importParcel({ draft: sale, warnings: [], newMasters: {} }, scope);
  assert.deepEqual(parcel.target, { type: "Sale", isReturn: false });
  assert.equal(importParcelVerdict(parcel, { type: "Sale", isReturn: false, scope }), "ok");
  assert.equal(importParcelVerdict(parcel, { type: "Purchase", isReturn: false, scope }), "wrong-screen");
  assert.equal(importParcelVerdict(parcel, { type: "Sale", isReturn: true, scope }), "wrong-screen");
});

test("a parcel from before kinds still opens on the purchase screen", () => {
  const { target, route, ...old } = purchase;
  void target;
  void route;
  const parcel = importParcel({ draft: old }, scope);
  assert.deepEqual(parcel.target, { type: "Purchase", isReturn: false });
});

/* ─────────────────────────── what is asked ───────────────────────────── */

console.log("\n--- the prompt ---");

test("the model reads both parties and the document's own name, and is not told it is a purchase", () => {
  for (const name of ["documentKind", "buyerName", "buyerGstin", "buyerPhone", "buyerAddress", "buyerState"]) {
    assert.ok(EXTRACTION_FIELD_NAMES.includes(name), name);
  }
  const prompt = extractionPrompt();
  assert.doesNotMatch(prompt, /PURCHASE BILL/);
  assert.match(prompt, /issued BY the business reading it \(a sale\) or TO it \(a purchase\)/);
  assert.match(prompt, /do not swap them/);
});

/* ───────────────────────────── the wiring ────────────────────────────── */

console.log("\n--- the route and the page ---");

const route = code(read("../app/api/invoice-extract/route.js"));
const page = code(read("../app/upload/page.js"));

test("the route checks the kind it is given", () => {
  assert.match(route, /kind !== AUTO_KIND && !IMPORT_KINDS\.includes\(kind\)/);
  assert.match(route, /draftFromExtraction\(\{ extraction, parties, items, company, kind \}\)/);
});

test("changing the kind re-drafts without reading the photo again", () => {
  const redraft = route.indexOf("if (body?.extraction && !body?.data)");
  const model = route.indexOf("await readBill(");
  assert.ok(redraft > 0 && redraft < model, "the re-draft returns before any model call");
  assert.match(route, /extraction\.lines\.length > MAX_LINES/);
});

test("each photo read is capped per firm, before the paid call", () => {
  const cap = route.indexOf('hitRateLimit("bill-read-firm"');
  assert.ok(cap > 0 && cap < route.indexOf("await readBill("));
  assert.ok(limitFor("bill-read-firm").limit > 0);
});

test("the billing screen takes the tax type the draft worked out, and only that", () => {
  const screen = code(read("../components/billing/BillingScreen.jsx"));
  assert.match(screen, /if \(draft\.taxType === 'local' \|\| draft\.taxType === 'central'\) setTaxType\(draft\.taxType\)/);
});

test("a re-draft checks it is still the same firm and user", () => {
  const body = page.slice(page.indexOf("const redraft = async"), page.indexOf("const openInForm"));
  assert.match(body, /await whoAmI\(\)/);
  assert.match(body, /scope\.companyId !== readBy\.companyId/);
});

test("the page sends the kind, re-drafts on a change, and opens the draft's own screen", () => {
  assert.match(page, /JSON\.stringify\(\{ data: await toBase64\(scaled\), name: file\.name, kind \}\)/);
  assert.match(page, /JSON\.stringify\(\{ extraction: result\.draft\.read, kind: nextKind \}\)/);
  assert.match(page, /router\.push\(`\$\{result\.draft\.route\}\?import=1`\)/);
  assert.match(page, /disabled=\{!draft\.kind \|\| redrafting\}/);
});

test("every route a draft can carry is one of the four billing screens", () => {
  const routes = new Set(Object.values(BILLING_TYPES).map((t) => t.route));
  for (const d of [sale, purchase, draft({ ...OUR_SALE, documentKind: "Credit Note" })]) {
    assert.ok(routes.has(d.route), d.route);
  }
});

console.log(`\n  ${passed} checks passed\n`);
