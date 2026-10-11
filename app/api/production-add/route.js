import { NextResponse } from "next/server";
import Bom from "@/models/bomModel";
import Item from "@/models/itemModel";
import Production from "@/models/productionModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { withTransaction, AbortTransaction } from "@/lib/withTransaction.mjs";
import { getNextProductionNo, raiseProductionCounter } from "@/lib/getNextProductionNo";
import { writeProductionLedgerRows } from "@/lib/itemLedger.mjs";
import { buildProductionEntry } from "@/lib/productionSave.mjs";

/**
 * Save a production entry -- Sigfa's Production voucher, MKEY 'FR'.
 *
 * This is the only route in the BOM feature that moves stock: materials and
 * wastage are issued, the finished item and any by-products are received, all
 * in one transaction with the voucher itself. A voucher that saved without its
 * stock rows, or stock rows without their voucher, is the partial-write
 * corruption lib/withTransaction.mjs exists to prevent.
 *
 *
 * TWO WAYS IN, AND THE LINES ARE RE-DERIVED EITHER WAY
 * ----------------------------------------------------
 * The form can send `bomName` + `quantity` and let the server explode it, or
 * send `lines` it has already shown the user (after they edited one by hand,
 * which Sigfa allows too unless "Lock Raw Material Detail" is set).
 *
 * When lines ARE sent they are trusted as quantities but not as prices: every
 * rate is read from the item master here, never from the request. A client
 * that could post its own rates could post a cost of zero on a voucher that
 * consumed fifty thousand rupees of steel.
 *
 * What the client is never allowed to send:
 *
 *   docNo          settled here, against the counter and the highest existing
 *                  entry -- a number from the peek endpoint is a suggestion,
 *                  and two people opening the form both get the same one.
 *   rate, amount   from the item master.
 *   netCost etc    derived from the lines that were actually saved.
 */
async function handlePOST(req, auth) {
  try {
    const body = await req.json();

    // The quantity and date checks used to sit here, outside the transaction,
    // and are now inside buildProductionEntry -- one copy, shared with the
    // alter route. They throw AbortTransaction, which the catch below already
    // turns into the same 400 with the same wording.
    const saved = await withTransaction(async (session) => {
      // The item lookup, the lines, the validation and the rate freezing all
      // live in lib/productionSave.mjs, shared with `production-alter`. Two
      // copies of this would be two chances for an alter to value a batch
      // differently from the way the original save valued it.
      const { fields, frozen, warnings, kind } = await buildProductionEntry({ body, session, auth });

      // The number, settled before the write -- the same dance as save-invoice
      // and order-add. The form supplies one from the peek endpoint, which two
      // people opening it at once both receive, and the unique index turns
      // that into a failed save.
      const requested = Number(body.docNo);
      let docNo;
      if (Number.isFinite(requested) && requested > 0) {
        // Scoped to the KIND: Goods Issue 5 and Production 5 are different
        // vouchers under different ledger keys, so one does not take the
        // other's number.
        const taken = await Production.findOne(
          { kind, docNo: requested },
          { _id: 1 },
          { session }
        ).lean();
        if (taken) {
          docNo = await getNextProductionNo(session, kind);
        } else {
          docNo = requested;
          await raiseProductionCounter(requested, session, kind);
        }
      } else {
        docNo = await getNextProductionNo(session, kind);
      }

      const [entry] = await Production.create(
        [
          {
            ...fields,
            docNo,
            editCount: 0,
            printCount: 0,
          },
        ],
        { session }
      );

      // In the SAME transaction. The stock rows are keyed "PRD-<docNo>", which
      // is why productionLedgerKey exists -- see the note in lib/itemLedger.mjs.
      const rows = await writeProductionLedgerRows({
        session,
        kind,
        docNo,
        date: fields.date,
        outputItem: entry.outputItem,
        outputQuantity: entry.outputQuantity,
        lines: frozen,
        partyName: entry.partyName,
      });

      void warnings;

      return { entry, rows };
    });

    return NextResponse.json({
      success: true,
      production: saved.entry,
      stockRows: saved.rows,
      message: `Production ${saved.entry.docNo} saved`,
    });
  } catch (err) {
    if (err instanceof AbortTransaction) {
      return NextResponse.json(err.payload, { status: err.status });
    }
    console.error("Production add error:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);
