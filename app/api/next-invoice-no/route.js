import { NextResponse } from "next/server";
import { connect } from "../../../lib/mongodb";
import Counter from "../../../models/counterModel";
import Invoice from "../../../models/invoiceModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";

/**
 * What the next invoice number will probably be — for display on the form.
 *
 * Deliberately a PEEK, not a reservation: opening the form and walking away
 * should not burn a number and leave a gap in the book. The number is only
 * really claimed when the invoice is saved, and `save-invoice` re-checks it
 * there, so two people opening the form at once no longer collide.
 *
 * It reads the counter as well as the highest invoice, because a number set by
 * hand on the form can run ahead of the counter.
 */
async function handleGET(req, auth) {
  try {
    await connect();

    const [lastInvoice, counter] = await Promise.all([
      Invoice.findOne({}, { invoiceNo: 1 }).sort({ invoiceNo: -1 }).lean(),
      Counter.findOne({ name: "invoiceNo" }).lean(),
    ]);

    const highest = Math.max(
      Number(lastInvoice?.invoiceNo) || 0,
      Number(counter?.value) || 0
    );

    return NextResponse.json({ invoiceNo: highest + 1 });
  } catch (err) {
    console.error("Error fetching next invoice number:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);
