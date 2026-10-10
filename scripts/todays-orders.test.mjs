/**
 * Fixture tests for the "orders dated today" reminder.
 *
 *   node scripts/todays-orders.test.mjs
 *
 * Three things are worth guarding:
 *
 *   1. The day is the SHOPKEEPER'S day, in IST. At 2am on the 9th in Delhi it
 *      is still the 8th in UTC, and these dates are stored as UTC midnight of
 *      whatever a date picker produced -- so a naive comparison is off by a
 *      day for part of every night.
 *
 *   2. Returns stay out. A credit note's order date is the original order's,
 *      so including them surfaces the same order twice.
 *
 *   3. Dismissing lasts exactly one day, and a browser that refuses
 *      localStorage must not take the page down with it.
 *
 * NOTE: this file is deliberately identical in `vyapaar` and in
 * `vyapaar-einvoice`, like lib/todaysOrders.mjs itself.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  DISMISS_PREFIX,
  MAX_LISTED,
  ORDER_TYPES,
  dismissKey,
  headline,
  isOrderType,
  isTodaysOrder,
  orderLine,
  shouldShow,
  todaysOrders,
} from "../lib/todaysOrders.mjs";
import { istDayWindow } from "../lib/istDate.mjs";

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

/** Mid-morning in Delhi on 9 October 2026. */
const NOW = Date.parse("2026-10-09T10:00:00+05:30");
/** 2am in Delhi on the 9th -- which is still the 8th in UTC. */
const EARLY = Date.parse("2026-10-09T02:00:00+05:30");

const invoice = (over = {}) => ({
  invoiceNo: 42,
  type: "Sale",
  return: false,
  customer: { name: "Sharma Traders" },
  orderNo: "PO-7",
  orderDate: "2026-10-09",
  finalAmount: 7965,
  ...over,
});

console.log("\n--- the day is the shopkeeper's, not the server's ---");

test("an order dated today counts", () => {
  assert.equal(isTodaysOrder(invoice(), NOW), true);
});

test("yesterday and tomorrow do not", () => {
  assert.equal(isTodaysOrder(invoice({ orderDate: "2026-10-08" }), NOW), false);
  assert.equal(isTodaysOrder(invoice({ orderDate: "2026-10-10" }), NOW), false);
});

test("at 2am in Delhi, today is still the Indian day", () => {
  // The hard case: UTC says the 8th, the shopkeeper says the 9th, and the
  // order they typed today is stored as 2026-10-09T00:00:00Z.
  assert.equal(isTodaysOrder(invoice({ orderDate: "2026-10-09" }), EARLY), true);
  assert.equal(isTodaysOrder(invoice({ orderDate: "2026-10-08" }), EARLY), false);
});

test("a date stored with a real time still lands on its own day", () => {
  assert.equal(isTodaysOrder(invoice({ orderDate: "2026-10-09T14:00:00.000Z" }), NOW), true);
  assert.equal(isTodaysOrder(invoice({ orderDate: new Date("2026-10-09T00:00:00.000Z") }), NOW), true);
});

test("the query window contains what the rule accepts", () => {
  // The route narrows with a window and then filters with the rule. If the
  // two disagree, orders go missing with nothing in the log.
  const w = istDayWindow(NOW);
  for (const stored of ["2026-10-09", "2026-10-09T00:00:00.000Z", "2026-10-09T18:00:00.000Z"]) {
    const d = new Date(stored);
    const inWindow = d >= w.from && d < w.to;
    assert.equal(inWindow, isTodaysOrder(invoice({ orderDate: stored }), NOW), stored);
  }
  for (const stored of ["2026-10-08", "2026-10-10"]) {
    const d = new Date(stored);
    assert.equal(d >= w.from && d < w.to, false, stored);
  }
});

test("no order date at all is not today's order", () => {
  for (const orderDate of [null, undefined, "", "not a date"]) {
    assert.equal(isTodaysOrder(invoice({ orderDate }), NOW), false, JSON.stringify(orderDate));
  }
});

test("an unusable clock makes nothing today's order", () => {
  // Both sides can come back as "no day". Without a guard they would compare
  // equal to each other, and every invoice with no order date would be
  // announced as today's.
  for (const orderDate of [null, undefined, "", "not a date"]) {
    assert.equal(isTodaysOrder(invoice({ orderDate }), "rubbish"), false, JSON.stringify(orderDate));
  }
  assert.equal(isTodaysOrder(invoice({ orderDate: "2026-10-09" }), "rubbish"), false);
});

console.log("\n--- which documents count ---");

test("sales and purchases, and nothing else", () => {
  assert.deepEqual(ORDER_TYPES, ["Sale", "Purchase"]);
  assert.equal(isTodaysOrder(invoice({ type: "Sale" }), NOW), true);
  assert.equal(isTodaysOrder(invoice({ type: "Purchase" }), NOW), true);
  assert.equal(isTodaysOrder(invoice({ type: "Quotation" }), NOW), false);
  assert.equal(isTodaysOrder(invoice({ type: "" }), NOW), false);
});

test("returns are excluded, both kinds", () => {
  // Their order date is the original order's, so including them would show
  // the same order twice.
  assert.equal(isTodaysOrder(invoice({ type: "Sale", return: true }), NOW), false);
  assert.equal(isTodaysOrder(invoice({ type: "Purchase", return: true }), NOW), false);
  // Only `true` excludes -- an older row with no flag at all is a live bill.
  assert.equal(isTodaysOrder(invoice({ return: undefined }), NOW), true);
  assert.equal(isTodaysOrder(invoice({ return: false }), NOW), true);
});

test("isOrderType does not look at the date", () => {
  assert.equal(isOrderType(invoice({ orderDate: null })), true);
  assert.equal(isOrderType(invoice({ type: "Sale", return: true })), false);
  assert.equal(isOrderType(null), false);
  assert.equal(isOrderType({}), false);
});

console.log("\n--- the list the popup shows ---");

test("today's orders come back newest invoice first", () => {
  const list = todaysOrders(
    [
      invoice({ invoiceNo: 7 }),
      invoice({ invoiceNo: 41, orderDate: "2026-10-08" }),
      invoice({ invoiceNo: 99 }),
      invoice({ invoiceNo: 50, return: true }),
    ],
    NOW
  );
  assert.deepEqual(list.map((i) => i.invoiceNo), [99, 7]);
});

test("an empty or missing list is not an error", () => {
  assert.deepEqual(todaysOrders([], NOW), []);
  assert.deepEqual(todaysOrders(null, NOW), []);
  assert.deepEqual(todaysOrders(undefined), []);
});

test("a line carries what the popup prints, and nothing else", () => {
  assert.deepEqual(orderLine(invoice()), {
    invoiceNo: 42,
    type: "Sale",
    party: "Sharma Traders",
    orderNo: "PO-7",
    amount: 7965,
  });
});

test("a missing party reads as something rather than blank", () => {
  assert.equal(orderLine(invoice({ customer: {} })).party, "No party");
  assert.equal(orderLine(invoice({ customer: null })).party, "No party");
  assert.equal(orderLine({}).party, "No party");
  assert.equal(orderLine({}).amount, 0, "never NaN on screen");
  assert.equal(orderLine(invoice({ finalAmount: "abc" })).amount, 0);
});

test("one order does not read as '1 orders'", () => {
  assert.equal(headline(1), "1 order is dated today");
  assert.equal(headline(2), "2 orders are dated today");
  assert.equal(headline(0), "");
  assert.equal(headline(-1), "");
});

test("the popup names a bounded number of them", () => {
  assert.ok(MAX_LISTED > 0 && MAX_LISTED <= 20, `${MAX_LISTED} is not a sensible cap`);
});

console.log("\n--- shown once a day, and never fatal ---");

test("the key carries today's Indian day", () => {
  assert.equal(dismissKey(NOW), `${DISMISS_PREFIX}20261009`);
  assert.equal(dismissKey(EARLY), `${DISMISS_PREFIX}20261009`, "2am is still the 9th");
  assert.equal(dismissKey(Date.parse("2026-10-10T10:00:00+05:30")), `${DISMISS_PREFIX}20261010`);
});

test("tomorrow is a different key, so nothing has to expire", () => {
  assert.notEqual(dismissKey(NOW), dismissKey(Date.parse("2026-10-10T10:00:00+05:30")));
});

test("an unusable clock yields no key rather than a wrong one", () => {
  assert.equal(dismissKey("rubbish"), null);
  assert.equal(shouldShow({ count: 3, now: "rubbish", read: () => null }), false);
});

test("it shows when there is something to show and nothing stored", () => {
  assert.equal(shouldShow({ count: 3, now: NOW, read: () => null }), true);
  assert.equal(shouldShow({ count: 1, now: NOW, read: () => null }), true);
});

test("it stays hidden once dismissed, and when there is nothing", () => {
  assert.equal(shouldShow({ count: 3, now: NOW, read: () => "1" }), false);
  assert.equal(shouldShow({ count: 0, now: NOW, read: () => null }), false);
  assert.equal(shouldShow({ count: undefined, now: NOW, read: () => null }), false);
  assert.equal(shouldShow(), false);
});

test("it reads the key for TODAY, not any old key", () => {
  const stored = { [`${DISMISS_PREFIX}20261008`]: "1" };
  assert.equal(
    shouldShow({ count: 3, now: NOW, read: (k) => stored[k] }),
    true,
    "yesterday's dismissal must not silence today"
  );
});

test("storage that throws does not take the page down", () => {
  // A private window throws on localStorage. A reminder shown twice beats a
  // page that will not render.
  const read = () => {
    throw new Error("SecurityError");
  };
  assert.equal(shouldShow({ count: 3, now: NOW, read }), true);
});

console.log("\n--- the wiring ---");

const read = (name) => fs.readFileSync(new URL(`../${name}`, import.meta.url), "utf8");

test("the route filters through the same rule the popup uses", () => {
  const src = read("app/api/todays-orders/route.js");
  assert.match(src, /todaysOrders\(invoices, now\)/, "the route does not apply the rule");
  assert.match(src, /istDayWindow\(now\)/, "the route does not use the IST window");
  assert.match(src, /return: \{ \$ne: true \}/, "the route does not exclude returns");
  assert.match(src, /tenantRoute\(handleGET\)/, "the route is not scoped to the firm");
});

test("the popup is mounted in the layout and skips the sign-in pages", () => {
  const layout = read("app/layout.js");
  assert.match(layout, /<TodaysOrders \/>/, "the popup is not mounted");
  assert.match(layout, /import TodaysOrders from/);
  const component = read("components/TodaysOrders.jsx");
  assert.match(component, /pathname === '\/login' \|\| pathname === '\/signup'/);
  assert.match(component, /'use client'/);
});

test("every storage call in the popup is wrapped", () => {
  // localStorage throws in a private window. An unwrapped call in a component
  // that sits in the root layout would break every page.
  const src = read("components/TodaysOrders.jsx");
  const calls = [...src.matchAll(/window\.localStorage/g)];
  assert.ok(calls.length >= 2, "expected a read and a write");
  for (const m of calls) {
    const before = src.slice(0, m.index);
    const tryAt = before.lastIndexOf("try {");
    const fnAt = Math.max(before.lastIndexOf("const dismiss"), before.lastIndexOf("shouldShow({"));
    assert.ok(tryAt > -1 && tryAt > fnAt - 400, "a localStorage call looks unguarded");
  }
});

console.log(`\n${passed} checks passed.\n`);
