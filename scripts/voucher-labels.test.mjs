/**
 * Naming a voucher in a list: scripts/voucher-labels.test.mjs
 *
 * Plain node, no framework -- `node scripts/voucher-labels.test.mjs`.
 *
 * The test that matters is the first one in "the bug it exists for": four
 * vouchers through one bank must come out as four DIFFERENT rows. That is
 * the whole reason this module is here, and it is the thing a later
 * simplification would quietly undo.
 */

import assert from "node:assert/strict";
import fs from "node:fs";

import {
  NARRATION_MAX,
  shortNarration,
  voucherAccount,
  voucherAmount,
  voucherPickerLabel,
} from "../lib/voucherLabels.mjs";

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

/** A bank voucher, as /api/get-voucher returns one. */
const voucher = (over = {}) => ({
  _id: "v1",
  kind: "PAYMENT",
  acName: "BANK OF BARODA",
  paymentType: "Bank",
  date: new Date("2026-10-18T00:00:00.000Z"),
  narration: "Neft",
  customers: [{ name: "A A ENTERPRISES", debit: 10000, credit: 0 }],
  ...over,
});

console.log("\n--- the bug it exists for ---");

test("four vouchers through one bank are four different rows", () => {
  // Exactly the list from the screenshot that started this: same acName on
  // every one of them.
  const sameBank = [
    voucher({ _id: "v1", date: new Date("2026-10-15T00:00:00.000Z"), narration: "", customers: [{ name: "X", debit: 1000 }] }),
    voucher({ _id: "v2", date: new Date("2026-10-15T00:00:00.000Z"), narration: "", customers: [{ name: "X", debit: 1000 }] }),
    voucher({ _id: "v3", date: new Date("2026-10-18T00:00:00.000Z"), narration: "Neft", customers: [{ name: "X", credit: 10000 }] }),
    voucher({ _id: "v4", date: new Date("2026-10-18T00:00:00.000Z"), narration: "", customers: [{ name: "X", debit: 1000 }] }),
  ];

  const labels = sameBank.map(voucherPickerLabel);
  for (const label of labels) {
    assert.notEqual(label, "BANK OF BARODA", "still named after the account");
  }
  // v1 and v2 are a genuine same-day, same-amount pair, so they are allowed
  // to read alike -- the other two must not.
  assert.equal(new Set(labels).size >= 3, true, `too many identical rows: ${labels.join(" | ")}`);
  assert.equal(labels[2], "18/10/2026 · ₹10,000.00 · Neft");
});

test("the account is the fallback, not the name", () => {
  // No narration: the account is better than nothing, and still sits behind
  // the date and the amount that actually tell the rows apart.
  const label = voucherPickerLabel(voucher({ narration: "" }));
  assert.equal(label, "18/10/2026 · ₹10,000.00 · BANK OF BARODA");
});

console.log("\n--- the parts ---");

test("the amount is the larger side, not the sum of both", () => {
  // A journal balances, so adding the columns would double it.
  assert.equal(
    voucherAmount({ customers: [{ debit: 500 }, { credit: 500 }] }),
    500,
    "a balanced journal of 500 reported as 1000"
  );
  assert.equal(voucherAmount({ customers: [{ credit: 200 }, { credit: 300 }] }), 500);
  assert.equal(voucherAmount({}), 0);
  assert.equal(voucherAmount(null), 0);
});

test("a journal with no account is named by its first line", () => {
  const journal = {
    _id: "j1",
    kind: "JOURNAL",
    date: new Date("2026-10-18T00:00:00.000Z"),
    narration: "",
    customers: [{ name: "Depreciation", debit: 5000 }, { name: "Plant", credit: 5000 }],
  };
  assert.equal(voucherAccount(journal), "Depreciation");
  assert.equal(voucherPickerLabel(journal), "18/10/2026 · ₹5,000.00 · Depreciation");
});

test("a long narration is cut, not wrapped", () => {
  const long = "Payment against the September invoices for the Ashok Vihar branch";
  const cut = shortNarration(long);
  // At most the cap -- a word boundary landing on a space makes it one
  // short, because "word …" is not how an ellipsis is set.
  assert.ok(cut.length <= NARRATION_MAX, `cut to ${cut.length}, over the ${NARRATION_MAX} cap`);
  assert.ok(cut.length >= NARRATION_MAX - 1, `cut to ${cut.length}, shorter than it needed to be`);
  assert.match(cut, /[^\s]…$/, "no space before the ellipsis");
  assert.equal(shortNarration("Neft"), "Neft");
  assert.equal(shortNarration("  spaced   out  "), "spaced out");
  assert.equal(shortNarration(null), "");
});

test("the date is read in India, not on the server", () => {
  // Stored as UTC midnight. A host in UTC-5 formatting its own clock would
  // call this the 17th. lib/istDate.mjs is why this is not a new formatter.
  assert.match(voucherPickerLabel(voucher()), /^18\/10\/2026 /);
});

console.log("\n--- it can always be selected ---");

test("a voucher with nothing on it still gets a row", () => {
  // A blank row that opens something is worse than an ugly one.
  assert.equal(voucherPickerLabel({ _id: "abc123" }), "abc123");
  assert.equal(voucherPickerLabel({ id: "abc123" }), "abc123");
  assert.equal(voucherPickerLabel({}), "");
  assert.equal(voucherPickerLabel(null), "");
});

test("a missing date drops that part rather than printing Invalid Date", () => {
  const label = voucherPickerLabel(voucher({ date: null }));
  assert.equal(label, "₹10,000.00 · Neft");
  assert.doesNotMatch(label, /Invalid|null|NaN/);
});

console.log("\n--- the wiring ---");

test("every voucher picker uses it, and none is named by its account", () => {
  const src = code("../app/page.js");
  const uses = src.match(/name: voucherPickerLabel\(v\)/g) || [];
  assert.equal(
    uses.length,
    6,
    `expected Bank, Cash, Journal, Contra, Credit Note and Debit Note to use it, found ${uses.length}`
  );
  assert.doesNotMatch(
    src,
    /name: v\.acName/,
    "a picker is still naming vouchers after the account they moved through"
  );
});

test("the dashboard opens a voucher by id, so the label is free to change", () => {
  // The label is display only. If a picker ever opened by `name` again, a
  // readable label would stop the row opening at all.
  const src = code("../app/page.js");
  assert.match(src, /isNamed\(sectionName\)\) \{\s*label = entity\.name;\s*alterValue = entity\.id;/);
});

console.log(`\n  ${passed} checks passed\n`);
