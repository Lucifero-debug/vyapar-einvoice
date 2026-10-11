import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import ItemLedger from "@/models/itemLedgerModel";
import Production from "@/models/productionModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { productionLedgerKey } from "@/lib/bom.mjs";

/**
 * One production entry, by `id` or by `docNo`.
 *
 * Returns the stock rows it wrote alongside it. Not for display so much as for
 * reconciliation: a voucher whose lines say one thing while the stock ledger
 * says another is the failure mode worth being able to see, and the only way
 * to see it is to put both in front of someone.
 */
async function handleGET(req, auth) {
  try {
    await connect();

    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");
    const docNo = searchParams.get("docNo");

    if (!id && !docNo) {
      return NextResponse.json(
        { success: false, error: "Give an id or a docNo." },
        { status: 400 }
      );
    }

    let entry = null;
    if (id) {
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return NextResponse.json({ success: false, error: "Invalid id." }, { status: 400 });
      }
      entry = await Production.findById(id).lean();
    } else {
      const n = Number(docNo);
      if (!Number.isFinite(n)) {
        return NextResponse.json({ success: false, error: "Invalid docNo." }, { status: 400 });
      }
      entry = await Production.findOne({ docNo: n }).lean();
    }

    if (!entry) {
      return NextResponse.json(
        { success: false, error: "Production entry not found." },
        { status: 404 }
      );
    }

    const stockRows = await ItemLedger.find({ invoiceNo: productionLedgerKey(entry.docNo) })
      .sort({ _id: 1 })
      .lean();

    return NextResponse.json({ success: true, production: entry, stockRows });
  } catch (err) {
    console.error("Get production error:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const GET = tenantRoute(handleGET);
