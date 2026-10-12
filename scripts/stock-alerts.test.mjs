/**
 * Persistent low-stock alerts.
 *
 *   node scripts/stock-alerts.test.mjs
 *
 * lib/stockAlerts.mjs decides; lib/stockAlertSync.mjs writes. The decisions
 * are replayed here against an in-memory alert store that behaves like the
 * collection -- tenant-scoped, and with the unique partial index on the open
 * alert per item -- across repeated dashboard loads, so the properties that
 * matter are tested over time rather than for one call:
 *
 *   one open alert per item while it stays low, however often it is looked at
 *   worse news is seen again; better-but-still-low news is not re-announced
 *   recovery resolves it; a later shortage is a new alert
 *   one firm's stock never raises, touches or resolves another firm's alert
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { buildStockIndex } from "../lib/itemStock.mjs";
import { stockReason } from "../lib/dashboard.mjs";
import {
  SEVERITY,
  alertConditions,
  alertCounts,
  alertView,
  reconcileAlerts,
} from "../lib/stockAlerts.mjs";

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

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/* ------------------------------------------------------------ the store -- */

/**
 * The collection as lib/stockAlertSync.mjs uses it: an upsert keyed on the
 * open alert, plain updates by id, and the unique partial index on
 * { companyId, itemName } where status is open -- which throws, as Mongo does.
 */
const newStore = () => ({ docs: [], seq: 0 });

const uniqueCheck = (store) => {
  const seen = new Set();
  for (const d of store.docs.filter((x) => x.status === "open")) {
    const k = `${d.companyId}|${d.itemName}`;
    if (seen.has(k)) throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
    seen.add(k);
  }
};

/** One sync, for one firm, exactly as syncStockAlerts applies a plan. */
const sync = (store, firm, { items, movements, now }) => {
  const scoped = store.docs.filter((d) => d.companyId === firm);
  const open = scoped.filter((d) => d.status === "open").sort((a, b) => a.raisedAt - b.raisedAt);
  const stock = buildStockIndex({ items, movements });
  const plan = reconcileAlerts({ conditions: alertConditions({ stock, items }), open, now });
  for (const alert of plan.raise) {
    const exists = scoped.find((d) => d.status === "open" && d.itemName === alert.itemName);
    if (exists) continue; // $setOnInsert on a match changes nothing
    store.seq += 1;
    store.docs.push({ _id: `a${store.seq}`, companyId: firm, acknowledgedAt: null, acknowledgedBy: "", ...alert });
  }
  for (const { id, set } of plan.update) {
    const d = store.docs.find((x) => x._id === id && x.companyId === firm && x.status === "open");
    if (d) Object.assign(d, set);
  }
  for (const { id, resolvedAt } of plan.resolve) {
    const d = store.docs.find((x) => x._id === id && x.companyId === firm && x.status === "open");
    if (d) Object.assign(d, { status: "resolved", resolvedAt });
  }
  uniqueCheck(store);
  return { plan, open: store.docs.filter((d) => d.companyId === firm && d.status === "open") };
};

const acknowledge = (store, firm, id, by) => {
  const d = store.docs.find((x) => x._id === id && x.companyId === firm && x.status === "open");
  if (!d) return null;
  Object.assign(d, { acknowledgedAt: new Date(), acknowledgedBy: by });
  return d;
};

const ITEMS = [
  { name: "Widget", unit: "PCS", openingQuantity: 10, minQuantity: 5 },
  { name: "Bolt", unit: "KGS", openingQuantity: 0, minQuantity: null },
  { name: "Install", unit: "NOS", openingQuantity: 0, isService: true },
  { name: "Rod", unit: "MTR", openingQuantity: 100, minQuantity: 0 },
];
const moved = (name, issued, received = 0) => ({ _id: name, received, issued });
const T = (n) => new Date(Date.UTC(2026, 9, n));

/* ========================================================= thresholds ==== */

console.log("\n--- what counts as low ---");

test("the dashboard's own rule, unchanged", () => {
  assert.equal(stockReason(-1, 5), "negative");
  assert.equal(stockReason(0, null), "out");
  assert.equal(stockReason(4, 5), "below");
  assert.equal(stockReason(5, 5), null, "at the minimum is not below it");
  assert.equal(stockReason(3, null), null, "no minimum, no 'below'");
  assert.equal(stockReason(3, 0), null, "a minimum of zero is no minimum");
});

test("conditions: below a minimum, out, negative -- and never a service", () => {
  const stock = buildStockIndex({ items: ITEMS, movements: [moved("Widget", 7), moved("Install", 1)] });
  const c = alertConditions({ stock, items: ITEMS });
  assert.deepEqual(c.map((x) => [x.name, x.reason]).sort(), [["Bolt", "out"], ["Widget", "below"]]);
});

test("an item with no minimum is only raised when it runs out", () => {
  const stock = buildStockIndex({ items: ITEMS, movements: [moved("Bolt", 0, 3)] });
  assert.equal(alertConditions({ stock, items: ITEMS }).some((x) => x.name === "Bolt"), false);
});

/* ========================================================= duplicates ==== */

console.log("\n--- one alert per unresolved condition ---");

test("opening the dashboard ten times raises one alert, not ten", () => {
  const store = newStore();
  const state = { items: ITEMS, movements: [moved("Widget", 7)] };
  for (let i = 1; i <= 10; i += 1) sync(store, "A", { ...state, now: T(i) });
  const widget = store.docs.filter((d) => d.itemName === "Widget");
  assert.equal(widget.length, 1);
  assert.equal(widget[0].raisedAt.getTime(), T(1).getTime(), "the first sighting is kept");
});

test("an unchanged alert is not rewritten at all", () => {
  const store = newStore();
  const state = { items: ITEMS, movements: [moved("Widget", 7)] };
  sync(store, "A", { ...state, now: T(1) });
  const { plan } = sync(store, "A", { ...state, now: T(2) });
  assert.deepEqual([plan.raise.length, plan.update.length, plan.resolve.length], [0, 0, 0]);
});

test("two dashboards raising the same alert at once: the index refuses the second", () => {
  const store = newStore();
  store.docs.push({ _id: "x1", companyId: "A", itemName: "Widget", status: "open" });
  store.docs.push({ _id: "x2", companyId: "A", itemName: "Widget", status: "open" });
  assert.throws(() => uniqueCheck(store), /E11000/);
});

test("the model declares that index -- unique, partial on open, per firm", () => {
  const src = code(read("models/stockAlertModel.js"));
  assert.match(src, /stockAlertSchema\.plugin\(tenantPlugin\)/);
  assert.match(
    src,
    /index\(\s*\{ companyId: 1, itemName: 1 \},\s*\{ unique: true, partialFilterExpression: \{ status: "open" \}/
  );
  assert.match(read("scripts/sync-indexes.mjs"), /\["stockalerts", "stockAlertModel"\]/);
});

test("duplicates already in the data are closed, keeping the oldest", () => {
  const plan = reconcileAlerts({
    conditions: [{ name: "Widget", reason: "below", quantity: 3, minimum: 5, unit: "PCS" }],
    open: [
      { _id: "old", itemName: "Widget", reason: "below", quantity: 3, minimum: 5, unit: "PCS" },
      { _id: "dup", itemName: "Widget", reason: "below", quantity: 3, minimum: 5, unit: "PCS" },
    ],
  });
  assert.deepEqual(plan.resolve.map((r) => r.id), ["dup"]);
  assert.equal(plan.raise.length, 0);
});

/* ==================================================== over its lifetime == */

console.log("\n--- worse, better, recovered, again ---");

test("getting worse updates the same alert and makes it new again", () => {
  const store = newStore();
  sync(store, "A", { items: ITEMS, movements: [moved("Widget", 7)], now: T(1) });
  const [alert] = store.docs.filter((d) => d.itemName === "Widget");
  acknowledge(store, "A", alert._id, "Asha");
  assert.equal(alertCounts(store.docs).unseen, 1, "only Bolt is unseen");
  sync(store, "A", { items: ITEMS, movements: [moved("Widget", 10)], now: T(2) });
  const after = store.docs.filter((d) => d.itemName === "Widget");
  assert.equal(after.length, 1, "a worse shortage raised a second alert");
  assert.equal(after[0].reason, "out");
  assert.equal(after[0].acknowledgedAt, null, "worse news stayed marked as seen");
  assert.ok(SEVERITY.out > SEVERITY.below);
});

test("easing but still low keeps the acknowledgement", () => {
  const store = newStore();
  sync(store, "A", { items: ITEMS, movements: [moved("Widget", 10)], now: T(1) });
  const [alert] = store.docs.filter((d) => d.itemName === "Widget");
  acknowledge(store, "A", alert._id, "Asha");
  sync(store, "A", { items: ITEMS, movements: [moved("Widget", 7)], now: T(2) });
  const [after] = store.docs.filter((d) => d.itemName === "Widget");
  assert.equal(after.reason, "below");
  assert.equal(after.quantity, 3);
  assert.notEqual(after.acknowledgedAt, null);
});

test("recovery resolves it; a later shortage is a new alert", () => {
  const store = newStore();
  sync(store, "A", { items: ITEMS, movements: [moved("Widget", 7)], now: T(1) });
  sync(store, "A", { items: ITEMS, movements: [moved("Widget", 7, 20)], now: T(2) });
  const resolved = store.docs.filter((d) => d.itemName === "Widget");
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].status, "resolved");
  sync(store, "A", { items: ITEMS, movements: [moved("Widget", 30, 20)], now: T(3) });
  const widget = store.docs.filter((d) => d.itemName === "Widget");
  assert.equal(widget.length, 2, "a new shortage reused the resolved alert");
  assert.equal(widget.filter((d) => d.status === "open").length, 1);
  assert.equal(widget.find((d) => d.status === "open").raisedAt.getTime(), T(3).getTime());
});

test("deleting the item resolves its alert", () => {
  const store = newStore();
  sync(store, "A", { items: ITEMS, movements: [moved("Widget", 7)], now: T(1) });
  sync(store, "A", { items: ITEMS.filter((i) => i.name !== "Widget" && i.name !== "Bolt"), movements: [], now: T(2) });
  assert.equal(store.docs.filter((d) => d.status === "open").length, 0);
});

test("the view lists new first, then the worst", () => {
  const view = alertView([
    { _id: "1", itemName: "A", reason: "below", status: "open", acknowledgedAt: new Date() },
    { _id: "2", itemName: "B", reason: "below", status: "open", acknowledgedAt: null },
    { _id: "3", itemName: "C", reason: "negative", status: "open", acknowledgedAt: null },
    { _id: "4", itemName: "D", reason: "out", status: "resolved", acknowledgedAt: null },
  ]);
  assert.deepEqual(view.map((a) => a.itemName), ["C", "B", "A"]);
  assert.deepEqual(alertCounts([{ status: "open" }, { status: "open", acknowledgedAt: new Date() }]), { open: 2, unseen: 1 });
});

test("an empty book raises nothing and resolves nothing", () => {
  const plan = reconcileAlerts({ conditions: [], open: [] });
  assert.deepEqual(plan, { raise: [], update: [], resolve: [] });
  assert.deepEqual(alertView([]), []);
});

/* ==================================================== tenant isolation === */

console.log("\n--- one firm's alerts are its own ---");

test("two firms with the same item name each get their own alert", () => {
  const store = newStore();
  sync(store, "A", { items: ITEMS, movements: [moved("Widget", 7)], now: T(1) });
  sync(store, "B", { items: ITEMS, movements: [moved("Widget", 7)], now: T(1) });
  assert.equal(store.docs.filter((d) => d.itemName === "Widget").length, 2);
  uniqueCheck(store);
});

test("one firm's recovery does not resolve another firm's alert", () => {
  const store = newStore();
  sync(store, "A", { items: ITEMS, movements: [moved("Widget", 7)], now: T(1) });
  sync(store, "B", { items: ITEMS, movements: [moved("Widget", 7)], now: T(1) });
  sync(store, "A", { items: ITEMS, movements: [moved("Widget", 7, 20)], now: T(2) });
  assert.equal(store.docs.find((d) => d.companyId === "B" && d.itemName === "Widget").status, "open");
});

test("one firm cannot acknowledge another's alert", () => {
  const store = newStore();
  sync(store, "B", { items: ITEMS, movements: [moved("Widget", 7)], now: T(1) });
  const theirs = store.docs.find((d) => d.companyId === "B" && d.itemName === "Widget");
  assert.equal(acknowledge(store, "A", theirs._id, "Intruder"), null);
  assert.equal(theirs.acknowledgedAt, null);
});

/* ============================================================== wiring == */

console.log("\n--- the sync, the route and the dashboard ---");

const SYNC = code(read("lib/stockAlertSync.mjs"));

test("every write is inside the transaction helper, with the session", () => {
  assert.match(SYNC, /return withTransaction\(async \(session\) =>/);
  const calls = [...SYNC.matchAll(/\b(StockAlert|Item|ItemLedger)\.(find\w*|updateOne|bulkWrite|aggregate|create|deleteMany)\(/g)];
  assert.ok(calls.length >= 6, "the sweep is not reading the sync");
  for (const m of calls) {
    const tail = SYNC.slice(m.index, SYNC.indexOf(";", m.index));
    assert.match(tail, /session/, `${m[0]} runs outside the transaction`);
  }
  assert.match(SYNC, /\$setOnInsert: alert/, "raising is not an upsert");
  assert.match(SYNC, /upsert: true/);
  assert.match(SYNC, /StockAlert\.bulkWrite\(ops, \{ session/, "the writes are not one batch in the session");
  // The first reads of the transaction run one after another.
  assert.doesNotMatch(SYNC, /Promise\.all\(/, "parallel first operations race to start the transaction");
  assert.match(SYNC, /\{ _id: id, status: "open" \}/, "an update could touch a resolved alert");
});

test("the alert route is tenant-wrapped and takes the acknowledger from the session", () => {
  const src = code(read("app/api/stock-alerts/route.js"));
  assert.match(src, /export const GET = tenantRoute\(handleGET\)/);
  // Wrapped, and acknowledging is a write (scripts/rate-limit.test.mjs).
  assert.match(src, /export const POST = tenantRoute\(handlePOST, \{ permission: "master:write" \}\)/);
  assert.match(src, /by: auth\?\.name \|\| auth\?\.email/);
  assert.match(src, /mongoose\.Types\.ObjectId\.isValid\(id\)/);
  assert.doesNotMatch(src, /body\.(by|acknowledgedBy|companyId|status)/, "a client field reaches the alert");
});

test("the dashboard lists the same conditions it stores, and survives a failed sync", () => {
  const src = code(read("app/api/analytics/route.js"));
  assert.match(src, /const lowStock = alertConditions\(\{ stock, items \}\)/);
  assert.match(src, /isService: 1/, "services cannot be told apart");
  // Handed the stock it just computed: the ledger is summed once per load.
  assert.match(src, /try \{\s*\(\{ alerts: storedAlerts \} = await syncStockAlerts\(\{ items, stock \}\)\);\s*\} catch/);
  assert.match(SYNC, /if \(!items \|\| !stock\)/, "the sync sums the ledger even when handed the stock");
  const page = read("app/dashboard/page.js");
  assert.match(page, /Mark seen/);
  assert.match(page, /fetch\('\/api\/stock-alerts'/);
});

console.log(`\n${passed} checks passed.\n`);
