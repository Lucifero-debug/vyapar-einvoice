/**
 * The one place an invoice touches an order's quantities.
 *
 * Impure, like lib/itemLedger.mjs and lib/runningBalances.mjs: it loads and
 * saves through Mongoose. The arithmetic it applies is all in
 * lib/orderStatus.mjs, which is pure and tested on its own.
 *
 * WHY ONE MODULE AND NOT THREE CALL SITES
 * ---------------------------------------
 * Three routes move order quantities -- save-invoice claims, delete-invoice
 * releases, sale-alter does both -- and each of them is already long enough
 * that a fourth copy of the same subtraction would not be noticed going
 * wrong. The over-billing guard only guards what goes through here, so
 * scripts/orders.test.mjs asserts that none of those three routes mentions
 * `invoicedQty` itself.
 *
 * ALWAYS INSIDE THE CALLER'S TRANSACTION
 * --------------------------------------
 * Every function takes the active session. An invoice that committed while
 * its order's claim rolled back is the worst of both states: the goods are
 * billed and the order still says they are pending.
 */

import Order from "../models/orderModel";
import { AbortTransaction } from "./withTransaction.mjs";
import {
  applyDeltas,
  claimsFromItems,
  netClaims,
  orderStatus,
  orderTotal,
} from "./orderStatus.mjs";

/**
 * Apply one order's signed line changes, or abort.
 *
 * `status` and `totalAmount` are recomputed here rather than left to drift:
 * billing the last pending line is exactly what turns an order closed, and
 * that is this function's business, not the caller's.
 */
const applyToOrder = async ({ session, orderNo, orderType, byLine }) => {
  const order = await Order.findOne({ orderNo, type: orderType })
    .session(session)
    .lean();

  if (!order) {
    // The invoice references an order that is not there. Refusing is the only
    // safe answer: carrying on would bill goods against no commitment, and
    // the reference on the invoice line would point at nothing for good.
    throw new AbortTransaction({
      success: false,
      error: `${orderType} order ${orderNo} no longer exists. Remove the order reference from the bill, or restore the order.`,
    });
  }

  const { items, problems } = applyDeltas(order, byLine);
  if (problems.length) {
    throw new AbortTransaction({
      success: false,
      error: `${orderType} order ${orderNo}: ${problems.join(" ")}`,
    });
  }

  await Order.updateOne(
    { orderNo, type: orderType },
    {
      $set: {
        items,
        status: orderStatus({ items }),
        totalAmount: orderTotal(items),
      },
    },
    { session }
  );

  return { orderNo, orderType, status: orderStatus({ items }) };
};

/**
 * Settle every order an invoice's lines reference, in the given direction.
 * `sign` is +1 to claim quantity, -1 to give it back.
 */
const settle = async ({ session, items, sign }) => {
  const touched = [];
  for (const group of claimsFromItems(items)) {
    const byLine = new Map();
    for (const [lineId, want] of group.byLine) byLine.set(lineId, sign * want);
    touched.push(
      await applyToOrder({
        session,
        orderNo: group.orderNo,
        orderType: group.orderType,
        byLine,
      })
    );
  }
  return touched;
};

/**
 * An invoice was raised: take its quantities off the orders it fulfils.
 *
 * Aborts the whole transaction if any line would be over-billed, so the
 * invoice is never written against a commitment that cannot cover it.
 */
export const claimOrderQty = ({ session, items }) =>
  settle({ session, items, sign: +1 });

/** An invoice was deleted: hand its quantities back to the orders. */
export const releaseOrderQty = ({ session, items }) =>
  settle({ session, items, sign: -1 });

/**
 * An invoice was edited: move each order by the difference only.
 *
 * Releasing everything and re-claiming would work on the happy path and fail
 * on the one that matters -- an edit that merely moves a quantity between two
 * lines of the same order would release line A, claim line B, and briefly
 * leave the order inconsistent inside the transaction. The difference is
 * applied in one write per order instead.
 */
export const reconcileOrderQty = async ({ session, before, after }) => {
  const touched = [];
  for (const group of netClaims(before, after)) {
    touched.push(
      await applyToOrder({
        session,
        orderNo: group.orderNo,
        orderType: group.orderType,
        byLine: group.byLine,
      })
    );
  }
  return touched;
};
