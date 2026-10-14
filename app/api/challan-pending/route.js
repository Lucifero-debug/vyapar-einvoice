import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import Challan from "@/models/challanModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { challanStatus, isChallanType, toInvoiceLines } from "@/lib/challanStatus.mjs";

/**
 * The challans a bill could be raised against -- "Pending Challan [Alt+H]".
 *
 *   /api/challan-pending?type=Sale&customer=Acme%20Traders
 *
 * Each comes back already turned into invoice lines (pending quantity, the
 * challan's rate, discount and GST, and the reference back to the challan
 * line), so the billing screen computes nothing.
 */
async function handleGET(req) {
  try {
    await connect();
    const url = new URL(req.url);
    const type = String(url.searchParams.get("type") || "").trim();
    const customer = String(url.searchParams.get("customer") || "").trim();
    if (!isChallanType(type)) {
      return NextResponse.json({ success: false, error: "A type (Sale or Purchase) is needed." }, { status: 400 });
    }

    const query = { type, status: { $in: ["pending", "partial"] } };
    if (customer) query["customer.name"] = customer;

    const challans = await Challan.find(query).sort({ date: 1, challanNo: 1 }).limit(500).lean();

    const rows = challans
      .map((c) => ({
        challanNo: c.challanNo,
        type: c.type,
        date: c.date,
        customer: { name: c.customer?.name || "" },
        stockEffect: Boolean(c.stockEffect),
        status: challanStatus(c),
        lines: toInvoiceLines(c),
      }))
      // Re-checked from the lines, not trusted from the stored status.
      .filter((row) => row.status !== "billed" && row.lines.length);

    return NextResponse.json({ success: true, challans: rows });
  } catch (err) {
    console.error("Error fetching pending challans:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export const dynamic = "force-dynamic";
export const GET = tenantRoute(handleGET);
