/**
 * Fixture tests for the master duplicate-name rule.
 *
 *   node scripts/unique-name.test.mjs
 *
 * Every master in this app is joined by name, so "the same name" has to mean
 * the same thing in all eight routes. These pin down what counts as the same.
 */

import assert from "node:assert/strict";
import { findDuplicates, nameKey, normalizeName } from "../lib/uniqueName.mjs";

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

console.log("\n--- what gets stored ---");

test("surrounding whitespace is trimmed", () => {
  assert.equal(normalizeName("  Sharma Traders  "), "Sharma Traders");
  assert.equal(normalizeName("\tCash\n"), "Cash");
});

test("inner spacing is left exactly as typed", () => {
  // Collapsing it would quietly rename what somebody entered.
  assert.equal(normalizeName("Sharma  Traders"), "Sharma  Traders");
});

test("a missing name normalises to empty, not to \"undefined\"", () => {
  assert.equal(normalizeName(undefined), "");
  assert.equal(normalizeName(null), "");
  assert.equal(normalizeName(""), "");
});

console.log("\n--- what counts as the same name ---");

test("case does not make a different record", () => {
  assert.equal(nameKey("Sharma Traders"), nameKey("sharma traders"));
  assert.equal(nameKey("CASH"), nameKey("cash"));
});

test("surrounding whitespace does not either", () => {
  assert.equal(nameKey(" Cash "), nameKey("Cash"));
});

test("genuinely different names stay different", () => {
  assert.notEqual(nameKey("Sharma Traders"), nameKey("Sharma Trader"));
  assert.notEqual(nameKey("Cash"), nameKey("Cash Discount"));
  assert.notEqual(nameKey("Bank"), nameKey("Banking"));
});

console.log("\n--- finding what is already stored twice ---");

test("records differing only in case are reported together", () => {
  const dupes = findDuplicates([
    { _id: 1, name: "Cash" },
    { _id: 2, name: "cash" },
    { _id: 3, name: "Bank" },
  ]);
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0].records.length, 2);
  assert.deepEqual(dupes[0].spellings, ["Cash", "cash"]);
});

test("the stored spellings are reported, so you can see which is which", () => {
  const [d] = findDuplicates([
    { _id: 1, name: "Sharma Traders" },
    { _id: 2, name: " sharma traders " },
    { _id: 3, name: "SHARMA TRADERS" },
  ]);
  assert.equal(d.records.length, 3);
  assert.deepEqual(d.spellings, ["Sharma Traders", "sharma traders", "SHARMA TRADERS"]);
});

test("a clean master reports nothing", () => {
  assert.deepEqual(findDuplicates([{ _id: 1, name: "A" }, { _id: 2, name: "B" }]), []);
  assert.deepEqual(findDuplicates([]), []);
  assert.deepEqual(findDuplicates(), []);
});

test("blank names are ignored rather than grouped with each other", () => {
  // Two records with no name are not "the same party".
  const dupes = findDuplicates([
    { _id: 1, name: "" },
    { _id: 2, name: "   " },
    { _id: 3 },
  ]);
  assert.deepEqual(dupes, []);
});

test("it works on a field that is not called name", () => {
  const dupes = findDuplicates(
    [{ _id: 1, hsncode: "8481" }, { _id: 2, hsncode: " 8481 " }],
    "hsncode"
  );
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0].name, "8481");
});

test("three copies are one group of three, not two groups", () => {
  const dupes = findDuplicates([
    { _id: 1, name: "Cash" },
    { _id: 2, name: "cash" },
    { _id: 3, name: "CASH" },
  ]);
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0].records.length, 3);
});

console.log(`\n  ${passed} checks passed\n`);
