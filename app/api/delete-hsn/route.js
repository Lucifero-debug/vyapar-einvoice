import { NextResponse } from "next/server";
import { connect } from "../../../lib/mongodb";
import mongoose from "mongoose";
import Hsn from "../../../models/hsnModel";
import Item from "../../../models/itemModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";


async function handlePOST(req, auth) {
  try {
    await connect();

    const url = new URL(req.url);
    const id = url.searchParams.get("id"); // still using 'id' param for invoiceNo

    if (!id) {
      return NextResponse.json({ error: "Id missing in query." }, { status: 400 });
    }

    if (!mongoose.isValidObjectId(id)) {
      return NextResponse.json({ error: "Invalid HSN id." }, { status: 400 });
    }

    const hsn = await Hsn.findById(id);
    if (!hsn) {
      return NextResponse.json({ error: "HSN not found." }, { status: 404 });
    }

    // Items store the HSN by code and pick it from the HSN list when edited;
    // deleting a code still in use would leave those items pointing at nothing.
    const inUse = await Item.countDocuments({ hsn: hsn.hsncode });
    if (inUse) {
      return NextResponse.json(
        {
          success: false,
          error: `Cannot delete HSN ${hsn.hsncode} because ${inUse} item(s) use it. Change their HSN first.`,
        },
        { status: 409 }
      );
    }

    const deletedHsn = await Hsn.findByIdAndDelete(id);

    return NextResponse.json({
      message: "Hsn deleted successfully",
      success: true,
      deletedHsn,
    });

  } catch (error) {
    console.error("Delete Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);
