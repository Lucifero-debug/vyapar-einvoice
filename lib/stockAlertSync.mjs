/**
 * Bring the stored low-stock alerts in line with the stock as it stands.
 *
 * NOT a pure module -- it reads and writes Mongo -- so the decisions live in
 * lib/stockAlerts.mjs, which the tests run under bare node, and this is the
 * thin part that applies them.
 *
 * Inside the existing transaction helper, with the session on every query,
 * like every other write in the app. Scoped to the caller's firm by the
 * tenant plugin, so it can only ever see and touch this firm's items, stock
 * and alerts.
 *
 * WHEN IT RUNS: whenever the alerts are looked at (the dashboard and
 * /api/stock-alerts). That is when an alert can be noticed, and running it
 * there rather than inside every invoice, production and voucher route keeps
 * the posting paths exactly as they were. The stock figure it reads is the
 * same summed one the dashboard shows, so the two cannot disagree.
 */

import Item from "../models/itemModel";
import ItemLedger from "../models/itemLedgerModel";
import StockAlert from "../models/stockAlertModel";
import { withTransaction } from "./withTransaction.mjs";
import { buildStockIndex } from "./itemStock.mjs";
import { alertConditions, reconcileAlerts } from "./stockAlerts.mjs";

export async function syncStockAlerts({ items: givenItems, stock: givenStock, now = new Date() } = {}) {
  return withTransaction(async (session) => {
    // The dashboard has just computed the stock; it hands it over rather than
    // have it summed a second time. Read here only when called on its own.
    //
    // One after another, never in parallel: the first operation of a
    // transaction is the one that starts it, and parallel first operations
    // race to do so -- a lost race is a NoSuchTransaction and a retry.
    let items = givenItems;
    let stock = givenStock;
    if (!items || !stock) {
      items = await Item.find(
        {},
        { name: 1, unit: 1, hsn: 1, openingQuantity: 1, minQuantity: 1, isService: 1 },
        { session }
      ).lean();
      const movements = await ItemLedger.aggregate([
        { $group: { _id: "$itemName", received: { $sum: "$receiptQuantity" }, issued: { $sum: "$issueQuantity" } } },
      ]).session(session);
      stock = buildStockIndex({ items, movements });
    }
    const open = await StockAlert.find({ status: "open" }, null, { session })
      .sort({ raisedAt: 1, _id: 1 })
      .lean();

    const plan = reconcileAlerts({ conditions: alertConditions({ stock, items }), open, now });

    // One round trip for the lot. The tenant plugin's bulkWrite hook scopes
    // every filter to this firm (lib/tenantScope.mjs scopeBulkOps), and an
    // upsert copies that filter's companyId onto the alert it inserts.
    const ops = [
      // Raised as an upsert keyed on the item's OPEN alert: if one exists
      // (raised by a request that committed a moment ago) nothing changes,
      // and the unique index stops a true race outright.
      ...plan.raise.map((alert) => ({
        updateOne: {
          filter: { itemName: alert.itemName, status: "open" },
          update: { $setOnInsert: alert },
          upsert: true,
        },
      })),
      ...plan.update.map(({ id, set }) => ({
        updateOne: { filter: { _id: id, status: "open" }, update: { $set: set } },
      })),
      ...plan.resolve.map(({ id, resolvedAt }) => ({
        updateOne: {
          filter: { _id: id, status: "open" },
          update: { $set: { status: "resolved", resolvedAt } },
        },
      })),
    ];
    if (ops.length) await StockAlert.bulkWrite(ops, { session, ordered: true });

    const current = ops.length
      ? await StockAlert.find({ status: "open" }, null, { session }).lean()
      : open;
    return {
      alerts: current,
      changes: { raised: plan.raise.length, updated: plan.update.length, resolved: plan.resolve.length },
    };
  });
}

/** Acknowledge one open alert, as the signed-in user. */
export async function acknowledgeStockAlert({ id, by = "", now = new Date() }) {
  return withTransaction(async (session) =>
    StockAlert.findOneAndUpdate(
      { _id: id, status: "open" },
      { $set: { acknowledgedAt: now, acknowledgedBy: by } },
      { new: true, session }
    ).lean()
  );
}
