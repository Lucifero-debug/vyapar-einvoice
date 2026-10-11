import { NextResponse } from "next/server";
import { connect } from "../../../lib/mongodb";
import Order from "@/models/orderModel";
import Invoice from "@/models/invoiceModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { billingInvoices } from "@/lib/orderReports.mjs";
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

    // === What has been billed against this order ===
    //
    // Without this the link is one-way: an invoice line knows which order it
    // came from, but the order could not say what had billed it, so a prefill
    // that silently failed left no trace and the register showed an order as
    // part-billed with nothing to point at. Served off the per-firm index on
    // items.orderNo in models/invoiceModel.js.
    const billing = await Invoice.find(
      { "items.orderNo": orderNo, "items.orderType": type },
      { invoiceNo: 1, date: 1, type: 1, return: 1, "items.name": 1, "items.quantity": 1, "items.orderNo": 1, "items.orderType": 1, "items.orderLineId": 1 }
    )
      .sort({ invoiceNo: 1 })
      .lean();

    // The shaping -- which lines belong to this order, how returns are
    // treated -- lives in lib/orderReports.mjs, where the fixture test can
    // reach it. The route only fetches.
    const invoices = billingInvoices(billing, { orderNo, type });

    return NextResponse.json({
      success: true,
      order: {
        ...order,
        status: orderStatus(order),
        pendingValue: pendingValue(order),
        invoices,
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
