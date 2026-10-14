import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import Challan from "@/models/challanModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { challanStatus, isChallanType, pendingQty } from "@/lib/challanStatus.mjs";

/**
 * The challan register, and SIGFA's "Pending Challan Book".
 *
 *   /api/challan?type=Sale&status=pending&customer=Acme&from=2026-04-01&to=2026-10-14
 *
 * `status=pending` means anything still to bill -- pending AND part billed --
 * as SIGFA's pending query takes every challan with an unposted line.
 * Each row's status is re-derived from its own lines before it is returned.
 */
async function handleGET(req) {
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
    if (isChallanType(type)) query.type = type;
    if (customer) query["customer.name"] = customer;
    if (status === "pending") query.status = { $in: ["pending", "partial"] };
    else if (["partial", "billed"].includes(status)) query.status = status;
    if (from || to) {
      const bad = [from, to].some((d) => d && Number.isNaN(new Date(d).getTime()));
      if (bad) {
        return NextResponse.json({ success: false, error: "That is not a date." }, { status: 400 });
      }
      query.date = {};
      if (from) query.date.$gte = new Date(from);
      if (to) query.date.$lte = new Date(new Date(to).setHours(23, 59, 59, 999));
    }

    const challans = await Challan.find(query).sort({ date: -1, challanNo: -1 }).limit(limit).lean();

    const rows = challans.map((c) => ({
      ...c,
      status: challanStatus(c),
      pendingCount: (c.items || []).filter((l) => pendingQty(l) > 0).length,
    }));

    return NextResponse.json({ success: true, challans: rows });
  } catch (err) {
    console.error("Error listing challans:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export const dynamic = "force-dynamic";
export const GET = tenantRoute(handleGET);
