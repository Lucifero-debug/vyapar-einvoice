/**
 * The part of saving a production entry that needs the database.
 *
 * NOT pure, and one of the documented exceptions in lib/ -- the same as
 * itemLedger.mjs, runningBalances.mjs, cashAccount.mjs, orderClaims.mjs,
 * bomSave.mjs, glAccounts.mjs, openBillsFor.mjs and staffStore.mjs. The rules
 * live in lib/bom.mjs, which stays runnable under bare node.
 *
 *
 * WHY IT EXISTS
 * -------------
 * So `production-add` and `production-alter` cannot drift apart, for exactly
 * the reason bomSave.mjs exists: the same item-master lookup, the same choice
 * between trusting the form's lines and re-exploding the formula, the same
 * unknown-item check, the same validation and the same rate freezing, written
 * twice. That is how `customer-add` and `customer-alter` ended up with
 * different duplicate-name rules, and how a name blocked on create could be
 * reached by renaming.
 *
 * Here the stakes are higher than a name: this pipeline decides how much
 * stock moves and at what cost. Two copies is two chances for an alter to
 * value a batch differently from the way the original save valued it.
 *
 *
 * WHAT STAYS OUT OF HERE, AND WHY
 * -------------------------------
 * The document number. `add` allocates one against the counter; `alter` must
 * not touch it at all -- see the note in `production-alter`. Putting that
 * choice in a shared function would mean a flag, and a flag on the one field
 * that keys the stock rows is a flag worth not having.
 *
 * The write itself, for the same reason: one creates, the other updates.
 */

import Bom from "../models/bomModel";
import Item from "../models/itemModel";
import { AbortTransaction } from "./withTransaction.mjs";
import { isStockKind, kindOf, stockKind, stockKindProblems } from "./stockVoucher.mjs";
import {
  bomCost,
  byOutputItem,
  explode,
  mergeLines,
  productionProblems,
  roundQty,
  toProductionLines,
} from "./bom.mjs";

const text = (value) => String(value ?? "").trim();
const key = (value) => text(value).toLowerCase();

/**
 * Everything a production entry needs, worked out from what the form sent.
 *
 * Returns `{ fields, frozen, warnings }`:
 *
 *   fields    the document's own columns, ready to create or to $set
 *   frozen    the material lines with their rates read from the item master
 *   warnings  whatever the explosion reported, when it did one
 *
 * Throws AbortTransaction, so the caller's transaction rolls back and the
 * route answers with the payload and status it carries -- the same contract
 * `production-add` used when this logic lived inside it.
 */
export async function buildProductionEntry({ body, session, auth }) {
  // WHICH OF THE THREE this is. Refused rather than defaulted when the
  // request names something unknown: silently treating a mistyped kind as
  // Production would write a finished item into stock on a document that was
  // meant to send goods out.
  if (body.kind !== undefined && !isStockKind(body.kind)) {
    throw new AbortTransaction(
      { success: false, error: `"${body.kind}" is not a stock voucher kind.` },
      400
    );
  }
  const kind = kindOf(body.kind);
  const config = stockKind(kind);

  // A goods issue or receipt has no finished item, so there is no quantity to
  // check -- its quantities are on its lines.
  const outputQuantity = config.hasOutput
    ? Number(body.quantity ?? body.outputQuantity)
    : 0;
  if (config.hasOutput && (!Number.isFinite(outputQuantity) || outputQuantity <= 0)) {
    throw new AbortTransaction(
      { success: false, error: "Enter how much was produced." },
      400
    );
  }

  const date = body.date ? new Date(body.date) : new Date();
  if (Number.isNaN(date.getTime())) {
    throw new AbortTransaction({ success: false, error: "That date is not valid." }, 400);
  }

  const items = await Item.find({}, { name: 1, unit: 1, cost: 1 }, { session }).lean();
  const byName = new Map(items.map((i) => [key(i.name), i]));
  const costOf = (itemName) => Number(byName.get(key(itemName))?.cost) || 0;

  const bomName = text(body.bomName);
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

  const outputItem = config.hasOutput ? text(body.outputItem || bom?.outputItem) : "";
  const outputMaster = config.hasOutput ? byName.get(key(outputItem)) : null;
  if (config.hasOutput && !outputMaster) {
    throw new AbortTransaction(
      { success: false, error: `"${outputItem}" is not in the item master.` },
      400
    );
  }

  // Either the lines the form shows, or a fresh explosion. The explosion is
  // the same call bom-explode makes, so the figures the user approved and the
  // figures that get saved come from one implementation.
  //
  // ON AN ALTER THIS IS WHAT KEEPS THE RECORD HONEST. The form loads the
  // entry's STORED lines and sends them back, so a formula edited since the
  // batch was made does not retroactively change what the batch consumed. The
  // production screen's own note puts it best: a batch that actually used a
  // bit more of something should be recorded as it happened, not as the recipe
  // says.
  let lines;
  let warnings = [];
  if (Array.isArray(body.lines) && body.lines.length) {
    lines = mergeLines(
      body.lines.map((line) => ({
        itemName: text(line?.itemName),
        kind: line?.kind,
        quantity: roundQty(line?.quantity),
        unit: text(line?.unit),
        depth: Number(line?.depth) || 0,
        via: text(line?.via),
        path: line?.source || line?.path,
      }))
    );
  } else {
    if (!config.usesFormula) {
      throw new AbortTransaction(
        {
          success: false,
          error: `Add at least one item to this ${config.label.toLowerCase()}.`,
        },
        400
      );
    }
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

  // Every line must name a real item, or the stock rows land under a name with
  // no master and the stock report counts its opening quantity as zero.
  const unknown = [...new Set(lines.map((l) => l.itemName).filter((n) => n && !byName.has(key(n))))];
  if (unknown.length) {
    throw new AbortTransaction(
      { success: false, error: `Not in the item master: ${unknown.join(", ")}.`, unknown },
      400
    );
  }

  const problems = [
    ...stockKindProblems({ kind, outputItem, lines }),
    // The checks every stock voucher shares. Skipped for a kind with no
    // finished item, because productionProblems demands one.
    ...(config.hasOutput ? productionProblems({ date, outputItem, outputQuantity, lines }) : []),
  ];
  if (problems.length) {
    throw new AbortTransaction({ success: false, error: problems[0], problems }, 400);
  }

  // Rates frozen onto the voucher from the MASTER, never from the request. A
  // client that could post its own rates could post a cost of zero on a
  // voucher that consumed fifty thousand rupees of steel -- and on an alter it
  // could do that to an entry that was costed correctly yesterday.
  const frozen = toProductionLines({ lines, costOf });
  const costing = bomCost({ lines, outputQuantity, costOf });

  return {
    frozen,
    warnings,
    kind,
    fields: {
      kind,
      date,
      bomName: bom?.name || "",
      outputItem: outputMaster ? text(outputMaster.name) : "",
      outputQuantity: config.hasOutput ? roundQty(outputQuantity) : 0,
      outputUnit: outputMaster ? text(outputMaster.unit) : "",
      lines: frozen,
      partyName: text(body.partyName),
      // Sigfa's Series and Store, off its slip header. Stored as typed --
      // neither has a master behind it here, and `store` deliberately has no
      // effect on where stock is held. See models/productionModel.js.
      series: text(body.series),
      store: text(body.store),
      materialValue: costing.materialValue,
      wastageValue: costing.wastageValue,
      byproductValue: costing.byproductValue,
      netCost: costing.netCost,
      costPerUnit: costing.costPerUnit,
      missingCosts: costing.missingCosts,
      warnings,
      remarks: text(body.remarks),
      // Sigfa's LUSER.
      createdBy: auth?.name || auth?.email || "",
    },
  };
}

export default buildProductionEntry;
