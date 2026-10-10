/**
 * Turning an order into the lines a billing form expects.
 *
 * Pure and dependency-free, like the rest of lib/*.mjs. The caller passes its
 * own `recalc` -- the billing pages already have `recalcItem`, which is what
 * decides taxableAmount, gstAmount and total -- so this module never has to
 * know how a line's money is worked out. It only decides WHICH lines, WHAT
 * quantity, and which fields come from where.
 *
 * THE RULE ABOUT TAX
 * ------------------
 * The GST rate comes from the ITEM MASTER as it stands today, never from the
 * order. An order placed in March and billed in October is billed at
 * October's rate -- that is the law, and it is also why nothing tax-shaped is
 * stored on an order in the first place (models/orderModel.js).
 *
 * The rate and discount, by contrast, come from the ORDER. Those were agreed
 * with the customer; silently re-pricing them from the master at billing time
 * is how a client ends up invoicing a figure they never quoted.
 */

import { QTY_EPSILON, pendingQty } from "./orderStatus.mjs";

const key = (name) => String(name ?? "").trim().toLowerCase();
const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Build billing lines from an order's pending quantities.
 *
 *   order  - as /api/get-order returns it
 *   items  - the item master list the page already holds
 *   recalc - the page's own recalcItem
 *
 * Returns `{ lines, customerName, skipped }`. `skipped` names any order line
 * whose item is no longer in the master: those are still billed, using the
 * order's own rate and no GST rate, because dropping them silently would
 * under-bill the order and leave it looking part-pending for good. The page
 * shows the names so the user knows to check the tax on them.
 */
export const prefillFromOrder = ({ order, items, recalc }) => {
  const masters = new Map((items || []).filter(Boolean).map((i) => [key(i.name), i]));
  const skipped = [];

  const lines = (order?.items || [])
    .filter(Boolean)
    .map((line) => ({ line, pending: pendingQty(line) }))
    .filter(({ pending }) => pending > QTY_EPSILON)
    .map(({ line, pending }) => {
      const master = masters.get(key(line.name));
      if (!master) skipped.push(line.name);

      const merged = {
        ...(master || {}),
        name: line.name,
        description: line.description || "",
        hsn: line.hsn || master?.hsn || "",
        quantity: pending,
        // From the ORDER: this is the price that was agreed.
        cost: num(line.cost),
        discount: num(line.discount),
        // From the MASTER, today. Never from the order.
        gstRate: num(master?.gst ?? master?.gstRate),
        uqc: master?.uqc || line.uqc,
        isService: master ? Boolean(master.isService) : Boolean(line.isService),
        // The reference that lets save-invoice settle this order line.
        // lib/orderClaims.mjs refuses a claim unless all three are present.
        orderNo: Number(order?.orderNo),
        orderType: String(order?.type || ""),
        orderLineId: String(line._id || ""),
      };

      return typeof recalc === "function" ? recalc(merged) : merged;
    });

  return {
    lines,
    customerName: order?.customer?.name || "",
    skipped,
  };
};
