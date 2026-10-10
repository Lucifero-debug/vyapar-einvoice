/**
 * Fixture tests for the customer group master.
 *
 *   node scripts/customer-groups.test.mjs
 *
 * Two things matter here. Cash and Bank are not ordinary groups -- an invoice
 * finds the account it settles into by those names -- so nothing may rename or
 * delete them. And seeding must not create a second copy of a group that is
 * already there under different capitalisation, because customers are filed
 * under the group's name and two spellings would split them.
 */

import assert from "node:assert/strict";
import { RESERVED_GROUPS, isReservedGroup, planSeed } from "../lib/customerGroups.mjs";

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

console.log("\n--- the reserved groups ---");

test("Cash and Bank are reserved", () => {
  assert.deepEqual(RESERVED_GROUPS, ["Cash", "Bank"]);
  assert.equal(isReservedGroup("Cash"), true);
  assert.equal(isReservedGroup("Bank"), true);
});

test("matching ignores case and surrounding space", () => {
  // lib/cashAccount.mjs resolves the account with /^cash$/i, so "cash" and
  // " Cash " are the same group to the thing that depends on it.
  for (const v of ["cash", "CASH", "  Bank  ", "bank"]) {
    assert.equal(isReservedGroup(v), true, `${JSON.stringify(v)} should be reserved`);
  }
});

test("an ordinary group is not reserved", () => {
  for (const v of ["Sundry Debtors", "Cash Discount", "Banking", "", null, undefined]) {
    assert.equal(isReservedGroup(v), false, `${JSON.stringify(v)} should not be reserved`);
  }
});

console.log("\n--- seeding the master ---");

test("a fresh database gets the reserved pair first, then what is in use", () => {
  const plan = planSeed({ inUse: ["Sundry Debtors", "Sundry Creditors"], existing: [] });
  assert.deepEqual(plan.map((g) => g.name), ["Cash", "Bank", "Sundry Debtors", "Sundry Creditors"]);
  assert.deepEqual(plan.map((g) => g.reserved), [true, true, false, false]);
});

test("a group already in the master is not created again", () => {
  const plan = planSeed({
    inUse: ["Sundry Debtors", "Cash"],
    existing: [{ name: "Cash" }, { name: "Sundry Debtors" }],
  });
  assert.deepEqual(plan.map((g) => g.name), ["Bank"]);
});

test("capitalisation does not create a duplicate", () => {
  // "cash" in use and "Cash" in the master are one group, not two.
  const plan = planSeed({ inUse: ["cash", "SUNDRY DEBTORS"], existing: [{ name: "Cash" }] });
  assert.ok(!plan.some((g) => g.name.toLowerCase() === "cash"), "Cash must not be duplicated");
  assert.deepEqual(plan.map((g) => g.name), ["Bank", "SUNDRY DEBTORS"]);
});

test("the same group listed twice in use is created once", () => {
  const plan = planSeed({ inUse: ["Retail", "retail", " Retail "], existing: [] });
  assert.equal(plan.filter((g) => g.name.toLowerCase() === "retail").length, 1);
});

test("blank and missing groups are ignored", () => {
  const plan = planSeed({ inUse: ["", null, undefined, "   "], existing: [] });
  assert.deepEqual(plan.map((g) => g.name), ["Cash", "Bank"]);
});

test("customer-shaped input works as well as bare names", () => {
  const plan = planSeed({ inUse: [{ group: "Retail" }, { group: "Retail" }], existing: [] });
  assert.deepEqual(plan.map((g) => g.name), ["Cash", "Bank", "Retail"]);
});

test("nothing to do when the master already covers everything", () => {
  const plan = planSeed({
    inUse: ["Cash", "Bank"],
    existing: [{ name: "Cash" }, { name: "Bank" }],
  });
  assert.deepEqual(plan, []);
});

test("no arguments is not an error", () => {
  assert.deepEqual(planSeed().map((g) => g.name), ["Cash", "Bank"]);
});

console.log(`\n  ${passed} checks passed\n`);
