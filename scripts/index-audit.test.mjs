/**
 * Fixture tests for the index audit.
 *
 *   node scripts/index-audit.test.mjs
 *
 * This decides which indexes a migration will DROP from a live database, so
 * the two ways it can be wrong are both expensive:
 *
 *   1. Missing a global unique index leaves the bug in place — the second firm
 *      still cannot write invoice 1, and the user sees a duplicate-key error
 *      about a number they have never used.
 *
 *   2. Flagging one it should not drops protection that was doing its job.
 *      `_id_` and the per-firm compound indexes must never be touched, and
 *      neither must a plain non-unique index that is only there for speed.
 */

import assert from "node:assert/strict";
import {
  ID_INDEX,
  auditIndexes,
  describeIndex,
  isGlobalUnique,
  isTenantScoped,
  keySignature,
  missingTenantUniques,
  protectedFields,
} from "../lib/indexAudit.mjs";

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

/** Indexes as `collection.indexes()` returns them. */
const idIndex = { v: 2, key: { _id: 1 }, name: "_id_" };
const oldGlobal = { v: 2, key: { invoiceNo: 1 }, name: "invoiceNo_1", unique: true };
const perFirm = { v: 2, key: { companyId: 1, invoiceNo: 1 }, name: "companyId_1_invoiceNo_1", unique: true };
const forSpeed = { v: 2, key: { date: 1, invoiceNo: 1 }, name: "date_1_invoiceNo_1" };

console.log("\n--- the ones that have to go ---");

test("a unique index that is not led by companyId is global", () => {
  assert.equal(isGlobalUnique(oldGlobal), true);
  assert.equal(isGlobalUnique({ key: { name: 1 }, name: "name_1", unique: true }), true);
  assert.equal(isGlobalUnique({ key: { code: 1 }, name: "code_1", unique: true }), true);
  assert.equal(isGlobalUnique({ key: { hsncode: 1 }, name: "hsncode_1", unique: true }), true);
});

test("companyId has to come FIRST, not merely appear", () => {
  // `{ invoiceNo: 1, companyId: 1 }` is unique on the pair, but Mongo can use
  // its leading field alone -- and any document missing companyId collides
  // across firms. The order is the whole question.
  assert.equal(
    isGlobalUnique({ key: { invoiceNo: 1, companyId: 1 }, name: "invoiceNo_1_companyId_1", unique: true }),
    true
  );
  assert.equal(isGlobalUnique(perFirm), false);
});

console.log("\n--- the ones that must never be touched ---");

test("_id_ is never flagged", () => {
  assert.equal(isGlobalUnique(idIndex), false);
  assert.equal(isGlobalUnique({ ...idIndex, unique: true }), false, "even described as unique");
  assert.equal(ID_INDEX, "_id_");
});

test("a non-unique index is left alone however it is shaped", () => {
  assert.equal(isGlobalUnique(forSpeed), false);
  assert.equal(isGlobalUnique({ key: { name: 1 }, name: "name_1" }), false);
  assert.equal(isGlobalUnique({ key: { "customer.name": 1 }, name: "customer.name_1" }), false);
});

test("a per-firm unique index is kept", () => {
  assert.equal(isGlobalUnique(perFirm), false);
  assert.equal(isTenantScoped(perFirm), true);
  assert.equal(isTenantScoped(oldGlobal), false);
  // companyId present but not leading is NOT per-firm, for the same reason as
  // above: Mongo can use the leading field on its own.
  assert.equal(
    isTenantScoped({ key: { invoiceNo: 1, companyId: 1 }, name: "invoiceNo_1_companyId_1" }),
    false
  );
  assert.equal(isTenantScoped({ key: {} }), false);
  // Including the partial one on IRN.
  const irn = {
    key: { companyId: 1, irn: 1 },
    name: "companyId_1_irn_1",
    unique: true,
    partialFilterExpression: { irn: { $type: "string" } },
  };
  assert.equal(isGlobalUnique(irn), false);
});

test("nothing throws on a shape the driver might return", () => {
  for (const index of [null, undefined, {}, { name: "x" }, { key: {}, unique: true }]) {
    assert.equal(isGlobalUnique(index), false, JSON.stringify(index));
  }
});

console.log("\n--- the audit splits a collection's indexes ---");

test("a collection mid-migration is split correctly", () => {
  const { drop, keep } = auditIndexes([idIndex, oldGlobal, perFirm, forSpeed]);
  assert.deepEqual(drop.map((i) => i.name), ["invoiceNo_1"]);
  assert.deepEqual(keep.map((i) => i.name), ["_id_", "companyId_1_invoiceNo_1", "date_1_invoiceNo_1"]);
});

test("a collection already migrated has nothing to drop", () => {
  const { drop, keep } = auditIndexes([idIndex, perFirm, forSpeed]);
  assert.deepEqual(drop, []);
  assert.equal(keep.length, 3);
});

test("two global indexes on one collection are both caught", () => {
  // `states` is the case: name and code were each unique on their own.
  const { drop } = auditIndexes([
    idIndex,
    { key: { name: 1 }, name: "name_1", unique: true },
    { key: { code: 1 }, name: "code_1", unique: true },
    { key: { companyId: 1, name: 1 }, name: "companyId_1_name_1", unique: true },
  ]);
  assert.deepEqual(drop.map((i) => i.name), ["name_1", "code_1"]);
});

test("an empty or missing index list is not an error", () => {
  assert.deepEqual(auditIndexes([]), { drop: [], keep: [] });
  assert.deepEqual(auditIndexes(), { drop: [], keep: [] });
});

console.log("\n--- what the dropped index was protecting ---");

test("the fields to check for duplicates, companyId excluded", () => {
  assert.deepEqual(protectedFields(oldGlobal), ["invoiceNo"]);
  assert.deepEqual(protectedFields({ key: { name: 1 } }), ["name"]);
  assert.deepEqual(protectedFields(perFirm), ["invoiceNo"]);
  assert.deepEqual(protectedFields({ key: { companyId: 1 } }), []);
});

test("a report line names the index, its keys and its flags", () => {
  assert.equal(describeIndex(oldGlobal), "invoiceNo_1  { invoiceNo: 1 }  [unique]");
  assert.equal(describeIndex(forSpeed), "date_1_invoiceNo_1  { date: 1, invoiceNo: 1 }");
  assert.match(describeIndex({ key: { companyId: 1, irn: 1 }, name: "x", unique: true, partialFilterExpression: {} }), /unique, partial/);
});

console.log("\n--- the per-firm indexes that must exist ---");

// What `schema.indexes()` returns: [keyObject, options] pairs.
const DECLARED = [
  [{ companyId: 1, invoiceNo: 1 }, { unique: true, background: true }],
  [{ date: 1, invoiceNo: 1 }, { background: true }],
  [{ "customer.name": 1 }, { background: true }],
];

test("a key signature keeps the field order", () => {
  assert.equal(keySignature({ companyId: 1, invoiceNo: 1 }), "companyId:1,invoiceNo:1");
  assert.notEqual(
    keySignature({ companyId: 1, invoiceNo: 1 }),
    keySignature({ invoiceNo: 1, companyId: 1 }),
    "order is part of the identity of an index"
  );
  assert.equal(keySignature({}), "");
  assert.equal(keySignature(), "");
});

test("nothing is missing when the per-firm index is there", () => {
  assert.deepEqual(missingTenantUniques(DECLARED, [idIndex, perFirm, forSpeed]), []);
});

test("the per-firm unique index is reported when absent", () => {
  // The dangerous state: the global one has been dropped and the replacement
  // never built, so the collection protects nothing.
  const missing = missingTenantUniques(DECLARED, [idIndex, forSpeed]);
  assert.deepEqual(missing, [{ companyId: 1, invoiceNo: 1 }]);
});

test("only unique per-firm indexes are demanded", () => {
  // A plain index missing is a performance matter, not a correctness one --
  // including one that IS led by companyId, which most of them are.
  assert.deepEqual(missingTenantUniques([[{ companyId: 1, name: 1 }, {}]], [idIndex]), []);
  assert.deepEqual(
    missingTenantUniques([[{ companyId: 1, name: 1 }, { unique: false }]], [idIndex]),
    []
  );
  assert.deepEqual(missingTenantUniques([[{ date: 1 }, {}]], [idIndex]), []);
});

test("a globally unique declaration is not this check's business", () => {
  // users.email is unique across every firm on purpose, and this helper only
  // speaks about companyId-led ones.
  assert.deepEqual(missingTenantUniques([[{ email: 1 }, { unique: true }]], [idIndex]), []);
});

test("an index whose keys are in the other order does not count as present", () => {
  const actual = [idIndex, { key: { invoiceNo: 1, companyId: 1 }, name: "x", unique: true }];
  assert.deepEqual(missingTenantUniques(DECLARED, actual), [{ companyId: 1, invoiceNo: 1 }]);
});

test("empty inputs are not an error", () => {
  assert.deepEqual(missingTenantUniques(), []);
  assert.deepEqual(missingTenantUniques([], []), []);
  assert.deepEqual(missingTenantUniques(DECLARED, []), [{ companyId: 1, invoiceNo: 1 }]);
});

console.log(`\n${passed} checks passed.\n`);
