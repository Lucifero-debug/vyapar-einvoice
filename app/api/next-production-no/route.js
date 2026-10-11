import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import { peekNextProductionNo } from "@/lib/getNextProductionNo";
import { isStockKind, kindOf } from "@/lib/stockVoucher.mjs";
import { tenantRoute } from "@/lib/tenantRoute.mjs";

export const dynamic = "force-dynamic";

/**
 * What the next production number will probably be.
 *
 * A PEEK, like next-invoice-no and next-order-no: opening the form and walking
 * away must not burn a number and leave a gap in the register. The real number
 * is settled inside production-add's transaction, which is also what makes two
 * people opening the form at once safe.
 */
async function handleGET(req, auth) {
  try {
    await connect();

    // Each kind has its own series, so the peek has to be told which one --
    // otherwise the goods-issue form opens showing the next PRODUCTION
    // number, and the first save silently corrects it to something else.
    const asked = new URL(req.url).searchParams.get("kind");
    if (asked && !isStockKind(asked)) {
      return NextResponse.json(
        { success: false, error: `"${asked}" is not a stock voucher kind.` },
        { status: 400 }
      );
    }
    const kind = kindOf(asked);

    return NextResponse.json({
      success: true,
      kind,
      docNo: await peekNextProductionNo(kind),
    });
  } catch (err) {
    console.error("Next production no error:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);
