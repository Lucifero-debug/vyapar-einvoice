import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import Customer from "@/models/custModel";
import Invoice from "@/models/invoiceModel";
import Item from "@/models/itemModel";
import ItemLedger from "@/models/itemLedgerModel";
import Voucher from "@/models/voucherModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { buildStockIndex } from "@/lib/itemStock.mjs";
import { documentsFor } from "@/lib/salesReports.mjs";
import {
  comparisonRows,
  filterParties,
  grainFor,
  isPartySide,
  isPreset,
  lowStockRows,
  movedInPeriod,
  onSide,
  paginate,
  periodFigures,
  periodProblem,
  partyRows,
  partySummary,
  previousPeriod,
  resolvePeriod,
  stockSummary,
  trendMetrics,
  trendSeries,
  vouchersIn,
} from "@/lib/dashboard.mjs";

// Every bill, voucher and movement changes these, so a cached dashboard is a
// wrong dashboard.
export const dynamic = "force-dynamic";

/**
 * The owner's dashboard, from one route.
 *
 *   GET /api/analytics
 *         ?preset=today|last7|last30|thisMonth|prevMonth|thisFy|custom
 *         &from=&to=            (with preset=custom)
 *         &grain=day|week|month (the chart; defaulted from the period)
 *         &side=receivable|payable   (which party table to page)
 *         &search=&sort=&page=&size=
 *
 * ONE ROUTE, because the sections have to agree with each other: the net
 * sales on the card is the net sales the chart bars add up to, and the
 * receivables total is the sum of the rows under it. Separate routes would be
 * separate chances for the card and the table to disagree.
 *
 * THE ARITHMETIC IS ALL IN lib/dashboard.mjs, which in turn defers to the
 * existing authoritative sources -- lib/salesReports.mjs for what counts as a
 * sale, `Customer.lastBal` for balances, lib/itemStock.mjs for stock. This
 * route fetches and shapes.
 *
 * WHAT IS AGGREGATED IN THE DATABASE, AND WHY
 * -------------------------------------------
 * The stock ledger is the biggest collection in the app, so its movements are
 * summed with one `$group` -- the same aggregation /api/item-stock uses -- and
 * never row by row per item. The invoices are fetched for the period only,
 * projected down to the columns the figures need, and the lines are left out
 * entirely: no dashboard figure reads an invoice line.
 */
async function handleGET(req, auth) {
  try {
    await connect();

    const params = new URL(req.url).searchParams;
    const preset = (params.get("preset") || "thisMonth").trim();
    const askedFrom = (params.get("from") || "").trim();
    const askedTo = (params.get("to") || "").trim();
    const grain = (params.get("grain") || "").trim();
    const side = (params.get("side") || "receivable").trim();
    const search = (params.get("search") || "").trim();
    const sort = (params.get("sort") || "amount").trim();
    const page = Number(params.get("page") || 1);
    const size = Number(params.get("size") || 20);

    if (!isPreset(preset)) {
      return NextResponse.json(
        { success: false, error: `"${preset}" is not one of the periods.` },
        { status: 400 }
      );
    }
    if (!isPartySide(side)) {
      return NextResponse.json(
        { success: false, error: `"${side}" is not a party side.` },
        { status: 400 }
      );
    }

    const period = resolvePeriod({ preset, from: askedFrom, to: askedTo });
    const problem = periodProblem(period);
    if (problem) {
      return NextResponse.json({ success: false, error: problem }, { status: 400 });
    }

    const previous = previousPeriod(period);
    // One query wide enough for both windows, rather than two. Widened by two
    // days at each edge because the stored dates are UTC midnights while
    // every comparison is of IST calendar days.
    const earliest = previous ? previous.from : period.from;
    const windowStart = new Date(`${earliest}T00:00:00.000Z`);
    windowStart.setUTCDate(windowStart.getUTCDate() - 1);
    const windowEnd = new Date(`${period.to}T00:00:00.000Z`);
    windowEnd.setUTCDate(windowEnd.getUTCDate() + 2);
    const dateWindow = { $gte: windowStart, $lt: windowEnd };

    const [invoices, vouchers, customers, items, movements] = await Promise.all([
      // No `items` projection: nothing on this dashboard reads an invoice
      // line, and the lines are the bulk of an invoice.
      Invoice.find(
        { date: dateWindow },
        {
          invoiceNo: 1,
          type: 1,
          return: 1,
          date: 1,
          "customer.name": 1,
          "customer.gstin": 1,
          stateOfSupply: 1,
          taxType: 1,
          gst: 1,
          totalAmount: 1,
          finalAmount: 1,
          received: 1,
          balanceDue: 1,
        }
      ).lean(),
      Voucher.find({ date: dateWindow }, { date: 1, acName: 1, customers: 1 }).lean(),
      Customer.find(
        {},
        { name: 1, group: 1, city: 1, phone: 1, lastBal: 1, lastMode: 1 }
      ).lean(),
      Item.find({}, { name: 1, unit: 1, hsn: 1, openingQuantity: 1, minQuantity: 1 }).lean(),
      // The one aggregation that matters for cost: the stock ledger summed in
      // the database, as /api/item-stock does it.
      ItemLedger.aggregate([
        {
          $group: {
            _id: "$itemName",
            received: { $sum: "$receiptQuantity" },
            issued: { $sum: "$issueQuantity" },
          },
        },
      ]),
    ]);

    /* ── sales and purchases ───────────────────────────────────── */

    const saleRows = documentsFor({ invoices, side: "Sale", from: period.from, to: period.to });
    const purchaseRows = documentsFor({
      invoices,
      side: "Purchase",
      from: period.from,
      to: period.to,
    });

    const chartGrain = grain || grainFor(period);

    /* ── parties ───────────────────────────────────────────────── */

    const receivable = partyRows({ customers, side: "receivable" });
    const payable = partyRows({ customers, side: "payable" });

    const customerNames = new Set(
      customers.filter((c) => onSide(c, "receivable")).map((c) => String(c?.name ?? "").trim())
    );
    const supplierNames = new Set(
      customers.filter((c) => onSide(c, "payable")).map((c) => String(c?.name ?? "").trim())
    );

    const periodVouchers = vouchersIn({ vouchers, ...period });
    const collected = movedInPeriod({
      vouchers: periodVouchers,
      parties: customerNames,
      side: "receivable",
    });
    const paid = movedInPeriod({
      vouchers: periodVouchers,
      parties: supplierNames,
      side: "payable",
    });

    // The side being paged; both totals are always returned, because both
    // cards are on screen at once.
    const chosen = side === "payable" ? payable : receivable;

    /* ── stock ─────────────────────────────────────────────────── */

    const stock = buildStockIndex({ items, movements });
    const lowStock = lowStockRows({ stock, items });

    /* ── the comparison ────────────────────────────────────────── */

    const current = periodFigures({
      invoices,
      vouchers: periodVouchers,
      customerNames,
      supplierNames,
      from: period.from,
      to: period.to,
    });

    const before = previous
      ? periodFigures({
          invoices,
          vouchers: vouchersIn({ vouchers, ...previous }),
          customerNames,
          supplierNames,
          from: previous.from,
          to: previous.to,
        })
      : {};

    return NextResponse.json({
      success: true,
      period,
      previous,
      grain: chartGrain,
      sales: {
        metrics: trendMetrics(saleRows),
        series: trendSeries({ rows: saleRows, from: period.from, to: period.to, grain: chartGrain }),
      },
      purchases: { metrics: trendMetrics(purchaseRows) },
      receivables: {
        ...partySummary({ ...receivable, collected }),
        ...paginate(filterParties({ rows: receivable.rows, search, sort }), page, size),
      },
      payables: {
        ...partySummary({ ...payable, collected: paid }),
        ...paginate(filterParties({ rows: payable.rows, search, sort }), page, size),
      },
      side,
      sideCount: chosen.rows.length,
      stock: { ...stockSummary({ rows: lowStock, stock, items }), rows: lowStock.slice(0, 50) },
      comparison: comparisonRows({ current, previous: before }),
    });
  } catch (err) {
    console.error("Analytics error:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query above scoped to the caller's
// own firm. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);
