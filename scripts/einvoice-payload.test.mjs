/**
 * Fixture tests for the INV-01 payload.
 *
 *   node scripts/einvoice-payload.test.mjs
 *
 * This is the file where e-invoicing actually goes wrong, so the tests are
 * organised around what the IRP rejects rather than around the functions:
 *
 *   - totals that do not reconcile, to the paisa, line by line and overall
 *   - IGST and CGST/SGST on the same line
 *   - a date that is not dd/mm/yyyy, or is in the future
 *   - a state code that lost its leading zero, or a PIN sent as a string
 *   - a filing that should never have been attempted: a purchase, a B2C sale,
 *     an invoice already reported
 *
 * A rejected filing comes back as a number, not a sentence, so everything that
 * can be caught here has to be caught here.
 */

import assert from "node:assert/strict";
import {
  INV01_VERSION,
  RECONCILE_TOLERANCE,
  buildEinvoicePayload,
  buildLine,
  otherCharges,
  payloadProblems,
  reconcile,
} from "../lib/einvoicePayload.mjs";
import { round2 } from "../lib/balance.mjs";

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

const NOW = Date.parse("2026-10-08T12:00:00Z");

const COMPANY = {
  name: "Suryavansh Textiles",
  gstin: "07ABCDE1234F1Z5",
  address: "LIG Flats No. 68, Sarita Vihar",
  city: "New Delhi",
  state: "Delhi",
  stateCode: "07",
  pincode: "110076",
};

const BUYER = {
  name: "Sharma Traders",
  gstin: "03AABBC1234D1Z5",
  address: "12 Main Bazaar",
  city: "Ludhiana",
  pincode: "141001",
  stateCode: "03",
};

/** A clean one-line local sale: 15 shirts at 450, 18% GST. */
const invoiceOf = (over = {}) => ({
  invoiceNo: 42,
  date: "2026-10-08",
  type: "Sale",
  return: false,
  taxType: "local",
  customer: { ...BUYER, stateCode: "07", pincode: "110006", city: "New Delhi" },
  items: [
    { name: "Cotton Shirt", hsn: "6205", quantity: 15, cost: 450, discount: 0, gstRate: 18, uqc: "PCS" },
  ],
  freight: "",
  partyTaxes: [],
  finalAmount: 7965,
  ...over,
});

const build = (over = {}, company = COMPANY) =>
  buildEinvoicePayload({ invoice: invoiceOf(over), company, now: NOW });

/** Every reconciliation rule the IRP applies, asserted on a built payload. */
const assertReconciles = (payload, label = "") => {
  for (const line of payload.ItemList) {
    assert.equal(
      line.TotItemVal,
      round2(line.AssAmt + line.CgstAmt + line.SgstAmt + line.IgstAmt),
      `${label} line ${line.SlNo}: TotItemVal does not equal AssAmt + taxes`
    );
    assert.equal(line.AssAmt, round2(line.TotAmt - line.Discount), `${label} line ${line.SlNo}: AssAmt`);
    assert.ok(
      line.IgstAmt === 0 || (line.CgstAmt === 0 && line.SgstAmt === 0),
      `${label} line ${line.SlNo} carries both IGST and CGST/SGST`
    );
  }
  const v = payload.ValDtls;
  const lines = round2(payload.ItemList.reduce((s, l) => s + l.TotItemVal, 0));
  assert.equal(
    round2(lines + v.OthChrg + v.RndOffAmt),
    v.TotInvVal,
    `${label} the grand total does not reconcile`
  );
  assert.equal(v.AssVal, round2(payload.ItemList.reduce((s, l) => s + l.AssAmt, 0)), `${label} AssVal`);
  assert.equal(v.CgstVal, round2(payload.ItemList.reduce((s, l) => s + l.CgstAmt, 0)), `${label} CgstVal`);
  assert.equal(v.SgstVal, round2(payload.ItemList.reduce((s, l) => s + l.SgstAmt, 0)), `${label} SgstVal`);
  assert.equal(v.IgstVal, round2(payload.ItemList.reduce((s, l) => s + l.IgstAmt, 0)), `${label} IgstVal`);
  assert.ok(Math.abs(v.RndOffAmt) <= RECONCILE_TOLERANCE, `${label} the rounding adjustment is too big`);
};

console.log("\n--- a clean sale ---");

test("a local sale produces the payload the IRP documents", () => {
  const { payload, problems } = build();
  assert.deepEqual(problems, []);
  // The literal, not the constant: asserting a constant against itself proves
  // nothing, and the IRP rejects a version it does not recognise.
  assert.equal(payload.Version, "1.1");
  assert.equal(INV01_VERSION, "1.1");
  assert.deepEqual(payload.TranDtls, { TaxSch: "GST", SupTyp: "B2B", RegRev: "N", IgstOnIntra: "N" });
  assert.deepEqual(payload.DocDtls, { Typ: "INV", No: "42", Dt: "08/10/2026" });
  assert.equal(payload.ItemList.length, 1);
  assertReconciles(payload);
});

test("the seller and buyer blocks carry what the IRP asks for", () => {
  const { payload } = build();
  assert.deepEqual(payload.SellerDtls, {
    Gstin: "07ABCDE1234F1Z5",
    LglNm: "Suryavansh Textiles",
    Addr1: "LIG Flats No. 68, Sarita Vihar",
    Loc: "New Delhi",
    Pin: 110076,
    Stcd: "07",
  });
  assert.equal(payload.BuyerDtls.Gstin, "03AABBC1234D1Z5");
  assert.equal(payload.BuyerDtls.Pos, "07");
});

test("a GSTIN typed in lower case is sent upper case", () => {
  // The profile form normalises it, but this module is handed whatever the
  // route read, and the IRP matches the string exactly.
  const { payload } = build(
    { customer: { ...BUYER, gstin: "03aabbc1234d1z5", stateCode: "07", pincode: "110006" } },
    { ...COMPANY, gstin: "07abcde1234f1z5" }
  );
  assert.equal(payload.SellerDtls.Gstin, "07ABCDE1234F1Z5");
  assert.equal(payload.BuyerDtls.Gstin, "03AABBC1234D1Z5");
});

test("Pin is a number and Stcd a string that keeps its zero", () => {
  const { payload } = build();
  assert.equal(typeof payload.SellerDtls.Pin, "number");
  assert.equal(typeof payload.BuyerDtls.Pin, "number");
  assert.equal(payload.SellerDtls.Stcd, "07", "Delhi must not become 7");
  assert.equal(typeof payload.SellerDtls.Stcd, "string");
  assert.equal(typeof payload.BuyerDtls.Stcd, "string");
});

test("the line is built from quantity, rate and a percentage discount", () => {
  const [line] = build().payload.ItemList;
  assert.equal(line.SlNo, "1");
  assert.equal(line.HsnCd, "6205");
  assert.equal(line.Qty, 15);
  assert.equal(line.Unit, "PCS");
  assert.equal(line.UnitPrice, 450);
  assert.equal(line.TotAmt, 6750);
  assert.equal(line.AssAmt, 6750);
  assert.equal(line.GstRt, 18);
  assert.equal(line.TotItemVal, 7965);
});

test("a discount is read as a percentage, as it is everywhere else here", () => {
  const { payload } = build({
    items: [{ name: "x", hsn: "6205", quantity: 10, cost: 100, discount: 10, gstRate: 18, uqc: "PCS" }],
    finalAmount: 1062,
  });
  const [line] = payload.ItemList;
  assert.equal(line.TotAmt, 1000, "TotAmt is before the discount");
  assert.equal(line.Discount, 100, "10% of 1000");
  assert.equal(line.AssAmt, 900);
  assert.equal(line.TotItemVal, 1062);
  assertReconciles(payload);
});

console.log("\n--- local splits, central does not ---");

test("a local supply splits the tax in two and leaves IGST at zero", () => {
  const { payload } = build();
  const [line] = payload.ItemList;
  assert.equal(line.CgstAmt, 607.5);
  assert.equal(line.SgstAmt, 607.5);
  assert.equal(line.IgstAmt, 0);
  assert.equal(payload.ValDtls.IgstVal, 0);
});

test("a central supply is IGST only", () => {
  const { payload } = build({ taxType: "central", customer: BUYER, finalAmount: 7965 });
  const [line] = payload.ItemList;
  assert.equal(line.IgstAmt, 1215);
  assert.equal(line.CgstAmt, 0);
  assert.equal(line.SgstAmt, 0);
  assert.equal(payload.ValDtls.CgstVal, 0);
  assert.equal(payload.ValDtls.SgstVal, 0);
  assertReconciles(payload);
});

test("an odd paisa of tax is carried once, not twice", () => {
  // The whole reason splitGst() exists: (tax/2).toFixed(2) printed twice
  // leaves the halves disagreeing with the tax by a paisa, and the IRP adds
  // them up.
  const { payload } = build({
    items: [{ name: "x", hsn: "6205", quantity: 1, cost: 105.05, discount: 0, gstRate: 5, uqc: "PCS" }],
    finalAmount: 110.3,
  });
  const [line] = payload.ItemList;
  assert.equal(round2(line.CgstAmt + line.SgstAmt), round2((line.AssAmt * line.GstRt) / 100));
  assert.notEqual(line.CgstAmt, line.SgstAmt, "the odd paisa has to land on one side");
  assertReconciles(payload);
});

console.log("\n--- it has to add up ---");

test("freight stored as a string still reaches other charges", () => {
  assert.equal(otherCharges({ freight: "500" }), 500);
  assert.equal(otherCharges({ freight: "1,250" }), 1250);
  assert.equal(otherCharges({ freight: "" }), 0);
  assert.equal(otherCharges({ freight: null }), 0);
  assert.equal(otherCharges({ freight: "not a number" }), 0);
  const { payload } = build({ freight: "500", finalAmount: 8465 });
  assert.equal(payload.ValDtls.OthChrg, 500);
  assertReconciles(payload);
});

test("party taxes land in other charges too", () => {
  assert.equal(otherCharges({ partyTaxes: [{ name: "Labour", total: "250" }, { total: 100 }] }), 350);
  const { payload } = build({
    partyTaxes: [{ name: "Labour", total: "250" }],
    finalAmount: 8215,
  });
  assert.equal(payload.ValDtls.OthChrg, 250);
  assertReconciles(payload);
});

test("a rounded-off bill reconciles through RndOffAmt", () => {
  const { payload, problems } = build({ finalAmount: 7965.4 });
  assert.deepEqual(problems, []);
  assert.equal(payload.ValDtls.RndOffAmt, 0.4);
  assertReconciles(payload);
});

test("a bill that is out by more than a rupee is refused, not papered over", () => {
  const { payload, problems } = build({ finalAmount: 7900 });
  assert.equal(payload, null);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /does not add up/);
  assert.match(problems[0], /7965\.00/);
  assert.match(problems[0], /7900\.00/);
});

test("thirty lines of awkward figures still reconcile exactly", () => {
  // Float drift: thirty lines of 33.33 at 18% is where a naive sum stops
  // matching the total by a paisa, which the IRP does notice.
  const items = Array.from({ length: 30 }, (_, i) => ({
    name: `Item ${i + 1}`,
    hsn: "6205",
    quantity: 3,
    cost: 33.33,
    discount: 0,
    gstRate: 18,
    uqc: "PCS",
  }));
  const expected = round2(
    reconcile({ invoice: { ...invoiceOf({ items }), finalAmount: 0 } }).lineTotal
  );
  const { payload, problems } = build({ items, finalAmount: expected });
  assert.deepEqual(problems, []);
  assert.equal(payload.ItemList.length, 30);
  assert.equal(payload.ValDtls.RndOffAmt, 0);
  assertReconciles(payload, "30 lines:");
});

console.log("\n--- filings that should not be attempted ---");

test("a purchase is the supplier's filing, not ours", () => {
  const { payload, problems } = build({ type: "Purchase" });
  assert.equal(payload, null);
  assert.ok(problems.some((p) => /purchase/i.test(p)));
});

test("a buyer with no GSTIN is B2C and is not reported", () => {
  const { payload, problems } = build({
    customer: { name: "Walk-in customer", phone: "9811122233" },
  });
  assert.equal(payload, null);
  assert.ok(problems.some((p) => /B2C/.test(p)));
  assert.ok(problems.some((p) => /Walk-in customer/.test(p)));
});

test("a B2B buyer missing an address is named, field by field", () => {
  const { problems } = build({ customer: { ...BUYER, pincode: "", address: "" } });
  assert.ok(problems.some((p) => /address/.test(p) && /PIN code/.test(p)), problems.join(" | "));
});

test("an invoice already reported is refused", () => {
  const { payload, problems } = build({
    irn: "f".repeat(64),
    ackDt: "2026-10-08T06:00:00.000Z",
    einvoiceStatus: "generated",
  });
  assert.equal(payload, null);
  assert.ok(problems.some((p) => /reported to the IRP/.test(p)));
});

test("a cancelled e-invoice may be reported again", () => {
  const { payload, problems } = build({
    irn: "f".repeat(64),
    ackDt: "2026-10-08T06:00:00.000Z",
    einvoiceStatus: "cancelled",
  });
  assert.deepEqual(problems, []);
  assert.ok(payload);
});

test("our own profile has to be complete first", () => {
  const { payload, problems } = build({}, { ...COMPANY, gstin: "", pincode: "" });
  assert.equal(payload, null);
  assert.ok(problems.some((p) => /business profile/.test(p)));
  assert.ok(problems.some((p) => /GSTIN/.test(p) && /PIN code/.test(p)));
});

test("a future-dated invoice is refused", () => {
  assert.ok(build({ date: "2026-10-09" }).problems.some((p) => /future/.test(p)));
  assert.deepEqual(build({ date: "2026-10-08" }).problems, [], "today is fine");
  assert.deepEqual(build({ date: "2026-09-30" }).problems, [], "last week is fine");
  // Saved at 1am in Delhi, which is still the previous day in UTC. Comparing
  // the two instants would call this one tomorrow's invoice; comparing the
  // Indian calendar day, which is what the IRP does, calls it today's.
  assert.deepEqual(build({ date: "2026-10-07T19:30:00.000Z" }).problems, []);
  // And the comparison is by day, not by instant: a bill dated today is not
  // "future" because the hour on it has not come round yet.
  assert.deepEqual(build({ date: "2026-10-08T17:00:00.000Z" }).problems, []);
});

test("a line with no HSN code is named", () => {
  const { problems } = build({
    items: [{ name: "Mystery goods", quantity: 1, cost: 100, gstRate: 18, uqc: "PCS" }],
    finalAmount: 118,
  });
  assert.ok(problems.some((p) => /Line 1 \(Mystery goods\) has no HSN/.test(p)), problems.join(" | "));
});

test("a line with no quantity is named", () => {
  const { problems } = build({
    items: [{ name: "Ghost", hsn: "6205", quantity: 0, cost: 100, gstRate: 18 }],
    finalAmount: 0,
  });
  assert.ok(problems.some((p) => /Ghost\) has no quantity/.test(p)), problems.join(" | "));
});

test("an invoice with no items at all is refused", () => {
  assert.ok(build({ items: [], finalAmount: 0 }).problems.some((p) => /no items/.test(p)));
});

test("an invoice number the IRP will not take is refused", () => {
  assert.ok(build({ invoiceNo: "" }).problems.some((p) => /no number/.test(p)));
  assert.ok(build({ invoiceNo: "INV 42" }).problems.some((p) => /not one the IRP accepts/.test(p)));
  assert.ok(build({ invoiceNo: "INV#42" }).problems.some((p) => /not one the IRP accepts/.test(p)));
  assert.ok(build({ invoiceNo: "1".repeat(17) }).problems.some((p) => /not one the IRP accepts/.test(p)));
  assert.ok(build({ invoiceNo: "0042" }).problems.some((p) => /cannot start with "0"/.test(p)));
  assert.ok(build({ invoiceNo: "-42" }).problems.some((p) => /cannot start with "-"/.test(p)));
  // These are fine.
  assert.deepEqual(build({ invoiceNo: "INV/2026/42" }).problems, []);
  assert.deepEqual(build({ invoiceNo: 42 }).problems, []);
});

test("there is no invoice at all", () => {
  const { payload, problems } = buildEinvoicePayload({ company: COMPANY });
  assert.equal(payload, null);
  assert.deepEqual(problems, ["There is no invoice to report."]);
  assert.deepEqual(payloadProblems(), ["There is no invoice to report."]);
});

test("every problem is a sentence a shopkeeper can act on", () => {
  const { problems } = build({ type: "Purchase", customer: { name: "Walk-in" }, items: [] }, {});
  assert.ok(problems.length >= 3);
  for (const p of problems) {
    assert.equal(typeof p, "string");
    assert.ok(p.length > 20, `"${p}" is too terse to act on`);
    assert.doesNotMatch(p, /undefined|NaN|\[object/);
  }
});

console.log("\n--- the document's own details ---");

test("a sale return is filed as a credit note", () => {
  const { payload } = build({ return: true });
  assert.equal(payload.DocDtls.Typ, "CRN");
  assert.equal(build().payload.DocDtls.Typ, "INV");
});

test("the date is dd/mm/yyyy, with its leading zeros", () => {
  assert.equal(build({ date: "2026-01-05" }).payload.DocDtls.Dt, "05/01/2026");
  assert.equal(build({ date: "2026-10-08" }).payload.DocDtls.Dt, "08/10/2026");
  // Stored as an instant late in the Indian evening: still that day in India.
  assert.equal(
    build({ date: new Date("2026-10-07T19:30:00.000Z") }).payload.DocDtls.Dt,
    "08/10/2026"
  );
});

test("an unusable date is a problem, not an Invalid Date in the payload", () => {
  const { payload, problems } = build({ date: "whenever" });
  assert.equal(payload, null);
  assert.ok(problems.some((p) => /no usable date/.test(p)));
});

test("the document number is a string, upper-cased", () => {
  assert.equal(build({ invoiceNo: 42 }).payload.DocDtls.No, "42");
  assert.equal(typeof build().payload.DocDtls.No, "string");
  assert.equal(build({ invoiceNo: "inv/2026/42" }).payload.DocDtls.No, "INV/2026/42");
});

console.log("\n--- a line on its own ---");

test("buildLine needs nothing but the line and the tax type", () => {
  const line = buildLine({ hsn: "6205", quantity: 2, cost: 50, gstRate: 18 }, 0, { taxType: "local" });
  assert.equal(line.SlNo, "1");
  assert.equal(line.Unit, "OTH", "an item with no code still sends a valid one");
  assert.equal(line.IsServc, "N");
  assert.equal(line.TotItemVal, 118);
});

test("a service line says so", () => {
  const line = buildLine({ hsn: "9988", quantity: 1, cost: 500, gstRate: 18, isService: true }, 3, {
    taxType: "central",
  });
  assert.equal(line.IsServc, "Y");
  assert.equal(line.SlNo, "4");
  assert.equal(line.IgstAmt, 90);
});

test("junk in a line does not become NaN in the payload", () => {
  const line = buildLine({ quantity: "two", cost: "", gstRate: null, discount: "x" }, 0, {});
  for (const key of ["Qty", "UnitPrice", "TotAmt", "Discount", "AssAmt", "GstRt", "CgstAmt", "SgstAmt", "IgstAmt", "TotItemVal"]) {
    assert.ok(Number.isFinite(line[key]), `${key} is ${line[key]}`);
  }
});

console.log(`\n${passed} checks passed.\n`);
