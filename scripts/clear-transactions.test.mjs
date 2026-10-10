/**
 * Fixture tests for "clear the transactions, keep the masters".
 *
 *   node scripts/clear-transactions.test.mjs
 *
 * Two things are worth guarding and both are the kind of mistake that is
 * silent until somebody's data is gone:
 *
 *   1. No master collection may ever end up in the delete list. One line added
 *      in the wrong array turns this button into the full wipe, and the only
 *      sign would be a customer master that is suddenly empty.
 *
 *   2. Deleting the documents is not enough. `Customer.lastBal` accumulates
 *      from the very documents being deleted, so it has to be put back to the
 *      opening balance in the same breath -- otherwise the books come out
 *      "clean" with parties owing money for invoices that no longer exist.
 */

import assert from "node:assert/strict";
import {
  CLEAR_TRANSACTIONS_PHRASE,
  TRANSACTION_COLLECTIONS,
  MASTER_COLLECTIONS,
  openingReset,
} from "../lib/clearData.mjs";
import { modeOf } from "../lib/balance.mjs";

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

console.log("\n--- the masters survive ---");

test("no master collection is in the delete list", () => {
  for (const name of MASTER_COLLECTIONS) {
    assert.ok(
      !TRANSACTION_COLLECTIONS.includes(name),
      `"${name}" is master data and must never be cleared`
    );
  }
});

test("the two lists do not overlap at all", () => {
  const both = TRANSACTION_COLLECTIONS.filter((n) => MASTER_COLLECTIONS.includes(n));
  assert.deepEqual(both, []);
});

test("the collections people would panic about are named as masters", () => {
  // Spelled out rather than derived: if one of these ever disappears from the
  // master list, that is the thing to catch.
  for (const name of ["customers", "items", "hsns", "pricelists", "customergroups", "states"]) {
    assert.ok(MASTER_COLLECTIONS.includes(name), `"${name}" must be listed as master data`);
  }
});

console.log("\n--- the books go ---");

test("every books collection is cleared", () => {
  for (const name of ["invoices", "vouchers", "ledgers", "itemledgers"]) {
    assert.ok(TRANSACTION_COLLECTIONS.includes(name), `"${name}" must be cleared`);
  }
});

test("the invoice counter goes too", () => {
  // Left behind, numbering carries on from wherever the deleted invoices got
  // to instead of starting again.
  assert.ok(TRANSACTION_COLLECTIONS.includes("counters"));
});

test("nothing is listed twice", () => {
  assert.equal(new Set(TRANSACTION_COLLECTIONS).size, TRANSACTION_COLLECTIONS.length);
  assert.equal(new Set(MASTER_COLLECTIONS).size, MASTER_COLLECTIONS.length);
});

console.log("\n--- balances go back to opening ---");

test("a party that owed money is reset to its opening balance", () => {
  assert.deepEqual(
    openingReset({ openingBal: 1500, lastBal: 98765, lastMode: "Dr" }),
    { lastBal: 1500, lastMode: "Dr" }
  );
});

test("a credit opening balance comes back as Cr", () => {
  assert.deepEqual(
    openingReset({ openingBal: -2400.5, lastBal: 0, lastMode: "Dr" }),
    { lastBal: -2400.5, lastMode: "Cr" }
  );
});

test("a party with no opening balance lands on zero Dr", () => {
  assert.deepEqual(openingReset({ openingBal: 0, lastBal: 5000 }), { lastBal: 0, lastMode: "Dr" });
  assert.deepEqual(openingReset({ lastBal: 5000 }), { lastBal: 0, lastMode: "Dr" });
  assert.deepEqual(openingReset({}), { lastBal: 0, lastMode: "Dr" });
  assert.deepEqual(openingReset(undefined), { lastBal: 0, lastMode: "Dr" });
});

test("the running balance is never what gets kept", () => {
  // The whole point: lastBal is the accumulated effect of documents that are
  // being deleted, so it cannot survive them.
  const party = { openingBal: 100, lastBal: 7654.32, lastMode: "Dr" };
  const reset = openingReset(party);
  assert.notEqual(reset.lastBal, party.lastBal);
  assert.equal(reset.lastBal, 100);
});

test("the mode always matches the sign it is stored beside", () => {
  for (const opening of [-9999, -0.01, 0, 0.01, 1, 123456.78]) {
    const { lastBal, lastMode } = openingReset({ openingBal: opening });
    assert.equal(lastMode, modeOf(lastBal), `mode disagreed with the sign at ${opening}`);
  }
});

test("float drift does not survive the reset", () => {
  assert.equal(openingReset({ openingBal: 0.1 + 0.2 }).lastBal, 0.3);
});

test("a non-numeric opening balance reads as zero, not NaN", () => {
  assert.deepEqual(openingReset({ openingBal: "abc" }), { lastBal: 0, lastMode: "Dr" });
  assert.deepEqual(openingReset({ openingBal: null }), { lastBal: 0, lastMode: "Dr" });
});

console.log("\n--- the phrase is its own ---");

test("clearing transactions does not share a phrase with the full wipe", () => {
  // Typing one by habit must not fire the other.
  assert.notEqual(CLEAR_TRANSACTIONS_PHRASE, "DELETE ALL DATA");
  assert.equal(CLEAR_TRANSACTIONS_PHRASE, "CLEAR TRANSACTIONS");
});

console.log(`\n  ${passed} checks passed\n`);
