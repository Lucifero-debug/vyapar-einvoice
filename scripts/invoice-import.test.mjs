/**
 * Fixture tests for reading a purchase bill off a photograph.
 *
 *   node scripts/invoice-import.test.mjs
 *
 * An import is the one path into these books where the INPUT is a guess. A
 * camera and a language model between them will misread a quantity, drop a
 * decimal, spell a supplier differently from the master and read the bill's
 * own round-off line as an item. So the tests here are not mostly about
 * extraction -- they are about what the app does with a guess:
 *
 *   1. AN EXACT MATCH IS APPLIED; A LIKELY ONE IS ONLY SUGGESTED. Applying a
 *      string similarity posts a bill to the wrong account, and the wrong
 *      account is somebody whose balance is now wrong and whose statement
 *      shows a bill they never sent.
 *
 *   2. THE MONEY IS OURS, NOT THE MODEL'S. Every figure is recomputed by
 *      `recalcItem` -- the same function the four billing screens use -- and
 *      the printed totals are kept only as evidence that the rows were read
 *      right. The old import posted the model's own arithmetic.
 *
 *   3. THE SUPPLIER'S BILL NUMBER IS NOT OURS. `Invoice.invoiceNo` is this
 *      firm's own sequence with a unique index on it. The old import did
 *      `parseInt(aiInvoice.invoiceNo)`, which collided with a real invoice
 *      when the number parsed and wrote NaN into a required field when it
 *      did not.
 *
 *   4. CGST+SGST VERSUS IGST IS NOT A DEFAULT. The old import fell back to
 *      `"local"` and `"Delhi"`. That is a tax decision taken by a `||`.
 *
 *   5. A CHARGE IS NOT AN ITEM. A bill's freight row reads exactly like an
 *      item row, and the old import made it an item master entry and a stock
 *      movement -- so the firm had 1 of "Loading charges" on the shelf.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  EXTRACTION_FIELDS,
  EXTRACTION_FIELD_NAMES,
  IMPORT_DRAFT_KEY,
  LINE_FIELDS,
  MATCH_APPLIED,
  MATCH_NONE,
  MATCH_SUGGESTED,
  MAX_SUGGESTIONS,
  SUGGEST_FLOOR,
  draftFromExtraction,
  extractionPrompt,
  importIsReady,
  importLine,
  importWarnings,
  looksLikeCharge,
  matchMaster,
  matchParty,
  nameScore,
  nameTokens,
  newMasters,
  normalizeExtraction,
  num,
  parseExtractionJson,
  reconcileTotals,
  stateCodeOfGstin,
  taxTypeFor,
} from "../lib/invoiceImport.mjs";
import { recalcItem } from "../lib/billingMath.mjs";
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
const code = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

const PARTIES = [
  {
    _id: "p1",
    name: "Bharat Steel Corporation",
    group: "supplier",
    gstIn: "27AAACB2222B1Z6",
    state: "Maharashtra",
    stateCode: "27",
  },
  { _id: "p2", name: "Acme Traders", group: "customer", stateCode: "07" },
  { _id: "p3", name: "Zenith Industries", group: "supplier", stateCode: "07" },
];

const ITEMS = [
  { _id: "i1", name: "MS Angle 50x50", hsn: "7216", unit: "KG", gst: 18 },
  { _id: "i2", name: "MS Plate 10mm", hsn: "7208", unit: "KG", gst: 18 },
  { _id: "i3", name: "Copper Wire 2.5sqmm", hsn: "8544", unit: "MTR", gst: 18 },
];

const COMPANY = { name: "Shah Brothers", stateCode: "07", gstin: "07AAACS9999S1Z1" };

const BILL = {
  supplierName: "Bharat Steel Corporation",
  supplierGstin: "27AAACB2222B1Z6",
  buyerGstin: "07AAACS9999S1Z1",
  supplierInvoiceNo: "BS/2026-27/4417",
  date: "2026-10-05",
  printedTaxable: "1,00,000.00",
  printedGst: "18,000.00",
  printedTotal: "₹1,18,000.00",
  lines: [
    { name: "MS Angle 50x50", hsn: "7216", unit: "KG", quantity: "500", rate: "120", gstRate: "18" },
    { name: "MS Plate 10mm", hsn: "7208", unit: "KG", quantity: "200", rate: "200", gstRate: "18" },
  ],
};

const draft = (over = {}) =>
  draftFromExtraction({
    extraction: { ...BILL, ...over },
    parties: PARTIES,
    items: ITEMS,
    company: COMPANY,
  });

console.log("\n--- reading the numbers off a bill ---");

test("rupee signs, lakh commas and padding all parse", () => {
  assert.equal(num("1,00,000.00"), 100000);
  assert.equal(num("₹1,18,000.00"), 118000);
  assert.equal(num(" 120 "), 120);
  // A comma before THREE digits is a group separator and must survive. The
  // decimal-comma guard below must not reach this far.
  assert.equal(num("1,250"), 1250);
  assert.equal(num("1,18,000"), 118000);
  assert.equal(num("0"), 0);
  assert.equal(num(12.5), 12.5);
});

test("nothing readable is NULL, never a silent zero", () => {
  // The difference matters: a quantity of 0 is a row to query, and a
  // quantity that was not read is a row to type in. `|| 0` makes them the
  // same thing and the old import did exactly that.
  for (const nothing of ["", "   ", null, undefined, "n/a", "-", "abc", {}, []]) {
    assert.equal(num(nothing), null, JSON.stringify(nothing));
  }
});

test("a European decimal comma is refused rather than guessed at", () => {
  // "1 250,50" on an Indian bill read by a camera: guessing which of the
  // comma and the stop is the separator turns a rate of 1.250 into 1250.
  assert.equal(num("1 250,50"), null);
});

console.log("\n--- the extraction is untrusted input ---");

test("only the declared fields come through", () => {
  const out = normalizeExtraction({
    ...BILL,
    sneaky: "x",
    invoiceNo: 99,
    totalAmount: 50,
    __proto__: { bad: 1 },
  });
  assert.deepEqual(Object.keys(out).sort(), [...EXTRACTION_FIELD_NAMES].sort());
  assert.equal("sneaky" in out, false);
  // `invoiceNo` and `totalAmount` are OUR fields. The model is never asked
  // for them and cannot supply them -- mistakes 1 and 3 in the header.
  assert.equal("invoiceNo" in out, false);
  assert.equal("totalAmount" in out, false);
});

test("the field list the prompt uses is the field list the normaliser knows", () => {
  // One list drives both. A field the prompt asks for and this does not know
  // is dropped on every bill, which is the bug you only find by reading both.
  for (const field of EXTRACTION_FIELDS) {
    assert.ok(field.name, "a field with no name");
    assert.ok(field.note && field.note.length > 10, `${field.name} has no note for the prompt`);
  }
  assert.ok(EXTRACTION_FIELD_NAMES.includes("supplierInvoiceNo"));
  assert.equal(EXTRACTION_FIELD_NAMES.includes("invoiceNo"), false);
  assert.deepEqual(LINE_FIELDS, ["name", "hsn", "unit", "quantity", "rate", "discountPercent", "gstRate"]);
});

test("a row with no name is not a row", () => {
  // Bills carry sub-totals, "carried forward" lines and stray marks.
  const out = normalizeExtraction({
    lines: [{ name: "Real item", quantity: 1 }, { name: "  " }, { quantity: 5 }, null, "x"],
  });
  assert.equal(out.lines.length, 1);
  assert.equal(out.lines[0].name, "Real item");
});

test("a GSTIN is upper-cased and stripped of spaces", () => {
  const out = normalizeExtraction({ supplierGstin: "27 aaacb2222b1z6 " });
  assert.equal(out.supplierGstin, "27AAACB2222B1Z6");
});

test("lines is never anything but an array", () => {
  for (const bad of [null, "x", 5, {}]) {
    assert.deepEqual(normalizeExtraction({ lines: bad }).lines, []);
  }
  assert.deepEqual(normalizeExtraction(null).lines, []);
  assert.deepEqual(normalizeExtraction("nonsense").lines, []);
});

console.log("\n--- names ---");

test("a size reads the same however it is spaced", () => {
  assert.deepEqual(nameTokens("MS Plate 10mm"), ["ms", "plate", "10", "mm"]);
  assert.deepEqual(nameTokens("MS Plat 10 mm"), ["ms", "plat", "10", "mm"]);
  assert.equal(nameScore("MS Angle 50x50", "MS ANGLE 50 X 50"), 1);
});

test("a legal form is not part of the name; a trading word is", () => {
  // "Pvt Ltd" is noise a shop types or does not. "Steel" is the difference
  // between two suppliers.
  assert.deepEqual(nameTokens("Bharat Steel Pvt. Ltd."), ["bharat", "steel"]);
  assert.ok(nameScore("Bharat Steel Pvt Ltd", "Bharat Steel Private Limited") === 1);
  assert.ok(nameScore("Bharat Steel", "Bharat Textiles") < SUGGEST_FLOOR);
});

test("one slip inside a long word is the same word; inside a short one it is not", () => {
  // "Plat" for "Plate" is a camera. "Rid" for "Rod" is a different item --
  // and at three letters a single edit is most of the word.
  assert.equal(nameScore("MS Plate 10mm", "MS Plat 10 mm"), 1);
  assert.ok(nameScore("Steel Rod", "Steel Rid") < SUGGEST_FLOOR);
  // TWO slips is a different word. "Plate" and "Plant" are one letter apart
  // twice over, and they are not the same item.
  assert.ok(nameScore("MS Plate", "MS Plant") < SUGGEST_FLOOR);
  assert.ok(nameScore("Copper Wire 2.5sqmm", "Coppar Wire 2.5 sqmm") >= 0.8);
});

test("one master token cannot absorb two of the bill's", () => {
  // Without spending each right-hand token once, "MS Plate Plat" scores a
  // perfect match against "MS Plate" -- both "plate" and "plat" claim the
  // same master token, and three shared tokens out of two is a score above 1.
  assert.ok(nameScore("MS Plate Plat", "MS Plate") < 1);
});

test("an abbreviated name scores against the longer one it abbreviates", () => {
  assert.ok(nameScore("Bharat Steel", "Bharat Steel Corporation") >= 0.8);
});

test("two unrelated names score nothing", () => {
  assert.equal(nameScore("Acme Traders", "Zenith Industries"), 0);
  assert.equal(nameScore("", "Acme"), 0);
  assert.equal(nameScore("Acme", ""), 0);
});

console.log("\n--- an exact match is applied; a likely one is only suggested ---");

test("the same name, differing only in case or padding, is APPLIED", () => {
  // `nameKey` already treats these as identical everywhere else in the app,
  // and `findNameClash` stops two such rows both existing -- so matching one
  // is not a guess.
  for (const spelling of ["MS Angle 50x50", "ms angle 50x50", "  MS ANGLE 50X50  "]) {
    const m = matchMaster(spelling, ITEMS);
    assert.equal(m.how, MATCH_APPLIED, spelling);
    assert.equal(m.record._id, "i1", spelling);
    assert.equal(m.score, 1);
    assert.deepEqual(m.suggestions, []);
  }
});

test("A NEAR MISS IS NEVER APPLIED", () => {
  // The single most important assertion in this file. Applying this posts
  // the bill to whichever account the string resembled.
  const m = matchMaster("MS Plat 10 mm", ITEMS);
  assert.equal(m.how, MATCH_SUGGESTED);
  assert.notEqual(m.how, MATCH_APPLIED);
  assert.equal(m.suggestions[0].name, "MS Plate 10mm");
  assert.ok(m.suggestions[0].score >= SUGGEST_FLOOR);
});

test("nothing close enough is suggested at all", () => {
  const m = matchMaster("Hydraulic Pump Assembly", ITEMS);
  assert.equal(m.how, MATCH_NONE);
  assert.deepEqual(m.suggestions, []);
  assert.equal(m.record, null);
});

test("an empty needle matches nothing, rather than the first row", () => {
  for (const nothing of ["", "   ", null, undefined]) {
    assert.equal(matchMaster(nothing, ITEMS).how, MATCH_NONE);
  }
});

test("suggestions are ranked and capped", () => {
  // Deliberately NOT containing the needle: a fixture holding an exact match
  // returns MATCH_APPLIED with no suggestions at all, and then neither the
  // ranking nor the cap is being tested. That is how both of these passed
  // while broken.
  // Listed WORST FIRST, on purpose. `Array.prototype.sort` is stable, so a
  // comparator that returns 0 leaves the insertion order alone -- and a
  // fixture listed best-first is then still in descending order and the
  // assertion below passes with the ranking removed. That is exactly how
  // this one passed while broken.
  const many = [
    { _id: "m5", name: "MS Sheet 10mm" },
    { _id: "m4", name: "MS Plate 12mm Heavy Duty Grade" },
    { _id: "m3", name: "MS Plate" },
    { _id: "m7", name: "MS Plate 6mm Grade C" },
    { _id: "m6", name: "MS Plate 8mm Grade B" },
    { _id: "m2", name: "MS Plate 10mm" },
    { _id: "m1", name: "MS Plate 10mm Grade A" },
  ];
  const m = matchMaster("MS Plate 10mm Grade", many);
  assert.equal(m.how, MATCH_SUGGESTED);
  // CAPPED: more rows clear the floor than are worth showing.
  assert.ok(m.suggestions.length > 1, "the fixture must produce several near misses");
  assert.ok(m.suggestions.length <= MAX_SUGGESTIONS, `${m.suggestions.length} suggestions`);
  // RANKED, and with genuinely different scores -- a fixture where every row
  // scores the same is sorted correctly by accident.
  // The closest is first, named rather than merely implied by the ordering.
  assert.equal(m.suggestions[0].name, "MS Plate 10mm Grade A");
  const scores = m.suggestions.map((sg) => sg.score);
  assert.ok(new Set(scores).size > 1, "the fixture must produce different scores");
  for (let i = 1; i < scores.length; i += 1) {
    assert.ok(scores[i - 1] >= scores[i], `${scores.join(" ")} is not descending`);
  }
  // And an exact match still wins outright over all of them.
  assert.equal(
    matchMaster("MS Plate 10mm Grade", [...many, { _id: "x", name: "MS Plate 10mm Grade" }]).how,
    MATCH_APPLIED
  );
});

test("a master row with no name is skipped rather than matched", () => {
  assert.equal(matchMaster("Anything", [{ _id: "x" }, { _id: "y", name: "   " }]).how, MATCH_NONE);
});

console.log("\n--- the party ---");

test("a GSTIN outranks a name", () => {
  // Two shops can share a name; no two share a registration. It is also the
  // only way to recognise a supplier whose bill spells their name
  // differently from the master.
  const m = matchParty(
    { supplierGstin: "27AAACB2222B1Z6", supplierName: "B. S. Corp" },
    PARTIES
  );
  assert.equal(m.how, MATCH_APPLIED);
  assert.equal(m.by, "gstin");
  assert.equal(m.record._id, "p1");
});

test("a short or absent GSTIN falls back to the name", () => {
  const m = matchParty({ supplierGstin: "27AAA", supplierName: "Zenith Industries" }, PARTIES);
  assert.equal(m.how, MATCH_APPLIED);
  assert.equal(m.by, "name");
  assert.equal(m.record._id, "p3");
});

test("a supplier nobody has an account for is reported, not invented", () => {
  const d = draft({ supplierName: "Brand New Supplier", supplierGstin: "" });
  assert.equal(d.party.how, MATCH_NONE);
  assert.equal(d.party.name, "");
  // And what to put in their master is offered, filed as a SUPPLIER --
  // never guessed from the sign of a balance.
  assert.equal(d.party.proposed.name, "Brand New Supplier");
  assert.equal(d.party.proposed.group, "supplier");
  assert.deepEqual(newMasters(d).suppliers, [d.party.proposed]);
});

test("a party that WAS matched is not also offered as new", () => {
  // Offering both is how a master ends up with two accounts for one
  // supplier, which is the duplicate this matching exists to prevent.
  const d = draft();
  assert.equal(d.party.how, MATCH_APPLIED);
  assert.equal(d.party.proposed, null);
  assert.deepEqual(newMasters(d).suppliers, []);
});

test("the state read off the bill goes into the MASTER, not onto the invoice", () => {
  // lib/placeOfSupply.mjs takes the place of supply from the party's master
  // and from nowhere else. A draft that carried a state read off paper onto
  // the invoice would be deciding the tax from a photograph.
  const d = draft({
    supplierName: "Brand New Supplier",
    supplierGstin: "29AAACZ1234Z1Z5",
    supplierState: "Karnataka",
  });
  assert.equal(d.party.proposed.state, "Karnataka");
  assert.equal(d.party.proposed.stateCode, "29");
  assert.equal("stateOfSupply" in d, false, "a draft must not carry a place of supply");
});

console.log("\n--- the lines ---");

test("the master fills in what the bill did not say", () => {
  // The master is what the firm has DECIDED about that item. A camera
  // reading a smudged GST column is not better evidence than that.
  const line = importLine({ name: "MS Plate 10mm", quantity: 10, rate: 200 }, ITEMS);
  assert.equal(line.hsn, "7208");
  assert.equal(line.gstRate, 18);
  assert.equal(line.unit, "KG");
  assert.equal(line.match.how, MATCH_APPLIED);
  assert.deepEqual(line.match.missing, []);
});

test("where the bill DOES say and the master disagrees, the bill wins and it is reported", () => {
  // A supplier who has changed their HSN is a thing to know about rather
  // than to overwrite.
  const line = importLine(
    { name: "MS Plate 10mm", hsn: "7225", gstRate: 12, quantity: 10, rate: 200 },
    ITEMS
  );
  assert.equal(line.hsn, "7225");
  assert.equal(line.gstRate, 12);
  assert.equal(line.match.differs.length, 2);
  assert.match(line.match.differs.join(" "), /7225/);
  assert.match(line.match.differs.join(" "), /7208/);
  assert.match(line.match.differs.join(" "), /12%/);
});

test("the rate off the bill is the COST, never the selling price", () => {
  // `resolveItemPricing` reads `salePrice` unconditionally, which would
  // price a purchase at what the firm sells it for.
  const line = importLine({ name: "MS Plate 10mm", quantity: 10, rate: 200 }, ITEMS);
  assert.equal(line.cost, 200);
  assert.equal("salePrice" in line, false);
});

test("what was read is kept beside what was decided", () => {
  const line = importLine({ name: "ms plate 10mm", hsn: "7208", quantity: "10", rate: "200" }, ITEMS);
  assert.equal(line.name, "MS Plate 10mm", "the master's spelling is used");
  assert.equal(line.match.read.name, "ms plate 10mm", "the bill's own words are kept");
  assert.equal(line.match.read.quantity, 10);
});

test("a row that was not fully read says exactly what is missing", () => {
  const line = importLine({ name: "MS Plate 10mm", rate: "200" }, ITEMS);
  assert.deepEqual(line.match.missing, ["quantity"]);
  // And it is NOT silently zero -- it is zero on the draft so the form can
  // render it, and `missing` is what blocks the save.
  assert.equal(line.quantity, 0);
  const noRate = importLine({ name: "MS Plate 10mm", quantity: "5" }, ITEMS);
  assert.deepEqual(noRate.match.missing, ["rate"]);
  const neither = importLine({ name: "Unknown thing", quantity: "", rate: "" }, ITEMS);
  assert.deepEqual(neither.match.missing, ["quantity", "rate", "hsn"]);
});

test("a missing figure BLOCKS the save", () => {
  // Not merely noted. A quantity that was not read is zero on the draft so
  // the form can render it, and a zero quantity saved is a stock movement of
  // nothing against a bill for something.
  const d = draft({ lines: [{ name: "MS Plate 10mm", rate: "200" }] });
  assert.equal(importIsReady(d), false);
  const warning = importWarnings(d).find((w) => w.field === "lines.0.quantity");
  assert.equal(warning.severity, "blocking");
  assert.match(warning.message, /no quantity was read/);
});

test("every line carries the five fields the invoice schema requires", () => {
  const d = draft();
  for (const line of d.lines) {
    for (const required of ["name", "quantity", "cost", "discount", "total"]) {
      assert.ok(required in line, required);
      assert.notEqual(line[required], undefined, required);
    }
  }
});

console.log("\n--- a charge is not an item ---");

test("a freight row is recognised, and only when it has no HSN", () => {
  for (const name of ["Freight", "Loading charges", "Packing & Forwarding", "Insurance", "Round Off"]) {
    assert.equal(looksLikeCharge({ name }), true, name);
  }
  // A firm that genuinely trades in packing material has an HSN for it.
  assert.equal(looksLikeCharge({ name: "Packing Tape", hsn: "3919" }), false);
  assert.equal(looksLikeCharge({ name: "MS Plate 10mm" }), false);
  assert.equal(looksLikeCharge({}), false);
});

test("only rows that matched NOTHING are offered as new items", () => {
  const d = draft({
    lines: [
      // matched exactly -- not offered
      { name: "MS Plate 10mm", hsn: "7208", quantity: 1, rate: 100, gstRate: 18 },
      // a near miss -- a QUESTION, not a missing master. Offering it beside
      // the suggestion is how the master ends up holding both spellings.
      { name: "MS Plat 10 mm", hsn: "7208", quantity: 1, rate: 100, gstRate: 18 },
      // nothing like it -- offered
      { name: "Hydraulic Pump", hsn: "8413", quantity: 1, rate: 100, gstRate: 18 },
      // and the same new thing twice -- offered ONCE
      { name: "hydraulic pump", hsn: "8413", quantity: 2, rate: 100, gstRate: 18 },
    ],
  });
  assert.deepEqual(newMasters(d).items.map((i) => i.name), ["Hydraulic Pump"]);
});

test("a new item is seeded with the purchase price, never the selling price", () => {
  const d = draft({ lines: [{ name: "Hydraulic Pump", hsn: "8413", quantity: 1, rate: 4500, gstRate: 18 }] });
  const [proposed] = newMasters(d).items;
  assert.equal(proposed.purchasePrice, 4500);
  assert.equal(proposed.cost, 4500);
  // The firm sets what it SELLS for. A bill tells us what we paid.
  assert.equal("salePrice" in proposed, false);
  assert.equal(proposed.hsn, "8413");
  assert.equal(proposed.gst, 18);
});

test("it is flagged, not blocked, and never offered as an item master", () => {
  // The old import made it an item and a stock movement, so the firm had 1
  // of "Loading charges" on the shelf.
  const d = draft({
    lines: [...BILL.lines, { name: "Loading charges", quantity: "1", rate: "500" }],
  });
  const charge = d.lines[2];
  assert.equal(charge.match.charge, true);
  assert.deepEqual(charge.match.missing, [], "a charge is not missing an HSN");
  assert.equal(newMasters(d).items.some((i) => i.name === "Loading charges"), false);
  const warning = importWarnings(d).find((w) => w.field === "lines.2");
  assert.equal(warning.severity, "check");
  assert.match(warning.message, /reads like a charge/);
});

console.log("\n--- the money is ours, not the model's ---");

test("every figure is recomputed by the same function the billing screens use", () => {
  const d = draft();
  for (const line of d.lines) {
    const ours = recalcItem({
      name: line.name,
      quantity: line.quantity,
      cost: line.cost,
      discount: line.discount,
      gstRate: line.gstRate,
    });
    assert.equal(line.taxableAmount, ours.taxableAmount, line.name);
    assert.equal(line.gstAmount, ours.gstAmount, line.name);
    assert.equal(line.total, ours.total, line.name);
  }
  // 500 x 120 + 200 x 200 = 100,000 taxable; 18% = 18,000.
  assert.equal(d.totals.taxable, 100000);
  assert.equal(d.totals.gst, 18000);
  // Tax-INCLUSIVE, like Invoice.totalAmount everywhere else.
  assert.equal(d.totals.total, 118000);
});

test("a discount is applied before the tax", () => {
  const line = importLine(
    { name: "MS Plate 10mm", quantity: 10, rate: 100, discountPercent: 10, gstRate: 18 },
    ITEMS
  );
  assert.equal(line.taxableAmount, 900);
  assert.equal(line.gstAmount, 162);
  assert.equal(line.total, 1062);
});

test("the printed totals are evidence, not figures -- and a difference is REPORTED", () => {
  // Silently bending our rows to match a number read off a photograph is how
  // a bill comes to disagree with its own lines.
  const d = draft({ printedTotal: "120000" });
  assert.equal(d.totals.total, 118000, "the rows are what will be saved");
  assert.equal(d.totals.checks.total.printed, 120000);
  assert.equal(d.totals.checks.total.difference, -2000);
  assert.equal(d.totals.checks.total.agrees, false);
  const warning = importWarnings(d).find((w) => w.field === "totals.total");
  assert.equal(warning.severity, "check");
  assert.match(warning.message, /The rows are what will be saved/);
});

test("a round-off sized difference is tolerated", () => {
  const d = draft({ printedTotal: "118000.60" });
  assert.equal(d.totals.checks.total.agrees, true);
  assert.equal(importWarnings(d).some((w) => w.field === "totals.total"), false);
});

test("a printed total that was not read is not a discrepancy", () => {
  const d = draft({ printedTotal: "", printedGst: "", printedTaxable: "" });
  assert.equal(d.totals.checks.total, null);
  assert.equal(importWarnings(d).some((w) => String(w.field).startsWith("totals.")), false);
});

test("the totals of no lines are zero, not NaN", () => {
  const t = reconcileTotals([], {});
  assert.deepEqual([t.taxable, t.gst, t.total], [0, 0, 0]);
});

console.log("\n--- CGST+SGST versus IGST is not a default ---");

test("it comes from the two state codes", () => {
  assert.equal(taxTypeFor("07", "07"), "local");
  assert.equal(taxTypeFor("27", "07"), "central");
  assert.equal(taxTypeFor("7", "07"), "local", "a single digit is normalised");
});

test("a missing code gives NULL, not a guess", () => {
  // The old import's `|| "local"` is a tax decision taken by a fallback.
  assert.equal(taxTypeFor("", "07"), null);
  assert.equal(taxTypeFor("27", ""), null);
  assert.equal(taxTypeFor(null, undefined), null);
  const d = draft({ supplierGstin: "", buyerGstin: "" });
  // The matched party's master still supplies it where it can...
  assert.equal(d.taxType, "central", "from the party master's state code");
  // ...and with neither, it is null and the warning says so.
  const blind = draftFromExtraction({
    extraction: { ...BILL, supplierGstin: "", buyerGstin: "", supplierName: "Nobody" },
    parties: [],
    items: ITEMS,
    company: {},
  });
  assert.equal(blind.taxType, null);
  assert.match(importWarnings(blind).find((w) => w.field === "taxType").message, /CGST\+SGST or IGST/);
});

test("the state code is read off the GSTIN, which is where it lives", () => {
  assert.equal(stateCodeOfGstin("27AAACB2222B1Z6"), "27");
  assert.equal(stateCodeOfGstin("07AAACS9999S1Z1"), "07");
  // Only from a full one: the first two characters of a half-typed GSTIN are
  // not a state code.
  assert.equal(stateCodeOfGstin("27AAA"), "");
  assert.equal(stateCodeOfGstin(""), "");
});

console.log("\n--- the supplier's bill number is not ours ---");

test("it is kept whole, letters and slashes included", () => {
  // `parseInt("BS/2026-27/4417")` is NaN, and `parseInt("4417")` would
  // collide with this firm's own invoice 4417 -- there is a unique index on
  // { companyId, invoiceNo }.
  const d = draft();
  assert.equal(d.partyBillNo, "BS/2026-27/4417");
  assert.equal("invoiceNo" in d, false, "a draft must not carry an invoice number");
});

test("an unreadable one is a note to type it in, not a NaN", () => {
  const d = draft({ supplierInvoiceNo: "" });
  assert.equal(d.partyBillNo, "");
  assert.match(importWarnings(d).find((w) => w.field === "partyBillNo").message, /how you find this bill/);
});

console.log("\n--- what the person is told ---");

test("a clean bill against existing masters has nothing blocking", () => {
  const d = draft();
  assert.equal(importIsReady(d), true);
  assert.deepEqual(importWarnings(d).filter((w) => w.severity === "blocking"), []);
});

test("an unmatched party or item BLOCKS the save", () => {
  const d = draft({ supplierName: "Nobody At All", supplierGstin: "" });
  assert.equal(importIsReady(d), false);
  const party = importWarnings(d).find((w) => w.field === "party");
  assert.equal(party.severity, "blocking");
  assert.match(party.message, /not in your accounts/);

  const rows = draft({ lines: [{ name: "Hydraulic Pump", hsn: "8413", quantity: 1, rate: 100 }] });
  assert.equal(importIsReady(rows), false);
  assert.match(importWarnings(rows).find((w) => w.field === "lines.0").message, /item master/);
});

test("a near-miss blocks too, and names what it might be", () => {
  // Blocking is the point: the person must say whether it is the same thing.
  const d = draft({ supplierName: "Bharat Steels", supplierGstin: "" });
  assert.equal(d.party.how, MATCH_SUGGESTED);
  assert.equal(importIsReady(d), false);
  assert.match(importWarnings(d).find((w) => w.field === "party").message, /Did you mean "Bharat Steel Corporation"/);
});

test("a bill that read as nothing at all says so", () => {
  const d = draft({ lines: [] });
  assert.equal(importIsReady(d), false);
  assert.match(importWarnings(d).find((w) => w.field === "lines").message, /No item rows/);
});

test("the blocking ones come first", () => {
  const d = draft({
    supplierName: "Nobody",
    supplierGstin: "",
    printedTotal: "999999",
    lines: [{ name: "Hydraulic Pump", quantity: 1, rate: 100 }],
  });
  const warnings = importWarnings(d);
  const firstCheck = warnings.findIndex((w) => w.severity === "check");
  const lastBlocking = warnings.map((w) => w.severity).lastIndexOf("blocking");
  assert.ok(lastBlocking < firstCheck, "a check was sorted above a blocker");
});

console.log("\n--- what is NOT done here ---");

test("nothing in this module writes anything", () => {
  const src = read("../lib/invoiceImport.mjs");
  assert.equal(/import mongoose/.test(src), false);
  assert.equal(/from "\.\.\/models/.test(src), false);
  // And it does not call the model either -- the extraction arrives as an
  // argument, which is what makes every test above possible.
  assert.equal(/fetch\(/.test(code(src)), false);
});

test("the draft waits in sessionStorage, not in the URL", () => {
  // The old page put the whole items array through encodeURIComponent into a
  // query string: a bill's worth of data in the address bar, in the browser
  // history and in every server log that records a URL.
  assert.match(IMPORT_DRAFT_KEY, /^vyapaar:/);
});

console.log("\n--- the prompt and the parser ---");

test("the prompt asks for exactly the fields the normaliser reads", () => {
  // One list drives both. A prompt asking for `invoiceTotal` while the
  // normaliser reads `printedTotal` comes back empty on every bill and looks
  // like a model that cannot read totals.
  const prompt = extractionPrompt();
  for (const name of EXTRACTION_FIELD_NAMES) {
    assert.ok(prompt.includes(`"${name}"`), `the prompt never mentions ${name}`);
  }
  // And it does not ask for OUR fields.
  for (const ours of ['"invoiceNo"', '"totalAmount"', '"stateOfSupply"', '"taxType"']) {
    assert.equal(prompt.includes(ours), false, `the prompt asks the model for ${ours}`);
  }
});

test("the prompt carries the four instructions that bills get misread without", () => {
  // Checked against the RULES section alone. The field notes mention some of
  // the same things, so a check over the whole prompt passes even with a
  // rule deleted -- which is how two of these passed while broken.
  const whole = extractionPrompt();
  const rules = whole.slice(whole.indexOf("Rules:")).toLowerCase();
  assert.ok(rules.length > 100, "the rules section was not found");
  const prompt = rules;
  // The rate column and the amount column are adjacent; reading one as the
  // other multiplies the bill by the quantity.
  assert.match(prompt, /rate per unit/);
  // 05-10-2026 is 5 October; read as American it lands in May, and in the
  // wrong GST return.
  assert.match(prompt, /dd-mm-yyyy/);
  // A guessed figure is indistinguishable from a read one once it is in the
  // draft, and the whole review depends on knowing which is which.
  assert.match(prompt, /leave the key out/);
  // Both names are on the bill in similar boxes.
  assert.match(prompt, /do not swap them/);
});

test("JSON is found however the model wraps it", () => {
  assert.deepEqual(parseExtractionJson('{"supplierName":"A"}'), { supplierName: "A" });
  assert.deepEqual(parseExtractionJson('```json\n{"supplierName":"A"}\n```'), { supplierName: "A" });
  assert.deepEqual(parseExtractionJson('```\n{"supplierName":"A"}\n```'), { supplierName: "A" });
  assert.deepEqual(
    parseExtractionJson('Here is the bill:\n{"supplierName":"A"}\nLet me know!'),
    { supplierName: "A" }
  );
});

test("something that is not an extraction is null, not a crash", () => {
  // The route turns null into a sentence the person can act on. A thrown
  // SyntaxError is not that.
  for (const bad of ["", "   ", "I cannot read this bill.", "[1,2,3]", '"a string"', "null", null]) {
    assert.equal(parseExtractionJson(bad), null, JSON.stringify(bad));
  }
});

console.log("\n--- security ---");

test("the route is tenant-scoped and takes the firm from the session", () => {
  const route = read("../app/api/invoice-extract/route.js");
  assert.match(route, /export const POST = tenantRoute\(handlePOST\);/);
  assert.match(route, /Company\.findById\(auth\.companyId\)/);
  assert.equal(/body\??\.companyId/.test(route), false);
  // The image type comes from the BYTES -- the same sniffer the logo upload
  // uses, for the same reason.
  assert.match(route, /sniffImageType\(bytes\)/);
  // The masters are matched server-side, in two queries for the whole bill.
  assert.match(route, /Promise\.all/);
  assert.match(route, /draftFromExtraction\(/);
});

test("the route writes nothing", () => {
  const route = code(read("../app/api/invoice-extract/route.js"));
  // THE WHOLE POINT. The old page POSTed to /api/save-invoice.
  assert.equal(/save-invoice/.test(route), false);
  assert.equal(/\.create\(|findByIdAndUpdate|updateOne|insertMany/.test(route), false);
});

test("the model key is not a NEXT_PUBLIC one", () => {
  // The old service URL was NEXT_PUBLIC_, and a key that reaches the browser
  // is a key that is published.
  const route = read("../app/api/invoice-extract/route.js");
  assert.match(route, /process\.env\.INVOICE_AI_KEY/);
  assert.equal(/NEXT_PUBLIC_[A-Z_]*KEY/.test(route), false);
  // And it answers plainly when there is none, rather than failing somewhere
  // less obvious.
  assert.match(route, /INVOICE_AI_KEY/);
  assert.match(route, /503/);
});

test("the upload page no longer saves, and no longer puts a bill in the URL", () => {
  const page = code(read("../app/upload/page.js"));
  assert.equal(/save-invoice/.test(page), false, "the page still saves");
  assert.equal(/encodeURIComponent\(JSON\.stringify/.test(page), false, "a bill is still going into a URL");
  assert.match(page, /invoice-extract/);
  assert.match(page, /IMPORT_DRAFT_KEY/);
  assert.match(page, /sessionStorage/);
  // And it hands over to the ordinary purchase screen rather than the print
  // view of a bill it just wrote.
  assert.match(page, /purchaseadd\?import=1/);
});

test("the billing screen reads the draft ONCE and removes it", () => {
  const screen = read("../components/billing/BillingScreen.jsx");
  assert.match(screen, /sessionStorage\.getItem\(IMPORT_DRAFT_KEY\)/);
  // Removed in the same breath: a refresh must not re-apply it over what the
  // person has since typed, and an abandoned import must not land on a
  // different bill tomorrow.
  assert.match(screen, /sessionStorage\.removeItem\(IMPORT_DRAFT_KEY\)/);
  // The party is applied only on an exact match.
  assert.match(screen, /draft\.party\?\.how === MATCH_APPLIED/);
  // And nothing in the import sets a place of supply or a tax type -- those
  // follow the party's master through lib/placeOfSupply.mjs.
  // The effect's BODY, from where it reads the draft to where it reports
  // what it did. Slicing from the import statement at the top of the file
  // would span the whole screen, including the load-an-existing-invoice path
  // that legitimately sets all three.
  const from = screen.indexOf("sessionStorage.getItem(IMPORT_DRAFT_KEY)");
  const to = screen.indexOf("setImportPrefill({", from);
  assert.ok(from > 0 && to > from, "could not find the import effect");
  const applied = screen.slice(from, to);
  assert.equal(/setStateOfSupply|setTaxType|setStateCode/.test(applied), false);
});

test("the supplier bill number has a declared home and travels the payload", () => {
  const model = read("../models/invoiceModel.js");
  assert.match(model, /partyBillNo: \{ type: String/);
  const math = read("../lib/billingMath.mjs");
  assert.match(math, /"partyBillNo",/);
  assert.match(math, /partyBillNo: form\.partyBillNo,/);
  const screen = read("../components/billing/BillingScreen.jsx");
  assert.match(screen, /setPartyBillNo/);
});

test("the route is behind the SAME permission as the screen it serves", () => {
  // Equal, not merely set. A route behind a weaker rule than its own page is
  // how somebody who cannot open the importer calls it anyway -- and this
  // one creates masters and spends the firm's model budget per call.
  assert.ok(permissionForPath("/api/invoice-extract"), "the route is not in the table at all");
  assert.equal(permissionForPath("/api/invoice-extract"), permissionForPath("/upload"));
  for (const role of ["owner", "accountant", "biller"]) {
    assert.equal(
      canAccessPath(role, "/api/invoice-extract"),
      canAccessPath(role, "/upload"),
      role
    );
  }
});

console.log(`\n  ${passed} checks passed\n`);
