import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import Company from "@/models/companyModel";
import Item from "@/models/itemModel";
import ItemLedger from "@/models/itemLedgerModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { istDayWindow } from "@/lib/istDate.mjs";
import { companyFrom } from "@/lib/company.mjs";
import { formatOf, isReportFormat, reportResponse } from "@/lib/reportHttp.js";
import { isIsoDate, MAX_TEXT } from "@/lib/reportQuery.mjs";
import {
  COSTING_METHOD,
  MOVEMENT_TYPE_KEYS,
  MOVEMENT_TYPES,
  SUMMARY_STATUSES,
  inventorySheets,
  movementRows,
  movementTotals,
  stockSummaryRows,
  stockSummaryTotals,
  valuationRows,
} from "@/lib/inventoryReports.mjs";

export const dynamic = "force-dynamic";

/**
 * The inventory reports.
 *
 *   GET /api/stock-report
 *         ?view=summary|movements|valuation
 *         &from=&to=            IST calendar days; valuation is as at `to`
 *         &item=                one item, by its exact name (movements)
 *         &type=                a movement type (lib/inventoryReports.mjs)
 *         &ref=                 document number, or part of one
 *         &q=                   search: item, party, document, HSN, group
 *         &status=              summary: all|low|negative|out|below|in-stock
 *         &page=&size=          movements on screen only; exports are whole
 *         &format=json|csv|xlsx
 *
 * Every figure is the stock ledger summed (lib/itemStock.mjs) -- the number
 * the dashboard, the billing screens and the financial statements use -- and
 * the arithmetic is all in lib/inventoryReports.mjs. This route only fetches.
 * Read-only: nothing here writes.
 */

/** Movements read for one report, at most. A range wider than this is narrowed, not truncated. */
const MAX_MOVEMENTS = 20000;

const groupMoves = (match) => [
  ...(match ? [{ $match: match }] : []),
  { $group: { _id: "$itemName", received: { $sum: "$receiptQuantity" }, issued: { $sum: "$issueQuantity" } } },
];

const bad = (error) => NextResponse.json({ success: false, error }, { status: 400 });

async function handleGET(req, auth) {
  try {
    const params = new URL(req.url).searchParams;
    const get = (k) => (params.get(k) || "").trim();
    const view = get("view") || "summary";
    const from = get("from");
    const to = get("to");
    const item = get("item");
    const type = get("type");
    const ref = get("ref");
    const q = get("q");
    const status = get("status") || "all";
    const format = formatOf(params);

    if (!["summary", "movements", "valuation"].includes(view)) return bad(`"${view}" is not one of the stock reports.`);
    if (!isReportFormat(format)) return bad(`"${format}" is not a format. Use json, csv or xlsx.`);
    for (const [label, value] of [["from", from], ["to", to]]) {
      if (value && !isIsoDate(value)) return bad(`"${value}" is not a date (${label}).`);
    }
    if (from && to && from > to) return bad("The From date is after the To date.");
    if (type && !MOVEMENT_TYPE_KEYS.includes(type)) return bad(`"${type}" is not a movement type.`);
    if (!SUMMARY_STATUSES.includes(status)) return bad(`"${status}" is not a stock status.`);
    for (const value of [item, ref, q]) if (value.length > MAX_TEXT) return bad("That search is too long.");

    await connect();

    // IST day boundaries, as every report in the app uses them.
    const start = from ? istDayWindow(from).from : null;
    const end = to ? istDayWindow(to).to : null;

    const items = await Item.find(
      {},
      { name: 1, unit: 1, hsn: 1, group: 1, openingQuantity: 1, minQuantity: 1, isService: 1, cost: 1 }
    ).lean();

    let payload;
    let sheetRows;
    let sheetTotals;

    if (view === "valuation") {
      const movements = await ItemLedger.aggregate(groupMoves(end ? { date: { $lt: end } } : null));
      const { rows, totals } = valuationRows({ items, movements, q });
      payload = { success: true, view, asAt: to || null, method: COSTING_METHOD, rows, totals };
      sheetRows = rows;
      sheetTotals = totals;
    } else if (view === "summary") {
      const [before, inside] = await Promise.all([
        start ? ItemLedger.aggregate(groupMoves({ date: { $lt: start } })) : Promise.resolve([]),
        ItemLedger.aggregate(
          groupMoves(
            start || end
              ? { date: { ...(start ? { $gte: start } : {}), ...(end ? { $lt: end } : {}) } }
              : null
          )
        ),
      ]);
      const rows = stockSummaryRows({ items, before, inside, q, status });
      payload = { success: true, view, from: from || null, to: to || null, rows, totals: stockSummaryTotals(rows) };
      sheetRows = rows;
      sheetTotals = payload.totals;
    } else {
      // Movements. The opening for each item is everything before the window,
      // summed in the database; only the window's own rows are read.
      const scope = item ? { itemName: item } : {};
      const window = start || end ? { date: { ...(start ? { $gte: start } : {}), ...(end ? { $lt: end } : {}) } } : {};
      const [before, rows] = await Promise.all([
        start ? ItemLedger.aggregate(groupMoves({ ...scope, date: { $lt: start } })) : Promise.resolve([]),
        ItemLedger.find(
          { ...scope, ...window },
          { date: 1, itemName: 1, invoiceNo: 1, typeOfVoucher: 1, partyName: 1, receiptQuantity: 1, issueQuantity: 1 }
        )
          .sort({ date: 1, _id: 1 })
          .limit(MAX_MOVEMENTS + 1)
          .lean(),
      ]);
      if (rows.length > MAX_MOVEMENTS) {
        return bad(
          `More than ${MAX_MOVEMENTS.toLocaleString("en-IN")} movements in this range. Narrow the dates or choose an item.`
        );
      }
      const all = movementRows({ items, before, rows, from, to, type, ref, q });
      const totals = movementTotals(all);
      const size = Math.min(500, Math.max(1, Number(params.get("size")) || 100));
      const pages = Math.max(1, Math.ceil(all.length / size));
      const page = Math.min(pages, Math.max(1, Number(params.get("page")) || 1));
      payload = {
        success: true,
        view,
        from: from || null,
        to: to || null,
        types: MOVEMENT_TYPES,
        // The screen pages through; the download is handed every row.
        rows: format === "json" ? all.slice((page - 1) * size, page * size) : all,
        page,
        pages,
        size,
        totals,
      };
      sheetRows = all;
      sheetTotals = totals;
    }

    if (format === "json") return NextResponse.json(payload);

    const companyDoc = await Company.findById(auth.companyId).lean();
    return reportResponse({
      format,
      payload,
      sheets: inventorySheets({
        view,
        rows: sheetRows,
        totals: sheetTotals,
        from,
        to,
        company: companyFrom(companyDoc),
        filters: {
          Item: item,
          Type: type ? MOVEMENT_TYPES[type] : "",
          Document: ref,
          Search: q,
          Status: status !== "all" ? status : "",
        },
      }),
      filename: { report: `stock-${view}`, subject: item, from, to },
    });
  } catch (err) {
    console.error("Stock report error:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query scoped to the caller's own
// firm by the tenant plugin. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);
