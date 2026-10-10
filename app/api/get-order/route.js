import { NextResponse } from "next/server";
import { connect } from "../../../lib/mongodb";
import Order from "@/models/orderModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import {
  isOrderType,
  lineStatus,
  orderStatus,
  pendingQty,
  pendingValue,
} from "@/lib/orderStatus.mjs";

/**
 * One order, for the form to open or the print to render.
 *
 *   /api/get-order?orderNo=7&type=Sale
 *
 * Each line comes back with `pending` and its own status already worked out,
 * so the page never does the subtraction itself. That matters more than it
 * looks: the moment a screen computes `quantity - invoicedQty` on its own, it
 * forgets the cancelled quantity and starts offering to bill goods that were
 * called off.
 */
async function handleGET(req, auth) {
  try {
    await connect();
    const url = new URL(req.url);

    const orderNo = Number(url.searchParams.get("orderNo"));
    const type = String(url.searchParams.get("type") || "").trim();

    if (!Number.isFinite(orderNo) || !isOrderType(type)) {
      return NextResponse.json(
        { success: false, error: "An order number and a type are needed." },
        { status: 400 }
      );
    }

    const order = await Order.findOne({ orderNo, type }).lean();

    if (!order) {
      return NextResponse.json(
        { success: false, error: "Order not found." },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      order: {
        ...order,
        status: orderStatus(order),
        pendingValue: pendingValue(order),
        items: (order.items || []).filter(Boolean).map((line) => ({
          ...line,
          pending: pendingQty(line),
          lineStatus: lineStatus(line),
        })),
      },
    });
  } catch (err) {
    console.error("Error fetching order:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export const dynamic = "force-dynamic";

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);
