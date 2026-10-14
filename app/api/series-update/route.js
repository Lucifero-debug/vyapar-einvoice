import mongoose from "mongoose";
import { NextResponse } from "next/server";
import Series from "../../../models/seriesModel";
import Production from "../../../models/productionModel";
import Invoice from "../../../models/invoiceModel";
import { kindFilter } from "@/lib/getNextProductionNo";
import {
  docTypeLabel,
  normalizeDocType,
  normalizeSeries,
  normalizeSeriesCode,
  sameSeries,
  seriesProblems,
} from "@/lib/series.mjs";
import { withTransaction, AbortTransaction } from "@/lib/withTransaction.mjs";
import { tenantRoute } from "@/lib/tenantRoute.mjs";

/**
 * Alter a series.
 *
 * THE WHOLE RECORD COMES BACK. `normalizeSeries` fills every field of a
 * series from the body, so a dialog that posted only the few boxes it shows
 * would clear the rest -- which is the contract lib/masterActions.mjs upholds
 * for every master here, and why `alterPayload` loads the stored record and
 * posts it with the edits over it. scripts/series.test.mjs sweeps that the
 * payload produces every field in SERIES_FIELDS, which is the guard that
 * matters now that this route names no field individually.
 *
 * THE RENAME CASCADES. Documents carry the series by code, not by reference,
 * like every other join in this app. A renamed series whose documents kept
 * the old code would leave their Series column pointing at nothing, so the
 * rename and the cascade commit together or neither does.
 */

/**
 * Where the documents of a type live, for the cascade.
 *
 * Only the kinds that actually carry a series today: the three slips and the
 * four bills. Challans, orders and M.R.I. have master entries and no Series
 * box yet, so there is nothing of theirs to rename -- and an empty entry here
 * is better than a query against a field that does not exist.
 */
const STOCK_KIND_OF = { PRODUCTION: "FR", GOODS_ISSUED: "IS", GOODS_RECEIVED: "RS" };
// `return`, not `isReturn`: that is the field models/invoiceModel.js declares,
// and matching on a name the schema does not have would quietly select every
// bill of the type -- so renaming a sales-invoice series would relabel the
// sales returns with it.
const BILL_OF = {
  SALE_INVOICE: { type: "Sale", return: false },
  PURCHASE_INVOICE: { type: "Purchase", return: false },
  SALE_RETURN: { type: "Sale", return: true },
  PURCHASE_RETURN: { type: "Purchase", return: true },
};

/** The model and filter naming every document of this type. */
const documentsOf = (docType, code) => {
  if (STOCK_KIND_OF[docType]) {
    // `kindFilter` rather than `{ kind }`: an entry written before the kind
    // existed has none and reads as Production, so a plain match would miss
    // exactly the oldest rows. lib/getNextProductionNo.js owns that rule.
    return { Model: Production, filter: { series: code, ...kindFilter(STOCK_KIND_OF[docType]) } };
  }
  if (BILL_OF[docType]) {
    return { Model: Invoice, filter: { series: code, ...BILL_OF[docType] } };
  }
  return null;
};

async function handlePOST(req, auth) {
  try {
    const body = await req.json();
    const id = body.id || body._id;

    if (!mongoose.isValidObjectId(id)) {
      return NextResponse.json({ success: false, error: "Invalid series id." }, { status: 400 });
    }

    const draft = normalizeSeries(body);

    const problems = seriesProblems({ ...draft, docType: body.docType });
    if (problems.length) {
      return NextResponse.json({ success: false, error: problems[0] }, { status: 400 });
    }

    const series = await withTransaction(async (session) => {
      const existing = await Series.findById(id).session(session);
      if (!existing) {
        throw new AbortTransaction({ success: false, error: "Series not found." }, 404);
      }

      const previousCode = normalizeSeriesCode(existing.code);
      const previousDocType = normalizeDocType(existing.docType);
      const renamed = !sameSeries(previousCode, draft.code);

      // Left out of its own comparison, or re-saving a series without
      // touching its code would report a clash with itself.
      const clash = await Series.findOne({
        code: draft.code,
        docType: draft.docType,
        _id: { $ne: id },
      })
        .collation({ locale: "en", strength: 2 })
        .session(session)
        .lean();

      if (clash) {
        throw new AbortTransaction(
          {
            success: false,
            error: `Series ${draft.code} already exists for ${docTypeLabel(draft.docType)}.`,
          },
          409
        );
      }

      // One default per document -- and the OLD document is cleared too, since
      // moving the default series from one document to another must not leave
      // two rows both claiming it.
      if (draft.isDefault) {
        await Series.updateMany(
          {
            docType: { $in: [...new Set([draft.docType, previousDocType].filter(Boolean))] },
            isDefault: true,
            _id: { $ne: id },
          },
          { $set: { isDefault: false } },
          { session }
        );
      }

      existing.set(draft);
      await existing.save({ session });

      // The documents follow the master, under the type they were written
      // under -- not the new one, which is where they would not be found.
      // Matched case-insensitively because the slip field was free text
      // before this master existed and holds whatever was typed.
      if (renamed && previousCode) {
        const target = documentsOf(previousDocType, previousCode);
        if (target) {
          await target.Model.updateMany(
            target.filter,
            { $set: { series: draft.code } },
            { session, collation: { locale: "en", strength: 2 } }
          );
        }
      }

      return existing;
    });

    return NextResponse.json({ success: true, series });
  } catch (error) {
    if (error instanceof AbortTransaction) {
      return NextResponse.json(error.payload, { status: error.status });
    }
    console.error("Error updating series:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);
