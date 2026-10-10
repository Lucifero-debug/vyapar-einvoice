// app/api/hsn-update/route.js

import { NextResponse } from "next/server";
import { connect } from "../../../lib/mongodb";
import Hsn from "../../../models/hsnModel";
import Item from "../../../models/itemModel"; // use Item model instead of Product
import { findNameClash, normalizeName } from "@/lib/uniqueName.mjs";
import { tenantRoute } from "@/lib/tenantRoute.mjs";

async function handlePOST(req, auth) {
  try {
    await connect();
    const body = await req.json();

    const { hsncode, hsnname, gst, gstunit, id } = body;

    // Blank GST would be written through to every item on this HSN as null.
    if (!hsncode || gst === "" || gst === null || gst === undefined) {
      return NextResponse.json(
        {
          success: false,
          message: "HSN code and GST are required",
        },
        { status: 400 }
      );
    }

    // Renaming onto another HSN's code would hit the unique index as a 500.
    const clash = await findNameClash(Hsn, "hsncode", hsncode, { excludeId: id });
    if (clash) {
      return NextResponse.json(
        {
          success: false,
          message: `HSN code "${normalizeName(hsncode)}" already exists.`,
        },
        { status: 409 }
      );
    }

    // 1. Get old HSN record first
    const existingHsn = await Hsn.findById(id);

    if (!existingHsn) {
      return NextResponse.json(
        {
          success: false,
          message: "HSN code not found",
        },
        { status: 404 }
      );
    }

    const oldHsnCode = existingHsn.hsncode;

    // 2. Update HSN master table
    const updated = await Hsn.findOneAndUpdate(
      { _id: id },
      {
        $set: {
          hsnname,
          hsncode,
          gst,
          gstunit,
        },
      },
      { new: true }
    );

    // 3. Update all items using old HSN code
    await Item.updateMany(
      { hsn: oldHsnCode }, // item schema uses "hsn"
      {
        $set: {
          hsn: hsncode,
          gst: gst, // item schema has gst
        },
      }
    );

    return NextResponse.json({
      success: true,
      message: "HSN and related items updated successfully",
      data: updated,
    });
  } catch (error) {
    console.error("Error updating HSN:", error);

    return NextResponse.json(
      {
        success: false,
        message: "Server error",
      },
      { status: 500 }
    );
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);
