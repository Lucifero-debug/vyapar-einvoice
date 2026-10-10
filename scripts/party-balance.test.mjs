/**
 * Fixture tests for the party balance shown on the billing pages.
 *
 *   node scripts/party-balance.test.mjs
 *
 * The thing worth guarding is that the balance resolves in BOTH shapes the
 * billing pages put in `selectedCustomer`: the full master document when the
 * party is picked from the dropdown, and the invoice's embedded
 * { name, phone, email, custId } snapshot when a saved invoice is reopened.
 * The snapshot carries no balance, so a naive `selectedCustomer.lastBal` shows
 * a figure while writing a bill and a blank while editing one.
 */

import assert from "node:assert/strict";
import { livePartyFor, balanceGloss, partyCity } from "../lib/partyBalance.mjs";
import { formatINR } from "../lib/currency.mjs";
import { toDisplay } from "../lib/balance.mjs";

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

// The master, in the shape /api/get-customer returns it.
const MASTER = [
  { _id: "aaa", name: "Ramesh Traders", city: "Ludhiana", lastBal: 1500, lastMode: "Dr" },
  { _id: "bbb", name: "Verma Textiles", city: "Surat", lastBal: -2400.5, lastMode: "Cr" },
  { _id: "ccc", name: "Settled Party", city: "", lastBal: 0, lastMode: "Dr" },
  { _id: "ddd", name: "Never Traded" },
];

/** Exactly what <PartyBalance> ends up putting on screen. */
const shown = (selected, customers = MASTER) => {
  const live = livePartyFor(selected, customers);
  if (!live) return null;
  const { amount, mode } = toDisplay(live.lastBal);
  return amount === 0 ? "settled" : `${formatINR(amount)} ${mode}`;
};

console.log("\n--- picked from the dropdown: the full master document ---");

test("a party that owes us reads Dr", () => {
  assert.equal(shown(MASTER[0]), "₹1,500.00 Dr");
});

test("a party we owe reads Cr", () => {
  assert.equal(shown(MASTER[1]), "₹2,400.50 Cr");
});

test("a zero balance says settled, not Rs 0.00 Dr", () => {
  assert.equal(shown(MASTER[2]), "settled");
});

test("a party that has never traded says settled", () => {
  // No lastBal field at all, which is what a freshly seeded party looks like.
  assert.equal(shown(MASTER[3]), "settled");
});

console.log("\n--- reopened invoice: only the embedded snapshot ---");

test("the snapshot resolves by custId", () => {
  const snapshot = { name: "Ramesh Traders", phone: "9876543210", email: "", custId: "aaa" };
  assert.equal(shown(snapshot), "₹1,500.00 Dr");
});

test("a snapshot written before custId existed resolves by name", () => {
  assert.equal(shown({ name: "Verma Textiles" }), "₹2,400.50 Cr");
});

test("custId wins when the snapshot's name is stale", () => {
  // The party was renamed after this invoice was written.
  assert.equal(shown({ name: "Ramesh Trdrs", custId: "aaa" }), "₹1,500.00 Dr");
});

test("a stale custId falls back to a name that still matches", () => {
  assert.equal(shown({ name: "Ramesh Traders", custId: "zzz" }), "₹1,500.00 Dr");
});

test("custId beats a name that now belongs to somebody else", () => {
  // "Ramesh Traders" was renamed, and a DIFFERENT party later took that name.
  // Matching on the name first would put the new party's balance on the old
  // party's invoice -- the wrong figure, shown confidently.
  const master = [
    { _id: "aaa", name: "Ramesh Enterprises", lastBal: 1500 },
    { _id: "nnn", name: "Ramesh Traders", lastBal: -9999 },
  ];
  assert.equal(shown({ name: "Ramesh Traders", custId: "aaa" }, master), "\u20B91,500.00 Dr");
});

test("an id that is an ObjectId rather than a string still matches", () => {
  // Anything that did not come through JSON hands over an ObjectId, which is
  // never === a string.
  const objectId = { toString: () => "aaa" };
  const master = [{ _id: objectId, name: "Ramesh Traders", lastBal: 1500 }];
  assert.equal(shown({ name: "someone else", custId: "aaa" }, master), "\u20B91,500.00 Dr");
});

console.log("\n--- nothing to show beats a confident zero ---");

test("no party selected shows nothing", () => {
  assert.equal(shown({}), null);
  assert.equal(shown(undefined), null);
  assert.equal(shown({ name: "" }), null);
});

test("a party no longer in the master shows nothing", () => {
  assert.equal(shown({ name: "Deleted Party", custId: "xxx" }), null);
});

test("an empty or missing master shows nothing", () => {
  assert.equal(shown(MASTER[0], []), null);
  assert.equal(livePartyFor({ name: "Ramesh Traders" }), null);
});

console.log("\n--- Dr/Cr follows the sign, not the cache ---");

test("a drifted lastMode cache does not decide the label", () => {
  // lastBal says we owe them; the cache wrongly says Dr. The sign wins.
  const drifted = [{ _id: "eee", name: "Drifted", lastBal: -900, lastMode: "Dr" }];
  assert.equal(shown({ name: "Drifted" }, drifted), "₹900.00 Cr");
});

console.log("\n--- rupees are grouped the Indian way ---");

test("lakhs group as 12,34,567.50 and not 1,234,567.50", () => {
  const big = [{ _id: "fff", name: "Big Co", lastBal: 1234567.5 }];
  assert.equal(shown({ name: "Big Co" }, big), "₹12,34,567.50 Dr");
});

test("formatINR never prints NaN at a customer", () => {
  assert.equal(formatINR(undefined), "₹0.00");
  assert.equal(formatINR("abc"), "₹0.00");
  assert.equal(formatINR(null), "₹0.00");
});

console.log("\n--- the wording depends on what kind of account it is ---");

test("a trading party owes us on Dr and is owed on Cr", () => {
  assert.equal(balanceGloss("Dr", "Sundry Debtors"), "owes you");
  assert.equal(balanceGloss("Cr", "Sundry Debtors"), "you owe");
  assert.equal(balanceGloss("Dr", ""), "owes you");
  assert.equal(balanceGloss("Cr", undefined), "you owe");
});

test("the cash drawer holds money on Dr, it does not owe it", () => {
  // "Cash owes you Rs 50,000" is nonsense -- the drawer IS the fifty thousand.
  assert.equal(balanceGloss("Dr", "Cash"), "in hand");
  assert.equal(balanceGloss("Cr", "Cash"), "overdrawn");
});

test("a bank account reads as a balance in the account", () => {
  assert.equal(balanceGloss("Dr", "Bank"), "in account");
  assert.equal(balanceGloss("Cr", "Bank"), "overdrawn");
});

test("the group is matched the way the cash resolver matches it", () => {
  // lib/cashAccount.mjs uses /^cash$/i and /^bank$/i, so case and stray
  // whitespace must not change the reading.
  assert.equal(balanceGloss("Dr", "cash"), "in hand");
  assert.equal(balanceGloss("Dr", "  CASH  "), "in hand");
  assert.equal(balanceGloss("Dr", "bank"), "in account");
  assert.equal(balanceGloss("Cr", " Bank"), "overdrawn");
});

test("a group that merely contains the word cash is a trading party", () => {
  // "Cash Sales Parties" is a normal debtor group, not the drawer.
  assert.equal(balanceGloss("Dr", "Cash Sales Parties"), "owes you");
  assert.equal(balanceGloss("Dr", "Petty Cash Staff"), "owes you");
  assert.equal(balanceGloss("Dr", "Bank Guarantee Parties"), "owes you");
});

console.log("\n--- the city comes off the master, not off the document ---");

/** The city the line would print for a given selection. */
const cityShown = (selected, customers = MASTER) =>
  partyCity(livePartyFor(selected, customers));

test("a party picked from the dropdown shows its city", () => {
  assert.equal(cityShown(MASTER[0]), "Ludhiana");
  assert.equal(cityShown(MASTER[1]), "Surat");
});

test("a reopened invoice still shows the city", () => {
  // The invoice snapshot is only { name, phone, email, custId } -- it has no
  // city on it, so reading selectedCustomer.city would print the city while
  // writing a bill and nothing at all on every saved one.
  const snapshot = { name: "Ramesh Traders", phone: "9876543210", custId: "aaa" };
  assert.equal(snapshot.city, undefined, "the snapshot must not carry a city");
  assert.equal(cityShown(snapshot), "Ludhiana");
});

test("a party with no city prints nothing, not undefined", () => {
  assert.equal(cityShown(MASTER[2]), "");
  assert.equal(cityShown(MASTER[3]), "");
  assert.equal(partyCity(undefined), "");
  assert.equal(partyCity({}), "");
  assert.equal(partyCity({ city: null }), "");
});

test("a whitespace-only city is nothing, not a stray separator", () => {
  // Rendered as-is this would print "   " followed by the separator dot, which
  // reads as a missing word rather than as no city.
  assert.equal(partyCity({ city: "   " }), "");
  assert.equal(partyCity({ city: "\t\n" }), "");
});

test("a city keeps its inner spacing and case", () => {
  assert.equal(partyCity({ city: "  New Delhi  " }), "New Delhi");
  assert.equal(partyCity({ city: "Navi Mumbai" }), "Navi Mumbai");
});

test("the city never decides the balance, and vice versa", () => {
  // A party whose city changed is still the same party with the same balance.
  const moved = [{ _id: "aaa", name: "Ramesh Traders", city: "Amritsar", lastBal: 1500 }];
  assert.equal(cityShown({ name: "Ramesh Traders", custId: "aaa" }, moved), "Amritsar");
  assert.equal(shown({ name: "Ramesh Traders", custId: "aaa" }, moved), "\u20B91,500.00 Dr");
});

console.log(`\n  ${passed} checks passed\n`);
