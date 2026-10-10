import { NextResponse } from "next/server";
import { connect } from "../../../lib/mongodb";
import { peekNextOrderNo } from "@/lib/getNextOrderNo";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { isOrderType } from "@/lib/orderStatus.mjs";

/**
 * What the next order number will probably be -- for display on the form.
 *
 *   /api/next-order-no?type=Sale
 *
 * A PEEK, not a reservation, exactly like /api/next-invoice-no: opening the
 * form and walking away must not burn a number and leave a gap in the order
 * book. `order-add` settles it properly, and honours this one if it is still
 * free when the order is saved.
 *
 * Sales and purchase orders number independently, so the type is required.
 */
async function handleGET(req, auth) {
  try {
    await connect();
    const type = String(new URL(req.url).searchParams.get("type") || "").trim();

    if (!isOrderType(type)) {
      return NextResponse.json(
        { error: "A type (Sale or Purchase) is needed." },
        { status: 400 }
      );
    }

    return NextResponse.json({ orderNo: await peekNextOrderNo(type), type });
  } catch (err) {
    console.error("Error fetching next order number:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export const dynamic = "force-dynamic";

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);
