import { NextResponse } from "next/server";
import { connect } from "../../../lib/mongodb";
import Invoice from "../../../models/invoiceModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { istDayWindow } from "@/lib/istDate.mjs";
import { MAX_LISTED, ORDER_TYPES, orderLine, todaysOrders } from "@/lib/todaysOrders.mjs";

// The popup asks on every first page load of the day, so it must not be cached.
export const dynamic = "force-dynamic";

/**
 * Invoices whose ORDER date falls on today — for the reminder popup.
 *
 *   GET /api/todays-orders
 *
 * The window is today's IST calendar day, because that is the day the person
 * reading the popup is having. The dates are stored as UTC midnight of the day
 * somebody picked, which falls inside that window for the same day. See
 * lib/istDate.mjs.
 *
 * Returns a count and up to MAX_LISTED + 1 lines: the popup names what it can
 * and says "and N more" for the rest, so the query stays small however busy
 * the day was.
 */
async function handleGET(req, auth) {
  try {
    await connect();

    const now = Date.now();
    const window = istDayWindow(now);

    const invoices = await Invoice.find(
      {
        orderDate: { $gte: window.from, $lt: window.to },
        type: { $in: ORDER_TYPES },
        return: { $ne: true },
      },
      { invoiceNo: 1, type: 1, orderNo: 1, orderDate: 1, finalAmount: 1, "customer.name": 1 }
    )
      .sort({ invoiceNo: -1 })
      // One more than the popup lists, so "and N more" can be worked out
      // without counting the whole day twice.
      .limit(MAX_LISTED + 1)
      .lean();

    // Filtered again through the pure rule. The query narrows; this decides.
    // A document that slipped through the window -- a stray time on the date,
    // say -- is excluded by the same function the popup and the tests use.
    const orders = todaysOrders(invoices, now);

    return NextResponse.json({
      success: true,
      orders: orders.slice(0, MAX_LISTED).map(orderLine),
      // How many more than the popup is naming.
      more: Math.max(0, orders.length - MAX_LISTED),
      count: orders.length,
    });
  } catch (error) {
    console.error("Error reading today's orders:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);
