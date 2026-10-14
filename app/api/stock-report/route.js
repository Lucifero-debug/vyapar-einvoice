import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import Company from "@/models/companyModel";
import Item from "@/models/itemModel";
import Invoice from "@/models/invoiceModel";
import ItemLedger from "@/models/itemLedgerModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { companyFrom } from "@/lib/company.mjs";
import { formatOf, isReportFormat, reportResponse } from "@/lib/reportHttp.js";
import { isPreset, istIso, resolvePeriod } from "@/lib/reportPeriods.mjs";
import { buildStockIndex } from "@/lib/itemStock.mjs";
import { STOCK_REASONS } from "@/lib/dashboard.mjs";
import {
  DEFAULT_AGING_SLABS,
  DEFAULT_BASIS,
  DEFAULT_FILTER,
  STOCK_REPORTS,
  VALUATION_BASES,
  agingColumns,
  agingOf,
  agingTotals,
  applyFilter,
  basisProblem,
  dayBook,
  dayBookTotals,
  isStockFilter,
  isStockReport,
  lastPurchaseRates,
  reportTakesPeriod,
  sheetTotals,
  shortList,
  shortListSummary,
  slabProblem,
  stockPeriod,
  stockPeriodTotals,
  stockReportName,
  stockSheets,
  valueCoverage,
  valueRows,
  weightedRates,
} from "@/lib/inventory.mjs";

// Every invoice and every stock voucher changes these, so a cached stock
// sheet is a wrong stock sheet -- the same reason /api/financials and
// /api/item-stock say this.
export const dynamic = "force-dynamic";

/**
 * Sigfa's stock reports, from one route.
 *
 *   report    summary | value | short | aging | daybook
 *   preset    one of lib/reportPeriods.mjs's thirteen (the period reports)
 *   from,to   inclusive IST calendar days; required when preset=custom
 *   basis     the valuation basis, for report=value
 *   filter    all | negative | nonzero | moved
 *   slabs     the aging day slabs, comma-separated
 *   item      one item only, for the day book
 *   format    json | csv | xlsx
 *
 * ONE ROUTE SERVES THE SCREEN AND BOTH DOWNLOADS, which is how the rule that
 * a user who cannot see a report cannot download it is made true by
 * construction rather than by a second permission entry somebody has to
 * remember. See the note atop lib/reportHttp.js.
 *
 * The route computes nothing. Every figure comes from lib/inventory.mjs,
 * which in turn defers to lib/itemStock.mjs for the closing quantity,
 * lib/dashboard.mjs for what counts as low and lib/salesReports.mjs for the
 * weighted average rate -- so this route cannot hold a second opinion about
 * any of them.
 *
 * WHAT IS FETCHED, AND WHY IT IS NOT TRIMMED TO THE WINDOW. The stock rows
 * are read in FULL, not filtered to the period, because the Opening Quantity
 * column is everything that happened before `from` -- the same reason
 * /api/account-book fetches a party's whole ledger. The invoices are fetched
 * only for the two valuation bases that need them, and then only their lines.
 */
async function handleGET(req, auth) {
  try {
    await connect();

    const { searchParams } = new URL(req.url);
    const report = (searchParams.get("report") || "summary").trim();
    const preset = (searchParams.get("preset") || "thisFy").trim();
    const basis = (searchParams.get("basis") || DEFAULT_BASIS).trim();
    const filter = (searchParams.get("filter") || DEFAULT_FILTER).trim();
    const item = (searchParams.get("item") || "").trim();
    const format = formatOf(searchParams);

    if (!isStockReport(report)) {
      return NextResponse.json(
        { success: false, error: `"${report}" is not a stock report.` },
        { status: 400 }
      );
    }
    if (!isReportFormat(format)) {
      return NextResponse.json(
        { success: false, error: `"${format}" is not a format. Use json, csv or xlsx.` },
        { status: 400 }
      );
    }
    if (!isStockFilter(filter)) {
      return NextResponse.json(
        { success: false, error: `"${filter}" is not a filter.` },
        { status: 400 }
      );
    }
    // Validated rather than quietly defaulted: a preset this build does not
    // know means the caller and the server disagree about which period they
    // are discussing.
    if (!isPreset(preset)) {
      return NextResponse.json({ success: false, error: `"${preset}" is not a period.` }, { status: 400 });
    }

    const slabsParam = (searchParams.get("slabs") || "").trim();
    const slabs = slabsParam
      ? slabsParam.split(",").map((s) => Number(s.trim()))
      : DEFAULT_AGING_SLABS;
    if (report === "aging") {
      const bad = slabProblem(slabs);
      if (bad) return NextResponse.json({ success: false, error: bad }, { status: 400 });
    }
    if (report === "value") {
      const bad = basisProblem(basis);
      // 400, not a silent fall back to the cost price: a sheet headed FIFO
      // that was valued some other way is the one mistake in this module that
      // would be carried into a balance sheet.
      if (bad) return NextResponse.json({ success: false, error: bad }, { status: 400 });
    }

    const period = resolvePeriod({
      preset,
      from: searchParams.get("from") || "",
      to: searchParams.get("to") || "",
    });

    // A level is compared against stock as it stands, and the ageing against
    // what is on the shelf today -- neither takes a period, so those two
    // reports are headed "As on" instead.
    const takesPeriod = reportTakesPeriod(report);
    const asOf = takesPeriod ? period.to : istIso(Date.now());

    const [companyDoc, items, rows] = await Promise.all([
      Company.findOne({}).lean(),
      Item.find(
        {},
        {
          name: 1,
          unit: 1,
          hsn: 1,
          group: 1,
          openingQuantity: 1,
          minQuantity: 1,
          reorderLevel: 1,
          maxLevel: 1,
          cost: 1,
          purchasePrice: 1,
          mrp: 1,
        }
      ).lean(),
      ItemLedger.find(
        {},
        { itemName: 1, date: 1, invoiceNo: 1, typeOfVoucher: 1, partyName: 1, receiptQuantity: 1, issueQuantity: 1 }
      ).lean(),
    ]);

    const company = companyFrom(companyDoc);

    let built = [];
    let totals = null;
    let extra = {};

    if (report === "summary") {
      built = applyFilter(stockPeriod({ items, rows, from: period.from, to: period.to }), filter);
      totals = stockPeriodTotals(built);
    } else if (report === "value") {
      const base = applyFilter(stockPeriod({ items, rows, from: period.from, to: period.to }), filter);
      // Only the two bases that read the bills go near the invoice
      // collection, and then only the lines.
      const needsBills = basis === "weighted" || basis === "lastPurchase";
      const invoices = needsBills
        ? await Invoice.find(
            { type: "Purchase" },
            { type: 1, return: 1, date: 1, invoiceNo: 1, "items.name": 1, "items.quantity": 1, "items.cost": 1, "items.taxableAmount": 1, "items.gstAmount": 1, "items.total": 1 }
          ).lean()
        : [];
      const weighted = basis === "weighted" ? weightedRates({ invoices, upto: period.to }) : null;
      const last = basis === "lastPurchase" ? lastPurchaseRates({ invoices, upto: period.to }) : null;

      built = valueRows({ rows: base, items, basis, weighted, last });
      totals = stockPeriodTotals(built);
      extra = { coverage: valueCoverage(built), basis };
    } else if (report === "short") {
      const stock = buildStockIndex({
        items,
        movements: rows.map((r) => ({
          itemName: r.itemName,
          received: r.receiptQuantity,
          issued: r.issueQuantity,
        })),
      });
      // All five reasons here -- Sigfa's Short List and Under-Over Stock in
      // one sheet. The dashboard tile asks for three; see
      // DASHBOARD_REASONS in lib/dashboard.mjs.
      built = shortList({ items, stock, reasons: STOCK_REASONS });
      extra = { summary: shortListSummary({ items, stock, rows: built }) };
    } else if (report === "aging") {
      built = agingOf({ items, rows, asOf, slabs });
      totals = agingTotals(built, slabs);
      extra = { slabs, columns: agingColumns(slabs) };
    } else if (report === "daybook") {
      built = dayBook({ rows, from: period.from, to: period.to, item });
      totals = dayBookTotals(built);
      extra = { item };
    }

    const payload = {
      success: true,
      report,
      reportName: stockReportName(report),
      reports: STOCK_REPORTS,
      bases: VALUATION_BASES,
      period: takesPeriod ? period : null,
      asOf,
      filter,
      company,
      rows: built,
      totals,
      ...extra,
    };

    return reportResponse({
      format,
      payload,
      sheets: stockSheets({
        report,
        rows: built,
        totals: sheetTotals({ report, rows: built, slabs }),
        from: period.from,
        to: period.to,
        basis,
        filter,
        slabs,
        asOf,
        company,
      }),
      filename: {
        report: `stock-${report}`,
        subject: report === "daybook" ? item : "",
        from: takesPeriod ? period.from : asOf,
        to: takesPeriod ? period.to : asOf,
      },
    });
  } catch (err) {
    console.error("Stock report error:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query above scoped to the caller's
// own firm. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);
