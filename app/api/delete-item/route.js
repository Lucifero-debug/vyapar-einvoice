import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { connect } from "../../../lib/mongodb";
import Item from "@/models/itemModel";
import Invoice from "../../../models/invoiceModel";
import ItemLedger from "../../../models/itemLedgerModel";
import Bom from "@/models/bomModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { itemDeleteBlockedReason } from "@/lib/bom.mjs";

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

    // Bills of material name their items the same way -- by name -- so the
    // same reasoning applies a third time. Sigfa runs this very check: its
    // item-delete path reads "Check From Salpur1,Sporder1,Quot1,Fmast,PrList,
    // Itmast", and Fmast is its formula master.
    //
    // An item deleted while a formula still names it leaves a formula that
    // makes or consumes something which does not exist, and the explosion then
    // issues nothing for it -- a production entry quietly short of a component,
    // with no error anywhere.
    //
    // Only the formulas that could match are fetched, not the whole book: one
    // query answering both halves of the question (does a formula MAKE this,
    // does one USE it), against the indexes bomModel declares for exactly
    // these two lookups.
    const relatedBoms = await Bom.find(
      { $or: [{ outputItem: item.name }, { "lines.itemName": item.name }] },
      { name: 1, outputItem: 1, lines: 1 }
    )
      .collation({ locale: "en", strength: 2 })
      .lean();

    const bomReason = itemDeleteBlockedReason(item.name, relatedBoms);
    if (bomReason) {
      return NextResponse.json({ success: false, message: bomReason }, { status: 409 });
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
