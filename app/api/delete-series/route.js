import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { connect } from "../../../lib/mongodb";
import Series from "../../../models/seriesModel";
import Production from "../../../models/productionModel";
import Invoice from "../../../models/invoiceModel";
import { kindFilter } from "@/lib/getNextProductionNo";
import { docTypeLabel, normalizeDocType, normalizeSeriesCode } from "@/lib/series.mjs";
import { tenantRoute } from "@/lib/tenantRoute.mjs";

/**
 * Delete a series.
 *
 * REFUSED WHILE DOCUMENTS CARRY IT, like every other master in this app.
 * Documents hold the series by code, so deleting one still in use would leave
 * their Series column naming something that is no longer on the list -- and
 * there would be no way to pick that value on the next document.
 *
 * A firm that has finished with a series should untick Active instead: the
 * documents keep their label and it stops being offered. The refusal says so.
 */

/** Which documents of this type would be orphaned. */
const STOCK_KIND_OF = { PRODUCTION: "FR", GOODS_ISSUED: "IS", GOODS_RECEIVED: "RS" };
// `return`, not `isReturn` -- the field models/invoiceModel.js declares. The
// same table as app/api/series-update/route.js, and scripts/series.test.mjs
// sweeps that the two agree: a series counted as unused here but renamed
// there would be deletable while bills still carry it.
const BILL_OF = {
  SALE_INVOICE: { type: "Sale", return: false },
  PURCHASE_INVOICE: { type: "Purchase", return: false },
  SALE_RETURN: { type: "Sale", return: true },
  PURCHASE_RETURN: { type: "Purchase", return: true },
};

/**
 * How many documents carry this series.
 *
 * Case-insensitively, because the slip field was free text before this master
 * and each one holds whatever was typed onto it. An exact match would report
 * a series as unused and then orphan the slips labelled "mi".
 *
 * Challans, orders and M.R.I. have master entries and no Series box yet, so
 * they have nothing to count -- when one grows a Series field it is added
 * here, and scripts/series.test.mjs sweeps that this table and the one in
 * series-update agree.
 */
const countDocuments = async (docType, code) => {
  const collation = { locale: "en", strength: 2 };
  if (STOCK_KIND_OF[docType]) {
    return Production.countDocuments({
      series: code,
      // An entry written before `kind` existed has none and reads as
      // Production -- lib/getNextProductionNo.js owns that rule.
      ...kindFilter(STOCK_KIND_OF[docType]),
    }).collation(collation);
  }
  if (BILL_OF[docType]) {
    return Invoice.countDocuments({ series: code, ...BILL_OF[docType] }).collation(collation);
  }
  return 0;
};

async function handlePOST(req, auth) {
  try {
    await connect();

    const id = new URL(req.url).searchParams.get("id");

    if (!id) {
      return NextResponse.json({ error: "Id missing in query." }, { status: 400 });
    }
    if (!mongoose.isValidObjectId(id)) {
      return NextResponse.json({ error: "Invalid series id." }, { status: 400 });
    }

    const series = await Series.findById(id);
    if (!series) {
      return NextResponse.json({ error: "Series not found." }, { status: 404 });
    }

    const code = normalizeSeriesCode(series.code);
    const docType = normalizeDocType(series.docType);
    const used = code ? await countDocuments(docType, code) : 0;

    if (used) {
      const what = docTypeLabel(docType).toLowerCase() || "document";
      return NextResponse.json(
        {
          success: false,
          error: `Cannot delete series ${code} because ${used} ${what} document${
            used === 1 ? "" : "s"
          } carry it. Untick Active instead to stop it being offered on new ones.`,
        },
        { status: 409 }
      );
    }

    const deletedSeries = await Series.findByIdAndDelete(id);

    return NextResponse.json({
      success: true,
      message: "Series deleted successfully",
      deletedSeries,
    });
  } catch (error) {
    console.error("Delete Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);
