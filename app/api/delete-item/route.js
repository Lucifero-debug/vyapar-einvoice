import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { connect } from "../../../lib/mongodb";
import Item from "@/models/itemModel";
import Invoice from "../../../models/invoiceModel";
import ItemLedger from "../../../models/itemLedgerModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";

async function handlePOST(req, auth) {
  try {
    await connect();

    const id = new URL(req.url).searchParams.get("id");

    if (!id) {
      return NextResponse.json({ error: "Id missing in query." }, { status: 400 });
    }
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json({ error: "Invalid item id." }, { status: 400 });
    }

    const item = await Item.findById(id);
    if (!item) {
      return NextResponse.json({ error: "Item not found." }, { status: 404 });
    }

    // Guard by NAME, which is what the rest of the database joins on.
    //
    // This used to look for `Invoice.items._id` — the id of the embedded line,
    // which only matches when the line was added from the item master on this
    // form. A line imported from an invoice image carries no master id at all,
    // so those invoices were invisible to the check and their item could be
    // deleted out from under them.
    const existingInvoice = await Invoice.findOne(
      { "items.name": item.name },
      { invoiceNo: 1 }
    ).lean();

    if (existingInvoice) {
      return NextResponse.json(
        {
          success: false,
          message: `Cannot delete "${item.name}" — it is used in invoice #${existingInvoice.invoiceNo}.`,
          invoiceNo: existingInvoice.invoiceNo,
        },
        { status: 409 }
      );
    }

    // Stock history was never checked at all. An item whose invoices had been
    // deleted could still be removed, stranding its movements under a name with
    // no master — and the stock report then counts its opening quantity as 0.
    const existingStock = await ItemLedger.findOne({ itemName: item.name }, { _id: 1 }).lean();

    if (existingStock) {
      return NextResponse.json(
        {
          success: false,
          message: `Cannot delete "${item.name}" — it has stock movements recorded against it.`,
        },
        { status: 409 }
      );
    }

    const deletedItem = await Item.findByIdAndDelete(id);

    return NextResponse.json({
      message: "Item deleted successfully",
      success: true,
      deletedItem,
    });
  } catch (error) {
    console.error("Delete Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);
