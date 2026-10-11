import { NextResponse } from "next/server";
import Bom from "@/models/bomModel";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { withTransaction, AbortTransaction } from "@/lib/withTransaction.mjs";
import { findNameClash, normalizeName } from "@/lib/uniqueName.mjs";
import { bomProblems } from "@/lib/bom.mjs";
import { loadItemIndex, loopFromSaving, stampBomLines } from "@/lib/bomSave.mjs";

/**
 * Save a new bill of material -- Sigfa's Masters > Misc > Bill of Material.
 *
 * Four things are refused, in this order, because each one depends on the last
 * having passed:
 *
 *   1. A line naming an item that is not in the master. Stock issued against
 *      a name with no master behind it is invisible to the stock report.
 *   2. Anything `bomProblems` lists -- no output item, a zero batch size, an
 *      item made of itself, the same item twice. Sigfa's own rules.
 *   3. A duplicate formula name, case-insensitively. Sigfa says "Duplicate
 *      BOM Name"; the case-insensitivity is ours, because every master in
 *      this app is joined by name and two records differing only in case are
 *      one thing to a human (lib/uniqueName.mjs).
 *   4. A loop across formulas. A made of B made of A -- invisible in either
 *      document alone, so it has to be checked against the book.
 *
 * In a transaction for the clash check: two people saving "Bracket" at the
 * same moment both pass a check made outside one, and the unique index then
 * turns the loser into a raw duplicate-key error.
 */
async function handlePOST(req, auth) {
  try {
    const body = await req.json();

    const draft = {
      name: normalizeName(body.name),
      outputItem: normalizeName(body.outputItem),
      forQuantity: Number(body.forQuantity),
      remarks: String(body.remarks || "").trim(),
      hold: Boolean(body.hold),
    };

    const saved = await withTransaction(async (session) => {
      const itemIndex = await loadItemIndex(session);

      const { lines, unknown } = stampBomLines(body.lines || [], itemIndex);
      if (unknown.length) {
        throw new AbortTransaction(
          {
            success: false,
            error: `Not in the item master: ${unknown.join(", ")}. Add them first.`,
            unknown,
          },
          400
        );
      }

      // The output item has to exist too. A formula that makes something with
      // no master would receive stock for it and leave it out of every report.
      const outputMaster = itemIndex.get(draft.outputItem.toLowerCase());
      if (draft.outputItem && !outputMaster) {
        throw new AbortTransaction(
          { success: false, error: `"${draft.outputItem}" is not in the item master.` },
          400
        );
      }

      const candidate = {
        ...draft,
        outputUnit: String(outputMaster?.unit || "").trim(),
        lines,
      };

      const problems = bomProblems(candidate);
      if (problems.length) {
        throw new AbortTransaction({ success: false, error: problems[0], problems }, 400);
      }

      const clash = await findNameClash(Bom, "name", candidate.name, { session });
      if (clash) {
        throw new AbortTransaction(
          { success: false, error: `A formula named "${candidate.name}" already exists.` },
          409
        );
      }

      const loop = await loopFromSaving(candidate, { session });
      if (loop) {
        throw new AbortTransaction({ success: false, error: loop }, 400);
      }

      const [bom] = await Bom.create(
        [
          {
            ...candidate,
            // Sigfa's LUSER. `auth` carries name and email (lib/authServer.mjs).
            createdBy: auth?.name || auth?.email || "",
            editCount: 0,
          },
        ],
        { session }
      );

      return bom;
    });

    return NextResponse.json({
      success: true,
      bom: saved,
      message: `Formula "${saved.name}" saved`,
    });
  } catch (err) {
    if (err instanceof AbortTransaction) {
      return NextResponse.json(err.payload, { status: err.status });
    }
    console.error("BOM add error:", err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// Signed in, permission checked, and every query below scoped to the
// caller's own firm. See lib/tenantRoute.mjs.
export const POST = tenantRoute(handlePOST);
