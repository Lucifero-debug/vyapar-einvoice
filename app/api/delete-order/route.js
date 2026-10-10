import { NextResponse } from "next/server";
import Order from "@/models/orderModel";
import { withTransaction, AbortTransaction } from "@/lib/withTransaction.mjs";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { deleteBlockedReason, isOrderType } from "@/lib/orderStatus.mjs";

/**
 * Delete an order.
 *
 * Refused once anything on it has been billed, the same way a reported IRN
 * anchors an invoice (lib/einvoiceLock.mjs). The invoice line holds this
 * order's id and line id; deleting the order would leave those references
 * pointing at nothing, and no later edit of that invoice could then settle
 * or release the quantity. Delete the invoices first.
 *
 * Nothing else has to be undone: an order posts nothing to the ledger, moves
 * no stock and carries no tax, which is the main practical dividend of
 * following Sigfa and keeping orders out of the books entirely.
 */
async function handlePOST(req, auth) {
  try {
    const url = new URL(req.url);
    const orderNo = Number(url.searchParams.get("orderNo"));
    const type = String(url.searchParams.get("type") || "").trim();

    if (!Number.isFinite(orderNo) || !isOrderType(type)) {
      return NextResponse.json(
        { error: "An order number and a type (Sale or Purchase) are needed." },
        { status: 400 }
      );
    }

    const deleted = await withTransaction(async (session) => {
      // Read before deleting, so a blocked delete never has to rely on a
      // rollback to put the row back.
      const existing = await Order.findOne({ orderNo, type })
        .session(session)
        .lean();

      if (!existing) {
        throw new AbortTransaction({ error: "Order not found." }, 404);
      }

      const blocked = deleteBlockedReason(existing);
      if (blocked) {
        throw new AbortTransaction({ error: blocked }, 409);
      }

      return Order.findOneAndDelete({ orderNo, type }, { session });
    });

    return NextResponse.json({
      success: true,
      message: `${type} order ${orderNo} deleted`,
      deletedOrder: deleted,
    });
  } catch (err) {
    if (err instanceof AbortTransaction) {
      return NextResponse.json(err.payload, { status: err.status });
    }
    console.error("Error deleting order:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);
