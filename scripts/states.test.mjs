/**
 * Fixture tests for the state master.
 *
 *   node scripts/states.test.mjs
 *
 * The GST state code is the first two digits of a GSTIN and decides CGST+SGST
 * versus IGST, so the two things that matter are that the leading zero survives
 * and that the seeded list holds no retired or duplicated code.
 */

import assert from "node:assert/strict";
import {
  INDIAN_STATES,
  findStateByCode,
  findStateByName,
  normalizeStateCode,
  planStateSeed,
  stateLabel,
} from "../lib/states.mjs";

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

console.log("\n--- the code is two digits, always ---");

test("a leading zero survives", () => {
  assert.equal(normalizeStateCode(7), "07");
  assert.equal(normalizeStateCode("7"), "07");
  assert.equal(normalizeStateCode("07"), "07");
});

test("two-digit codes pass through", () => {
  assert.equal(normalizeStateCode(27), "27");
  assert.equal(normalizeStateCode("97"), "97");
});

test("nothing meaningful becomes empty, not \"00\"", () => {
  for (const v of ["", null, undefined, "0", 0, "abc"]) {
    assert.equal(normalizeStateCode(v), "", `${JSON.stringify(v)} should be blank`);
  }
});

console.log("\n--- the seeded list ---");

test("every code is unique", () => {
  const codes = INDIAN_STATES.map((s) => s.code);
  assert.equal(new Set(codes).size, codes.length);
});

test("every name is unique", () => {
  const names = INDIAN_STATES.map((s) => s.name.toLowerCase());
  assert.equal(new Set(names).size, names.length);
});

test("every code is already in two-digit form", () => {
  for (const s of INDIAN_STATES) {
    assert.equal(s.code, normalizeStateCode(s.code), `${s.name} has code ${s.code}`);
    assert.match(s.code, /^\d{2}$/, `${s.name}`);
  }
});

test("the retired codes 25 and 28 are not offered", () => {
  // 25 (Daman & Diu) merged into 26; 28 (old Andhra Pradesh) became 37.
  assert.equal(findStateByCode(INDIAN_STATES, "25"), null);
  assert.equal(findStateByCode(INDIAN_STATES, "28"), null);
  assert.ok(findStateByCode(INDIAN_STATES, "26"), "26 should exist");
  assert.ok(findStateByCode(INDIAN_STATES, "37"), "37 should exist");
});

test("the codes everyone knows are right", () => {
  assert.equal(findStateByName(INDIAN_STATES, "Delhi").code, "07");
  assert.equal(findStateByName(INDIAN_STATES, "Maharashtra").code, "27");
  assert.equal(findStateByName(INDIAN_STATES, "Karnataka").code, "29");
  assert.equal(findStateByName(INDIAN_STATES, "Gujarat").code, "24");
  assert.equal(findStateByName(INDIAN_STATES, "Tamil Nadu").code, "33");
});

console.log("\n--- lookups ---");

test("name lookup ignores case and surrounding space", () => {
  assert.equal(findStateByName(INDIAN_STATES, " delhi ").code, "07");
  assert.equal(findStateByName(INDIAN_STATES, "WEST BENGAL").code, "19");
});

test("code lookup tolerates a missing leading zero", () => {
  assert.equal(findStateByCode(INDIAN_STATES, 7).name, "Delhi");
  assert.equal(findStateByCode(INDIAN_STATES, "07").name, "Delhi");
});

test("an unknown state is null, not a wrong guess", () => {
  assert.equal(findStateByName(INDIAN_STATES, "Mumbai"), null, "Mumbai is a city");
  assert.equal(findStateByName(INDIAN_STATES, "Jaipur"), null, "Jaipur is a city");
  assert.equal(findStateByCode(INDIAN_STATES, "99"), null);
});

test("the label pairs the code with the name", () => {
  assert.equal(stateLabel({ code: "7", name: "Delhi" }), "07 — Delhi");
  assert.equal(stateLabel(null), "");
});

console.log("\n--- seeding ---");

test("an empty master gets the whole list", () => {
  assert.equal(planStateSeed({ existing: [] }).length, INDIAN_STATES.length);
  assert.equal(planStateSeed().length, INDIAN_STATES.length);
});

test("a state already present by code is not created again", () => {
  const plan = planStateSeed({ existing: [{ code: "07", name: "Delhi" }] });
  assert.equal(plan.length, INDIAN_STATES.length - 1);
  assert.ok(!plan.some((s) => s.code === "07"));
});

test("a state present under a different code is still matched by name", () => {
  // Someone may have typed Delhi in by hand with the wrong code; seeding must
  // not add a second Delhi beside it.
  const plan = planStateSeed({ existing: [{ code: "99", name: "Delhi" }] });
  assert.ok(!plan.some((s) => s.name === "Delhi"), "Delhi must not be duplicated");
});

test("a fully seeded master plans nothing", () => {
  assert.deepEqual(planStateSeed({ existing: INDIAN_STATES }), []);
});

console.log(`\n  ${passed} checks passed\n`);
