import { NextResponse } from "next/server";
import { connect } from "../../../lib/mongodb";
import Counter from "../../../models/counterModel";
import Invoice from "../../../models/invoiceModel";
import Series from "@/models/seriesModel";
import { seriesCounterName } from "@/lib/getNextInvoiceNo";
import {
  docTypeForBilling,
  formatDocNo,
  fyStartYear,
  normalizeSeriesCode,
} from "@/lib/series.mjs";
import { tenantRoute } from "@/lib/tenantRoute.mjs";

/**
 * What the next number will probably be — for display on the billing form.
 *
 * Deliberately a PEEK, not a reservation: opening the form and walking away
 * should not burn a number and leave a gap in the book. The numbers are only
 * really claimed when the invoice is saved, and `save-invoice` re-checks them
 * there, so two people opening the form at once no longer collide.
 *
 * It answers with BOTH of a bill's numbers (lib/getNextInvoiceNo.js says why
 * there are two):
 *
 *   invoiceNo   the firm's own sequence — the key, never printed
 *   seriesNo    the running number inside the chosen series and year
 *   voucherNo   what that prints as: "26-27/1"
 *
 * With no series only `invoiceNo` comes back, and the form shows it plain, as
 * it did before series numbering existed.
 *
 * Each read takes the counter as well as the highest document, because a
 * number set by hand on the form can run ahead of the counter.
 */

/** The next number a counter would issue, against what has actually been used. */
const peek = (highest, counter) =>
  Math.max(Number(highest) || 0, Number(counter?.value) || 0) + 1;

async function handleGET(req, auth) {
  try {
    await connect();

    const params = new URL(req.url).searchParams;
    const series = normalizeSeriesCode(params.get("series"));
    // The bill's OWN date decides the financial year, so a bill dated back
    // into March is numbered into that year. Today only when the form has
    // not said, which is the moment before its date box has loaded.
    const finYear = fyStartYear(params.get("date") || new Date());
    // Which document the series must be filed under: a sales-invoice series
    // is not offered on a purchase, so it must not be numbered as one either.
    const docType = docTypeForBilling(params.get("key"));

    const [lastInvoice, counter] = await Promise.all([
      Invoice.findOne({}, { invoiceNo: 1 }).sort({ invoiceNo: -1 }).lean(),
      Counter.findOne({ name: "invoiceNo" }).lean(),
    ]);

    const invoiceNo = peek(lastInvoice?.invoiceNo, counter);

    if (!series || !docType || finYear === null) {
      return NextResponse.json({ invoiceNo, seriesNo: null, voucherNo: "", finYear });
    }

    const [seriesRow, lastInSeries, seriesCounter] = await Promise.all([
      // For `fillLeftSpaceWithZero` only — the padding is the series' own.
      Series.findOne({ code: series, docType }).lean(),
      Invoice.findOne({ series, finYear }, { seriesNo: 1 }).sort({ seriesNo: -1 }).lean(),
      Counter.findOne({ name: seriesCounterName(series, finYear) }).lean(),
    ]);

    // A series the master no longer holds still numbers what it already
    // numbered: the count is the bills', not the master row's, so a series
    // switched off mid-year does not restart if it is picked again.
    const seriesNo = peek(lastInSeries?.seriesNo, seriesCounter);

    return NextResponse.json({
      invoiceNo,
      seriesNo,
      finYear,
      voucherNo: formatDocNo(seriesNo, seriesRow || {}, params.get("date") || new Date()),
    });
  } catch (err) {
    console.error("Error fetching next invoice number:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);
