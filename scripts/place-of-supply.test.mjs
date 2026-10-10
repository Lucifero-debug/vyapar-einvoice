/**
 * Fixture tests for the place of supply.
 *
 *   node scripts/place-of-supply.test.mjs
 *
 * The state code is the first two digits of a GSTIN, and it is what decides
 * whether a supply is intra-state or inter-state. It used to be a dropdown
 * picked per bill; it now comes from the party's master and nowhere else.
 *
 * So what is guarded here is: the master wins, nothing is invented when the
 * master is blank, a code never loses its leading zero, and neither the form
 * nor the routes can go back to deciding it for themselves.
 *
 * NOTE: this file is deliberately identical in `vyapaar` and in
 * `vyapaar-einvoice`, like lib/placeOfSupply.mjs itself.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  needsStateLookup,
  placeOfSupply,
  placeOfSupplyLabel,
} from "../lib/placeOfSupply.mjs";

let passed = 0;
const test = (name, fn) => {
  try {
    // An async test body would report "ok" before it had asserted anything:
    // the throw lands in a promise nobody waits for. Refuse one outright.
    const result = fn();
    assert.equal(result, undefined, "this test body is async -- make it synchronous");
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  }
};

/** A party as `customers` stores one. */
const PARTY = { name: "Sharma Traders", state: "Punjab", stateCode: "03" };

const STATES = [
  { name: "Delhi", code: "07" },
  { name: "Punjab", code: 3 },
  { name: "Maharashtra", code: "27" },
];

console.log("\n--- it comes from the party, not a dropdown ---");

test("a party with a state and a code needs no help", () => {
  assert.deepEqual(placeOfSupply(PARTY), { stateOfSupply: "Punjab", stateCode: "03" });
  assert.equal(needsStateLookup(PARTY), false);
});

test("a code saved as a number keeps its leading zero", () => {
  // Delhi is "07", not 7. Stored as a Number it loses the zero, and a GSTIN
  // starting 07 then disagrees with it.
  assert.equal(placeOfSupply({ state: "Delhi", stateCode: 7 }).stateCode, "07");
  assert.equal(placeOfSupply({ state: "Delhi", stateCode: "7" }).stateCode, "07");
  assert.equal(placeOfSupply({ state: "Delhi", stateCode: 0 }).stateCode, "");
  assert.equal(placeOfSupply({ state: "Delhi", stateCode: "xx" }).stateCode, "");
});

test("values are trimmed", () => {
  assert.deepEqual(placeOfSupply({ state: "  Punjab  ", stateCode: " 03 " }), {
    stateOfSupply: "Punjab",
    stateCode: "03",
  });
});

console.log("\n--- a missing half is filled in from the states master ---");

test("a party with the name and no code gets the code", () => {
  // Parties recorded before the customer form had a state dropdown have one
  // and not the other. A blank state code on a GST invoice is worth a lookup.
  const party = { state: "Punjab" };
  assert.equal(needsStateLookup(party), true);
  assert.deepEqual(placeOfSupply(party, STATES), { stateOfSupply: "Punjab", stateCode: "03" });
  // Without the master there is nothing to fill it from, and nothing invented.
  assert.deepEqual(placeOfSupply(party), { stateOfSupply: "Punjab", stateCode: "" });
});

test("a party with the code and no name gets the name", () => {
  assert.deepEqual(placeOfSupply({ stateCode: 7 }, STATES), {
    stateOfSupply: "Delhi",
    stateCode: "07",
  });
  assert.equal(needsStateLookup({ stateCode: "07" }), true);
});

test("the lookup never overwrites a code the party already has", () => {
  // Even when the two disagree, what the master says wins. Correcting it is
  // the customer form's job, not a silent rewrite at billing time.
  assert.equal(placeOfSupply({ state: "Punjab", stateCode: "27" }, STATES).stateCode, "27");
});

test("the lookup is case- and space-insensitive, like the rest of the joins", () => {
  assert.equal(placeOfSupply({ state: "  delhi " }, STATES).stateCode, "07");
  assert.equal(placeOfSupply({ state: "PUNJAB" }, STATES).stateCode, "03");
});

test("a state that is not in the master keeps its name and gets no code", () => {
  assert.deepEqual(placeOfSupply({ state: "Atlantis" }, STATES), {
    stateOfSupply: "Atlantis",
    stateCode: "",
  });
});

test("a party with no state at all yields blanks, never undefined", () => {
  for (const party of [null, undefined, {}, { name: "Walk-in" }, { state: "  " }]) {
    const place = placeOfSupply(party, STATES);
    assert.deepEqual(place, { stateOfSupply: "", stateCode: "" }, JSON.stringify(party));
    assert.equal(needsStateLookup(party), false, "there is nothing to look up");
    assert.ok(!JSON.stringify(place).includes("undefined"));
  }
});

console.log("\n--- the line the form shows ---");

test("it reads the way the dropdown used to", () => {
  assert.equal(placeOfSupplyLabel(placeOfSupply(PARTY)), "03 — Punjab");
  assert.equal(placeOfSupplyLabel(placeOfSupply({ state: "Delhi", stateCode: 7 })), "07 — Delhi");
});

test("half an answer still reads as something", () => {
  assert.equal(placeOfSupplyLabel({ stateOfSupply: "Atlantis" }), "Atlantis");
  assert.equal(placeOfSupplyLabel({ stateCode: "07" }), "07");
});

test("blank reads as blank, never as a stray dash", () => {
  for (const place of [null, undefined, {}, { stateOfSupply: "", stateCode: "" }, { stateOfSupply: " " }]) {
    assert.equal(placeOfSupplyLabel(place), "", JSON.stringify(place));
  }
});

console.log("\n--- nothing else gets to decide it ---");

const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

test("both invoice routes derive it and ignore what the form sent", () => {
  for (const route of ["app/api/save-invoice/route.js", "app/api/sale-alter/route.js"]) {
    const src = read(route);
    assert.match(src, /placeOfSupply\(/, `${route} does not derive the place of supply`);
    assert.match(src, /stateOfSupply: place\.stateOfSupply/, route);
    assert.match(src, /stateCode: place\.stateCode/, route);
    // The shapes that would mean the body is being trusted again.
    assert.doesNotMatch(src, /stateOfSupply: (body|invoiceData)\./, `${route} still trusts the form`);
    assert.doesNotMatch(src, /stateCode: (body|invoiceData)\./, `${route} still trusts the form`);
  }
});

test("the party is read before the invoice is written", () => {
  // The state cannot be derived from a party nobody has looked up yet.
  const src = read("app/api/save-invoice/route.js");
  assert.ok(
    src.indexOf("Customer.findOne") < src.indexOf("Invoice.create"),
    "save-invoice creates the invoice before it knows who the buyer is"
  );
});

test("the routes ask for the columns the rule reads", () => {
  // A projection without them yields a blank state and no error at all,
  // which is the quietest possible version of this bug.
  for (const route of ["app/api/save-invoice/route.js", "app/api/sale-alter/route.js"]) {
    const src = read(route);
    assert.match(src, /state(Code)?: 1|BUYER_PROJECTION/, `${route} does not project the state columns`);
  }
});

test("the billing pages no longer offer a state to pick", () => {
  for (const page of ["saleadd", "purchaseadd", "salereturn", "purchasereturn"]) {
    const src = read(`app/${page}/page.js`);
    assert.match(src, /placeOfSupplyLabel\(place\)/, `${page} does not show the derived state`);
    assert.doesNotMatch(src, /setStateOfSupply\(e\.target\.value\)/, `${page} still has the dropdown`);
    assert.doesNotMatch(src, /<option value={s\.name}/, `${page} still lists the states master`);
    // What is sent has to be the same value that is shown.
    assert.match(src, /stateOfSupply: place\.stateOfSupply/, page);
    assert.match(src, /stateCode: place\.stateCode/, page);
  }
});

console.log(`\n${passed} checks passed.\n`);
