import { NextResponse } from "next/server";
import { connect } from "../../../lib/mongodb";
import Order from "@/models/orderModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import {
  isOrderType,
  orderStatus,
  pendingValue,
  pendingQty,
} from "@/lib/orderStatus.mjs";

/**
 * The order register: a list, filtered.
 *
 *   /api/order?type=Sale&status=open&from=2026-04-01&to=2026-10-10&customer=Acme
 *
 * `status` filters on the STORED column, which exists only so this query can
 * run in the database instead of loading every order. Each row that comes
 * back is then re-derived from its own lines before being returned, so a
 * stored status that has somehow drifted shows the truth on screen rather
 * than the column -- the same belt-and-braces the today's-orders route uses.
 */
async function handleGET(req, auth) {
  try {
    await connect();
    const url = new URL(req.url);

    const type = String(url.searchParams.get("type") || "").trim();
    const status = String(url.searchParams.get("status") || "").trim();
    const customer = String(url.searchParams.get("customer") || "").trim();
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const limit = Math.min(Number(url.searchParams.get("limit")) || 200, 500);

    const query = {};
    if (isOrderType(type)) query.type = type;
    if (customer) query["customer.name"] = customer;

    // "open" on the screen means anything still owing something, which is two
    // stored statuses. Asking for one and getting only half the outstanding
    // orders is the kind of wrong that looks like missing data.
    if (status === "open") query.status = { $in: ["open", "partial"] };
    else if (status) query.status = status;

    if (from || to) {
      query.date = {};
      if (from) query.date.$gte = new Date(from);
      // Inclusive of the end day: a date picker sends midnight, so $lte on the
      // raw value would drop everything dated that day.
      if (to) query.date.$lte = new Date(new Date(to).setHours(23, 59, 59, 999));
    }

    const orders = await Order.find(query)
      .sort({ date: -1, orderNo: -1 })
      .limit(limit)
      .lean();

    const rows = orders.map((order) => ({
      ...order,
      status: orderStatus(order),
      pendingValue: pendingValue(order),
      pendingCount: (order.items || []).filter((l) => pendingQty(l) > 0).length,
    }));

    return NextResponse.json({ success: true, orders: rows });
  } catch (err) {
    console.error("Error listing orders:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export const dynamic = "force-dynamic";

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);
