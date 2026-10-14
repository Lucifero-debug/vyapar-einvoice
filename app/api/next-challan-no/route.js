import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import { peekNextChallanNo } from "@/lib/getNextChallanNo";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { isChallanType } from "@/lib/challanStatus.mjs";

/**
 * What the next challan number will probably be -- a PEEK, like
 * /api/next-order-no: opening the form must not burn a number.
 *
 *   /api/next-challan-no?type=Sale
 */
async function handleGET(req) {
  try {
    await connect();
    const type = String(new URL(req.url).searchParams.get("type") || "").trim();
    if (!isChallanType(type)) {
      return NextResponse.json({ success: false, error: "A type (Sale or Purchase) is needed." }, { status: 400 });
    }
    return NextResponse.json({ success: true, challanNo: await peekNextChallanNo(type), type });
  } catch (err) {
    console.error("Error fetching next challan number:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export const dynamic = "force-dynamic";
export const GET = tenantRoute(handleGET);
