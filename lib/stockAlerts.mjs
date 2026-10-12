/**
 * Low-stock alerts that persist: raised once, kept while the condition lasts,
 * resolved when it clears.
 *
 * Pure and dependency-free, like the rest of lib/*.mjs, so `node` can run
 * scripts/stock-alerts.test.mjs directly. Never import Mongoose in here; the
 * writes are lib/stockAlertSync.mjs's.
 *
 *
 * WHAT WAS THERE
 * --------------
 * The dashboard's "Stock to reorder" panel recomputed its list on every load
 * (lib/dashboard.mjs `lowStockRows`). Correct, but with no memory: nothing
 * could say since when an item had been short, nobody could mark one as seen,
 * and there was no record to tell "still the same shortage" from "short
 * again". This module adds exactly that memory and nothing else -- the rule
 * for what counts as low is still `stockReason`, unchanged, and the
 * threshold is still the item master's optional `minQuantity`.
 *
 *
 * ONE ALERT PER UNRESOLVED CONDITION
 * ----------------------------------
 * The condition is "this item is low". While it lasts there is ONE open
 * alert for the item, however many times the dashboard is opened. If it gets
 * worse -- below minimum, then out, then negative -- the same alert is
 * updated, and its acknowledgement is cleared so the worse news is seen. If
 * it eases but is still low, it is updated and stays acknowledged. When stock
 * recovers the alert is resolved; a later shortage is a new condition and a
 * new alert. The database enforces the "one open alert per item" rule with a
 * unique partial index (models/stockAlertModel.js), so two dashboards opened
 * at the same moment cannot raise it twice.
 *
 * SERVICES ARE NOT STOCK. The posting path writes stock-ledger rows for
 * every invoice line, services included, so a service that is sold reads as
 * "negative stock". Nobody reorders a service; they are left out here.
 */

import { lowStockRows, STOCK_REASON_LABELS } from "./dashboard.mjs";

const text = (value) => String(value ?? "").trim();
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const key = (name) => text(name).toLowerCase();

/** Worse is higher. Out of stock is worse than below minimum, negative worse still. */
export const SEVERITY = { below: 1, out: 2, negative: 3 };

/**
 * The items that are low right now: the dashboard's own rows, less services.
 * `stock` is lib/itemStock.mjs's index; `items` the master, with `isService`.
 */
export const alertConditions = ({ stock = [], items = [] } = {}) => {
  const services = new Set(items.filter((i) => i?.isService).map((i) => key(i.name)));
  return lowStockRows({ stock, items }).filter((row) => !services.has(key(row.name)));
};

/**
 * What to write, given the conditions now and the alerts already open.
 *
 * Returns `{ raise, update, resolve }`:
 *   raise    conditions with no open alert for their item -> insert one
 *   update   open alerts whose figures changed -> set them (and clear the
 *            acknowledgement when the reason got worse)
 *   resolve  open alerts whose item is no longer low -> close them
 *
 * An open alert whose figures are unchanged is left alone entirely: opening
 * the dashboard does not touch a row it has nothing new to say about.
 */
export const reconcileAlerts = ({ conditions = [], open = [], now = new Date() } = {}) => {
  const current = new Map();
  for (const c of conditions) if (text(c?.name)) current.set(key(c.name), c);

  const openByItem = new Map();
  const duplicates = [];
  for (const a of open) {
    const k = key(a?.itemName);
    if (!k) continue;
    // Belt and braces: should two open alerts ever exist for one item (data
    // written before the unique index), keep the oldest and close the rest.
    if (openByItem.has(k)) duplicates.push(a);
    else openByItem.set(k, a);
  }

  const raise = [];
  const update = [];
  const resolve = duplicates.map((a) => ({ id: a._id, resolvedAt: now, reason: "duplicate" }));

  for (const [k, c] of current) {
    const alert = openByItem.get(k);
    const figures = {
      reason: c.reason,
      quantity: num(c.quantity),
      minimum: c.minimum === null || c.minimum === undefined ? null : num(c.minimum),
      unit: text(c.unit),
    };
    if (!alert) {
      raise.push({ itemName: text(c.name), ...figures, status: "open", raisedAt: now, lastChangedAt: now });
      continue;
    }
    const changed =
      alert.reason !== figures.reason ||
      num(alert.quantity) !== figures.quantity ||
      (alert.minimum ?? null) !== figures.minimum ||
      text(alert.unit) !== figures.unit;
    if (!changed) continue;
    const worse = (SEVERITY[figures.reason] || 0) > (SEVERITY[alert.reason] || 0);
    update.push({
      id: alert._id,
      set: {
        ...figures,
        lastChangedAt: now,
        ...(worse ? { acknowledgedAt: null, acknowledgedBy: "" } : {}),
      },
    });
  }

  for (const [k, alert] of openByItem) {
    if (!current.has(k)) resolve.push({ id: alert._id, resolvedAt: now, reason: "recovered" });
  }

  return { raise, update, resolve };
};

/**
 * The alerts as the dashboard lists them: newest-unseen first, then by how
 * bad. `isNew` is open and not yet acknowledged.
 */
export const alertView = (alerts = []) =>
  alerts
    .filter((a) => a?.status === "open")
    .map((a) => ({
      id: text(a._id),
      itemName: text(a.itemName),
      reason: a.reason,
      reasonLabel: STOCK_REASON_LABELS[a.reason] || text(a.reason),
      quantity: num(a.quantity),
      minimum: a.minimum ?? null,
      unit: text(a.unit),
      raisedAt: a.raisedAt || null,
      acknowledgedAt: a.acknowledgedAt || null,
      acknowledgedBy: text(a.acknowledgedBy),
      isNew: !a.acknowledgedAt,
    }))
    .sort(
      (a, b) =>
        Number(b.isNew) - Number(a.isNew) ||
        (SEVERITY[b.reason] || 0) - (SEVERITY[a.reason] || 0) ||
        a.itemName.localeCompare(b.itemName)
    );

/** "3 new, 7 open" -- for the panel heading. */
export const alertCounts = (alerts = []) => {
  const view = alertView(alerts);
  return { open: view.length, unseen: view.filter((a) => a.isNew).length };
};
