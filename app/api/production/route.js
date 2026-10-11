import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import Production from "@/models/productionModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";

// Stock and costs move under it, so a cached register is a wrong one.
export const dynamic = "force-dynamic";

/**
 * The production register -- Sigfa's Production series list.
 *
 * Optional `from` / `to` on the date, and an optional `item` to show only the
 * entries that produced or consumed one thing. The lines are left out of the
 * list for the same reason the formula list leaves them out: a few hundred
 * entries of a dozen lines each is a lot of payload to draw a table of
 * numbers. get-production returns the full document.
 */
async function handleGET(req, auth) {
  try {
    await connect();

    const { searchParams } = new URL(req.url);
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    const item = (searchParams.get("item") || "").trim();

    const filter = {};

    if (from || to) {
      filter.date = {};
      if (from) {
        const d = new Date(from);
        if (!Number.isNaN(d.getTime())) filter.date.$gte = d;
      }
      if (to) {
        const d = new Date(to);
        // Through the END of the `to` day. Without this an entry dated on the
        // last day of the range falls outside it, which is the off-by-one
        // every date filter in this app has had to learn once.
        if (!Number.isNaN(d.getTime())) {
          d.setHours(23, 59, 59, 999);
          filter.date.$lte = d;
        }
      }
      if (!Object.keys(filter.date).length) delete filter.date;
    }

    if (item) {
      // Either side: an entry that made it, or one that consumed it.
      filter.$or = [{ outputItem: item }, { "lines.itemName": item }];
    }

    const entries = await Production.find(filter, {
      docNo: 1,
      date: 1,
      bomName: 1,
      outputItem: 1,
      outputQuantity: 1,
      outputUnit: 1,
      partyName: 1,
      netCost: 1,
      costPerUnit: 1,
      missingCosts: 1,
      remarks: 1,
      lines: 1,
    })
      .sort({ date: -1, docNo: -1 })
      .lean();

    const list = entries.map((entry) => ({
      ...entry,
      lineCount: (entry.lines || []).length,
      // Dropped after counting -- the register shows a count, not the lines.
      lines: undefined,
    }));

    return NextResponse.json({ success: true, productions: list });
  } catch (err) {
    console.error("Production list error:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);
