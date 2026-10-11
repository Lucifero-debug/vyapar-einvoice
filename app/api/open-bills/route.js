import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { billCountsFor, openBillsFor } from "@/lib/openBillsFor.mjs";
import {
  adjustmentSummary,
  emptyReason,
  fifoAllocate,
  nothingToAdjust,
} from "@/lib/billAdjust.mjs";

// Every receipt changes what is outstanding, so a cached list is a wrong one.
export const dynamic = "force-dynamic";

/**
 * A party's unpaid bills, for the "Against Bill" picker.
 *
 *   party     the account name, as the ledger joins on it
 *   type      Sale or Purchase -- which side the money is moving
 *   amount    the line's amount, so the FIFO suggestion can be returned with it
 *   voucher   the voucher being edited, left out of what counts as settled
 *
 * The suggestion is computed here rather than in the browser so the figures
 * the screen offers come from the same code that will check them on save.
 * A picker that offered an allocation the save then refused would be worse
 * than no picker.
 */
async function handleGET(req, auth) {
  try {
    await connect();

    const { searchParams } = new URL(req.url);
    const party = (searchParams.get("party") || "").trim();
    const type = (searchParams.get("type") || "").trim();
    const amount = Number(searchParams.get("amount") || 0);
    const voucher = (searchParams.get("voucher") || "").trim();

    if (!party) {
      return NextResponse.json({ success: false, error: "Pick a party first." }, { status: 400 });
    }
    if (type !== "Sale" && type !== "Purchase") {
      return NextResponse.json(
        { success: false, error: "Enter the amount before choosing bills -- which bills are offered depends on whether money is coming in or going out." },
        { status: 400 }
      );
    }

    const bills = await openBillsFor({
      party,
      type,
      excludeVoucherId: voucher || undefined,
    });

    // The line, as the rules module reads one: a receipt from a customer is a
    // credit to them, a payment to a supplier is a debit.
    const line = type === "Sale" ? { credit: amount } : { debit: amount };
    const suggestion = Number.isFinite(amount) && amount > 0 ? fifoAllocate(line, bills) : [];

    // Only when there is nothing to show. An empty picker has three causes
    // and the commonest -- the amount typed in the wrong column -- looks
    // exactly like the other two unless it is spelled out.
    const counts = bills.length ? null : await billCountsFor({ party, type });

    return NextResponse.json({
      success: true,
      party,
      type,
      bills,
      // Sigfa: "Adjustment on FIFO Basis". Offered, never applied -- the user
      // decides whether oldest-first is what they mean.
      suggestion,
      summary: adjustmentSummary(line, [], bills),
      // Sigfa: "No Pending Bills Found".
      empty: nothingToAdjust(bills),
      reason: counts ? emptyReason({ party, type, bills, counts }) : null,
    });
  } catch (err) {
    console.error("Open bills error:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);
