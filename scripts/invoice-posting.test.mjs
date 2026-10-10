/**
 * Fixture tests for the two invoice posting rules.
 *
 *   node scripts/invoice-posting.test.mjs
 *
 * Both of these shipped wrong once, and both failed quietly:
 *   - a fully-paid sale posted a zero delta and vanished from the books
 *   - returns moved stock backwards because the stock rule read a field the
 *     UI has never sent
 * Neither throws, so only assertions catch them coming back.
 */

import assert from "node:assert/strict";
import {
  invoiceDelta,
  isInwardStock,
  receiptDelta,
  round2,
} from "../lib/balance.mjs";

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

const SALE = { type: "Sale", isReturn: false };
const SALE_RETURN = { type: "Sale", isReturn: true };
const PURCHASE = { type: "Purchase", isReturn: false };
const PURCHASE_RETURN = { type: "Purchase", isReturn: true };

console.log("\n--- stock direction ---");

test("a purchase brings stock in", () => {
  assert.equal(isInwardStock(PURCHASE), true);
});

test("a sale takes stock out", () => {
  assert.equal(isInwardStock(SALE), false);
});

test("a sale return puts stock back", () => {
  assert.equal(isInwardStock(SALE_RETURN), true);
});

test("a purchase return takes stock back out", () => {
  assert.equal(isInwardStock(PURCHASE_RETURN), false);
});

test("a return is always the opposite of the document it reverses", () => {
  assert.notEqual(isInwardStock(SALE), isInwardStock(SALE_RETURN));
  assert.notEqual(isInwardStock(PURCHASE), isInwardStock(PURCHASE_RETURN));
});

test("isReturn defaults to false rather than reading as a return", () => {
  assert.equal(isInwardStock({ type: "Sale" }), false);
  assert.equal(isInwardStock({ type: "Purchase" }), true);
});

test("stock direction follows the sign of the money movement", () => {
  // The two rules drifted apart once; this ties them together explicitly.
  for (const doc of [SALE, SALE_RETURN, PURCHASE, PURCHASE_RETURN]) {
    const money = invoiceDelta({ ...doc, amount: 100 });
    // Party owes us more (+) exactly when goods left the building.
    assert.equal(isInwardStock(doc), money < 0, JSON.stringify(doc));
  }
});

console.log("\n--- receipt leg ---");

test("cash received on a sale comes in, party comes down", () => {
  const { cash, party } = receiptDelta({ ...SALE, received: 500 });
  assert.equal(cash, 500);
  assert.equal(party, -500);
});

test("cash paid on a purchase goes out, payable comes down", () => {
  const { cash, party } = receiptDelta({ ...PURCHASE, received: 500 });
  assert.equal(cash, -500);
  assert.equal(party, 500);
});

test("a refund on a sale return takes cash out", () => {
  const { cash, party } = receiptDelta({ ...SALE_RETURN, received: 500 });
  assert.equal(cash, -500);
  assert.equal(party, 500);
});

test("money back on a purchase return brings cash in", () => {
  const { cash, party } = receiptDelta({ ...PURCHASE_RETURN, received: 500 });
  assert.equal(cash, 500);
  assert.equal(party, -500);
});

test("the two legs of a receipt always cancel", () => {
  for (const doc of [SALE, SALE_RETURN, PURCHASE, PURCHASE_RETURN]) {
    const { cash, party } = receiptDelta({ ...doc, received: 137.55 });
    assert.equal(round2(cash + party), 0, JSON.stringify(doc));
  }
});

test("nothing received moves nothing", () => {
  const { cash, party } = receiptDelta({ ...SALE, received: 0 });
  assert.equal(cash, 0);
  assert.equal(party, 0);
});

console.log("\n--- the invariant that makes this safe to switch on ---");

test("full invoice + receipt nets to the old balanceDue posting", () => {
  // Existing party balances must not shift when the receipt leg is switched
  // on: only the ledger detail and the cash account change.
  const cases = [
    [SALE, 1000, 1000], // fully paid
    [SALE, 1000, 400], // part paid
    [SALE, 1000, 0], // fully on credit
    [SALE, 1000, 1200], // overpaid
    [PURCHASE, 750.5, 250.25],
    [SALE_RETURN, 300, 300],
    [PURCHASE_RETURN, 90.75, 40.25],
  ];

  for (const [doc, finalAmount, received] of cases) {
    const docDelta = invoiceDelta({ ...doc, amount: finalAmount });
    const { party } = receiptDelta({ ...doc, received });
    const net = round2(docDelta + party);

    const legacy = invoiceDelta({ ...doc, amount: round2(finalAmount - received) });
    assert.equal(net, legacy, `${JSON.stringify(doc)} ${finalAmount}/${received}`);
  }
});

test("a fully-paid sale is no longer invisible", () => {
  // The bug: balanceDue is 0, so the only posting was a zero delta.
  const docDelta = invoiceDelta({ ...SALE, amount: 5000 });
  const { cash, party } = receiptDelta({ ...SALE, received: 5000 });

  assert.equal(invoiceDelta({ ...SALE, amount: 0 }), 0, "old behaviour posted nothing");
  assert.equal(docDelta, 5000, "sale now reaches the ledger in full");
  assert.equal(cash, 5000, "and the money lands in cash");
  assert.equal(round2(docDelta + party), 0, "party still nets to nil");
});

console.log(`\n${passed} passed\n`);
