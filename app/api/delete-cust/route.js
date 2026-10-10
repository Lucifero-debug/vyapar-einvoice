import { NextResponse } from "next/server";
import mongoose from "mongoose";
import { connect } from "../../../lib/mongodb";
import Customer from "@/models/custModel";
import Invoice from "../../../models/invoiceModel";
import Voucher from "../../../models/voucherModel";
import Ledger from "../../../models/ledgerModel";
import PriceList from "../../../models/priceListModel";
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
      return NextResponse.json({ error: "Invalid customer id." }, { status: 400 });
    }

    const customer = await Customer.findById(id);

    if (!customer) {
      return NextResponse.json({ error: "Customer not found." }, { status: 404 });
    }

    // By name as well as id: an invoice can carry the id of an earlier party
    // of the same name, and the voucher and ledger checks below go by name too.
    const existingInvoice = await Invoice.findOne({
      $or: [{ "customer.custId": id }, { "customer.name": customer.name }],
    });

    if (existingInvoice) {
      return NextResponse.json(
        {
          success: false,
          message: `Customer cannot be deleted because it is used in invoice #${existingInvoice.invoiceNo}.`,
          invoiceNo: existingInvoice.invoiceNo,
        },
        { status: 409 } // Conflict
      );
    }

    // Invoices were the only thing checked, so a party with nothing but
    // voucher activity could be deleted -- leaving ledger rows pointing at an
    // account that no longer exists and its balance effect stranded.
    const existingVoucher = await Voucher.findOne({
      $or: [{ acName: customer.name }, { "customers.name": customer.name }],
    });

    if (existingVoucher) {
      return NextResponse.json(
        {
          success: false,
          message: "Customer cannot be deleted because vouchers exist for this customer.",
        },
        { status: 409 }
      );
    }

    const existingLedger = await Ledger.findOne({
      $or: [{ customerName: customer.name }, { account: customer.name }],
    });

    if (existingLedger) {
      return NextResponse.json(
        {
          success: false,
          message: "Customer cannot be deleted because ledger entries exist for this customer.",
        },
        { status: 409 }
      );
    }

    const existingPriceList = await PriceList.findOne({ party: customer._id });

    if (existingPriceList) {
      return NextResponse.json(
        {
          success: false,
          message: "Customer cannot be deleted because a price list exists for this customer.",
        },
        { status: 409 }
      );
    }

    const deletedCust = await Customer.findByIdAndDelete(id);

    return NextResponse.json({
      message: "Customer deleted successfully",
      success: true,
      deletedCust,
    });

  } catch (error) {
    console.error("Delete Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);
