import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import Challan from "@/models/challanModel";
import Invoice from "@/models/invoiceModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { challanStatus, isChallanType, pendingQty } from "@/lib/challanStatus.mjs";

/**
 * One challan, for the form to open or the print to render, with the
 * invoices that have billed it (SIGFA: "Challan Used In Invoice No").
 *
 *   /api/get-challan?type=Sale&challanNo=7
 */
async function handleGET(req) {
  try {
    await connect();
    const url = new URL(req.url);
    const challanNo = Number(url.searchParams.get("challanNo"));
    const type = String(url.searchParams.get("type") || "").trim();
    if (!Number.isInteger(challanNo) || challanNo <= 0 || !isChallanType(type)) {
      return NextResponse.json({ success: false, error: "A challan number and a type are needed." }, { status: 400 });
    }

    const challan = await Challan.findOne({ challanNo, type }).lean();
    if (!challan) {
      return NextResponse.json({ success: false, error: "Challan not found." }, { status: 404 });
    }

    const billing = await Invoice.find(
      { "items.challanNo": challanNo, "items.challanType": type },
      { invoiceNo: 1, date: 1, type: 1, return: 1, "items.challanNo": 1, "items.challanType": 1, "items.quantity": 1 }
    )
      .sort({ invoiceNo: 1 })
      .lean();

    const invoices = billing.map((inv) => ({
      invoiceNo: inv.invoiceNo,
      date: inv.date,
      type: inv.type,
      quantity: (inv.items || [])
        .filter((l) => Number(l.challanNo) === challanNo && l.challanType === type)
        .reduce((t, l) => t + (Number(l.quantity) || 0), 0),
    }));

    return NextResponse.json({
      success: true,
      challan: {
        ...challan,
        status: challanStatus(challan),
        invoices,
        items: (challan.items || []).map((line) => ({ ...line, pending: pendingQty(line) })),
      },
    });
  } catch (err) {
    console.error("Error fetching challan:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export const dynamic = "force-dynamic";
export const GET = tenantRoute(handleGET);
