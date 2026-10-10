/**
 * Fixture tests for the buyer block the invoice carries.
 *
 *   node scripts/buyer-snapshot.test.mjs
 *
 * The thing being protected is that a filed invoice stops changing. Once the
 * IRP has it, the buyer's details on our copy must be the ones that were
 * reported -- so they are copied onto the invoice at save time rather than
 * read back out of the master when the bill is printed.
 *
 * The other trap in here is spelling. `custModel` calls the buyer's GSTIN
 * `gstIn`; everything else in the project, and the IRP, call it `gstin`. A
 * snapshot that quietly read the wrong one would leave every invoice looking
 * like a B2C supply, which is a filing that cannot be corrected afterwards.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  BUYER_FIELDS,
  BUYER_PROJECTION,
  buyerMissing,
  buyerSnapshot,
  isB2B,
  partyGstin,
  placeOfSupply,
} from "../lib/buyerSnapshot.mjs";

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

/** A party as `customers` stores one. Note the capital I in gstIn. */
const PARTY = {
  _id: "66f1c0ffee0000000000abcd",
  name: "Sharma Traders",
  phone: "9811122233",
  email: "sharma@example.in",
  gstIn: "03AABBC1234D1Z5",
  address: "12 Main Bazaar",
  city: "Ludhiana",
  state: "Punjab",
  pincode: "141001",
  stateCode: "03",
};

console.log("\n--- the registration details come from the master ---");

test("a party with everything filled in snapshots completely", () => {
  const buyer = buyerSnapshot(PARTY, { name: "Sharma Traders" });
  assert.deepEqual(buyer, {
    name: "Sharma Traders",
    phone: "9811122233",
    email: "sharma@example.in",
    custId: "66f1c0ffee0000000000abcd",
    gstin: "03AABBC1234D1Z5",
    address: "12 Main Bazaar",
    city: "Ludhiana",
    state: "Punjab",
    pincode: "141001",
    stateCode: "03",
  });
});

test("gstIn and gstin are both read, and upper-cased", () => {
  assert.equal(partyGstin({ gstIn: "03aabbc1234d1z5" }), "03AABBC1234D1Z5");
  assert.equal(partyGstin({ gstin: "03aabbc1234d1z5" }), "03AABBC1234D1Z5");
  assert.equal(buyerSnapshot({ gstIn: "03AABBC1234D1Z5" }).gstin, "03AABBC1234D1Z5");
  assert.equal(buyerSnapshot({ gstin: "03AABBC1234D1Z5" }).gstin, "03AABBC1234D1Z5");
  assert.equal(partyGstin({}), "");
  assert.equal(partyGstin(null), "");
});

test("the form cannot supply registration details, only contact ones", () => {
  // A bill that tried to send its own GSTIN or address would be claiming
  // something the master does not say. It is ignored.
  const buyer = buyerSnapshot(PARTY, {
    name: "Sharma Traders",
    gstin: "99ZZZZZ9999Z9Z9",
    address: "Somewhere else entirely",
    city: "Nowhere",
    pincode: "999999",
    stateCode: "99",
  });
  assert.equal(buyer.gstin, "03AABBC1234D1Z5");
  assert.equal(buyer.address, "12 Main Bazaar");
  assert.equal(buyer.city, "Ludhiana");
  assert.equal(buyer.pincode, "141001");
  assert.equal(buyer.stateCode, "03");
});

test("a phone typed on the bill wins over the master's", () => {
  const buyer = buyerSnapshot(PARTY, { name: "Sharma Traders", phone: "9999988888" });
  assert.equal(buyer.phone, "9999988888");
  // Blank on the bill falls back rather than wiping it.
  assert.equal(buyerSnapshot(PARTY, { phone: "" }).phone, "9811122233");
  assert.equal(buyerSnapshot(PARTY, { phone: "   " }).phone, "9811122233");
});

test("the party's own id is kept, so a rename can still find them", () => {
  assert.equal(buyerSnapshot(PARTY, {}).custId, PARTY._id);
  // An upload may carry an id for a party this lookup missed.
  assert.equal(buyerSnapshot(null, { custId: "from-the-upload" }).custId, "from-the-upload");
});

test("a state code saved as a number keeps its leading zero", () => {
  assert.equal(buyerSnapshot({ stateCode: 3 }).stateCode, "03");
  assert.equal(buyerSnapshot({ stateCode: "7" }).stateCode, "07");
  assert.equal(buyerSnapshot({ stateCode: 0 }).stateCode, "");
  assert.equal(buyerSnapshot({ stateCode: "xx" }).stateCode, "");
});

console.log("\n--- nothing invented, nothing dropped ---");

test("every field is a string, never undefined", () => {
  for (const party of [null, undefined, {}, { name: "Walk-in" }]) {
    const buyer = buyerSnapshot(party);
    assert.deepEqual(Object.keys(buyer).sort(), [...BUYER_FIELDS].sort());
    for (const field of BUYER_FIELDS) {
      assert.equal(typeof buyer[field], "string", `${field} on ${JSON.stringify(party)}`);
    }
    assert.ok(!JSON.stringify(buyer).includes("undefined"));
  }
});

test("values are trimmed", () => {
  const buyer = buyerSnapshot({ name: "  Sharma Traders  ", city: " Ludhiana " });
  assert.equal(buyer.name, "Sharma Traders");
  assert.equal(buyer.city, "Ludhiana");
});

test("nothing from the master beyond the listed fields comes along", () => {
  const buyer = buyerSnapshot({ ...PARTY, lastBal: -5000, openingBal: 100, discount: 5 });
  assert.deepEqual(Object.keys(buyer).sort(), [...BUYER_FIELDS].sort());
  assert.ok(!("lastBal" in buyer), "a running balance has no business on an invoice");
});

test("the projection asks for everything the snapshot reads", () => {
  // A route that projects fewer fields than this gets a snapshot full of
  // blanks and no error at all, which is the quietest possible version of
  // this bug.
  for (const key of ["name", "phone", "email", "gstIn", "address", "city", "state", "pincode", "stateCode", "_id"]) {
    assert.equal(BUYER_PROJECTION[key], 1, `the projection is missing ${key}`);
  }
});

console.log("\n--- B2B or B2C is decided by the GSTIN ---");

test("a fifteen-character GSTIN makes it a B2B supply", () => {
  assert.equal(isB2B(buyerSnapshot(PARTY)), true);
  assert.equal(isB2B(buyerSnapshot({ name: "Walk-in customer" })), false);
  assert.equal(isB2B({ gstin: "03AABBC1234D1Z" }), false, "fourteen characters is not a GSTIN");
  assert.equal(isB2B(null), false);
  assert.equal(isB2B({}), false);
});

test("a B2B buyer with gaps is named, field by field", () => {
  assert.deepEqual(buyerMissing(buyerSnapshot(PARTY)), []);
  assert.deepEqual(buyerMissing(buyerSnapshot({ ...PARTY, pincode: "" })), ["PIN code"]);
  assert.deepEqual(buyerMissing(buyerSnapshot({ name: "Walk-in" })), [
    "GSTIN",
    "address",
    "city",
    "PIN code",
    "state code",
  ]);
  assert.deepEqual(buyerMissing(null).length > 0, true);
});

test("the buyer's state and the place of supply are not the same field", () => {
  // The invoice has a top-level `stateCode` for the place of supply. This one
  // is the buyer's own registration. On a Punjab buyer taking delivery in
  // Delhi they differ, and swapping them is a wrong filing.
  const buyer = buyerSnapshot(PARTY);
  assert.equal(buyer.stateCode, "03");
  assert.ok(!("stateOfSupply" in buyer), "the place of supply does not belong in the buyer block");
  assert.ok(!("pos" in buyer));
});

console.log("\n--- the schema and the routes agree with the shape ---");

const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

test("every snapshot field is declared on the invoice schema", () => {
  // Mongoose strict mode drops what is not declared, with no error. A field
  // in BUYER_FIELDS and not in the schema means the value is captured, sent,
  // and silently thrown away -- which is how five earlier fields were lost.
  const schema = read("models/invoiceModel.js");
  const block = schema.slice(schema.indexOf("customer: {"), schema.indexOf("hsnTotals:"));
  for (const field of BUYER_FIELDS) {
    if (field === "name") continue; // declared as required, same block
    assert.match(block, new RegExp(`\\b${field}:\\s*\\{\\s*type:`), `${field} is not declared`);
  }
});

test("both routes build the buyer block with buyerSnapshot()", () => {
  for (const route of ["app/api/save-invoice/route.js", "app/api/sale-alter/route.js"]) {
    const src = read(route);
    assert.match(src, /buyerSnapshot\(/, `${route} does not use the snapshot`);
    assert.match(src, /BUYER_PROJECTION/, `${route} does not project the fields it needs`);
    // The regression that matters: a hand-written block with three fields in
    // it, which drops the GSTIN, the address and custId all at once.
    assert.doesNotMatch(
      src,
      /customer:\s*\{\s*\n\s*name:/,
      `${route} writes the customer block by hand again`
    );
  }
});

test("the party is read before the invoice is written", () => {
  // Both the snapshot and the "customer not found" refusal depend on it.
  const src = read("app/api/save-invoice/route.js");
  assert.ok(
    src.indexOf("Customer.findOne") < src.indexOf("Invoice.create"),
    "save-invoice creates the invoice before it knows who the buyer is"
  );
  const alter = read("app/api/sale-alter/route.js");
  assert.ok(
    alter.indexOf("BUYER_PROJECTION") < alter.indexOf("Invoice.findOneAndUpdate"),
    "sale-alter updates the invoice before reading the buyer"
  );
});

console.log("\n--- the place of supply agrees with the buyer block ---");

test("they are read from the same two columns", () => {
  // So the top-level state on an invoice cannot drift from the buyer block
  // beside it. The rule itself is tested in scripts/place-of-supply.test.mjs.
  const buyer = buyerSnapshot(PARTY);
  const place = placeOfSupply(buyer);
  assert.equal(place.stateOfSupply, buyer.state);
  assert.equal(place.stateCode, buyer.stateCode);
  assert.equal(place.stateCode, "03");
});

console.log(`\n${passed} checks passed.\n`);
