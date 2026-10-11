import mongoose from "mongoose";
import { tenantPlugin } from "../lib/tenantPlugin.mjs";
import { LINE_KINDS } from "../lib/bom.mjs";

/**
 * A production entry -- Sigfa's Production voucher, MKEY 'FR' in its
 * MkeyMaster, stored in MFG / MFG1.
 *
 * It is the thing that makes a bill of material worth having: it takes a
 * formula and a quantity, explodes it, issues what was consumed and receives
 * what was made. Without it a formula is a costing sheet that moves no stock.
 *
 *
 * WHY THE LINES ARE COPIED HERE INSTEAD OF LOOKED UP
 * --------------------------------------------------
 * `lines` is a SNAPSHOT of the exploded formula, not a pointer to it. The same
 * decision as the buyer block on an invoice and `uqc` on an invoice line, and
 * for the same reason: what was consumed in March must keep saying so after
 * the formula is corrected in June. A voucher that re-derived its materials
 * from today's formula would quietly rewrite its own history, and the stock
 * movements already written against it would then match nothing.
 *
 * That is also what makes editing a formula safe, and why nothing in this
 * module blocks it. `bomName` is kept only so a voucher can say where it came
 * from; the formula may since have been renamed or deleted.
 *
 * `rate` and `amount` ARE stored on each line, even though the formula itself
 * deliberately stores no rate (lib/bom.mjs explains why). A formula is a
 * recipe, costed at today's prices; a voucher is a record of what a thing cost
 * on the day it happened.
 */

const productionLineSchema = new mongoose.Schema(
  {
    itemName: { type: String, required: true, trim: true },

    // material / wastage / byproduct. Decides which side of the stock ledger
    // the line lands on: see consumes() in lib/bom.mjs.
    kind: { type: String, enum: LINE_KINDS, default: "material" },

    // Already scaled to this entry's output quantity -- not per-formula.
    quantity: { type: Number, required: true },
    unit: { type: String, trim: true },

    // The item master's cost at the moment of saving, and quantity x rate.
    rate: { type: Number, default: 0 },
    amount: { type: Number, default: 0 },

    // Where this line sat in the tree. Depth 0 is a direct line of the
    // formula; anything deeper came from a sub-formula. `via` names the
    // formula that contributed it and `source` the chain of items above it,
    // both kept as text so the voucher can still explain itself after the
    // sub-formula has been edited away.
    depth: { type: Number, default: 0 },
    via: { type: String, trim: true },
    source: { type: String, trim: true },
  },
  { _id: false }
);

const productionSchema = new mongoose.Schema(
  {
    // Its own sequence, per firm, from the shared counters collection:
    // "productionNo". Numbering alongside invoices rather than inside them,
    // exactly as Sigfa numbers its MFG DocNo independently of SALPUR.
    docNo: { type: Number, required: true },

    date: { type: Date, required: true },

    // Where it came from. Text, and deliberately not a reference -- see the
    // snapshot note above.
    bomName: { type: String, trim: true },

    // What was made.
    outputItem: { type: String, required: true, trim: true },
    outputQuantity: { type: Number, required: true },
    outputUnit: { type: String, trim: true },

    lines: [productionLineSchema],

    // Sigfa's "Y  Ask Party In Production." -- job work done for someone, or
    // material issued on their behalf. Optional, and carried as a name like
    // every other party reference here.
    partyName: { type: String, trim: true },

    // The costing, frozen. `netCost` is material + wastage - by-product
    // credit, which is what Sigfa's ADDLESS column is for.
    materialValue: { type: Number, default: 0 },
    wastageValue: { type: Number, default: 0 },
    byproductValue: { type: Number, default: 0 },
    netCost: { type: Number, default: 0 },
    costPerUnit: { type: Number, default: 0 },

    // Items that had no cost in the master when this was saved. Kept so the
    // voucher does not present a confident cost that silently omitted half its
    // lines -- the page can say "costed on 4 of 7 lines" a year later too.
    missingCosts: [{ type: String }],

    // Warnings the explosion produced: an ambiguous sub-formula, a loop, a
    // tree deeper than the limit. Worth keeping on the record, because they
    // are the reason a quantity is what it is.
    warnings: [{ type: String }],

    remarks: { type: String, trim: true },

    // Sigfa's LUSER / CRDATE / LUSERE / CRDATEE / EDCNT / PRNCNT. Declared in
    // full -- Mongoose strict mode drops what is not.
    createdBy: { type: String },
    updatedBy: { type: String },
    editCount: { type: Number, default: 0 },
    printCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Every row belongs to one firm. The plugin adds companyId, scopes every
// query to it, and stamps it onto everything created -- see lib/tenantPlugin.mjs.
productionSchema.plugin(tenantPlugin);

// Unique per FIRM. The same lesson as invoice numbering: globally unique
// numbers meant the second firm to open could not write entry 1.
productionSchema.index({ companyId: 1, docNo: 1 }, { unique: true });

// The register, read in date order.
productionSchema.index({ companyId: 1, date: -1, docNo: -1 });

// "What has this formula produced?" -- asked before deleting a formula, so the
// user can be told what they are giving up.
productionSchema.index({ companyId: 1, bomName: 1 });

// "Where did this item come from / go?" -- the item-master delete guard and
// the per-item history. Multikey over the lines array.
productionSchema.index({ companyId: 1, "lines.itemName": 1 });
productionSchema.index({ companyId: 1, outputItem: 1 });

const Production =
  mongoose.models.Production || mongoose.model("Production", productionSchema);

export default Production;
