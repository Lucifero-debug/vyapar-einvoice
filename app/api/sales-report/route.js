import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import Invoice from "@/models/invoiceModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import {
  DEFAULT_GRAIN,
  DEFAULT_SCOPE,
  documentsFor,
  isBookGrain,
  isDocScope,
  isReportSide,
  isSalesView,
  itemTotals,
  itemWise,
  partyTotals,
  partyWise,
  periodTotals,
  periodWise,
  reportName,
  scopeName,
  totalsOf,
  zoomInto,
} from "@/lib/salesReports.mjs";

// Every bill raised changes these, so a cached sheet is a wrong one.
export const dynamic = "force-dynamic";

/**
 * Sigfa's Sales and Purchase module reports.
 *
 *   GET /api/sales-report
 *         ?view=book|party|item
 *         &side=Sale|Purchase
 *         &from=&to=
 *         &scope=invoices|returns|both     (the book and the item sheet)
 *         &grain=month|date|document       (the book)
 *         &month=YYYY-MM                   (the zoom: dates inside a month)
 *
 * One route for all six -- three shapes over two sides -- because they are
 * one body of documents looked at three ways. Three routes would be three
 * places for "what counts as a sale" to drift.
 *
 * THE BOOK IS A PERIOD SUMMARY by default, as Sigfa's is: one row per month,
 * and `grain=date&month=` is its zoom. `grain=document` is the bill-by-bill
 * register. RETURNS SUBTRACT, which is Sigfa's own rule rather than a choice
 * made here, and `scope` is its own selector for isolating them.
 *
 * The arithmetic is all in lib/salesReports.mjs; this fetches and shapes.
 */
async function handleGET(req, auth) {
  try {
    await connect();

    const params = new URL(req.url).searchParams;
    const view = (params.get("view") || "book").trim();
    const side = (params.get("side") || "Sale").trim();
    const from = (params.get("from") || "").trim();
    const to = (params.get("to") || "").trim();
    const scope = (params.get("scope") || DEFAULT_SCOPE).trim();
    const grain = (params.get("grain") || DEFAULT_GRAIN).trim();
    const month = (params.get("month") || "").trim();

    if (!isSalesView(view)) {
      return NextResponse.json(
        { success: false, error: `"${view}" is not one of the sales reports.` },
        { status: 400 }
      );
    }
    if (!isReportSide(side)) {
      return NextResponse.json(
        { success: false, error: `"${side}" is not a side. Expected Sale or Purchase.` },
        { status: 400 }
      );
    }
    if (!isDocScope(scope)) {
      return NextResponse.json(
        { success: false, error: `"${scope}" is not one of the document scopes.` },
        { status: 400 }
      );
    }
    if (!isBookGrain(grain)) {
      return NextResponse.json(
        { success: false, error: `"${grain}" is not one of the book's grains.` },
        { status: 400 }
      );
    }

    // Narrowed in the database on the side, and on the date when one is
    // given, so a firm with years of books does not load all of them to
    // report on one month. The IST day comparison still happens in the
    // module: this is a coarse filter, that one is the rule.
    const filter = { type: side };
    if (from || to) {
      filter.date = {};
      // A day either side, because the stored dates are UTC midnights and the
      // module compares IST calendar days -- an invoice saved late on the
      // 30th is the 1st in UTC. Narrowing exactly here would drop it before
      // the real comparison ever saw it.
      if (from) filter.date.$gte = new Date(`${from}T00:00:00.000Z`);
      if (to) {
        const end = new Date(`${to}T00:00:00.000Z`);
        end.setUTCDate(end.getUTCDate() + 2);
        filter.date.$lt = end;
      }
    }

    const invoices = await Invoice.find(filter, {
      invoiceNo: 1,
      type: 1,
      return: 1,
      date: 1,
      customer: 1,
      stateOfSupply: 1,
      taxType: 1,
      totalAmount: 1,
      gst: 1,
      finalAmount: 1,
      received: 1,
      balanceDue: 1,
      // Only the item-wise sheet reads the lines, and they are the bulk of
      // an invoice's payload.
      ...(view === "item" ? { items: 1 } : {}),
    }).lean();

    const title = reportName(view, side);
    // Sigfa's own name for the chosen scope, so the sheet can print what it
    // covers in the words the client already reads on their old screens.
    const covers = scopeName(scope, side);
    const shell = { success: true, view, side, scope, covers, title };

    if (view === "item") {
      const rows = itemWise({ invoices, side, from, to, scope });
      return NextResponse.json({ ...shell, rows, totals: itemTotals(rows) });
    }

    const documents = documentsFor({ invoices, side, from, to, scope });

    if (view === "party") {
      const rows = partyWise(documents);
      return NextResponse.json({ ...shell, rows, totals: partyTotals(rows) });
    }

    // The book. A period sheet unless the bill-by-bill register was asked
    // for, and the zoom when a month was named.
    if (grain === "document") {
      return NextResponse.json({
        ...shell,
        grain,
        rows: documents,
        totals: totalsOf(documents),
      });
    }

    const rows =
      grain === "date" && month ? zoomInto(documents, month) : periodWise(documents, grain);

    return NextResponse.json({ ...shell, grain, month: month || null, rows, totals: periodTotals(rows) });
  } catch (err) {
    console.error("Sales report error:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);
