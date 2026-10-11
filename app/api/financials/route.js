import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import Customer from "@/models/custModel";
import Item from "@/models/itemModel";
import ItemLedger from "@/models/itemLedgerModel";
import Ledger from "@/models/ledgerModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { buildStockIndex } from "@/lib/itemStock.mjs";
import { istDayWindow } from "@/lib/istDate.mjs";
import {
  accountPositions,
  accumulatedProfit,
  balanceSheet,
  profitAndLoss,
  profitDiffers,
  statementWarnings,
  stockValue,
  tradingAccount,
  trialBalance,
} from "@/lib/financials.mjs";

// Every posting changes these, so a cached statement is a wrong statement.
export const dynamic = "force-dynamic";

/**
 * All four financial statements, from one route.
 *
 * They share everything expensive -- the account master, every ledger row, the
 * stock valuation -- and they have to agree with each other: the gross profit
 * the Trading account arrives at is the figure the P&L carries in, and the
 * accumulated profit the Balance Sheet shows is derived from the same
 * positions the Trial Balance foots on. Computing them separately is how two
 * statements come to disagree about one number.
 *
 *   from, to        the period, inclusive, as IST calendar days
 *   closingStock    an override; omitted, it is valued from the item ledger
 *   openingStock    an override; omitted, valued as at `from`
 *   expand          list every account in a collapsed trial-balance group
 *
 * The route computes nothing itself. Everything comes from lib/financials.mjs,
 * so the statements and their tests cannot drift apart.
 */
async function handleGET(req, auth) {
  try {
    await connect();

    const { searchParams } = new URL(req.url);
    const from = searchParams.get("from") || "";
    const to = searchParams.get("to") || "";
    const expand = searchParams.get("expand") === "1";
    const closingOverride = searchParams.get("closingStock");
    const openingOverride = searchParams.get("openingStock");

    // The window's end, as a UTC instant, for the stock movements query. Via
    // istDayWindow so "up to the 31st" means the 31st in Delhi -- the same
    // rule the ledger rows are filtered by.
    const endWindow = to ? istDayWindow(to) : null;
    const startWindow = from ? istDayWindow(from) : null;

    const [accounts, rows, items, movementsToDate, movementsToStart] = await Promise.all([
      Customer.find({}, { name: 1, group: 1, openingBal: 1 }).lean(),
      // Every row up to the end of the window. Trimmed here rather than in the
      // rules module so the whole ledger is not shipped for a one-month
      // statement; `accountPositions` still splits them into before and
      // within, which is what gives each account an opening figure.
      Ledger.find(
        endWindow ? { date: { $lt: endWindow.to } } : {},
        { customerName: 1, date: 1, debit: 1, credit: 1 }
      ).lean(),
      Item.find({}, { name: 1, openingQuantity: 1, unit: 1, cost: 1 }).lean(),
      ItemLedger.aggregate([
        ...(endWindow ? [{ $match: { date: { $lt: endWindow.to } } }] : []),
        {
          $group: {
            _id: "$itemName",
            received: { $sum: "$receiptQuantity" },
            issued: { $sum: "$issueQuantity" },
          },
        },
      ]),
      // The same, as at the START of the window, for the opening stock.
      startWindow
        ? ItemLedger.aggregate([
            { $match: { date: { $lt: startWindow.from } } },
            {
              $group: {
                _id: "$itemName",
                received: { $sum: "$receiptQuantity" },
                issued: { $sum: "$issueQuantity" },
              },
            },
          ])
        : Promise.resolve([]),
    ]);

    const positions = accountPositions({ accounts, rows, from, to });

    const closingValuation = stockValue({
      stock: buildStockIndex({ items, movements: movementsToDate }),
      items,
    });
    const openingValuation = stockValue({
      stock: buildStockIndex({ items, movements: movementsToStart }),
      items,
    });

    // An override is what the firm counted on the floor, and it wins. Blank is
    // not an override -- `Number("")` is 0, which would silently wipe the
    // valuation, so the check is on the string.
    const hasClosing = closingOverride !== null && closingOverride.trim() !== "";
    const hasOpening = openingOverride !== null && openingOverride.trim() !== "";
    const closingStock = hasClosing ? Number(closingOverride) : closingValuation.value;
    const openingStock = hasOpening ? Number(openingOverride) : openingValuation.value;

    if (hasClosing && !Number.isFinite(closingStock)) {
      return NextResponse.json(
        { success: false, error: "That closing stock figure is not a number." },
        { status: 400 }
      );
    }
    if (hasOpening && !Number.isFinite(openingStock)) {
      return NextResponse.json(
        { success: false, error: "That opening stock figure is not a number." },
        { status: 400 }
      );
    }

    const trial = trialBalance(positions, { expand });
    const trading = tradingAccount({ positions, openingStock, closingStock });
    const pl = profitAndLoss({ positions, gross: trading.gross });
    const accumulated = accumulatedProfit({ positions, closingStock });
    const sheet = balanceSheet({ positions, closingStock, profit: accumulated });

    const warnings = statementWarnings({
      positions,
      trial,
      openingStock,
      closingStock,
      periodNet: pl.net,
      accumulated,
    });

    // The valuation's own gaps, which `statementWarnings` cannot see because
    // it is handed a figure rather than the items behind it.
    if (!hasClosing && closingValuation.missingCosts.length) {
      warnings.push(
        `Closing stock valued on ${closingValuation.valued} of ${closingValuation.held} items holding stock. No cost in the item master for: ${closingValuation.missingCosts
          .slice(0, 6)
          .join(", ")}${closingValuation.missingCosts.length > 6 ? ", …" : ""}.`
      );
    }

    return NextResponse.json({
      success: true,
      from: from || null,
      to: to || null,
      positions,
      trial,
      trading,
      pl,
      sheet,
      stock: {
        closing: closingStock,
        opening: openingStock,
        closingOverridden: hasClosing,
        openingOverridden: hasOpening,
        closingValuation,
        openingValuation,
      },
      profit: {
        period: pl.net,
        accumulated,
        differs: profitDiffers(pl.net, accumulated),
      },
      warnings,
    });
  } catch (err) {
    console.error("Financials error:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);
