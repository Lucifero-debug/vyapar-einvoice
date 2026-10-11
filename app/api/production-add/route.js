import { NextResponse } from "next/server";
import Bom from "@/models/bomModel";
import Item from "@/models/itemModel";
import Production from "@/models/productionModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { withTransaction, AbortTransaction } from "@/lib/withTransaction.mjs";
import { getNextProductionNo, raiseProductionCounter } from "@/lib/getNextProductionNo";
import { writeProductionLedgerRows } from "@/lib/itemLedger.mjs";
import {
  bomCost,
  byOutputItem,
  explode,
  mergeLines,
  productionProblems,
  roundQty,
  toProductionLines,
} from "@/lib/bom.mjs";

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

    const outputQuantity = Number(body.quantity ?? body.outputQuantity);
    if (!Number.isFinite(outputQuantity) || outputQuantity <= 0) {
      return NextResponse.json(
        { success: false, error: "Enter how much was produced." },
        { status: 400 }
      );
    }

    const date = body.date ? new Date(body.date) : new Date();
    if (Number.isNaN(date.getTime())) {
      return NextResponse.json({ success: false, error: "That date is not valid." }, { status: 400 });
    }

    const saved = await withTransaction(async (session) => {
      const items = await Item.find({}, { name: 1, unit: 1, cost: 1 }, { session }).lean();
      const byName = new Map(items.map((i) => [String(i.name || "").trim().toLowerCase(), i]));
      const costOf = (itemName) =>
        Number(byName.get(String(itemName || "").trim().toLowerCase())?.cost) || 0;

      const bomName = String(body.bomName || "").trim();
      let bom = null;
      if (bomName) {
        bom = await Bom.findOne({ name: bomName }, null, { session })
          .collation({ locale: "en", strength: 2 })
          .lean();
        if (!bom) {
          throw new AbortTransaction(
            { success: false, error: `No formula named "${bomName}".` },
            404
          );
        }
      }

      const outputItem = String(body.outputItem || bom?.outputItem || "").trim();
      const outputMaster = byName.get(outputItem.toLowerCase());
      if (!outputMaster) {
        throw new AbortTransaction(
          { success: false, error: `"${outputItem}" is not in the item master.` },
          400
        );
      }

      // Either the lines the form shows, or a fresh explosion. The explosion
      // is the same call bom-explode makes, so the figures the user approved
      // and the figures that get saved come from one implementation.
      let lines;
      let warnings = [];
      if (Array.isArray(body.lines) && body.lines.length) {
        lines = mergeLines(
          body.lines.map((line) => ({
            itemName: String(line?.itemName || "").trim(),
            kind: line?.kind,
            quantity: roundQty(line?.quantity),
            unit: String(line?.unit || "").trim(),
            depth: Number(line?.depth) || 0,
            via: String(line?.via || "").trim(),
            path: line?.source || line?.path,
          }))
        );
      } else {
        if (!bom) {
          throw new AbortTransaction(
            { success: false, error: "Pick a formula, or send the material lines." },
            400
          );
        }
        const nested = body.nested === undefined ? true : Boolean(body.nested);
        const allBoms = nested
          ? await Bom.find({}, { name: 1, outputItem: 1, forQuantity: 1, lines: 1 }, { session }).lean()
          : [];
        const result = explode({
          bom,
          outputQuantity,
          index: byOutputItem(allBoms),
          nested,
        });
        lines = mergeLines(result.lines);
        warnings = result.warnings;
      }

      // Every line must name a real item, or the stock rows below land under a
      // name with no master and the stock report counts its opening quantity
      // as zero.
      const unknown = [
        ...new Set(
          lines
            .map((l) => l.itemName)
            .filter((n) => n && !byName.has(n.toLowerCase()))
        ),
      ];
      if (unknown.length) {
        throw new AbortTransaction(
          { success: false, error: `Not in the item master: ${unknown.join(", ")}.`, unknown },
          400
        );
      }

      const problems = productionProblems({ date, outputItem, outputQuantity, lines });
      if (problems.length) {
        throw new AbortTransaction({ success: false, error: problems[0], problems }, 400);
      }

      // Rates frozen onto the voucher from the master, never from the request.
      const frozen = toProductionLines({ lines, costOf });
      const costing = bomCost({ lines, outputQuantity, costOf });

      // The number, settled before the write -- the same dance as save-invoice
      // and order-add. The form supplies one from the peek endpoint, which two
      // people opening it at once both receive, and the unique index turns
      // that into a failed save.
      const requested = Number(body.docNo);
      let docNo;
      if (Number.isFinite(requested) && requested > 0) {
        const taken = await Production.findOne({ docNo: requested }, { _id: 1 }, { session }).lean();
        if (taken) {
          docNo = await getNextProductionNo(session);
        } else {
          docNo = requested;
          await raiseProductionCounter(requested, session);
        }
      } else {
        docNo = await getNextProductionNo(session);
      }

      const [entry] = await Production.create(
        [
          {
            docNo,
            date,
            bomName: bom?.name || "",
            outputItem: String(outputMaster.name || "").trim(),
            outputQuantity: roundQty(outputQuantity),
            outputUnit: String(outputMaster.unit || "").trim(),
            lines: frozen,
            partyName: String(body.partyName || "").trim(),
            materialValue: costing.materialValue,
            wastageValue: costing.wastageValue,
            byproductValue: costing.byproductValue,
            netCost: costing.netCost,
            costPerUnit: costing.costPerUnit,
            missingCosts: costing.missingCosts,
            warnings,
            remarks: String(body.remarks || "").trim(),
            // Sigfa's LUSER.
            createdBy: auth?.name || auth?.email || "",
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
        docNo,
        date,
        outputItem: entry.outputItem,
        outputQuantity: entry.outputQuantity,
        lines: frozen,
        partyName: entry.partyName,
      });

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
