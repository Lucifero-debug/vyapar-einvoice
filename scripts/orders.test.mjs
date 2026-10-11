/**
 * Fixture tests for sales and purchase orders.
 *
 *   node scripts/orders.test.mjs
 *
 * The whole feature rests on one subtraction -- pending = ordered - cancelled
 * - invoiced -- and on the invoice line that points back at the order line it
 * consumed. So this file spends most of its effort on four failure modes,
 * each of which silently corrupts a client's order book rather than throwing:
 *
 *   1. OVER-BILLING. Two bills raised against one order, each for the full
 *      quantity. The pending figure must refuse the second, not go negative.
 *
 *   2. SPLIT LINES. One order line billed across two invoice lines. The
 *      claims must ADD, not overwrite -- taking the last value leaves the
 *      order half open forever.
 *
 *   3. EDITS THAT SHRINK HISTORY. An order reduced below what has already
 *      been billed, or a billed line deleted outright.
 *
 *   4. FLOAT DUST. 0.1 + 0.2 quantities that never compare equal to zero, so
 *      an order that is fully billed still shows as pending.
 *
 * The back-reference on the invoice line is Sigfa's (ORDERNO + OMKEY +
 * OREFNO, populated on 9,260 of their 12,413 invoice lines). The running
 * `invoicedQty` is NOT theirs -- their INVQTY mirrors QTY and they derive
 * pending by joining instead; see the note atop lib/orderStatus.mjs. What is
 * also not copied is tax: an order stores none, so there is nothing here
 * about GST.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  ORDER_STATUSES,
  ORDER_TYPES,
  applyCancel,
  applyRestore,
  cancelBlockedReason,
  cancellableQty,
  cancellationEntry,
  cancellationSummary,
  nothingToCancel,
  restoreBlockedReason,
  QTY_EPSILON,
  applyDeltas,
  cancelledQty,
  claimsFromItems,
  deleteBlockedReason,
  editBlockedReason,
  invoicedQty,
  isOpenOrder,
  isOrderType,
  isSettled,
  lineRef,
  lineStatus,
  lineSummary,
  lineTotal,
  netClaims,
  orderKey,
  orderStatus,
  orderTotal,
  orderedQty,
  pendingLines,
  pendingQty,
  pendingValue,
  roundQty,
  toInvoiceLines,
  trim,
} from "../lib/orderStatus.mjs";
import { pickFromOrder, pickableLines, prefillFromOrder } from "../lib/orderPrefill.mjs";

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

/**
 * Read a project file, for the wiring checks.
 *
 * Declared HERE, with the test helper, rather than beside the first wiring
 * check that used it -- a `const` is in its temporal dead zone until the line
 * that declares it runs, so a check added anywhere above threw "Cannot access
 * 'read' before initialization" instead of asserting anything.
 */
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

/** An order line. Quantities default to a clean, wholly unbilled 10. */
const line = (over = {}) => ({
  _id: "l1",
  name: "M8 Bolt",
  hsn: "7318",
  quantity: 10,
  cancelledQty: 0,
  invoicedQty: 0,
  cost: 50,
  discount: 0,
  ...over,
});

const order = (over = {}) => ({
  orderNo: 7,
  type: "Sale",
  date: new Date("2026-10-01"),
  items: [line()],
  ...over,
});

/** An invoice line carrying a reference back to an order line. */
const billed = (over = {}) => ({
  name: "M8 Bolt",
  quantity: 4,
  cost: 50,
  orderNo: 7,
  orderType: "Sale",
  orderLineId: "l1",
  ...over,
});

console.log("\n--- the two documents ---");

test("Sale and Purchase are the order types", () => {
  assert.deepEqual(ORDER_TYPES, ["Sale", "Purchase"]);
  assert.equal(isOrderType("Sale"), true);
  assert.equal(isOrderType("Purchase"), true);
});

test("a sale return is not an order type", () => {
  // Returns reference the ORIGINAL order; they never consume one themselves.
  assert.equal(isOrderType("Sale Return"), false);
  assert.equal(isOrderType("Quotation"), false);
  assert.equal(isOrderType(""), false);
  assert.equal(isOrderType(null), false);
});

test("a type is matched after trimming, not by accident", () => {
  assert.equal(isOrderType("  Sale  "), true);
  assert.equal(isOrderType("sale"), false, "the stored casing is the only one");
});

test("the four statuses are the only ones", () => {
  assert.deepEqual(ORDER_STATUSES, ["open", "partial", "closed", "cancelled"]);
});

console.log("\n--- pending = ordered - cancelled - invoiced ---");

test("a fresh line is wholly pending", () => {
  assert.equal(pendingQty(line()), 10);
  assert.equal(orderedQty(line()), 10);
  assert.equal(invoicedQty(line()), 0);
  assert.equal(cancelledQty(line()), 0);
});

test("billing part of a line leaves the rest pending", () => {
  assert.equal(pendingQty(line({ invoicedQty: 4 })), 6);
});

test("cancelling part of a line leaves the rest pending", () => {
  assert.equal(pendingQty(line({ cancelledQty: 3 })), 7);
});

test("billed and cancelled both come off the same ordered quantity", () => {
  assert.equal(pendingQty(line({ invoicedQty: 4, cancelledQty: 3 })), 3);
});

test("pending never goes negative", () => {
  // Reachable if an order is edited down behind an invoice's back. A negative
  // pending offered back to the billing form would bill a negative quantity.
  assert.equal(pendingQty(line({ quantity: 5, invoicedQty: 8 })), 0);
  assert.equal(pendingQty(line({ quantity: 5, invoicedQty: 4, cancelledQty: 4 })), 0);
});

test("a negative quantity on a line reads as zero, not as a credit", () => {
  assert.equal(orderedQty(line({ quantity: -10 })), 0);
  assert.equal(invoicedQty(line({ invoicedQty: -4 })), 0);
  assert.equal(pendingQty(line({ quantity: -10 })), 0);
});

test("junk quantities read as zero rather than NaN", () => {
  assert.equal(orderedQty(line({ quantity: "abc" })), 0);
  assert.equal(pendingQty(line({ quantity: undefined })), 0);
  assert.equal(pendingQty({}), 0);
  assert.equal(pendingQty(null), 0);
});

test("a quantity typed as a string still counts", () => {
  // The form posts JSON, where a number input arrives as a string often enough.
  assert.equal(pendingQty(line({ quantity: "10", invoicedQty: "4" })), 6);
});

console.log("\n--- float dust ---");

test("three thirds of a line settle exactly", () => {
  // 0.1 + 0.2 === 0.30000000000000004. Billed in three parts, an unrounded
  // pending lands at -8.88e-16 or 8.88e-16 and never equals zero, so the
  // order shows as pending forever and refuses to close.
  const l = line({ quantity: 0.3, invoicedQty: 0.1 + 0.2 });
  assert.equal(pendingQty(l), 0);
  assert.equal(isSettled(l), true);
  assert.equal(lineStatus(l), "closed");
});

test("quantities keep three decimals, not two", () => {
  // 0.125 kg is a real line; rounding it to 0.13 silently bills more than
  // was ordered.
  assert.equal(roundQty(0.125), 0.125);
  assert.equal(roundQty(0.1255), 0.126);
  assert.equal(pendingQty(line({ quantity: 0.125 })), 0.125);
});

test("a residue below the tolerance counts as settled", () => {
  assert.equal(isSettled(line({ quantity: 10, invoicedQty: 9.99999 })), true);
  assert.equal(isSettled(line({ quantity: 10, invoicedQty: 9.9 })), false);
  assert.ok(QTY_EPSILON > 0 && QTY_EPSILON < 0.001);
});

console.log("\n--- line status ---");

test("untouched is open", () => {
  assert.equal(lineStatus(line()), "open");
});

test("part billed is partial", () => {
  assert.equal(lineStatus(line({ invoicedQty: 4 })), "partial");
});

test("part cancelled is partial", () => {
  assert.equal(lineStatus(line({ cancelledQty: 4 })), "partial");
});

test("fully billed is closed", () => {
  assert.equal(lineStatus(line({ invoicedQty: 10 })), "closed");
});

test("fully cancelled is cancelled, not closed", () => {
  // Both have nothing pending. Reporting a cancelled line as fulfilled would
  // show goods as supplied that were never sent.
  assert.equal(lineStatus(line({ cancelledQty: 10 })), "cancelled");
});

test("part billed then the rest cancelled is closed, not cancelled", () => {
  assert.equal(lineStatus(line({ invoicedQty: 4, cancelledQty: 6 })), "closed");
});

test("a zero-quantity line is open, not closed", () => {
  // An empty row on a half-typed order must not close the order.
  assert.equal(lineStatus(line({ quantity: 0 })), "open");
});

console.log("\n--- order status ---");

test("an order with no lines is open", () => {
  assert.equal(orderStatus(order({ items: [] })), "open");
  assert.equal(orderStatus({}), "open");
  assert.equal(orderStatus(null), "open");
});

test("all lines untouched is open", () => {
  assert.equal(
    orderStatus(order({ items: [line({ _id: "a" }), line({ _id: "b" })] })),
    "open"
  );
});

test("all lines billed is closed", () => {
  assert.equal(
    orderStatus(
      order({
        items: [line({ _id: "a", invoicedQty: 10 }), line({ _id: "b", invoicedQty: 10 })],
      })
    ),
    "closed"
  );
});

test("one line billed out of two is partial", () => {
  assert.equal(
    orderStatus(order({ items: [line({ _id: "a", invoicedQty: 10 }), line({ _id: "b" })] })),
    "partial"
  );
});

test("every line cancelled is cancelled", () => {
  assert.equal(
    orderStatus(
      order({
        items: [line({ _id: "a", cancelledQty: 10 }), line({ _id: "b", cancelledQty: 10 })],
      })
    ),
    "cancelled"
  );
});

test("billed and cancelled together is closed, not cancelled", () => {
  assert.equal(
    orderStatus(
      order({
        items: [line({ _id: "a", invoicedQty: 10 }), line({ _id: "b", cancelledQty: 10 })],
      })
    ),
    "closed"
  );
});

test("open and partial orders are the ones still worth listing", () => {
  assert.equal(isOpenOrder(order()), true);
  assert.equal(isOpenOrder(order({ items: [line({ invoicedQty: 4 })] })), true);
  assert.equal(isOpenOrder(order({ items: [line({ invoicedQty: 10 })] })), false);
  assert.equal(isOpenOrder(order({ items: [line({ cancelledQty: 10 })] })), false);
});

test("a null line in the array does not decide the status", () => {
  // The billing pages push an empty row and splice it out again, so a null
  // reaching the server is ordinary rather than exceptional.
  assert.equal(orderStatus(order({ items: [null, line({ invoicedQty: 10 })] })), "closed");
  assert.equal(pendingLines(order({ items: [null, line()] })).length, 1);
});

console.log("\n--- money, with no tax anywhere ---");

test("a line is quantity x rate less the discount percentage", () => {
  assert.equal(lineTotal(line({ quantity: 10, cost: 50 })), 500);
  assert.equal(lineTotal(line({ quantity: 10, cost: 50, discount: 10 })), 450);
});

test("no GST is added to a line, whatever the line carries", () => {
  // An order is a commitment, not a filing. A gstRate riding along on the
  // line -- it will, once the form reuses the invoice row component -- must
  // not reach the total.
  assert.equal(lineTotal(line({ quantity: 10, cost: 50, gstRate: 18 })), 500);
});

test("an order total is the sum of its lines", () => {
  assert.equal(
    orderTotal([line({ quantity: 10, cost: 50 }), line({ quantity: 2, cost: 25 })]),
    550
  );
  assert.equal(orderTotal([]), 0);
  assert.equal(orderTotal(null), 0);
});

test("money rounds to two decimals", () => {
  assert.equal(lineTotal(line({ quantity: 3, cost: 33.333 })), 100);
  assert.equal(lineTotal(line({ quantity: 1, cost: 10, discount: 33.333 })), 6.67);
});

test("pending value prices the pending quantity, not the ordered one", () => {
  // The figure a "what is still to come" report wants. Using orderTotal here
  // would double-count everything already invoiced.
  const o = order({ items: [line({ quantity: 10, cost: 50, invoicedQty: 4 })] });
  assert.equal(orderTotal(o.items), 500);
  assert.equal(pendingValue(o), 300);
});

test("a closed order has no pending value", () => {
  assert.equal(pendingValue(order({ items: [line({ invoicedQty: 10 })] })), 0);
});

console.log("\n--- the reference from an invoice line back to an order line ---");

test("a complete reference resolves", () => {
  assert.deepEqual(lineRef(billed()), { orderNo: 7, orderType: "Sale", lineId: "l1" });
});

test("a plain invoice line has no reference", () => {
  assert.equal(lineRef({ name: "M8 Bolt", quantity: 4 }), null);
  assert.equal(lineRef(null), null);
});

test("naming an order but not which line of it is refused", () => {
  // Two lines of the same item on one order is ordinary. Falling back to a
  // name match would bill one and leave both looking pending.
  assert.equal(lineRef(billed({ orderLineId: "" })), null);
  assert.equal(lineRef(billed({ orderLineId: undefined })), null);
});

test("a reference without a usable order number is refused", () => {
  assert.equal(lineRef(billed({ orderNo: 0 })), null);
  assert.equal(lineRef(billed({ orderNo: -1 })), null);
  assert.equal(lineRef(billed({ orderNo: "abc" })), null);
  assert.equal(lineRef(billed({ orderNo: null })), null);
});

test("a reference to something that is not an order type is refused", () => {
  assert.equal(lineRef(billed({ orderType: "Quotation" })), null);
  assert.equal(lineRef(billed({ orderType: "" })), null);
});

test("sale 1 and purchase 1 are different orders", () => {
  assert.notEqual(orderKey("Sale", 1), orderKey("Purchase", 1));
  assert.equal(orderKey("Sale", 1), orderKey("Sale", "1"));
});

console.log("\n--- claims gathered off an invoice ---");

test("one referenced line produces one claim", () => {
  const claims = claimsFromItems([billed({ quantity: 4 })]);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].orderNo, 7);
  assert.equal(claims[0].orderType, "Sale");
  assert.equal(claims[0].byLine.get("l1"), 4);
});

test("unreferenced lines on the same invoice are ignored", () => {
  const claims = claimsFromItems([billed(), { name: "Freight", quantity: 1 }]);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].byLine.size, 1);
});

test("one order line split across two invoice lines ADDS UP", () => {
  // The bug this guards: 6 at the agreed rate and 4 at a revised one is one
  // order line billed twice on one invoice. Overwriting instead of adding
  // claims 4 of 10 and leaves the order permanently half open.
  const claims = claimsFromItems([
    billed({ quantity: 6, cost: 50 }),
    billed({ quantity: 4, cost: 55 }),
  ]);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].byLine.get("l1"), 10);
});

test("two order lines on one invoice stay apart", () => {
  const claims = claimsFromItems([
    billed({ quantity: 4, orderLineId: "l1" }),
    billed({ quantity: 3, orderLineId: "l2" }),
  ]);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].byLine.get("l1"), 4);
  assert.equal(claims[0].byLine.get("l2"), 3);
});

test("two orders on one invoice produce two claims", () => {
  const claims = claimsFromItems([
    billed({ orderNo: 7 }),
    billed({ orderNo: 8, orderLineId: "l9" }),
  ]);
  assert.equal(claims.length, 2);
  assert.deepEqual(claims.map((c) => c.orderNo).sort(), [7, 8]);
});

test("a zero-quantity referenced line claims nothing", () => {
  assert.deepEqual(claimsFromItems([billed({ quantity: 0 })]), []);
  assert.deepEqual(claimsFromItems([]), []);
  assert.deepEqual(claimsFromItems(null), []);
});

console.log("\n--- applying a claim ---");

test("claiming the pending quantity settles the line", () => {
  const { items, problems } = applyDeltas(order(), new Map([["l1", 10]]));
  assert.deepEqual(problems, []);
  assert.equal(items[0].invoicedQty, 10);
  assert.equal(pendingQty(items[0]), 0);
});

test("claiming twice accumulates rather than replaces", () => {
  const first = applyDeltas(order(), new Map([["l1", 4]]));
  const second = applyDeltas({ items: first.items }, new Map([["l1", 3]]));
  assert.deepEqual(second.problems, []);
  assert.equal(second.items[0].invoicedQty, 7);
});

test("OVER-BILLING IS REFUSED", () => {
  // The headline guard. Two full bills against one order.
  const first = applyDeltas(order(), new Map([["l1", 10]]));
  assert.deepEqual(first.problems, []);
  const second = applyDeltas({ items: first.items }, new Map([["l1", 10]]));
  assert.equal(second.problems.length, 1);
  assert.match(second.problems[0], /only 0 left to bill of 10 ordered/);
});

test("billing one more than remains is refused", () => {
  const { problems } = applyDeltas(order({ items: [line({ invoicedQty: 9 })] }), new Map([["l1", 2]]));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /only 1 left to bill/);
});

test("a cancelled quantity is not available to bill", () => {
  const o = order({ items: [line({ quantity: 10, cancelledQty: 6 })] });
  assert.deepEqual(applyDeltas(o, new Map([["l1", 4]])).problems, []);
  assert.equal(applyDeltas(o, new Map([["l1", 5]])).problems.length, 1);
});

test("releasing a claim gives the quantity back", () => {
  const { items, problems } = applyDeltas(
    order({ items: [line({ invoicedQty: 4 })] }),
    new Map([["l1", -4]])
  );
  assert.deepEqual(problems, []);
  assert.equal(items[0].invoicedQty, 0);
  assert.equal(pendingQty(items[0]), 10);
});

test("releasing more than was claimed is refused", () => {
  // Would drive invoicedQty negative and show the line as pending twice over.
  const { problems } = applyDeltas(
    order({ items: [line({ invoicedQty: 4 })] }),
    new Map([["l1", -6]])
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /cannot un-bill 6 when only 4 was billed/);
});

test("a claim against a line that is not on the order is refused", () => {
  // The order was edited underneath the invoice. Ignoring it would bill goods
  // against no commitment at all.
  const { problems } = applyDeltas(order(), new Map([["gone", 4]]));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no longer exists/);
});

test("lines the claim does not mention are left exactly as they were", () => {
  const o = order({ items: [line({ _id: "a" }), line({ _id: "b", invoicedQty: 2 })] });
  const { items } = applyDeltas(o, new Map([["a", 3]]));
  assert.equal(items[0].invoicedQty, 3);
  assert.equal(items[1].invoicedQty, 2);
});

test("the order passed in is never mutated", () => {
  const o = order();
  applyDeltas(o, new Map([["l1", 10]]));
  assert.equal(o.items[0].invoicedQty, 0, "applyDeltas must return a new array");
});

test("a plain object works in place of a Map", () => {
  const { items, problems } = applyDeltas(order(), { l1: 4 });
  assert.deepEqual(problems, []);
  assert.equal(items[0].invoicedQty, 4);
});

console.log("\n--- what an edit changes ---");

test("an unchanged invoice produces no work", () => {
  const items = [billed({ quantity: 4 })];
  assert.deepEqual(netClaims(items, items), []);
});

test("raising a billed quantity claims only the difference", () => {
  const net = netClaims([billed({ quantity: 4 })], [billed({ quantity: 6 })]);
  assert.equal(net.length, 1);
  assert.equal(net[0].byLine.get("l1"), 2);
});

test("lowering a billed quantity releases the difference", () => {
  const net = netClaims([billed({ quantity: 6 })], [billed({ quantity: 4 })]);
  assert.equal(net[0].byLine.get("l1"), -2);
});

test("removing the line from the invoice releases all of it", () => {
  const net = netClaims([billed({ quantity: 4 })], []);
  assert.equal(net[0].byLine.get("l1"), -4);
});

test("adding a reference to a previously plain line claims it", () => {
  const net = netClaims([{ name: "M8 Bolt", quantity: 4 }], [billed({ quantity: 4 })]);
  assert.equal(net[0].byLine.get("l1"), 4);
});

test("moving an invoice from one order to another releases and claims", () => {
  const net = netClaims(
    [billed({ orderNo: 7, quantity: 4 })],
    [billed({ orderNo: 8, orderLineId: "l9", quantity: 4 })]
  );
  assert.equal(net.length, 2);
  const seven = net.find((n) => n.orderNo === 7);
  const eight = net.find((n) => n.orderNo === 8);
  assert.equal(seven.byLine.get("l1"), -4);
  assert.equal(eight.byLine.get("l9"), 4);
});

test("an order whose net change is zero is dropped entirely", () => {
  // Line A up by 2 and line B down by 2 is still work. The same LINE netting
  // to zero is not, and must not produce a pointless write.
  const net = netClaims(
    [billed({ orderLineId: "l1", quantity: 4 }), billed({ orderLineId: "l2", quantity: 3 })],
    [billed({ orderLineId: "l1", quantity: 4 }), billed({ orderLineId: "l2", quantity: 5 })]
  );
  assert.equal(net.length, 1);
  assert.equal(net[0].byLine.size, 1, "only the line that moved");
  assert.equal(net[0].byLine.get("l2"), 2);
});

test("float dust in a net change does not produce a write", () => {
  const net = netClaims([billed({ quantity: 0.3 })], [billed({ quantity: 0.1 + 0.2 })]);
  assert.deepEqual(net, []);
});

console.log("\n--- editing the order itself ---");

test("an unbilled order is freely editable", () => {
  const before = [line({ _id: "a" })];
  const after = [line({ _id: "a", quantity: 2 })];
  assert.equal(editBlockedReason(before, after), null);
});

test("an order may be raised above what is billed", () => {
  const before = [line({ _id: "a", invoicedQty: 4 })];
  assert.equal(editBlockedReason(before, [line({ _id: "a", quantity: 20 })]), null);
});

test("an order may NOT be cut below what is billed", () => {
  const before = [line({ _id: "a", invoicedQty: 4 })];
  const reason = editBlockedReason(before, [line({ _id: "a", quantity: 3 })]);
  // The SPECIFIC message, not just "4 is already billed" -- both branches of
  // editBlockedReason open with that phrase, so the looser match passed while
  // the quantity check itself was disabled. Mutation testing caught it.
  assert.match(reason, /the order cannot drop to 3/);
});

test("cutting the quantity is caught even with nothing cancelled", () => {
  // Isolates the first branch: ordered 10 -> 8 with 9 billed and nothing
  // cancelled. The cancellation branch cannot fire here, so only the
  // quantity check stands between this and a bill with no commitment.
  const before = [line({ _id: "a", quantity: 10, invoicedQty: 9 })];
  const reason = editBlockedReason(before, [line({ _id: "a", quantity: 8 })]);
  assert.match(reason, /the order cannot drop to 8/);
});

test("a billed line may not be cancelled out from under the invoice", () => {
  const before = [line({ _id: "a", invoicedQty: 4 })];
  const reason = editBlockedReason(before, [line({ _id: "a", quantity: 10, cancelledQty: 8 })]);
  assert.match(reason, /only 6 may be cancelled/);
});

test("cancelling only the unbilled part is allowed", () => {
  const before = [line({ _id: "a", invoicedQty: 4 })];
  assert.equal(
    editBlockedReason(before, [line({ _id: "a", quantity: 10, cancelledQty: 6 })]),
    null
  );
});

test("a billed line may not be deleted", () => {
  const before = [line({ _id: "a", invoicedQty: 4 }), line({ _id: "b" })];
  const reason = editBlockedReason(before, [line({ _id: "b" })]);
  assert.match(reason, /cannot be removed/);
});

test("an unbilled line may be deleted", () => {
  const before = [line({ _id: "a" }), line({ _id: "b", invoicedQty: 1 })];
  assert.equal(editBlockedReason(before, [line({ _id: "b", invoicedQty: 1 })]), null);
});

test("adding a new line is never blocked", () => {
  const before = [line({ _id: "a", invoicedQty: 10 })];
  const after = [line({ _id: "a", invoicedQty: 10 }), line({ _id: "new" })];
  assert.equal(editBlockedReason(before, after), null);
});

console.log("\n--- deleting an order ---");

test("an unbilled order may be deleted", () => {
  assert.equal(deleteBlockedReason(order()), null);
  assert.equal(deleteBlockedReason(order({ items: [line({ cancelledQty: 10 })] })), null);
});

test("a billed order may not be deleted", () => {
  const reason = deleteBlockedReason(order({ items: [line({ invoicedQty: 1 })] }));
  assert.match(reason, /already been billed/);
});

test("a missing order blocks nothing, so the route can 404 instead", () => {
  assert.equal(deleteBlockedReason(null), null);
  assert.equal(deleteBlockedReason(undefined), null);
});

console.log("\n--- carrying an order into a bill ---");

test("only the pending lines are offered", () => {
  const o = order({
    items: [
      line({ _id: "a", quantity: 10, invoicedQty: 10 }),
      line({ _id: "b", quantity: 5, invoicedQty: 2 }),
    ],
  });
  const lines = toInvoiceLines(o);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].orderLineId, "b");
});

test("the quantity offered is what is pending, not what was ordered", () => {
  const o = order({ items: [line({ quantity: 10, invoicedQty: 4 })] });
  assert.equal(toInvoiceLines(o)[0].quantity, 6);
});

test("the rate and discount come across so the bill matches the order", () => {
  const o = order({ items: [line({ cost: 47.5, discount: 5 })] });
  const [l] = toInvoiceLines(o);
  assert.equal(l.cost, 47.5);
  assert.equal(l.discount, 5);
  assert.equal(l.hsn, "7318");
});

test("every offered line carries the reference back to its order line", () => {
  const [l] = toInvoiceLines(order());
  assert.equal(l.orderNo, 7);
  assert.equal(l.orderType, "Sale");
  assert.equal(l.orderLineId, "l1");
  assert.deepEqual(lineRef(l), { orderNo: 7, orderType: "Sale", lineId: "l1" });
});

test("no tax fields are carried onto the bill", () => {
  // The GST is the item master's on the day of billing, so the form must look
  // it up rather than inherit a figure frozen at order time.
  const [l] = toInvoiceLines(order({ items: [line({ gstRate: 12 })] }));
  assert.equal(l.gstRate, undefined);
  assert.equal(l.taxableAmount, undefined);
});

test("a closed order offers nothing", () => {
  assert.deepEqual(toInvoiceLines(order({ items: [line({ invoicedQty: 10 })] })), []);
});

console.log("\n--- carrying an order onto the billing form ---");

/** Stands in for the billing pages' own recalcItem. */
const recalc = (l) => {
  const base = Number(l.quantity) * Number(l.cost);
  const taxable = base - (base * Number(l.discount || 0)) / 100;
  const gstAmount = (taxable * Number(l.gstRate || 0)) / 100;
  return { ...l, taxableAmount: taxable, gstAmount, total: taxable + gstAmount };
};

const masters = [
  { name: "M8 Bolt", hsn: "7318", gst: 18, salePrice: 60, uqc: "NOS", isService: false },
];

test("the pending quantity is billed, not the ordered one", () => {
  const o = order({ items: [line({ quantity: 10, invoicedQty: 4 })] });
  const { lines } = prefillFromOrder({ order: o, items: masters, recalc });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].quantity, 6);
});

test("the AGREED rate comes from the order, not the master", () => {
  // The master says 60. The order says 50, because that is what was quoted.
  // Re-pricing from the master would invoice a figure the customer never saw.
  const o = order({ items: [line({ cost: 50, discount: 5 })] });
  const { lines } = prefillFromOrder({ order: o, items: masters, recalc });
  assert.equal(lines[0].cost, 50);
  assert.equal(lines[0].discount, 5);
});

test("the GST rate comes from the master TODAY, not from the order", () => {
  // An order placed in March and billed in October is billed at October's
  // rate. This is also why no rate is stored on an order at all.
  const o = order({ items: [line({ gstRate: 5 })] });
  const { lines } = prefillFromOrder({ order: o, items: masters, recalc });
  assert.equal(lines[0].gstRate, 18);
});

test("the recalc the page passes is what computes the money", () => {
  const o = order({ items: [line({ quantity: 10, cost: 50, discount: 10 })] });
  const { lines } = prefillFromOrder({ order: o, items: masters, recalc });
  assert.equal(lines[0].taxableAmount, 450);
  assert.equal(lines[0].gstAmount, 81);
  assert.equal(lines[0].total, 531);
});

test("every billed line carries the reference back to the order line", () => {
  const { lines } = prefillFromOrder({ order: order(), items: masters, recalc });
  assert.deepEqual(lineRef(lines[0]), { orderNo: 7, orderType: "Sale", lineId: "l1" });
});

test("an item no longer in the master is still billed, and reported", () => {
  // Dropping it would under-bill the order and leave it part-pending for
  // good, which is worse than billing it with a tax rate to check by hand.
  const o = order({ items: [line({ name: "Discontinued washer" })] });
  const { lines, skipped } = prefillFromOrder({ order: o, items: masters, recalc });
  assert.equal(lines.length, 1);
  assert.deepEqual(skipped, ["Discontinued washer"]);
  assert.equal(lines[0].gstRate, 0);
});

test("a closed order prefills nothing", () => {
  const o = order({ items: [line({ invoicedQty: 10 })] });
  assert.deepEqual(prefillFromOrder({ order: o, items: masters, recalc }).lines, []);
});

test("the party comes across so the bill cannot be raised on the wrong one", () => {
  const o = order({ customer: { name: "Acme Traders" } });
  assert.equal(prefillFromOrder({ order: o, items: masters, recalc }).customerName, "Acme Traders");
});

test("THE BILL CARRIES THE ORDER NUMBER ON ITS HEADER", () => {
  // components/InvoiceDocument.jsx already prints "Order No" and "Order
  // Date". They were never filled when a bill came from an order, so the
  // printed invoice referenced the order nowhere -- which is most of what
  // "the order module is not linked to invoices" means on paper.
  const o = order({ orderNo: 7, date: new Date("2026-10-01"), reference: "PO/88" });
  const { header } = prefillFromOrder({ order: o, items: masters, recalc });
  assert.equal(header.orderNo, 7);
  assert.equal(header.orderDate, "2026-10-01");
  assert.equal(header.reference, "PO/88", "the buyer's own paperwork number, kept apart");
});

test("the header survives an order with nothing to fill it", () => {
  const { header } = prefillFromOrder({ order: order({ orderNo: 0, date: null }), items: masters, recalc });
  assert.equal(header.orderNo, "");
  assert.equal(header.orderDate, "");
  assert.equal(header.reference, "");
});

test("both billing pages set the header, not just the lines", () => {
  // Patched by script across two near-identical pages; one of them being
  // missed is exactly how the last round of manual edits went wrong.
  for (const page of ["saleadd", "purchaseadd"]) {
    const src = read(`../app/${page}/page.js`);
    assert.match(src, /skipped, header \} = prefillFromOrder/, `${page} must read header`);
    assert.match(src, /setOrderNo\(header\.orderNo\)/, `${page} must set the order number`);
    assert.match(src, /setOrderDate\(header\.orderDate\)/, `${page} must set the order date`);
  }
});

test("a missing order or recalc does not throw", () => {
  assert.deepEqual(prefillFromOrder({ order: null, items: masters, recalc }).lines, []);
  const plain = prefillFromOrder({ order: order(), items: masters });
  assert.equal(plain.lines[0].quantity, 10, "no recalc still returns the merged line");
});

console.log("\n--- billing chosen lines, in chosen quantities ---");

/**
 * Why this exists at all, from MCSFAST's live order book (9,260 invoice
 * lines referencing an order line):
 *
 *   29.8% of order lines are billed across MORE THAN ONE invoice -- one of
 *   them across 93. 64.6% of bills took only SOME of their order's lines.
 *   Invoices spanning two orders: 0.1%.
 *
 * So: part of a line, some of the lines, one order at a time.
 */
const partBilled = () =>
  order({ items: [line({ _id: "l1", quantity: 100, invoicedQty: 40, cost: 50 })] });

test("a pickable row shows what is left, not just what was ordered", () => {
  const [row] = pickableLines(partBilled());
  assert.equal(row.ordered, 100);
  assert.equal(row.billed, 40);
  assert.equal(row.pending, 60);
  assert.equal(row.billNow, 60, "offered in full, for the user to reduce");
  assert.equal(row.orderLineId, "l1");
  assert.equal(row.orderNo, 7);
  assert.equal(row.orderType, "Sale");
});

test("settled and cancelled lines are not pickable", () => {
  const o = order({
    items: [
      line({ _id: "a", invoicedQty: 10 }),
      line({ _id: "b", cancelledQty: 10 }),
      line({ _id: "c" }),
    ],
  });
  assert.deepEqual(pickableLines(o).map((r) => r.orderLineId), ["c"]);
});

test("PART OF A LINE CAN BE BILLED", () => {
  // The headline case: 29.8% of their order lines are drawn down over
  // several invoices, so all-or-nothing is wrong for nearly a third of them.
  const { lines, problems } = pickFromOrder({
    order: partBilled(),
    items: masters,
    recalc,
    picks: [{ orderLineId: "l1", quantity: 25 }],
  });
  assert.deepEqual(problems, []);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].quantity, 25);
});

test("BILLING MORE THAN IS PENDING IS REFUSED, NOT CLAMPED", () => {
  // Clamping would bill 60 while the clerk believes they billed 61, and
  // nothing on screen would say otherwise.
  const { lines, problems } = pickFromOrder({
    order: partBilled(),
    items: masters,
    recalc,
    picks: [{ orderLineId: "l1", quantity: 61 }],
  });
  assert.deepEqual(lines, []);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /only 60 is pending, so 61 cannot be billed/);
});

test("billing exactly what is pending is allowed", () => {
  const { lines, problems } = pickFromOrder({
    order: partBilled(),
    items: masters,
    recalc,
    picks: [{ orderLineId: "l1", quantity: 60 }],
  });
  assert.deepEqual(problems, []);
  assert.equal(lines[0].quantity, 60);
});

test("a zero pick is how a row is deselected", () => {
  const { lines, problems } = pickFromOrder({
    order: partBilled(),
    items: masters,
    recalc,
    picks: [{ orderLineId: "l1", quantity: 0 }],
  });
  assert.deepEqual(lines, []);
  assert.deepEqual(problems, [], "not an error -- just nothing chosen");
});

test("SOME of an order's lines can be billed", () => {
  const o = order({
    items: [
      line({ _id: "a", name: "M8 Bolt", quantity: 10 }),
      line({ _id: "b", name: "M6 Nut", quantity: 20 }),
      line({ _id: "c", name: "Washer", quantity: 30 }),
    ],
  });
  const { lines } = pickFromOrder({
    order: o,
    items: masters,
    recalc,
    picks: [{ orderLineId: "a", quantity: 4 }, { orderLineId: "c", quantity: 5 }],
  });
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => l.orderLineId), ["a", "c"]);
});

test("a pick against a line that is no longer pending is refused", () => {
  const { problems } = pickFromOrder({
    order: order({ items: [line({ _id: "l1", invoicedQty: 10 })] }),
    items: masters,
    recalc,
    picks: [{ orderLineId: "l1", quantity: 1 }],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no longer pending/);
});

test("the AGREED rate is billed, with TODAY'S gst rate", () => {
  // Same split as the whole-order prefill: the rate was agreed with the
  // customer, the tax is the law on the day of billing.
  const o = order({ items: [line({ _id: "l1", cost: 47.5, discount: 5, gstRate: 5 })] });
  const { lines } = pickFromOrder({
    order: o,
    items: masters,
    recalc,
    picks: [{ orderLineId: "l1", quantity: 2 }],
  });
  assert.equal(lines[0].cost, 47.5);
  assert.equal(lines[0].discount, 5);
  assert.equal(lines[0].gstRate, 18, "the master's, not the order's");
});

test("every picked line carries the reference back to its order line", () => {
  const { lines } = pickFromOrder({
    order: partBilled(),
    items: masters,
    recalc,
    picks: [{ orderLineId: "l1", quantity: 5 }],
  });
  assert.deepEqual(lineRef(lines[0]), { orderNo: 7, orderType: "Sale", lineId: "l1" });
});

test("an item no longer in the master is still billed, and reported", () => {
  const o = order({ items: [line({ _id: "l1", name: "Discontinued washer" })] });
  const { lines, skipped } = pickFromOrder({
    order: o,
    items: masters,
    recalc,
    picks: [{ orderLineId: "l1", quantity: 1 }],
  });
  assert.equal(lines.length, 1);
  assert.deepEqual(skipped, ["Discontinued washer"]);
});

test("junk picks are ignored rather than throwing", () => {
  const o = partBilled();
  assert.deepEqual(pickFromOrder({ order: o, items: masters, recalc, picks: null }).lines, []);
  assert.deepEqual(pickFromOrder({ order: o, items: masters, recalc, picks: [{}] }).lines, []);
  assert.deepEqual(
    pickFromOrder({ order: o, items: masters, recalc, picks: [{ orderLineId: "l1", quantity: "abc" }] }).lines,
    []
  );
  assert.deepEqual(pickableLines(null), []);
});

test("both billing pages offer the picker and neither does the arithmetic", () => {
  for (const page of ["saleadd", "purchaseadd"]) {
    const src = read(`../app/${page}/page.js`);
    assert.match(src, /pickFromOrder/, `${page} must use the rule`);
    assert.match(src, /order-pending/, `${page} must fetch the pending lines`);
    assert.ok(
      !/r\.ordered\s*-\s*r\.billed/.test(src),
      `${page} must not re-derive a pending quantity`
    );
  }
});

test("the pending endpoint serves the picker's rows", () => {
  const src = read("../app/api/order-pending/route.js");
  assert.match(src, /pickableLines\(/);
  assert.match(src, /pickable:/);
});


console.log("\n--- what a row says ---");

test("quantities print without trailing zeros", () => {
  assert.equal(trim(5), "5");
  assert.equal(trim(5.0), "5");
  assert.equal(trim(0.125), "0.125");
  assert.equal(trim(0.1 + 0.2), "0.3");
});

test("a summary names every quantity that is not zero", () => {
  assert.equal(lineSummary(line()), "10 ordered, 10 pending");
  assert.equal(lineSummary(line({ invoicedQty: 4 })), "10 ordered, 4 billed, 6 pending");
  assert.equal(
    lineSummary(line({ invoicedQty: 4, cancelledQty: 2 })),
    "10 ordered, 4 billed, 2 cancelled, 4 pending"
  );
  assert.equal(lineSummary(line({ invoicedQty: 10 })), "10 ordered, 10 billed, nothing pending");
});

console.log("\n--- cancelling ---");

test("a fresh line can be cancelled in full", () => {
  assert.equal(cancellableQty(line()), 10);
});

test("ONLY THE UNBILLED BALANCE CAN BE CANCELLED", () => {
  // The quantity on an invoice is accounted for; calling it off would leave a
  // bill against a commitment that no longer covers it.
  assert.equal(cancellableQty(line({ invoicedQty: 4 })), 6);
  assert.equal(cancellableQty(line({ invoicedQty: 10 })), 0);
});

test("an already-cancelled quantity is not cancellable twice", () => {
  assert.equal(cancellableQty(line({ cancelledQty: 4 })), 6);
  assert.equal(cancellableQty(line({ invoicedQty: 3, cancelledQty: 3 })), 4);
});

test("cancelling the whole order calls off every line", () => {
  const o = order({ items: [line({ _id: "a" }), line({ _id: "b", quantity: 5 })] });
  const { items, cancelled, problems } = applyCancel(o);
  assert.deepEqual(problems, []);
  assert.equal(cancelled.length, 2);
  assert.equal(items[0].cancelledQty, 10);
  assert.equal(items[1].cancelledQty, 5);
  assert.equal(orderStatus({ items }), "cancelled");
});

test("CANCELLING A PART-BILLED ORDER SHORT-CLOSES IT", () => {
  // Goods went out, so the honest status is closed, not cancelled.
  const o = order({ items: [line({ quantity: 10, invoicedQty: 4 })] });
  const { items, cancelled } = applyCancel(o);
  assert.equal(cancelled[0].quantity, 6);
  assert.equal(items[0].invoicedQty, 4, "the billed part is untouched");
  assert.equal(items[0].cancelledQty, 6);
  assert.equal(pendingQty(items[0]), 0);
  assert.equal(orderStatus({ items }), "closed");
});

test("CANCELLING TOPS UP AN ALREADY PART-CANCELLED LINE", () => {
  // Every other test here starts from nothing cancelled, where adding to the
  // existing figure and replacing it give the same answer -- so a cancel that
  // OVERWROTE the earlier cancellation passed them all. Mutation testing
  // caught it. Ordered 10, two billed, four already called off: cancelling
  // the rest must reach 8, not 4.
  const o = order({ items: [line({ quantity: 10, invoicedQty: 2, cancelledQty: 4 })] });
  assert.equal(cancellableQty(o.items[0]), 4);

  const { items, cancelled } = applyCancel(o);
  assert.equal(cancelled[0].quantity, 4, "only what was still pending");
  assert.equal(items[0].cancelledQty, 8, "4 already off plus the 4 just called off");
  assert.equal(items[0].invoicedQty, 2);
  assert.equal(pendingQty(items[0]), 0);
  assert.equal(orderStatus({ items }), "closed");
});

test("cancelling twice in a row reaches the same place as cancelling once", () => {
  const whole = applyCancel(order({ items: [line({ quantity: 10 })] }));
  const half = applyCancel(order({ items: [line({ quantity: 10, cancelledQty: 6 })] }));
  assert.equal(whole.items[0].cancelledQty, 10);
  assert.equal(half.items[0].cancelledQty, 10);
});

test("cancelling named lines leaves the others alone", () => {
  const o = order({ items: [line({ _id: "a" }), line({ _id: "b" })] });
  const { items, cancelled } = applyCancel(o, ["a"]);
  assert.equal(cancelled.length, 1);
  assert.equal(items[0].cancelledQty, 10);
  assert.equal(items[1].cancelledQty, 0);
  assert.equal(orderStatus({ items }), "partial");
});

test("a fully billed line is skipped SILENTLY, not refused", () => {
  // On a forty-line order with three billed out, refusing the whole action
  // because three lines had nothing to give would be useless.
  const o = order({
    items: [line({ _id: "a", invoicedQty: 10 }), line({ _id: "b" })],
  });
  const { items, cancelled, problems } = applyCancel(o);
  assert.deepEqual(problems, []);
  assert.equal(cancelled.length, 1, "only the line that had something left");
  assert.equal(items[0].cancelledQty, 0);
  assert.equal(items[1].cancelledQty, 10);
});

test("naming a line that is not on the order is refused", () => {
  const { problems } = applyCancel(order(), ["gone"]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /not on this order/);
});

test("the order passed in is never mutated", () => {
  const o = order();
  applyCancel(o);
  assert.equal(o.items[0].cancelledQty, 0, "applyCancel must return a new array");
});

test("nothing left to cancel is reported, with the right sentence", () => {
  assert.equal(cancelBlockedReason(order()), null);
  assert.match(
    cancelBlockedReason(order({ items: [line({ invoicedQty: 10 })] })),
    /every line is either billed or already cancelled/
  );
  assert.match(
    cancelBlockedReason(order({ items: [line({ cancelledQty: 10 })] })),
    /already cancelled/
  );
  assert.match(cancelBlockedReason(order({ items: [] })), /no items to cancel/);
  assert.equal(cancelBlockedReason(null), null, "so the route can 404 instead");
});

test("a part-billed order can still be cancelled", () => {
  assert.equal(cancelBlockedReason(order({ items: [line({ invoicedQty: 4 })] })), null);
});

test("nothingToCancel reads the whole order, not one line", () => {
  assert.equal(nothingToCancel(order({ items: [line({ invoicedQty: 10 }), line()] })), false);
  assert.equal(
    nothingToCancel(order({ items: [line({ invoicedQty: 10 }), line({ cancelledQty: 10 })] })),
    true
  );
});

console.log("\n--- restoring ---");

test("restoring puts the cancelled quantity back", () => {
  const o = order({ items: [line({ cancelledQty: 6, invoicedQty: 4 })] });
  const { items, restored } = applyRestore(o);
  assert.equal(restored[0].quantity, 6);
  assert.equal(items[0].cancelledQty, 0);
  assert.equal(items[0].invoicedQty, 4, "the billed part is untouched");
  assert.equal(pendingQty(items[0]), 6);
  assert.equal(orderStatus({ items }), "partial");
});

test("RESTORING CANNOT EXCEED WHAT WAS ORDERED", () => {
  // The guard that matters: a part-billed, part-cancelled line must come back
  // to "part billed, rest pending" -- never to more than was ordered.
  const o = order({ items: [line({ quantity: 10, invoicedQty: 7, cancelledQty: 3 })] });
  const { items } = applyRestore(o);
  assert.equal(pendingQty(items[0]), 3);
  assert.equal(orderedQty(items[0]), 10);
  assert.ok(invoicedQty(items[0]) + pendingQty(items[0]) <= orderedQty(items[0]));
});

test("restoring named lines leaves the others cancelled", () => {
  const o = order({
    items: [line({ _id: "a", cancelledQty: 10 }), line({ _id: "b", cancelledQty: 10 })],
  });
  const { items, restored } = applyRestore(o, ["a"]);
  assert.equal(restored.length, 1);
  assert.equal(items[0].cancelledQty, 0);
  assert.equal(items[1].cancelledQty, 10);
});

test("restoring an order with nothing cancelled moves nothing", () => {
  const { restored } = applyRestore(order());
  assert.deepEqual(restored, []);
  assert.match(restoreBlockedReason(order()), /Nothing on this order is cancelled/);
  assert.equal(restoreBlockedReason(order({ items: [line({ cancelledQty: 1 })] })), null);
  assert.equal(restoreBlockedReason(null), null);
});

test("cancel then restore returns the line exactly as it was", () => {
  const before = line({ quantity: 10, invoicedQty: 4 });
  const once = applyCancel({ items: [before] });
  const back = applyRestore({ items: once.items });
  assert.equal(back.items[0].cancelledQty, 0);
  assert.equal(back.items[0].invoicedQty, 4);
  assert.equal(pendingQty(back.items[0]), pendingQty(before));
});

console.log("\n--- the cancellation log ---");

test("an entry records what, why, who and when", () => {
  const at = new Date("2026-10-11T10:00:00Z");
  const e = cancellationEntry({
    lines: [{ name: "M8 Bolt", quantity: 6 }],
    reason: "Customer deferred",
    by: "Prashant",
    at,
  });
  assert.equal(e.action, "cancel");
  assert.equal(e.quantity, 6);
  assert.equal(e.reason, "Customer deferred");
  assert.equal(e.by, "Prashant");
  assert.equal(e.at.getTime(), at.getTime());
  assert.deepEqual(e.lines, [{ name: "M8 Bolt", quantity: 6 }]);
});

test("a restore is logged as a restore, not as another cancellation", () => {
  const e = cancellationEntry({ lines: [{ name: "x", quantity: 2 }], restore: true });
  assert.equal(e.action, "restore");
});

test("the entry totals every line it covers", () => {
  const e = cancellationEntry({
    lines: [{ name: "a", quantity: 6 }, { name: "b", quantity: 4 }],
    reason: "r",
  });
  assert.equal(e.quantity, 10);
  assert.equal(e.lines.length, 2);
});

test("a string date is accepted, so a stored entry round-trips", () => {
  const e = cancellationEntry({ lines: [], at: "2026-10-11T00:00:00Z" });
  assert.ok(e.at instanceof Date);
});

test("THE LOG IS A LIST, SO A SECOND CANCELLATION DOES NOT ERASE THE FIRST", () => {
  // Two of the three ways to cancel are partial. A single reason field would
  // be overwritten, losing the one thing it exists to answer.
  const log = [
    cancellationEntry({ lines: [{ name: "a", quantity: 4 }], reason: "first" }),
    cancellationEntry({ lines: [{ name: "b", quantity: 2 }], reason: "second" }),
  ];
  assert.equal(log.length, 2);
  assert.equal(log[0].reason, "first");
  assert.match(cancellationSummary({ cancellations: log }), /2 cancelled -- second/);
});

test("the summary says RESTORED when that was the last action", () => {
  // Nothing summarised a log ending in a restore, so a summary hard-coded to
  // "cancelled" passed. It would have told the user an order was called off
  // moments after they put it back.
  const log = [
    cancellationEntry({ lines: [{ name: "a", quantity: 6 }], reason: "deferred" }),
    cancellationEntry({ lines: [{ name: "a", quantity: 6 }], reason: "back on", restore: true }),
  ];
  assert.match(cancellationSummary({ cancellations: log }), /6 restored -- back on/);
});

test("the summary is empty when nothing was ever cancelled", () => {
  assert.equal(cancellationSummary(order()), "");
  assert.equal(cancellationSummary({ cancellations: [] }), "");
  assert.equal(cancellationSummary(null), "");
});

test("a cancellation with no reason still summarises", () => {
  const log = [cancellationEntry({ lines: [{ name: "a", quantity: 5 }] })];
  assert.equal(cancellationSummary({ cancellations: log }), "5 cancelled");
});

console.log("\n--- the cancel wiring ---");

test("the cancel route is a permission-checked write", () => {
  const roles = read("../lib/roles.mjs");
  assert.ok(roles.includes('"/api/order-cancel"'));
  assert.match(roles, /\["\/api\/order-cancel",\s*"invoice:write"\]/);
});

test("the cancel route is transactional and derives the status", () => {
  const src = read("../app/api/order-cancel/route.js");
  assert.match(src, /withTransaction/);
  assert.match(src, /orderStatus\(/);
  assert.match(src, /applyCancel|applyRestore/);
  assert.ok(
    !/cancelledQty\s*[:=]/.test(src),
    "the route must not move cancelledQty itself -- use lib/orderStatus.mjs"
  );
});

test("a cancellation demands a reason; a restore does not", () => {
  const src = read("../app/api/order-cancel/route.js");
  assert.match(src, /!restore && !reason/);
});

test("the log is declared on the model", () => {
  // Mongoose strict mode drops what is not declared, and a dropped log is a
  // cancellation nobody can explain afterwards.
  const model = read("../models/orderModel.js");
  assert.match(model, /cancellations:\s*\[/);
  for (const field of ["reason", "action", "by", "at"]) {
    assert.ok(new RegExp(`${field}:\\s*\\{`).test(model), `the log must declare ${field}`);
  }
});

test("both screens offer the action, and neither does the arithmetic", () => {
  const register = read("../app/order/page.js");
  assert.match(register, /order-cancel/);
  assert.match(register, /cancelBlockedReason/);
  assert.match(register, /restoreBlockedReason/);

  const form = read("../app/orderadd/page.js");
  assert.match(form, /cancellableQty/);
  assert.ok(
    !/quantity\s*-\s*invoicedQty/.test(form),
    "the form must not re-derive the cancellable quantity"
  );
});


console.log("\n--- the wiring ---");


test("the model declares all three quantities and the reference", () => {
  // Mongoose strict mode drops what a schema does not declare, which has
  // already cost this project five afternoons. A dropped invoicedQty would
  // leave every order permanently open.
  const model = read("../models/orderModel.js");
  for (const field of ["quantity", "cancelledQty", "invoicedQty"]) {
    assert.ok(new RegExp(`${field}\\s*:`).test(model), `orderModel must declare ${field}`);
  }
  const invoice = read("../models/invoiceModel.js");
  for (const field of ["orderNo", "orderType", "orderLineId"]) {
    assert.ok(
      new RegExp(`${field}\\s*:`).test(invoice),
      `the invoice item schema must declare ${field}`
    );
  }
});

test("the order collection is cleared with the other transactions", () => {
  // Orders are books, not masters: a transaction clear must take them, or a
  // trial run's orders survive into the live book.
  const clear = read("../lib/clearData.mjs");
  assert.match(clear, /TRANSACTION_COLLECTIONS\s*=\s*\[[^\]]*"orders"/s);
});

test("the index migration knows about the order model", () => {
  // A collection the migration cannot see is a collection whose obsolete
  // global unique index never gets dropped.
  assert.match(read("./sync-indexes.mjs"), /\["orders",\s*"orderModel"\]/);
});

test("the order number is unique per firm, not globally", () => {
  // The bug that took a day: a global unique index means the second firm to
  // open cannot write order 1.
  const model = read("../models/orderModel.js");
  assert.match(model, /companyId:\s*1[^}]*type:\s*1[^}]*orderNo:\s*1/s);
  assert.match(model, /unique:\s*true/);
  assert.match(model, /tenantPlugin/);
});

test("every order route is permission-checked", () => {
  const roles = read("../lib/roles.mjs");
  for (const path of [
    "/api/order",
    "/api/get-order",
    "/api/order-add",
    "/api/order-alter",
    "/api/delete-order",
    "/api/next-order-no",
    "/api/order-pending",
    "/orderadd",
    "/order",
  ]) {
    assert.ok(roles.includes(`"${path}"`), `roles.mjs has no rule for ${path}`);
  }
  // Reading is every role's; writing is not the biller's business to invent.
  assert.match(roles, /\["\/api\/order-add",\s*"invoice:write"\]/);
  assert.match(roles, /\["\/api\/order",\s*"invoice:read"\]/);
});

test("the claim helper is the only thing that touches invoicedQty", () => {
  // Three routes consume order quantities. If any of them does the
  // subtraction itself, the guards above stop protecting it.
  for (const route of ["save-invoice", "sale-alter", "delete-invoice"]) {
    const src = read(`../app/api/${route}/route.js`);
    assert.match(src, /orderClaims\.mjs/, `${route} must go through lib/orderClaims.mjs`);
    assert.ok(
      !/invoicedQty/.test(src),
      `${route} must not compute invoicedQty itself -- use lib/orderClaims.mjs`
    );
  }
});

test("the order writes are transactional", () => {
  for (const route of ["order-add", "order-alter", "delete-order"]) {
    assert.match(
      read(`../app/api/${route}/route.js`),
      /withTransaction/,
      `${route} must commit atomically`
    );
  }
});

test("the stored status is always recomputed, never taken from the client", () => {
  for (const route of ["order-add", "order-alter"]) {
    const src = read(`../app/api/${route}/route.js`);
    assert.match(src, /orderStatus\(/, `${route} must derive the status`);
  }
});

console.log("\n--- every import resolves ---");

/**
 * Resolve every relative and aliased import in the app's own source, against
 * the filesystem.
 *
 * THE BUG THIS EXISTS FOR
 * -----------------------
 * order-add and order-alter shipped with `../../../../models/custModel` --
 * four levels up from app/api/<route>/, where the repo root is three. Six
 * "Module not found" errors on the Vercel build, and NOTHING in this project
 * caught it first: `node --check` parses a file without resolving what it
 * imports, and the route assertions below only grep for text. A test suite
 * that reads a route's source and never resolves its imports will miss an
 * off-by-one path every time.
 *
 * NOTE: this sweeps the files that are actually on disk. Run against a
 * partial copy of the repo it will report misses that are really just files
 * nobody checked out -- the same caveat tenant-scope.test.mjs carries.
 */
const ROOT = new URL("../", import.meta.url);
const exists = (rel) => {
  try {
    return fs.statSync(new URL(rel, ROOT)).isFile();
  } catch {
    return false;
  }
};
const isDir = (rel) => {
  try {
    return fs.statSync(new URL(rel, ROOT)).isDirectory();
  } catch {
    return false;
  }
};

/** Every source file under these, as repo-relative posix paths. */
const sourceFiles = () => {
  const out = [];
  const walk = (dir) => {
    if (!isDir(dir)) return;
    for (const entry of fs.readdirSync(new URL(dir, ROOT), { withFileTypes: true })) {
      const rel = `${dir}${entry.name}`;
      if (entry.isDirectory()) walk(`${rel}/`);
      else if (/\.(js|mjs|jsx)$/.test(entry.name)) out.push(rel);
    }
  };
  for (const dir of ["app/", "lib/", "models/", "components/", "context/"]) walk(dir);
  return out;
};

/** The extensions Next resolves, plus the directory-index forms. */
const CANDIDATES = ["", ".js", ".mjs", ".jsx", ".ts", ".tsx", "/index.js", "/index.mjs", "/index.jsx"];

const resolves = (target) => CANDIDATES.some((ext) => exists(target + ext));

const files = sourceFiles();

test("there are source files to sweep at all", () => {
  // Guards the guard: a walk that silently finds nothing would make every
  // check below pass without testing anything.
  assert.ok(files.length > 20, `only found ${files.length} source files`);
});

test("every relative import points at a file that exists", () => {
  const misses = [];
  for (const file of files) {
    const src = fs.readFileSync(new URL(file, ROOT), "utf8");
    const dir = file.replace(/[^/]+$/, "");
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)) {
      // Join and normalise .. segments by hand -- these are posix repo paths,
      // not host paths, so node:path would be wrong on Windows.
      const parts = (dir + m[1]).split("/");
      const stack = [];
      for (const part of parts) {
        if (part === "." || part === "") continue;
        if (part === "..") stack.pop();
        else stack.push(part);
      }
      const target = stack.join("/");
      if (!resolves(target)) misses.push(`${file} -> ${m[1]}`);
    }
  }
  assert.deepEqual(misses, [], `unresolved imports:\n  ${misses.join("\n  ")}`);
});

test("every @/ import points at a file that exists", () => {
  // `@/*` maps to the repo root (jsconfig.json). An alias cannot be off by a
  // level, which is why the order routes now use it for the models.
  const misses = [];
  for (const file of files) {
    const src = fs.readFileSync(new URL(file, ROOT), "utf8");
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["']@\/([^"']+)["']/g)) {
      if (!resolves(m[1])) misses.push(`${file} -> @/${m[1]}`);
    }
  }
  assert.deepEqual(misses, [], `unresolved aliased imports:\n  ${misses.join("\n  ")}`);
});

test("the alias really is the repo root", () => {
  // If jsconfig stops mapping @/* to ".", every aliased import above is
  // being resolved against the wrong base and these checks mean nothing.
  const cfg = JSON.parse(fs.readFileSync(new URL("jsconfig.json", ROOT), "utf8"));
  assert.deepEqual(cfg.compilerOptions?.paths?.["@/*"], ["./*"]);
});

test("no route reaches above the repo root", () => {
  // The specific shape of the shipped bug: from app/api/<name>/ the root is
  // three levels up, so a fourth leaves the project entirely.
  const offenders = files
    .filter((f) => /^app\/api\/[^/]+\/route\.js$/.test(f))
    .filter((f) => /["']\.\.\/\.\.\/\.\.\/\.\.\//.test(fs.readFileSync(new URL(f, ROOT), "utf8")));
  assert.deepEqual(offenders, []);
});

console.log(`\n${passed} checks passed.`);
