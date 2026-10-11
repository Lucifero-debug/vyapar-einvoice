import { NextResponse } from "next/server";
import Order from "@/models/orderModel";
import { withTransaction, AbortTransaction } from "@/lib/withTransaction.mjs";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import {
  applyCancel,
  applyRestore,
  cancelBlockedReason,
  cancellationEntry,
  isOrderType,
  orderStatus,
  orderTotal,
  restoreBlockedReason,
} from "@/lib/orderStatus.mjs";

/**
 * Call off an order's unbilled balance, or put a cancellation back.
 *
 *   POST /api/order-cancel
 *   { orderNo, type, reason, lines?: [lineId], restore?: true }
 *
 * `lines` names the lines to act on; omit it for the whole order. Both shapes
 * go through the same two functions in lib/orderStatus.mjs, because "cancel
 * the order" is just "cancel every line" and keeping them apart is how the
 * two start disagreeing about what a billed line may do.
 *
 * WHAT CANNOT BE CANCELLED
 * ------------------------
 * A quantity already on an invoice. So cancelling a part-billed order SHORT-
 * CLOSES it: the billed part stands, the balance is written off, and the
 * order goes to `closed` rather than `cancelled` -- which is the honest
 * status, because goods did go out against it.
 *
 * NOTHING IS POSTED EITHER WAY
 * ----------------------------
 * No ledger, no stock, no tax -- an order never touched any of them. That is
 * what makes a cancellation safely reversible: `restore` sets the cancelled
 * quantity back to zero and there is nothing else to unwind. It is also why
 * this does not need to do anything about invoices already raised; they are
 * untouched, and lib/orderClaims.mjs still owns `invoicedQty`.
 */
async function handlePOST(req, auth) {
  try {
    const body = await req.json();

    const orderNo = Number(body.orderNo);
    const type = String(body.type || "").trim();
    const restore = Boolean(body.restore);
    const reason = String(body.reason || "").trim();
    const lines = Array.isArray(body.lines) && body.lines.length ? body.lines : null;

    if (!Number.isFinite(orderNo) || !isOrderType(type)) {
      return NextResponse.json(
        { success: false, error: "An order number and a type (Sale or Purchase) are needed." },
        { status: 400 }
      );
    }

    // A reason is required on the way out and not on the way back. Cancelling
    // loses a sale and somebody will ask why; restoring is the correction of a
    // mis-click and holding it up for an explanation is just friction.
    if (!restore && !reason) {
      return NextResponse.json(
        { success: false, error: "Give a reason for the cancellation." },
        { status: 400 }
      );
    }

    const updated = await withTransaction(async (session) => {
      const order = await Order.findOne({ orderNo, type }).session(session).lean();

      if (!order) {
        throw new AbortTransaction({ success: false, error: "Order not found." }, 404);
      }

      // Checked while the row is still as it was, so a refusal never relies on
      // a rollback to put anything back.
      const blocked = restore ? restoreBlockedReason(order) : cancelBlockedReason(order);
      if (blocked) {
        throw new AbortTransaction({ success: false, error: blocked }, 409);
      }

      const result = restore ? applyRestore(order, lines) : applyCancel(order, lines);
      if (result.problems.length) {
        throw new AbortTransaction({ success: false, error: result.problems.join(" ") }, 409);
      }

      const moved = restore ? result.restored : result.cancelled;
      if (!moved.length) {
        throw new AbortTransaction(
          {
            success: false,
            error: restore
              ? "Nothing on those lines is cancelled."
              : "Nothing left to cancel on those lines.",
          },
          409
        );
      }

      const entry = cancellationEntry({
        lines: moved,
        reason,
        by: auth?.name || auth?.email || "",
        restore,
      });

      const next = await Order.findOneAndUpdate(
        { orderNo, type },
        {
          $set: {
            items: result.items,
            // Both derived from the lines that were just written, which is the
            // only honest source now that the cancelled quantities moved.
            status: orderStatus({ items: result.items }),
            totalAmount: orderTotal(result.items),
            updatedBy: auth?.name || auth?.email || "",
          },
          $push: { cancellations: entry },
          $inc: { editCount: 1 },
        },
        { new: true, session }
      );

      if (!next) {
        throw new AbortTransaction({ success: false, error: "Order not found." }, 404);
      }

      return { order: next, moved, entry };
    });

    const what = restore ? "restored" : "cancelled";
    return NextResponse.json({
      success: true,
      order: updated.order,
      moved: updated.moved,
      message: `${updated.moved.length} line${updated.moved.length === 1 ? "" : "s"} ${what} on ${type} order ${orderNo}`,
    });
  } catch (err) {
    if (err instanceof AbortTransaction) {
      return NextResponse.json(err.payload, { status: err.status });
    }
    console.error("Error cancelling order:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);
