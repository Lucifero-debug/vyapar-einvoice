/**
 * The series master -- Sigfa's Series Master: scripts/series.test.mjs
 *
 * Plain node, no framework -- `node scripts/series.test.mjs`.
 *
 * Three halves, which is one too many but they are the three ways this
 * breaks. lib/series.mjs on its own, which is pure. Then a sweep of the real
 * files, because the wiring is what actually goes wrong: a model without the
 * tenant plugin, a unique index not led by companyId, an alter payload that
 * drops a field, a Series box still backed by free text. Then the invoice
 * side, where a field has to travel the whole frozen payload contract to
 * reach the database.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  alterNumberProblem,
  SERIES_CODE_MAX,
  SERIES_CODE_PATTERN,
  SERIES_DEFAULTS,
  SERIES_DOC_TYPES,
  SERIES_DOC_TYPES_NOT_HERE,
  SERIES_DOC_TYPE_CODES,
  SERIES_FIELDS,
  appliesTo,
  defaultSeries,
  SERIES_SNAPSHOT_FIELDS,
  docTypeForBill,
  docTypeForBilling,
  docTypeForChallan,
  effectsStock,
  isSeriesLocked,
  seriesSnapshot,
  voucherNoFor,
  docTypeForOrder,
  docTypeForStockKind,
  docTypeLabel,
  formatDocNo,
  fyStartYear,
  fyTag,
  isSeriesDocType,
  normalizeDocType,
  normalizeSeries,
  normalizeSeriesCode,
  sameSeries,
  seriesCodeProblem,
  seriesDocType,
  seriesFlag,
  seriesFor,
  seriesInUse,
  seriesKey,
  seriesNumber,
  seriesOptions,
  seriesProblems,
} from "../lib/series.mjs";
import { STOCK_KINDS, STOCK_KIND_CODES, seriesUsed } from "../lib/stockVoucher.mjs";
import { BILLING_KEYS, BILLING_TYPES } from "../lib/billingTypes.mjs";
import { CHALLAN_KINDS, CHALLAN_TYPES } from "../lib/challan.mjs";
import { PAYLOAD_KEYS, buildInvoicePayload } from "../lib/billingMath.mjs";
import { MASTER_SPECS, masterKindFor, masterSpec } from "../lib/masterActions.mjs";
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
const code = (p) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** A master row, as the routes store one. */
const row = (seriesCode, over = {}) => ({
  _id: `s-${seriesCode}`,
  ...SERIES_DEFAULTS,
  code: seriesCode,
  docType: "PRODUCTION",
  ...over,
});

console.log("\n--- the documents, from Sigfa's own radio list ---");

test("the twelve documents this app raises are offered, in Sigfa's order", () => {
  // Read off the Series Master screenshot, top to bottom. The order is not
  // cosmetic: the dialog shows the list exactly as Sigfa does, so somebody
  // holding both can check one against the other.
  assert.deepEqual(SERIES_DOC_TYPE_CODES, [
    "SALE_INVOICE",
    "SALE_CHALLAN",
    "SALE_RETURN",
    "GOODS_ISSUED",
    "GOODS_RECEIVED",
    "PURCHASE_RETURN",
    "SALE_ORDER",
    "PURCHASE_ORDER",
    "PRODUCTION",
    "MRI",
    "PURCHASE_INVOICE",
    "PURCHASE_CHALLAN",
  ]);
  assert.equal(new Set(SERIES_DOC_TYPE_CODES).size, SERIES_DOC_TYPE_CODES.length);
});

test("the seven Sigfa lists that this app has no document for are recorded", () => {
  // Recorded rather than offered: a radio button for a document nobody can
  // raise would be a series that could never go on anything, and dropping
  // them silently would lose the fact that Sigfa has them.
  assert.deepEqual(SERIES_DOC_TYPES_NOT_HERE, [
    "Sales Enquiry",
    "Sales Quotation",
    "M.R.O.",
    "Purchase Enquiry",
    "Purchase Quotation",
    "Sale Ord. Schedule",
    "Purc Ord. Schedule",
  ]);
  // Nineteen rows on the screen, twelve of them here.
  assert.equal(SERIES_DOC_TYPES.length + SERIES_DOC_TYPES_NOT_HERE.length, 19);
});

test("every link into this app's own tables names something that exists", () => {
  // THE DRIFT GUARD. lib/series.mjs holds these as literals so it can stay
  // dependency-free; this is what stops one going stale. A link that named a
  // kind nobody has would silently offer a series on no screen at all.
  for (const doc of SERIES_DOC_TYPES) {
    if (doc.stockKind) {
      assert.ok(STOCK_KIND_CODES.includes(doc.stockKind), `${doc.code} -> ${doc.stockKind}`);
    }
    if (doc.billingKey) {
      assert.ok(BILLING_KEYS.includes(doc.billingKey), `${doc.code} -> ${doc.billingKey}`);
    }
    if (doc.challanType) {
      assert.ok(CHALLAN_TYPES.includes(doc.challanType), `${doc.code} -> ${doc.challanType}`);
    }
  }
  // And each of this app's own documents is reachable, so none was forgotten.
  for (const kind of STOCK_KIND_CODES) {
    assert.ok(docTypeForStockKind(kind), `no series document for stock kind ${kind}`);
  }
  for (const key of BILLING_KEYS) {
    assert.ok(docTypeForBilling(key), `no series document for billing screen ${key}`);
  }
  for (const type of CHALLAN_TYPES) {
    assert.ok(docTypeForChallan(type), `no series document for ${type} challan`);
  }
});

test("a screen finds its own document type", () => {
  assert.equal(docTypeForStockKind("FR"), "PRODUCTION");
  assert.equal(docTypeForStockKind("IS"), "GOODS_ISSUED");
  assert.equal(docTypeForStockKind("RS"), "GOODS_RECEIVED");
  assert.equal(docTypeForStockKind("fr"), "PRODUCTION", "case is not relied on");
  assert.equal(docTypeForBilling("sale"), "SALE_INVOICE");
  assert.equal(docTypeForBilling("purchase"), "PURCHASE_INVOICE");
  assert.equal(docTypeForBilling("salereturn"), "SALE_RETURN");
  assert.equal(docTypeForBilling("purchasereturn"), "PURCHASE_RETURN");
  assert.equal(docTypeForChallan("Sale"), "SALE_CHALLAN");
  assert.equal(docTypeForChallan("Purchase"), "PURCHASE_CHALLAN");
  assert.equal(docTypeForOrder("Sale"), "SALE_ORDER");
  assert.equal(docTypeForOrder("Purchase"), "PURCHASE_ORDER");
  // A screen with no series document answers "", not a guess.
  assert.equal(docTypeForStockKind("ZZ"), "");
  assert.equal(docTypeForBilling(""), "");
  assert.equal(docTypeForBilling(undefined), "");
});

test("the labels carry Sigfa's wording, and its MKEYs where this app knows them", () => {
  assert.equal(docTypeLabel("SALE_INVOICE"), "Sales Invoice");
  assert.equal(docTypeLabel("PURCHASE_INVOICE"), "Purchase Inv.", "Sigfa abbreviates this one");
  assert.equal(docTypeLabel("MRI"), "M.R.I.");
  assert.equal(docTypeLabel("nonsense"), "", "an unknown document has no name");
  assert.equal(seriesDocType("sale_invoice")?.code, "SALE_INVOICE", "matched without regard to case");
  assert.equal(seriesDocType("nonsense"), null);
  // The MKEYs this project already recorded, unchanged.
  assert.equal(seriesDocType("SALE_CHALLAN").mkey, CHALLAN_KINDS.Sale.mkey);
  assert.equal(seriesDocType("PURCHASE_CHALLAN").mkey, CHALLAN_KINDS.Purchase.mkey);
  assert.equal(seriesDocType("PRODUCTION").mkey, "FR");
  // Sigfa's own list spells it "Goods Recieved"; this app spells it correctly
  // and says so in a comment rather than copying the typo.
  assert.equal(docTypeLabel("GOODS_RECEIVED"), STOCK_KINDS.RS.label);
});

test("an unknown document is NOT widened to a default", () => {
  // Every series belongs to exactly one document. A row this build cannot
  // place must be offered on NOTHING -- it still appears on the master
  // screen, where it can be corrected, and nowhere else.
  assert.equal(normalizeDocType("nonsense"), "");
  assert.equal(normalizeDocType(""), "");
  assert.equal(normalizeDocType(undefined), "");
  assert.equal(normalizeDocType("sale_invoice"), "SALE_INVOICE");
  assert.equal(isSeriesDocType("SALE_INVOICE"), true);
  assert.equal(isSeriesDocType("ANY"), false, "the old catch-all scope is gone");
});

console.log("\n--- the code, as it will be stored ---");

test("sixteen characters, upper case -- Sigfa's VOUCHER Text(16)", () => {
  assert.equal(SERIES_CODE_MAX, 16);
  assert.equal(normalizeSeriesCode("a"), "A");
  assert.equal(normalizeSeriesCode("  mo  "), "MO");
  assert.equal(normalizeSeriesCode("a".repeat(20)), "A".repeat(16));
  assert.equal(normalizeSeriesCode(undefined), "");
  assert.equal(normalizeSeriesCode(null), "");
});

test('"mi" and "MI" are one series, because the register already treats them so', () => {
  assert.equal(sameSeries("mi", "MI"), true);
  assert.equal(sameSeries(" mi ", "MI"), true);
  assert.equal(sameSeries("MI", "MO"), false);
  assert.equal(sameSeries("", ""), false, "blank is not a series");
  assert.equal(seriesKey("mi"), "MI");
  assert.deepEqual(seriesUsed([{ series: "mi" }, { series: "MI" }]), ["mi"]);
});

test("a code that cannot be stored says why", () => {
  assert.match(seriesCodeProblem(""), /Enter a series code/);
  assert.match(seriesCodeProblem("a".repeat(17)), /at most 16/);
  assert.match(seriesCodeProblem("M I"), /letters, digits/);
  assert.match(seriesCodeProblem("-MI"), /starts with a letter or digit/);
  assert.equal(seriesCodeProblem("A"), null);
  assert.equal(seriesCodeProblem("mi"), null, "lower case is normalized, not refused");
  assert.equal(seriesCodeProblem("GI-2026"), null);
  assert.equal(seriesCodeProblem("A/1"), null);
  assert.equal(seriesCodeProblem("a".repeat(16)), null, "exactly sixteen is allowed");
  assert.equal(SERIES_CODE_PATTERN.test("mi"), false, "the pattern sees the normalized code");
});

console.log("\n--- every field on Sigfa's screen ---");

test("the record carries all of them, with the defaults the screenshot shows", () => {
  for (const field of [
    "code", "name", "docType",
    "invoiceToBePrint", "compressPrinting", "rollStationary", "printCompName",
    "effectInStock", "remark", "topHeading", "topSubHeading", "invoiceNoCaption",
    "declarationCaption", "declaration", "store",
    "fillLeftSpaceWithZero", "bookNo", "lockVoucher",
    "slipWidthCm", "slipHeightCm", "dmpFont", "djFont",
  ]) {
    assert.ok(SERIES_FIELDS.includes(field), `${field} is not a field of a series`);
  }
  // Print Comp. Name and Effect In Stock are Yes on the screenshot; Compress
  // Printing and Roll Stationary are No; the sizes and the zero-fill are 0.
  assert.equal(SERIES_DEFAULTS.printCompName, true);
  assert.equal(SERIES_DEFAULTS.effectInStock, true);
  assert.equal(SERIES_DEFAULTS.compressPrinting, false);
  assert.equal(SERIES_DEFAULTS.rollStationary, false);
  assert.equal(SERIES_DEFAULTS.lockVoucher, false);
  assert.equal(SERIES_DEFAULTS.fillLeftSpaceWithZero, 0);
  assert.equal(SERIES_DEFAULTS.slipWidthCm, 0);
  assert.equal(SERIES_DEFAULTS.slipHeightCm, 0);
  // And the two that are this app's own, not Sigfa's.
  assert.equal(SERIES_DEFAULTS.active, true);
  assert.equal(SERIES_DEFAULTS.isDefault, false);
});

test('a tick box that arrives as the string "false" is off, not on', () => {
  // Boolean("false") is true. A series switched off on a form that stringifies
  // its fields would save as switched on, and the one default per document
  // would quietly become two.
  assert.equal(seriesFlag("false"), false);
  assert.equal(seriesFlag("FALSE"), false);
  assert.equal(seriesFlag("0"), false);
  assert.equal(seriesFlag("off"), false);
  assert.equal(seriesFlag("true"), true);
  assert.equal(seriesFlag(true), true);
  assert.equal(seriesFlag(false), false, "a real false stays false");
  assert.equal(seriesFlag(false, true), false, "and beats the fallback");
  // Not sent at all keeps the default rather than becoming false.
  assert.equal(seriesFlag(undefined, true), true);
  assert.equal(seriesFlag("", true), true);
});

test("a measurement is never NaN and never negative", () => {
  assert.equal(seriesNumber("4"), 4);
  assert.equal(seriesNumber("21.5"), 21.5);
  assert.equal(seriesNumber(""), 0);
  assert.equal(seriesNumber(undefined, 3), 3);
  assert.equal(seriesNumber("abc", 3), 3, "a typed letter keeps the old value");
  assert.equal(seriesNumber(-1, 0), 0, "a negative width is not a width");
});

test("normalizeSeries produces every field and nothing else", () => {
  // The guard against Mongoose strict mode, and against a request body
  // writing a field it has no business writing.
  const out = normalizeSeries({
    code: "a",
    docType: "sale_invoice",
    name: "Main book",
    fillLeftSpaceWithZero: "4",
    printCompName: "false",
    slipWidthCm: "21",
    companyId: "another-firm",
    _id: "somebody-else",
    nextNo: 500,
  });
  assert.deepEqual(Object.keys(out).sort(), [...SERIES_FIELDS].sort());
  assert.equal(out.code, "A");
  assert.equal(out.docType, "SALE_INVOICE");
  assert.equal(out.fillLeftSpaceWithZero, 4);
  assert.equal(out.printCompName, false);
  assert.equal(out.slipWidthCm, 21);
  assert.equal(out.companyId, undefined, "the tenant cannot be set through a body");
  assert.equal(out._id, undefined);
  assert.equal(out.nextNo, undefined, "and a series still has no number of its own");
  // Nothing sent at all is the defaults, not undefined in a controlled input.
  assert.deepEqual(normalizeSeries(), SERIES_DEFAULTS);
  assert.deepEqual(normalizeSeries({}), SERIES_DEFAULTS);
});

test("the problems list covers the code and the document", () => {
  assert.deepEqual(seriesProblems({ code: "A", docType: "SALE_INVOICE" }), []);
  assert.equal(seriesProblems({ code: "" }).length, 2, "both the code and the document");
  assert.match(seriesProblems({ code: "A" })[0], /Choose which document/);
  assert.match(seriesProblems({ code: "A", docType: "XX" })[0], /not a document this app raises/);
  assert.match(
    seriesProblems({ code: "A", docType: "SALE_INVOICE", fillLeftSpaceWithZero: 99 })[0],
    /at most 16/
  );
});

console.log("\n--- which series a document is offered ---");

test("a series is offered on its own document and no other", () => {
  assert.equal(appliesTo(row("A", { docType: "SALE_INVOICE" }), "SALE_INVOICE"), true);
  assert.equal(appliesTo(row("A", { docType: "SALE_INVOICE" }), "PURCHASE_INVOICE"), false);
  assert.equal(appliesTo(row("A", { docType: "sale_invoice" }), "SALE_INVOICE"), true);
  // A row this build cannot place is offered nowhere -- including on a blank.
  assert.equal(appliesTo(row("A", { docType: "XX" }), "SALE_INVOICE"), false);
  assert.equal(appliesTo(row("A", { docType: "XX" }), ""), false);
});

test("a series switched off stops being offered without unlabelling anything", () => {
  const master = [row("A"), row("B", { active: false }), row("C")];
  assert.deepEqual(seriesFor(master, "PRODUCTION").map((s) => s.code), ["A", "C"]);
  // The master screen has to show it, or there is no way to switch it back on.
  assert.deepEqual(
    seriesFor(master, "PRODUCTION", { includeInactive: true }).map((s) => s.code),
    ["A", "B", "C"]
  );
  assert.deepEqual(seriesFor([], "PRODUCTION"), []);
  assert.deepEqual(seriesFor(undefined, "PRODUCTION"), []);
});

test("the list is sorted by code, and the caller's array is not reordered", () => {
  const master = [row("C"), row("A"), row("B")];
  assert.deepEqual(seriesFor(master, "PRODUCTION").map((s) => s.code), ["A", "B", "C"]);
  assert.deepEqual(master.map((s) => s.code), ["C", "A", "B"], "sorted a copy");
});

test("the default is the one marked for that document, and nothing otherwise", () => {
  const master = [
    row("A", { docType: "SALE_INVOICE", isDefault: true }),
    row("B", { docType: "PURCHASE_INVOICE", isDefault: true }),
  ];
  assert.equal(defaultSeries(master, "SALE_INVOICE"), "A");
  assert.equal(defaultSeries(master, "PURCHASE_INVOICE"), "B");
  assert.equal(defaultSeries(master, "PRODUCTION"), "", "nothing marked means nothing selected");
  assert.equal(defaultSeries([], "SALE_INVOICE"), "");
  // A default that is switched off is not a default.
  assert.equal(defaultSeries([row("A", { isDefault: true, active: false })], "PRODUCTION"), "");
});

console.log("\n--- the dropdown keeps what the documents already say ---");

test("the master is offered first, then series the documents carry that it lacks", () => {
  // THE CASE THIS EXISTS FOR, on the slip screens: the box was free text
  // before the master, so a firm has slips labelled with series no row knows.
  const options = seriesOptions([row("MI", { name: "Material In" })], ["MI", "OLD"], "PRODUCTION");
  assert.deepEqual(options.map((o) => o.code), ["MI", "OLD"]);
  assert.deepEqual(options.map((o) => o.inMaster), [true, false]);
  assert.equal(options[0].name, "Material In");
});

test("a series in both is offered once, whatever case the documents used", () => {
  const options = seriesOptions([row("MI")], ["mi", "MI", "  mi  "], "PRODUCTION");
  assert.deepEqual(options.map((o) => o.code), ["MI"]);
  assert.equal(options[0].inMaster, true, "the master row wins, not the typed one");
});

test("history is deduped and sorted, and blanks are dropped", () => {
  const options = seriesOptions([], ["b", "a", "B", "", "   ", null], "PRODUCTION");
  assert.deepEqual(options.map((o) => o.code), ["A", "B"]);
});

test("nothing passed is an empty list, not a crash", () => {
  assert.deepEqual(seriesOptions(), []);
  assert.deepEqual(seriesOptions(null, null, "PRODUCTION"), []);
});

test("the number is the financial year, a slash, and the running number", () => {
  // Sigfa shows `Series: TAX` beside `Invoice No. 26-27/1`. The code is NOT
  // in the number; `fillLeftSpaceWithZero` pads only the running part.
  const d = "2026-10-15";
  assert.equal(formatDocNo(1, { code: "TAX" }, d), "26-27/1");
  assert.equal(formatDocNo(7, { code: "A", fillLeftSpaceWithZero: 4 }, d), "26-27/0007");
  assert.equal(formatDocNo(7, { code: "A", fillLeftSpaceWithZero: 0 }, d), "26-27/7");
  assert.equal(
    formatDocNo(12345, { code: "A", fillLeftSpaceWithZero: 3 }, d),
    "26-27/12345",
    "never truncated"
  );
  // The code never reaches the number, whatever it is.
  assert.doesNotMatch(formatDocNo(1, { code: "TAX" }, d), /TAX/);

  // No date, no year to print -- the Series Master's preview, before any
  // document exists to be dated.
  assert.equal(formatDocNo(7, { code: "A", fillLeftSpaceWithZero: 4 }), "0007");

  assert.equal(formatDocNo("", {}, d), "", "nothing to format");
  assert.equal(formatDocNo(undefined, {}, d), "");
  assert.equal(formatDocNo("abc", {}, d), "");
});

test("the year comes off the document's date, and April starts it", () => {
  assert.equal(fyStartYear("2026-10-15"), 2026);
  assert.equal(fyStartYear("2026-04-01"), 2026, "the first day of the year");
  assert.equal(fyStartYear("2026-03-31"), 2025, "the last day of the one before");
  assert.equal(fyStartYear("2027-01-05"), 2026, "January belongs to the April before it");
  assert.equal(fyStartYear("nonsense"), null);
  assert.equal(fyStartYear(""), null);
  assert.equal(fyStartYear(null), null);
  assert.equal(fyStartYear(undefined), null);

  assert.equal(fyTag(2026), "26-27");
  assert.equal(fyTag(1999), "99-00", "across the century");
  assert.equal(fyTag(null), "");
  assert.equal(fyTag("abc"), "");
});

test("how many documents carry a series, counted as they were written", () => {
  const docs = [{ series: "A" }, { series: "a" }, { series: "B" }, {}, { series: "" }];
  assert.equal(seriesInUse("A", docs), 2, "case-insensitive");
  assert.equal(seriesInUse("B", docs), 1);
  assert.equal(seriesInUse("C", docs), 0);
  assert.equal(seriesInUse("", docs), 0, "a blank series is not in use");
  assert.equal(seriesInUse("A"), 0);
});

console.log("\n--- the module stays pure, and composes rather than issues ---");

test("no imports at all, so nothing it describes can import it back", () => {
  const src = read("../lib/series.mjs");
  assert.doesNotMatch(src, /^import /m, "lib/series.mjs must stay dependency-free");
  assert.doesNotMatch(src, /\bfetch\(/, "the components fetch; this decides");
});

test("it records what the screenshot shows, and does not invent the rest", () => {
  // SIGFA105.exe cannot be read from here, so the provenance has to stay in
  // the file: if it is ever replaced by a prettier summary, the next person
  // has no way to tell what was observed from what was assumed.
  const src = read("../lib/series.mjs");
  assert.match(src, /screenshot/i);
  assert.match(src, /RADIO BUTTON/);
  assert.match(src, /VOUCHER Text\(16\)/);
  assert.match(src, /NO next-number or last-number box/);
});

test("the series numbers its own book, and the firm's sequence still does not move", () => {
  const src = read("../lib/series.mjs");
  // The constraint that governed the old decision governs this one too.
  assert.match(src, /consecutive/);

  // This module COMPOSES the number and never issues one: a counter has to
  // sit where a transaction can roll it back, which is lib/getNextInvoiceNo.js.
  assert.doesNotMatch(code("../lib/series.mjs"), /Counter|counterFor/);

  // The stock slips are untouched -- one counter per kind, as before.
  assert.doesNotMatch(
    code("../lib/getNextProductionNo.js"),
    /\bseries\b/i,
    "the slips did not grow a series"
  );

  // No field on the series record is a number to issue. The count lives in
  // the counter collection, where two people billing at once contend for it.
  for (const field of ["nextNo", "lastNo", "currentNo", "startNo"]) {
    assert.ok(!SERIES_FIELDS.includes(field), `${field} would make the master a counter`);
  }
});

console.log("\n--- the model ---");

test("every row belongs to one firm, and the unique index is led by companyId", () => {
  const src = read("../models/seriesModel.js");
  assert.match(src, /\.plugin\(\s*tenantPlugin\s*\)/, "not tenant-scoped");
  assert.match(
    src,
    /index\(\s*\{\s*companyId:\s*1,\s*docType:\s*1,\s*code:\s*1\s*\}\s*,\s*\{\s*unique:\s*true/,
    "the unique index must be (companyId, docType, code)"
  );
  assert.doesNotMatch(src, /index\(\s*\{\s*code:\s*1\s*\}/, "no global index on the code alone");
});

test("the schema declares every field, because strict mode drops the rest", () => {
  // Swept BOTH ways: a field on the record but not in the schema is discarded
  // on save, and a field in the schema but not on the record can never be set.
  const src = read("../models/seriesModel.js");
  const declared = new Set(
    [...src.matchAll(/^\s{4}([A-Za-z][\w]*):\s*\{/gm)].map((m) => m[1])
  );
  const missing = SERIES_FIELDS.filter((field) => !declared.has(field));
  assert.deepEqual(missing, [], "these fields would be dropped on save");
  assert.match(src, /enum:\s*SERIES_DOC_TYPE_CODES/, "the document must be constrained");
  assert.match(src, /from "\.\.\/lib\/series\.mjs"/);
});

console.log("\n--- the routes ---");

const ROUTES = ["get-series", "series-add", "series-update", "delete-series"];

test("all four exist, are wrapped, and go through the tenant route", () => {
  for (const name of ROUTES) {
    const src = read(`../app/api/${name}/route.js`);
    assert.match(src, /@\/lib\/tenantRoute\.mjs/, `${name} does not import the wrapper`);
    assert.match(src, /export const (GET|POST) = tenantRoute\(/, `${name} is not wrapped`);
    assert.doesNotMatch(
      src,
      /^export\s+async\s+function\s+(GET|POST)\b/m,
      `${name} exports a bare handler`
    );
  }
});

test("the two that write build the whole record rather than naming fields", () => {
  // `normalizeSeries` is what keeps twenty-four fields from having to be
  // listed in four places. It also drops anything that is not a field of a
  // series, so a body cannot set companyId or _id.
  for (const name of ["series-add", "series-update"]) {
    const src = code(`../app/api/${name}/route.js`);
    assert.match(src, /normalizeSeries\(body\)/, `${name} does not build the record`);
    assert.match(src, /seriesProblems\(/, `${name} does not validate`);
    assert.match(src, /status: 400/, `${name} does not answer 400`);
    // Either shape of 409: a NextResponse status, or AbortTransaction's second
    // argument, which is how a refusal inside a transaction is returned.
    assert.match(src, /\b409\b/, `${name} does not answer 409 on a clash`);
    assert.match(src, /already exists/, `${name} does not say what the clash is`);
    assert.match(src, /isDefault: false/, `${name} does not clear the previous default`);
  }
  // The alter leaves the record out of its own comparison, or renaming
  // nothing would report a clash with itself.
  assert.match(code("../app/api/series-update/route.js"), /_id: \{ \$ne: id \}/);
});

test("renaming a series carries its documents with it, in one transaction", () => {
  const src = code("../app/api/series-update/route.js");
  assert.match(src, /withTransaction\(/);
  assert.match(src, /AbortTransaction/, "a refusal must not half-commit");
  assert.match(src, /Production/, "the slips must follow the rename");
  assert.match(src, /Invoice/, "and so must the bills");
  // Under the type they were WRITTEN under, not the new one.
  assert.match(src, /documentsOf\(previousDocType/);
});

test("the two routes agree about where each document lives", () => {
  // A series counted as unused by the delete and renamed by the alter would be
  // deletable while documents still carry it.
  const update = code("../app/api/series-update/route.js");
  const remove = code("../app/api/delete-series/route.js");
  for (const src of [update, remove]) {
    assert.match(src, /PRODUCTION: "FR", GOODS_ISSUED: "IS", GOODS_RECEIVED: "RS"/);
    // `return`, not `isReturn`: models/invoiceModel.js declares `return`, and
    // filtering on a field the schema does not have would match every bill of
    // the type -- so a sales-invoice rename would relabel the sales returns.
    assert.match(src, /SALE_RETURN: \{ type: "Sale", return: true \}/);
    assert.doesNotMatch(src, /isReturn/, "the invoice field is `return`");
  }
});

test("a series in use cannot be deleted, and the refusal counts what uses it", () => {
  const src = code("../app/api/delete-series/route.js");
  assert.match(src, /searchParams\.get\(["']id["']\)/, "the master framework sends ?id=");
  assert.match(src, /export const POST = tenantRoute\(/);
  assert.match(src, /countDocuments\(/);
  assert.match(src, /status: 409/);
  assert.match(src, /Untick Active/, "it must name the way out");
  // Counted without regard to case, because the slip field was free text.
  assert.match(src, /collation\(/);
  // And a production count honours rows written before `kind` existed.
  assert.match(src, /kindFilter\(/);
});

console.log("\n--- the master framework knows about it ---");

test("a Series box reaches the series master, on any screen", () => {
  assert.equal(masterKindFor("series"), "series");
  assert.equal(masterKindFor("slipSeries"), "series");
  assert.equal(masterSpec("series")?.matchField, "code", "the box holds a code, not a name");
  const spec = MASTER_SPECS.series;
  for (const key of [
    "label", "listEndpoint", "listKey", "createEndpoint",
    "alterEndpoint", "deleteEndpoint", "matchField", "toPayload",
  ]) {
    assert.ok(spec[key], `series has no ${key}`);
  }
  assert.equal(spec.listEndpoint, "/api/get-series");
  assert.equal(spec.listKey, "series");
});

test("the alter payload carries EVERY field, or the alter resets the rest", () => {
  // THE ONE THAT MATTERS for this master. series-update rebuilds the row from
  // what it is sent, so a field the payload omits comes back as its default --
  // a cleared declaration, a heading lost, the series switched off.
  const produces = new Set(Object.keys(MASTER_SPECS.series.toPayload({})));
  const missing = SERIES_FIELDS.filter((field) => !produces.has(field));
  assert.deepEqual(missing, [], "these fields would be reset by an Alt+M");
  assert.ok(produces.has("id"), "and the route needs the id");
  const payload = MASTER_SPECS.series.toPayload({
    _id: "s1",
    code: "A",
    docType: "SALE_INVOICE",
    declaration: "E & O.E.",
    effectInStock: false,
  });
  assert.equal(payload.id, "s1");
  assert.equal(payload.docType, "SALE_INVOICE");
  assert.equal(payload.declaration, "E & O.E.");
  assert.equal(payload.effectInStock, false);
});

test("Alt+A in a Series box asks which document, because it cannot guess", () => {
  const quick = read("../components/billing/QuickMaster.jsx");
  assert.match(quick, /\/api\/series-add/);
  assert.match(quick, /name: 'docType'/, "the document must be asked for");
  assert.match(quick, /type: 'select'/, "and chosen, not typed");
  assert.match(quick, /SERIES_DOC_TYPES/, "from the one list");
});

console.log("\n--- who may use it ---");

test("reading the master needs master:read; changing one needs master:write", () => {
  // An unlisted /api path falls through to setup:write, which is owner-only.
  // That fails CLOSED rather than open, so forgetting these would not expose
  // anything -- it would leave an accountant with an empty Series box.
  assert.equal(permissionForPath("/api/get-series"), "master:read");
  for (const path of ["/api/series-add", "/api/series-update", "/api/delete-series"]) {
    assert.equal(permissionForPath(path), "master:write", path);
  }
  assert.equal(permissionForPath("/api/get-series"), permissionForPath("/api/get-state"));
  assert.equal(permissionForPath("/api/series-add"), permissionForPath("/api/state-add"));
});

test("a biller may read a series and not create one", () => {
  assert.equal(canAccessPath("biller", "/api/get-series"), true);
  assert.equal(canAccessPath("biller", "/api/series-add"), false);
  assert.equal(canAccessPath("accountant", "/api/series-add"), true);
  assert.equal(canAccessPath("owner", "/api/delete-series"), true);
});

console.log("\n--- the series on a bill ---");

test("the frozen payload contract carries it", () => {
  // The contract the four billing screens and both save routes agree on. A
  // key the screen sends and this list does not hold is refused by
  // prepareInvoiceInput; one this holds and the builder does not produce
  // arrives as undefined and is stored as nothing.
  assert.ok(PAYLOAD_KEYS.includes("series"));
  const payload = buildInvoicePayload({ series: "A", items: [] }, { type: "Sale", isReturn: false });
  assert.equal(payload.series, "A");
  assert.ok(Object.keys(payload).includes("series"));
});

test("the bill stores it, and an edit does not blank it", () => {
  const model = read("../models/invoiceModel.js");
  assert.match(model, /series: \{ type: String/, "strict mode would drop it");
  // Both write paths. sale-alter leaves shippedTo and dispatchFrom out on
  // purpose; the series is NOT one of those -- the edit screen reloads it.
  assert.match(code("../app/api/save-invoice/route.js"), /series: input\.series/);
  assert.match(code("../app/api/sale-alter/route.js"), /series: invoiceData\.series/);
  // And it is normalized on the way in, so a bill and its master row cannot
  // differ by their spelling.
  assert.match(code("../lib/invoiceInput.mjs"), /series: normalizeSeriesCode\(/);
});

test("the series numbers its own book, and leaves the firm's sequence alone", () => {
  // The decision this whole feature turns on. A bill takes TWO numbers: the
  // firm's `invoiceNo`, unchanged and still the key, and `seriesNo`, the
  // series' own count. Keeping them apart is what let the series start
  // numbering without renumbering a bill already issued.
  const save = code("../app/api/save-invoice/route.js");
  assert.match(save, /invoiceNo,/);
  assert.match(save, /getNextSeriesNo\(/, "the series number is not reserved");
  assert.match(save, /seriesNo,/);
  // The series never becomes part of `invoiceNo` itself.
  assert.doesNotMatch(save, /invoiceNo.*\+.*series/);

  const counters = code("../lib/getNextInvoiceNo.js");
  // Two counters, and the series' one is keyed by series AND year, or the
  // number would not restart in April.
  assert.match(counters, /name: 'invoiceNo'/, "the firm's own counter moved");
  assert.match(counters, /seriesCounterName/);
  assert.match(counters, /finYear/);
  // Both reserve inside the caller's session, so a rolled-back save gives
  // the number back instead of leaving a hole in the book.
  assert.match(counters, /session = null/);
});

test("the bill carries the year it was numbered in, and the index holds it", () => {
  const model = read("../models/invoiceModel.js");
  assert.match(model, /seriesNo: \{ type: Number \}/, "strict mode would drop it");
  assert.match(model, /finYear: \{ type: Number \}/);
  // One number per series per year, enforced where two tills contend.
  assert.match(
    model,
    /index\(\s*\{ companyId: 1, series: 1, finYear: 1, seriesNo: 1 \}/,
    "nothing stops two bills taking the same series number"
  );
  // Partial: every bill raised before this existed has no seriesNo, and a
  // plain unique index would read them all as null and collide them.
  const block = model.slice(model.indexOf("companyId: 1, series: 1"));
  assert.match(block.slice(0, 300), /partialFilterExpression: \{ seriesNo: \{ \$type: "number" \} \}/);
  // And the firm's own sequence is still unique and still there.
  assert.match(model, /index\(\{ companyId: 1, invoiceNo: 1 \}, \{ unique: true \}\)/);
});

console.log("\n--- the screens ---");

test("the billing screen offers its own document's series and sends it", () => {
  const src = read("../components/billing/BillingScreen.jsx");
  assert.match(src, /docTypeForBilling\(config\.key\)/, "a sale series must not reach a return");
  assert.match(src, /data-master-field='series'/, "Alt+A cannot create one from the bill");
  assert.match(src, /\/api\/get-series/, "the screen never loads the master");
  assert.match(src, /series: chosenSeries/, "the payload does not carry it");
  // Normalized on the way in, so an old bill lands on a real option.
  assert.match(src, /setSeries\(normalizeSeriesCode\(data\.series\)\)/);
});

test("the slip's Series box is fed by the master, not by free text alone", () => {
  const src = read("../app/production/page.js");
  assert.match(src, /seriesOptions\(/, "the box does not read the master");
  assert.match(src, /docTypeForStockKind\(kind\)/);
  assert.match(src, /data-master-field="series"/);
  assert.match(src, /\/api\/get-series/);
  assert.match(src, /<MasterShortcuts/, "the keys have to be mounted for the tag to do anything");
});

test("Setup carries the series master, which is where Sigfa keeps it", () => {
  const src = read("../app/setup/page.js");
  assert.match(src, /Document series/);
  assert.match(src, /\/api\/get-series/);
  assert.match(src, /docTypeLabel\(/, "the list must say which document each is for");
});

test("the dashboard lists the series master with the others", () => {
  const src = read("../app/page.js");
  assert.match(src, /SeriesMaster/);
  assert.match(src, /section: "Series"/);
  assert.match(src, /\/api\/delete-series\?id=/, "Delete on the row goes nowhere");
  assert.match(src, /\/api\/get-series/);
});

test("the dialog shows every field of Sigfa's screen, in its words", () => {
  // The screenshot is the specification. A field on the record that the
  // dialog never shows cannot be set at all.
  const src = read("../components/SeriesMaster.jsx");
  for (const label of [
    "Series \\[Initial\\]", "Series Name", "Invoice To Be Print", "Compress Printing",
    "Roll Stationary", "Print Comp. Name", "Effect In Stock", "Remark",
    "Top Heading", "Top Sub Heading", "Invoice No. Caption", "Declaration Caption",
    "Declaration", "Store", "Fill Left Space With Zero", "Book No.", "Lock Voucher",
    "Width In CM", "Height In CM", "DMP Font", "DJ Font",
    "Slip Size For DJ/Laser Printer", "Font Size Setting For PrnInvB",
  ]) {
    assert.match(src, new RegExp(label), `the dialog does not show "${label}"`);
  }
  // The document is a radio list down the left, as Sigfa's is.
  assert.match(src, /type="radio"/);
  // And it says, in whatever words, that the stored-only settings do nothing
  // yet -- a tick box that looks like it switches stock off and does not is
  // worse than no tick box.
  assert.match(src, /recorded only/i);
  assert.match(src, /still moves stock/i);
});

test("the dialog fits the window, which this one has to say out loud", () => {
  // DialogContent is `fixed` at top-1/2 with translate-y-[-50%] and NO
  // max-height, so a dialog taller than the window runs off BOTH ends: the
  // title scrolls away and the Save button cannot be reached. The other
  // masters have four fields and never hit it; this one has twenty-four.
  const src = read("../components/SeriesMaster.jsx");
  assert.match(src, /max-h-\[90vh\]/, "the dialog is not capped to the window");
  assert.match(src, /overflow-y-auto/, "the body does not scroll");
  // `minmax(0,1fr)`, not `1fr`: a grid row's default min-height is auto, so a
  // plain 1fr refuses to shrink below its content and the cap does nothing.
  assert.match(src, /grid-rows-\[auto_minmax\(0,1fr\)_auto\]/);
  assert.match(src, /min-h-0/);
});

console.log("\n--- what picking a series does to the bill ---");

test("a saved bill knows its own document type from type and return", () => {
  // The screens know their key ('salereturn'); a saved row has `type` and
  // `return`, and a route assembling the key itself is how a return gets
  // filed under the invoice series.
  assert.equal(docTypeForBill({ type: "Sale", isReturn: false }), "SALE_INVOICE");
  assert.equal(docTypeForBill({ type: "Sale", isReturn: true }), "SALE_RETURN");
  assert.equal(docTypeForBill({ type: "Purchase", isReturn: false }), "PURCHASE_INVOICE");
  assert.equal(docTypeForBill({ type: "Purchase", isReturn: true }), "PURCHASE_RETURN");
  assert.equal(docTypeForBill({ type: "sale" }), "SALE_INVOICE", "case is not relied on");
  assert.equal(docTypeForBill({ type: "nonsense" }), "");
  assert.equal(docTypeForBill({}), "");
  assert.equal(docTypeForBill(), "");
});

test("the snapshot carries what a bill must keep saying", () => {
  const snap = seriesSnapshot(
    row("A", {
      docType: "SALE_INVOICE",
      topHeading: "ORIGINAL FOR RECIPIENT",
      declaration: "E & O.E.",
      effectInStock: false,
    })
  );
  assert.equal(snap.topHeading, "ORIGINAL FOR RECIPIENT");
  assert.equal(snap.declaration, "E & O.E.");
  assert.equal(snap.effectInStock, false);
  // The CODE is not in the snapshot -- the bill has its own `series` column,
  // and two places holding it is two places to disagree.
  assert.ok(!SERIES_SNAPSHOT_FIELDS.includes("code"));
  // Nor is the lock: that one is read live, so unticking it frees the bills.
  assert.ok(!SERIES_SNAPSHOT_FIELDS.includes("lockVoucher"));
  // No series at all is a snapshot of defaults, not undefined fields in a
  // document Mongoose would then fill unpredictably.
  const blank = seriesSnapshot(null);
  assert.deepEqual(Object.keys(blank).sort(), [...SERIES_SNAPSHOT_FIELDS].sort());
  assert.equal(blank.topHeading, "");
  assert.equal(blank.effectInStock, true, "a bill with no series still moves stock");
  assert.equal(blank.printCompName, true);
});

test("Effect In Stock is off ONLY when a series says so", () => {
  // The whole safety property. Every bill this app has ever written moved
  // stock; a firm with no series must go on behaving exactly that way.
  assert.equal(effectsStock(null), true);
  assert.equal(effectsStock(undefined), true);
  assert.equal(effectsStock({}), true, "a row written before the field existed");
  assert.equal(effectsStock(row("A", { effectInStock: true })), true);
  assert.equal(effectsStock(row("A", { effectInStock: false })), false);
  // And the string "false" is off, not on.
  assert.equal(effectsStock(row("A", { effectInStock: "false" })), false);
});

test("Lock Voucher is read from the series, and off by default", () => {
  assert.equal(isSeriesLocked(null), false);
  assert.equal(isSeriesLocked({}), false);
  assert.equal(isSeriesLocked(row("A", { lockVoucher: true })), true);
  assert.equal(isSeriesLocked(row("A", { lockVoucher: "false" })), false);
});

test("the composed number needs a series, and carries the bill's own year", () => {
  const d = "2026-10-15";
  assert.equal(voucherNoFor(7, row("A", { fillLeftSpaceWithZero: 4 }), d), "26-27/0007");
  assert.equal(voucherNoFor(1, row("TAX"), d), "26-27/1");
  // A bill DATED into the year just gone is numbered into that year, not
  // into the one it happens to be typed in.
  assert.equal(voucherNoFor(1, row("TAX"), "2026-03-31"), "25-26/1");
  // No series means no composed number, and the bill shows its plain one.
  assert.equal(voucherNoFor(7, null, d), "");
  assert.equal(voucherNoFor(7, undefined, d), "");
});

test("the bill stores the composed number and the snapshot", () => {
  const model = read("../models/invoiceModel.js");
  assert.match(model, /voucherNo: \{ type: String/, "strict mode would drop it");
  // Every snapshot field is declared, or it is discarded on save and the
  // bill reprints without the heading somebody set.
  const block = model.slice(model.indexOf("seriesSnapshot:"), model.indexOf("againstInvoiceNo"));
  for (const field of SERIES_SNAPSHOT_FIELDS) {
    assert.match(block, new RegExp(`\\b${field}:\\s*\\{`), `${field} is not declared`);
  }
});

test("both save paths freeze the series onto the bill", () => {
  for (const path of ["../app/api/save-invoice/route.js", "../app/api/sale-alter/route.js"]) {
    const src = code(path);
    assert.match(src, /docTypeForBill\(/, `${path} does not resolve the document type`);
    assert.match(src, /Series\.findOne\(/, `${path} does not read the master`);
    assert.match(src, /voucherNo: voucherNoFor\(/, `${path} does not freeze the number`);
    assert.match(src, /seriesSnapshot: seriesProfile/, `${path} does not freeze the profile`);
    // The stock gate, on both, and passing an EMPTY LIST rather than skipping
    // the call -- the helper clears the invoice's existing rows first, so a
    // skipped call would leave movements behind when the effect is turned off.
    assert.match(src, /movesStock \? invoiceStockLines\(/, `${path} does not gate stock`);
  }
});

test("an edit keeps the number it was issued with, and may not change book", () => {
  const src = code("../app/api/sale-alter/route.js");
  // The customer is holding this number, so an edit must not move it.
  assert.match(src, /sameBook/);
  assert.match(src, /previousInvoice\.seriesNo/);
  // Sigfa refuses a change of series or year in Alter; so does the route,
  // before anything is written.
  assert.match(src, /alterNumberProblem\(\{/);
  assert.match(src, /if \(numberProblem\) \{\s*throw new AbortTransaction/);
  // A series bill saved before series numbers existed still gets one.
  assert.match(src, /getNextSeriesNo\(/);
  assert.match(src, /fyStartYear\(invoiceData\.date\)/);
  // Cleared to null, not left undefined: Mongoose drops an undefined from an
  // update, so the bill would keep the number of a book it has left.
  assert.match(src, /finYear: seriesNo === null \? null : finYear/);
});

test("a locked series refuses an alter, by the bill's OWN series", () => {
  const src = code("../app/api/sale-alter/route.js");
  assert.match(src, /isSeriesLocked\(/);
  // `previousInvoice.series`, not the one being saved -- or an edit could
  // escape a locked series by moving the bill out of it.
  assert.match(src, /previousInvoice\.series/);
  assert.match(src, /LOCKED_STATUS/, "it must answer like the other lock");
  assert.match(src, /Untick Lock Voucher/, "and name the way out");
});

test("the print uses what the bill kept, and falls back to what it printed before", () => {
  const src = read("../components/InvoiceDocument.jsx");
  // The number: the series' composition, else the plain one.
  assert.match(src, /invoice\?\.voucherNo \|\| invoice\?\.invoiceNo/);
  // The caption, the headings and the declaration, each with the old
  // behaviour behind it -- a bill with no series must print exactly as it did.
  assert.match(src, /seriesSnap\.invoiceNoCaption \|\| 'Invoice No:'/);
  assert.match(src, /seriesSnap\.topHeading/);
  assert.match(src, /seriesSnap\.topSubHeading/);
  assert.match(src, /seriesSnap\.declaration/);
  assert.match(src, /invoice\?\.seriesSnapshot \|\| \{\}/, "an old bill has none");
  // Off the ROW, never the master: a series edited next year must not
  // re-caption a bill the customer already holds.
  assert.doesNotMatch(src, /get-series/);
});

test("the Series box is on every bill, whether or not a series exists yet", () => {
  // The bug this fixes: it rendered only when the master already held one for
  // the document, so a firm that had defined none had no box -- and no way
  // in, since Alt+A acts on the field you are standing in.
  const src = read("../components/billing/BillingScreen.jsx");
  assert.doesNotMatch(src, /seriesChoices\.length > 0 &&/, "the box is hidden again");
  assert.match(src, /data-master-field='series'/);
});

test("picking a series asks again what the number will be", () => {
  // The bug: the number was fetched once when the form opened and the series
  // only changed a grey hint under the box, so switching series appeared to
  // do nothing at all. Each series counts on its own, and the screen cannot
  // work that out -- the count is in the counter collection.
  const src = read("../components/billing/BillingScreen.jsx");
  assert.match(src, /\/api\/next-invoice-no\?\$\{query\.toString\(\)\}/);
  assert.match(src, /query\.set\('series', chosenSeries\)/);
  // The date goes too, because the number restarts each financial year.
  assert.match(src, /new URLSearchParams\(\{ key: config\.key, date \}\)/);
  // And both are dependencies, or the refetch never happens.
  assert.match(src, /\}, \[value, chosenSeries, config\.key, date\]\)/);

  // The box shows the composed number and does not invite typing over it:
  // within a series the numbering has to be consecutive, so it is the
  // series' to give.
  assert.match(src, /value=\{voucherNo\}\s*\n\s*readOnly/);
  // The screen no longer composes it -- the server does, with the same code
  // that freezes it onto the bill. Comment-stripped, because the comment
  // where the old composition stood names it to say it has gone.
  assert.doesNotMatch(code("../components/billing/BillingScreen.jsx"), /formatDocNo/);
});

test("Sigfa's alter rule: a saved bill keeps its series and its year", () => {
  const TAX = { code: "TAX", effectInStock: true };
  const SAMPLE = { code: "SAMPLE", effectInStock: false };
  const RETAIL = { code: "RETAIL", effectInStock: true };
  const bill = { series: "TAX", finYear: 2026, seriesNo: 3 };

  // Unchanged: fine, including a date moved inside the same year.
  assert.equal(alterNumberProblem({ before: bill, after: { series: "tax", date: "2027-03-31" }, beforeRow: TAX, afterRow: TAX }), "");
  // Another series that also moves stock: "Can't Change Series !"
  assert.match(
    alterNumberProblem({ before: bill, after: { series: "RETAIL", date: "2026-10-15" }, beforeRow: TAX, afterRow: RETAIL }),
    /cannot be changed/
  );
  // One that differs on stock: Sigfa's other message.
  assert.match(
    alterNumberProblem({ before: bill, after: { series: "SAMPLE", date: "2026-10-15" }, beforeRow: TAX, afterRow: SAMPLE }),
    /disturb Effect In Stock/
  );
  // Taking the series off, or putting one on a bill that had none.
  assert.match(alterNumberProblem({ before: bill, after: { series: "", date: "2026-10-15" }, beforeRow: TAX }), /cannot be changed/);
  assert.match(
    alterNumberProblem({ before: { series: "", finYear: null }, after: { series: "TAX", date: "2026-10-15" }, afterRow: TAX }),
    /cannot be changed/
  );
  // Re-dated into another financial year: refused, with both years named.
  assert.match(
    alterNumberProblem({ before: bill, after: { series: "TAX", date: "2027-04-01" }, beforeRow: TAX, afterRow: TAX }),
    /26-27.*27-28/
  );
  // A bill with no series has no book to leave.
  assert.equal(alterNumberProblem({ before: { series: "" }, after: { series: "", date: "2030-01-01" } }), "");
});

test("the bill screen locks the Series box on a saved bill", () => {
  const src = read("../components/billing/BillingScreen.jsx");
  assert.match(src, /data-master-field='series'[\s\S]{0,200}disabled=\{Boolean\(value\)\}/);
});

console.log(`\n  ${passed} checks passed\n`);
