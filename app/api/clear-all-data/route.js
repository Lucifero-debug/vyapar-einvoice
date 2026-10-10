import Item from "@/models/itemModel";
import Customer from "../../../models/custModel";
import Invoice from "../../../models/invoiceModel";
import Hsn from "../../../models/hsnModel";
import Voucher from "../../../models/voucherModel";
import ItemLedger from "@/models/itemLedgerModel";
import Ledger from "../../../models/ledgerModel";
import Counter from "../../../models/counterModel";
import PriceList from "../../../models/priceListModel";
import { NextResponse } from "next/server";
import { withTransaction, AbortTransaction } from "@/lib/withTransaction.mjs";
import { tenantRoute } from "@/lib/tenantRoute.mjs";

/**
 * Wipe the books. Used to reset between demo runs.
 *
 * Guarded by a phrase the caller has to type, because this used to be a bare
 * unauthenticated DELETE: a single stray request -- a crawler, a mistyped
 * curl, anything that found the URL -- destroyed every record with nothing to
 * stop it and no way back.
 *
 * The phrase is not security. It is a speed bump, and the only one available
 * while there is no sign-in. Anything holding real money needs a login in
 * front of this route, not a magic word.
 */
export const CONFIRM_PHRASE = "DELETE ALL DATA";

async function handleDELETE(req, auth) {
  try {
    let body = {};
    try {
      body = await req.json();
    } catch {
      // no body at all -- treated as an unconfirmed request below
    }

    if (body?.confirm !== CONFIRM_PHRASE) {
      return NextResponse.json(
        {
          success: false,
          message: `Refused: send { "confirm": "${CONFIRM_PHRASE}" } to wipe the books.`,
        },
        { status: 400 }
      );
    }

    // All or nothing. Clearing seven collections with an unawaited Promise.all
    // could fail half way and leave, say, invoices gone but their ledger rows
    // behind -- the exact orphaned state the rest of the app works to avoid.
    const cleared = await withTransaction(async (session) => {
      const results = await Promise.all([
        Item.deleteMany({}, { session }),
        Customer.deleteMany({}, { session }),
        Invoice.deleteMany({}, { session }),
        Hsn.deleteMany({}, { session }),
        PriceList.deleteMany({}, { session }),
        Voucher.deleteMany({}, { session }),
        ItemLedger.deleteMany({}, { session }),
        Ledger.deleteMany({}, { session }),
        // Without this the invoice counter survives the wipe and numbering
        // carries on from wherever it left off instead of starting again.
        Counter.deleteMany({}, { session }),
      ]);

      return results.reduce((sum, r) => sum + (r.deletedCount || 0), 0);
    });

    return NextResponse.json({
      success: true,
      message: `All data cleared successfully (${cleared} records removed).`,
    });
  } catch (error) {
    if (error instanceof AbortTransaction) {
      return NextResponse.json(error.payload, { status: error.status });
    }
    return NextResponse.json(
      { success: false, message: error.message },
      { status: 500 }
    );
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const DELETE = tenantRoute(handleDELETE);
