import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import Company from "@/models/companyModel";
import Invoice from "@/models/invoiceModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { companyAddress, companyFrom } from "@/lib/company.mjs";
import { formatOf, isReportFormat, reportResponse } from "@/lib/reportHttp.js";
import { gstReturnSheets } from "@/lib/reportSheets.mjs";
import { isIsoDate } from "@/lib/reportQuery.mjs";
import {
  eReturnGaps,
  eReturnProblem,
  gstr1Json,
  gstr1Sheet,
  gstr3Sheet,
  gstr3bSheet,
  isReturnKey,
  jsonFilename,
  returnTitle,
  taxPeriod,
} from "@/lib/gstReturns.mjs";

// A bill raised after a return was built changes it, so a cached one is wrong.
export const dynamic = "force-dynamic";

/**
 * Sigfa's GST returns.
 *
 *   GET /api/gst-return?view=gstr1|gstr3|gstr3b|gstr1-ereturn&from=&to=
 *                       &format=json|csv|xlsx
 *
 * `format` downloads the SAME return the screen shows. GSTR-3 and GSTR-3B are
 * one label-and-figure table each, so they come as CSV or Excel. GSTR-1 is
 * ten tables of different shapes and comes as Excel only -- a CSV holds one
 * table, and its first sheet would be a summary pretending to be the return.
 * The e-return is the portal's JSON and nothing else.
 *
 * One route for all four, because they are one body of documents cut four
 * ways and every figure has to agree across them: the outward tax GSTR-1
 * foots on is the liability GSTR-3 carries in and the 3.1(a) tax 3B reports.
 * Four routes would be four places for that to drift.
 *
 * The e-return returns the portal's JSON plus the filename to save it under;
 * the other three return a sheet of numbered tables. Either way the whole of
 * the arithmetic is in lib/gstReturns.mjs.
 *
 * THE LINES ARE ALWAYS FETCHED here, unlike the sales report: every GST
 * table is filed a rate at a time, and the rate is on the line.
 */
async function handleGET(req, auth) {
  try {
    await connect();

    const params = new URL(req.url).searchParams;
    const view = (params.get("view") || "gstr1").trim();
    const from = (params.get("from") || "").trim();
    const to = (params.get("to") || "").trim();
    const format = formatOf(params);

    if (!isReturnKey(view)) {
      return NextResponse.json(
        { success: false, error: `"${view}" is not one of the GST returns.` },
        { status: 400 }
      );
    }
    if (!isReportFormat(format)) {
      return NextResponse.json(
        { success: false, error: `"${format}" is not a format. Use json, csv or xlsx.` },
        { status: 400 }
      );
    }
    if (format !== "json" && view === "gstr1-ereturn") {
      return NextResponse.json(
        { success: false, error: "The e-return is the portal's JSON. Download it from the screen." },
        { status: 400 }
      );
    }
    if (format === "csv" && view === "gstr1") {
      return NextResponse.json(
        { success: false, error: "GSTR-1 is ten tables; a CSV holds one. Download it as Excel." },
        { status: 400 }
      );
    }
    if (!from || !to) {
      return NextResponse.json(
        { success: false, error: "A return covers a period. Give both dates." },
        { status: 400 }
      );
    }
    // Strict yyyy-mm-dd that exists: "2026-02-30" used to roll into March,
    // and "2026-6-1" passed here only to fail as a 500 in the query.
    if (!isIsoDate(from) || !isIsoDate(to)) {
      return NextResponse.json(
        { success: false, error: `"${!isIsoDate(from) ? from : to}" is not a date (use yyyy-mm-dd).` },
        { status: 400 }
      );
    }
    if (from > to) {
      return NextResponse.json(
        { success: false, error: "The From date is after the To date." },
        { status: 400 }
      );
    }

    // GSTR-1 is outward only; the other two need both sides. Narrowed in the
    // database either way, and on the date -- widened by two days, because
    // the stored dates are UTC midnights while the module compares IST
    // calendar days, and on a return a day out is a period out.
    const outwardOnly = view === "gstr1" || view === "gstr1-ereturn";
    const filter = outwardOnly ? { type: "Sale" } : { type: { $in: ["Sale", "Purchase"] } };
    // Widened on BOTH sides: a document dated just after midnight IST on the
    // first day is stored on the previous UTC day. The module then keeps
    // exactly the IST days asked for (documentsIn).
    const start = new Date(`${from}T00:00:00.000Z`);
    start.setUTCDate(start.getUTCDate() - 1);
    const end = new Date(`${to}T00:00:00.000Z`);
    end.setUTCDate(end.getUTCDate() + 2);
    filter.date = { $gte: start, $lt: end };

    const invoices = await Invoice.find(filter, {
      invoiceNo: 1,
      type: 1,
      return: 1,
      date: 1,
      "customer.name": 1,
      "customer.gstin": 1,
      stateOfSupply: 1,
      stateCode: 1,
      taxType: 1,
      gst: 1,
      totalAmount: 1,
      finalAmount: 1,
      items: 1,
    }).lean();

    const title = returnTitle(view);

    if (view === "gstr1-ereturn") {
      // Scoped by the id on the session, explicitly: `companies` IS the
      // tenant list, so the tenant plugin deliberately does not apply to it.
      // Only the GSTIN is asked for -- it is the one field the upload needs.
      const company = await Company.findById(auth.companyId).select("gstin name").lean();
      const problem = eReturnProblem({ company: company || {}, from, to });
      if (problem) {
        return NextResponse.json({ success: false, error: problem }, { status: 400 });
      }

      const json = gstr1Json({ company, invoices, from, to });
      return NextResponse.json({
        success: true,
        view,
        title,
        period: taxPeriod(from),
        filename: jsonFilename(company, from),
        gaps: eReturnGaps(),
        json,
      });
    }

    const sheet =
      view === "gstr3"
        ? gstr3Sheet({ invoices, from, to })
        : view === "gstr3b"
          ? gstr3bSheet({ invoices, from, to })
          : gstr1Sheet({ invoices, from, to });

    if (format === "json") {
      return NextResponse.json({ success: true, view, title, ...sheet });
    }

    const companyDoc = await Company.findById(auth.companyId).lean();
    const company = companyFrom(companyDoc);
    return reportResponse({
      format,
      sheets: gstReturnSheets({
        view,
        sheet,
        from,
        to,
        company,
        companyAddressLine: companyAddress(company),
      }),
      filename: { report: view, subject: sheet.period, from, to },
    });
  } catch (err) {
    console.error("GST return error:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query above scoped to the caller's
// own firm. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);
