import { NextResponse } from "next/server";
import { connect } from "../../../lib/mongodb";
import Order from "@/models/orderModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import {
  isOpenOrder,
  isOrderType,
  orderStatus,
  pendingValue,
  toInvoiceLines,
} from "@/lib/orderStatus.mjs";

/**
 * The orders a bill could be raised against.
 *
 *   /api/order-pending?type=Sale&customer=Acme%20Traders
 *
 * This is what the billing form asks when the user clicks "from order". It
 * returns each open order already translated into invoice lines -- pending
 * quantities, the rate as agreed, and the reference back to the order line --
 * so the page has nothing to compute and nothing to get wrong.
 *
 * Held orders are left out. Sigfa's HOLD means "this stands but do not supply
 * against it yet", so offering one for billing defeats the point of setting it.
 */
async function handleGET(req, auth) {
  try {
    await connect();
    const url = new URL(req.url);

    const type = String(url.searchParams.get("type") || "").trim();
    const customer = String(url.searchParams.get("customer") || "").trim();

    if (!isOrderType(type)) {
      return NextResponse.json(
        { success: false, error: "A type (Sale or Purchase) is needed." },
        { status: 400 }
      );
    }

    const query = { type, status: { $in: ["open", "partial"] }, hold: { $ne: true } };
    if (customer) query["customer.name"] = customer;

    const orders = await Order.find(query)
      .sort({ date: 1, orderNo: 1 })
      .limit(200)
      .lean();

    // Re-filtered through the rule rather than trusted from the column: a
    // stored status that has drifted must not put a closed order on a list
    // headed "ready to bill".
    const rows = orders
      .filter(isOpenOrder)
      .map((order) => ({
        orderNo: order.orderNo,
        type: order.type,
        date: order.date,
        deliveryDate: order.deliveryDate,
        reference: order.reference || "",
        customer: { name: order.customer?.name || "" },
        status: orderStatus(order),
        pendingValue: pendingValue(order),
        lines: toInvoiceLines(order),
      }))
      .filter((row) => row.lines.length);

    return NextResponse.json({ success: true, orders: rows });
  } catch (err) {
    console.error("Error fetching pending orders:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export const dynamic = "force-dynamic";

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);
