import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import Counter from "@/models/counterModel";
import Customer from "@/models/custModel";
import Invoice from "@/models/invoiceModel";
import ItemLedger from "@/models/itemLedgerModel";
import Ledger from "@/models/ledgerModel";
import Voucher from "@/models/voucherModel";
import { withTransaction, AbortTransaction } from "@/lib/withTransaction.mjs";
import {
  CLEAR_TRANSACTIONS_PHRASE,
  TRANSACTION_COLLECTIONS,
} from "@/lib/clearData.mjs";
import { tenantRoute } from "@/lib/tenantRoute.mjs";

/**
 * Clear the books, keep the masters.
 *
 * Guarded by a typed phrase for the same reason the full wipe is: there is no
 * sign-in in front of this app, so the phrase is the only speed bump between a
 * stray request and an empty ledger. It is not security. Anything holding real
 * money needs a login in front of this route.
 */

// Keyed by the names in TRANSACTION_COLLECTIONS so the two cannot drift: a
// collection added to that list without a model here fails loudly below rather
// than being quietly skipped and left behind.
const MODELS = {
  invoices: Invoice,
  vouchers: Voucher,
  ledgers: Ledger,
  itemledgers: ItemLedger,
  counters: Counter,
};

async function handleDELETE(req, auth) {
  try {
    let body = {};
    try {
      body = await req.json();
    } catch {
      // no body at all -- treated as unconfirmed below
    }

    if (body?.confirm !== CLEAR_TRANSACTIONS_PHRASE) {
      return NextResponse.json(
        {
          success: false,
          message: `Refused: send { "confirm": "${CLEAR_TRANSACTIONS_PHRASE}" } to clear the transactions.`,
        },
        { status: 400 }
      );
    }

    const unmapped = TRANSACTION_COLLECTIONS.filter((name) => !MODELS[name]);
    if (unmapped.length) {
      return NextResponse.json(
        {
          success: false,
          message: `Refused: no model wired for ${unmapped.join(", ")}. Clearing would leave those rows behind.`,
        },
        { status: 500 }
      );
    }

    await connect();

    // All or nothing. A half-done clear leaves, say, invoices gone but their
    // ledger rows behind -- the orphaned state the rest of the app works to
    // avoid -- and parties carrying balances for documents that no longer exist.
    const result = await withTransaction(async (session) => {
      const deleted = {};
      for (const name of TRANSACTION_COLLECTIONS) {
        const { deletedCount } = await MODELS[name].deleteMany({}, { session });
        deleted[name] = deletedCount || 0;
      }

      // Every party back to its opening balance, with the mode following the
      // sign. Done as a pipeline update so it is one round trip rather than one
      // per customer, and so the two fields cannot disagree.
      const { modifiedCount } = await Customer.updateMany(
        {},
        [
          { $set: { lastBal: { $round: [{ $ifNull: ["$openingBal", 0] }, 2] } } },
          { $set: { lastMode: { $cond: [{ $gte: ["$lastBal", 0] }, "Dr", "Cr"] } } },
        ],
        { session }
      );

      return { deleted, partiesReset: modifiedCount || 0 };
    });

    const removed = Object.values(result.deleted).reduce((a, b) => a + b, 0);

    return NextResponse.json({
      success: true,
      message:
        `Transactions cleared: ${removed} record(s) removed, ` +
        `${result.partiesReset} party balance(s) reset to opening. ` +
        `Customers, items, HSN codes and price lists were kept.`,
      ...result,
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
