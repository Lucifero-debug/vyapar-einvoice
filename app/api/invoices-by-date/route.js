import { NextResponse } from "next/server";
import { connect } from "../../../lib/mongodb";
import Invoice from "../../../models/invoiceModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";

export const dynamic = "force-dynamic";

// A print run this size is already hundreds of pages; beyond it the browser
// struggles to lay the batch out at all.
const MAX_INVOICES = 500;

const TYPES = {
  sale: { type: "Sale", return: false },
  purchase: { type: "Purchase", return: false },
  salereturn: { type: "Sale", return: true },
  purchasereturn: { type: "Purchase", return: true },
};

const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");

/**
 * Invoices dated from..to inclusive, oldest first.
 *   GET /api/invoices-by-date?from=2026-04-01&to=2026-04-30&type=sale
 * Dates are stored as UTC midnight of the chosen day (see the invoice forms),
 * so the range runs from `from` 00:00 UTC up to, not including, the day after `to`.
 */
async function handleGET(req, auth) {
  try {
    const params = new URL(req.url).searchParams;
    const from = params.get("from");
    const to = params.get("to");
    const type = params.get("type") || "all";

    if (!isDay(from) || !isDay(to)) {
      return NextResponse.json({ success: false, error: "Valid from and to dates are required" }, { status: 400 });
    }
    if (from > to) {
      return NextResponse.json({ success: false, error: "From date is after the To date" }, { status: 400 });
    }
    if (type !== "all" && !TYPES[type]) {
      return NextResponse.json({ success: false, error: `Unknown invoice type: ${type}` }, { status: 400 });
    }

    const end = new Date(`${to}T00:00:00.000Z`);
    end.setUTCDate(end.getUTCDate() + 1);

    const filter = { date: { $gte: new Date(`${from}T00:00:00.000Z`), $lt: end } };
    if (type !== "all") {
      filter.type = TYPES[type].type;
      // Older rows may lack the flag entirely; treat that as "not a return".
      filter.return = TYPES[type].return ? true : { $ne: true };
    }

    await connect();
    const total = await Invoice.countDocuments(filter);
    const invoices = await Invoice.find(filter)
      .sort({ date: 1, invoiceNo: 1 })
      .limit(MAX_INVOICES)
      .lean();

    return NextResponse.json({ success: true, total, invoices });
  } catch (error) {
    console.error("Error fetching invoices by date:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);
