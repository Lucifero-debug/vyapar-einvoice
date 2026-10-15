/**
 * Fixture tests for Unit Quantity Codes.
 *
 *   node scripts/uqc.test.mjs
 *
 * The IRP accepts 44 codes and nothing else. What makes this worth testing is
 * not the list -- it is the two temptations around it:
 *
 *   1. Guessing the code from the shop's free-text unit. "bori" is not BAG,
 *      "ltr" is not a code at all, and a silent mapping turns a wrong guess
 *      into a filing nobody can take back. Unmatched means OTH, deliberately.
 *
 *   2. Letting the billing page decide. The page copies the whole item row
 *      into each line, so a stale copy would outrank the master. The master
 *      wins, and an invoice keeps the code it was filed with.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  UQC_CODES,
  UQC_DEFAULT,
  isServcFlag,
  isUqc,
  itemIndex,
  normalizeUqc,
  stampItemLines,
  uqcLabel,
} from "../lib/uqc.mjs";

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

console.log("\n--- the list is the list ---");

test("there are 44 codes, each one distinct", () => {
  assert.equal(UQC_CODES.length, 44);
  const codes = UQC_CODES.map((u) => u.code);
  assert.equal(new Set(codes).size, 44, "a code is listed twice");
  for (const { code, label } of UQC_CODES) {
    assert.match(code, /^[A-Z]{3}$/, `${code} is not three upper-case letters`);
    assert.ok(label, `${code} has no label`);
  }
});

test("the codes everyday trading needs are all there", () => {
  for (const code of ["NOS", "PCS", "KGS", "MTR", "LTR_NOT", "BOX", "BAG", "SET", "DOZ", "TON", "OTH"]) {
    if (code === "LTR_NOT") continue;
    assert.ok(isUqc(code), `${code} is missing from the list`);
  }
});

test("there is no code for litres, and that is not a bug", () => {
  // The official list genuinely has none. A litre is 1000 MLT.
  assert.equal(isUqc("LTR"), false);
  assert.equal(normalizeUqc("LTR"), "");
  assert.ok(isUqc("MLT") && isUqc("KLR"));
});

test("OTH is a real code, so the default is always valid", () => {
  assert.equal(UQC_DEFAULT, "OTH");
  assert.ok(isUqc(UQC_DEFAULT));
});

console.log("\n--- a value is a code or it is nothing ---");

test("case and whitespace are forgiven; spelling is not", () => {
  assert.equal(normalizeUqc(" pcs "), "PCS");
  assert.equal(normalizeUqc("Mtr"), "MTR");
  assert.equal(normalizeUqc("PIECES"), "");
  assert.equal(normalizeUqc("bori"), "");
  assert.equal(normalizeUqc("PC"), "");
  assert.equal(normalizeUqc(""), "");
  assert.equal(normalizeUqc(null), "");
  assert.equal(normalizeUqc(undefined), "");
  assert.equal(normalizeUqc(5), "");
});

test("nothing chosen reads as nothing, not as OTH", () => {
  // The difference matters: the model's default supplies OTH, and a caller
  // that cannot tell them apart cannot warn about an unset unit.
  assert.equal(normalizeUqc(""), "");
  assert.notEqual(normalizeUqc(""), UQC_DEFAULT);
});

test("a label is available for a report, and blank for junk", () => {
  assert.equal(uqcLabel("mtr"), "Metres");
  assert.equal(uqcLabel("MTS"), "Metric tons");
  assert.equal(uqcLabel("LTR"), "");
  assert.equal(uqcLabel(""), "");
});

console.log("\n--- the master stamps the invoice line ---");

const MASTERS = [
  { name: "Cotton Shirt", uqc: "PCS", isService: false },
  { name: "stitching charges", isService: true },
  { name: "Grey Fabric", uqc: "MTR" },
];

test("each line takes its unit from the item master", () => {
  const lines = stampItemLines(
    [{ name: "Cotton Shirt", quantity: 2 }, { name: "Grey Fabric", quantity: 15 }],
    MASTERS
  );
  assert.equal(lines[0].uqc, "PCS");
  assert.equal(lines[1].uqc, "MTR");
  assert.equal(lines[0].quantity, 2, "the rest of the line is untouched");
  assert.equal(lines[1].quantity, 15);
});

test("names are matched the way the rest of the project joins them", () => {
  // Case and surrounding space differ between the master and what a page
  // sends often enough that an exact match would miss.
  const lines = stampItemLines([{ name: "  cotton shirt " }], MASTERS);
  assert.equal(lines[0].uqc, "PCS");
});

test("the master wins over whatever the page sent", () => {
  const lines = stampItemLines([{ name: "Cotton Shirt", uqc: "BOX" }], MASTERS);
  assert.equal(lines[0].uqc, "PCS");
});

test("a master with no unit set still yields a valid code", () => {
  const lines = stampItemLines([{ name: "stitching charges" }], MASTERS);
  assert.equal(lines[0].uqc, UQC_DEFAULT);
  assert.equal(lines[0].isService, true);
});

test("an item not in the master keeps what it came with, then OTH", () => {
  const lines = stampItemLines(
    [{ name: "Imported mystery", uqc: "box" }, { name: "Another mystery" }],
    MASTERS
  );
  assert.equal(lines[0].uqc, "BOX");
  assert.equal(lines[1].uqc, UQC_DEFAULT);
});

test("a master row with isService false overrides a line claiming true", () => {
  const lines = stampItemLines([{ name: "Cotton Shirt", isService: true }], MASTERS);
  assert.equal(lines[0].isService, false, "goods billed as a service is a wrong filing");
});

test("isService is always a boolean, never undefined", () => {
  for (const line of stampItemLines([{ name: "x" }, { name: "Cotton Shirt" }], MASTERS)) {
    assert.equal(typeof line.isService, "boolean");
  }
});

test("empty, null and missing line lists are all just nothing", () => {
  assert.deepEqual(stampItemLines([], MASTERS), []);
  assert.deepEqual(stampItemLines(null, MASTERS), []);
  assert.deepEqual(stampItemLines(undefined), []);
  assert.deepEqual(stampItemLines([{ name: "x" }], []).length, 1);
});

test("a prebuilt index can be passed instead of the rows", () => {
  const index = itemIndex(MASTERS);
  assert.equal(stampItemLines([{ name: "Cotton Shirt" }], index)[0].uqc, "PCS");
  assert.equal(index.size, 3);
  assert.equal(itemIndex([{ name: "" }, {}, null]).size, 0);
});

test("the IRP's Y/N flag follows isService", () => {
  assert.equal(isServcFlag({ isService: true }), "Y");
  assert.equal(isServcFlag({ isService: false }), "N");
  assert.equal(isServcFlag({}), "N");
  assert.equal(isServcFlag(null), "N");
});

console.log("\n--- the schema and the routes agree ---");

const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

test("the item master declares both fields", () => {
  const src = read("models/itemModel.js");
  assert.match(src, /uqc:\s*\{/);
  assert.match(src, /isService:\s*\{/);
  assert.match(src, /default:\s*"OTH"|default:\s*UQC_DEFAULT/);
});

test("the invoice's line items declare them too", () => {
  // Mongoose strict mode drops what is not declared, so a stamped line would
  // be stamped and then thrown away, with no error anywhere.
  const src = read("models/invoiceModel.js");
  const lineBlock = src.slice(0, src.indexOf("const partyTaxSchema"));
  assert.match(lineBlock, /uqc:\s*\{/, "the invoice line has no uqc");
  assert.match(lineBlock, /isService:\s*\{/, "the invoice line has no isService");
});

test("both invoice routes stamp their lines", () => {
  for (const route of ["app/api/save-invoice/route.js", "app/api/sale-alter/route.js"]) {
    const src = read(route);
    assert.match(src, /stampItemLines\(/, `${route} does not stamp its lines`);
  }
});

console.log("\n--- where the free-text unit comes from ---");

/** The item master's HSN dropdown, from its handler to the option list. */
const hsnPickBlock = () => {
  const src = read("app/itemadd/page.js");
  const from = src.indexOf("const selectedHsn = hsnList.find");
  const to = src.indexOf('<option value="">Select HSN</option>');
  assert.ok(from > 0 && to > from, "the item master's HSN dropdown moved");
  return src.slice(from, to);
};

test("the HSN master carries a unit, and both of its forms show it", () => {
  // The field has been on the model all along; what is new is that an item
  // reads it. A form that stopped collecting it would leave every new HSN
  // unable to fill the box below.
  assert.match(read("models/hsnModel.js"), /gstunit:\s*\{/);
  assert.match(read("components/HsnMaster.jsx"), /gstunit: e\.target\.value/);
  assert.match(read("lib/masterActions.mjs"), /gstunit: record\.gstunit/);
});

test("picking an HSN fills the item's unit, and only when that HSN has one", () => {
  // The rate already came down from the HSN; the unit now comes with it, so
  // two items on one HSN cannot end up as "pcs" and "Pcs".
  const block = hsnPickBlock();
  assert.match(block, /selectedHsn\?\.gstunit/);
  assert.match(block, /if \(fromHsn\) setUnit\(fromHsn\)/);
});

test("picking an HSN never touches the UQC", () => {
  // THE RULE THIS FILE EXISTS FOR. `gstunit` is free text a shopkeeper typed
  // -- "bori", "pcs" -- and the IRP takes only a code from UQC_CODES. Filling
  // the code from that text is the silent guess the header forbids: a wrong
  // UQC is a rejected filing, so it stays on the item, picked by hand.
  assert.doesNotMatch(hsnPickBlock(), /setUqc\(/);
});

test("the unit box starts empty, not at zero", () => {
  // It was `useState(0)`, so every item saved without a typed unit went in
  // with unit "0" -- and the price list master copied those zeros onward.
  // scripts/clear-zero-units.mjs cleans the rows that already exist; this is
  // the form that must stop making new ones.
  const src = read("app/itemadd/page.js");
  assert.match(src, /const \[unit, setUnit\] = useState\(''\)/);
  assert.match(src, /setUnit\(data\.unit \|\| ''\)/);
  assert.doesNotMatch(src, /setUnit\(data\.unit \|\| 0\)/);
});

console.log(`\n${passed} checks passed.\n`);
