import mongoose from "mongoose";
import { tenantPlugin } from "../lib/tenantPlugin.mjs";
import { LINE_KINDS } from "../lib/bom.mjs";
import { DEFAULT_KIND, STOCK_KIND_CODES } from "../lib/stockVoucher.mjs";

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
    // === WHICH OF THE THREE STOCK VOUCHERS THIS IS ===
    //
    // Sigfa's MKEY, kept as its own three characters: 'FR' Production, 'IS'
    // Goods Issued, 'RS' Goods Received. All three are rows in its RIssue
    // table, told apart by this, and all three are rows in this collection
    // for the same reason -- a second copy of the stock-writing is where a
    // direction gets inverted without anybody noticing.
    //
    // Defaulted rather than required: every entry written before this field
    // existed is a production entry, and lib/stockVoucher.mjs reads an absent
    // kind as 'FR'. scripts/backfill-stock-kind.mjs stamps the old rows, and
    // must run before the index below can do its job.
    kind: {
      type: String,
      enum: STOCK_KIND_CODES,
      default: DEFAULT_KIND,
      index: true,
    },

    // Its own sequence per KIND, per firm, from the shared counters
    // collection -- "productionNo", "goodsIssueNo", "goodsReceiptNo".
    // Numbering alongside invoices rather than inside them, exactly as Sigfa
    // numbers its DocNo independently of SALPUR, and one series per MKEY as
    // Sigfa does too.
    docNo: { type: Number, required: true },

    date: { type: Date, required: true },

    // Where it came from. Text, and deliberately not a reference -- see the
    // snapshot note above.
    bomName: { type: String, trim: true },

    // What was made. PRODUCTION ONLY: a goods issue or receipt has no
    // finished item, only the lines it moves. Required conditionally rather
    // than always, or every goods voucher would fail validation; the rule is
    // asked of lib/stockVoucher.mjs so there is one answer to "does this kind
    // have an output".
    outputItem: {
      type: String,
      trim: true,
      required: function requiredForProduction() {
        return (this.kind || DEFAULT_KIND) === "FR";
      },
    },
    outputQuantity: {
      type: Number,
      required: function requiredForProduction() {
        return (this.kind || DEFAULT_KIND) === "FR";
      },
    },
    outputUnit: { type: String, trim: true },

    lines: [productionLineSchema],

    // Sigfa's "Y  Ask Party In Production." -- job work done for someone, or
    // material issued on their behalf. Optional, and carried as a name like
    // every other party reference here.
    partyName: { type: String, trim: true },

    // === Sigfa's Issue Slip / Receipt Slip header ===
    //
    // Its form carries Series, Slip No., Date, Store and Party. Slip No. is
    // `docNo`, Date is `date`, Party is `partyName`; these two had no
    // equivalent here and are new.
    //
    // SERIES is Sigfa's SubKey -- a sub-classification of the slip, seeded in
    // its MkeyMaster with MI, MO and RMI. There is no such master here, so
    // this is free text and the screen offers back whatever has been used
    // before on this firm's slips.
    series: { type: String, trim: true, default: "" },

    // STORE is recorded, and that is ALL it does. Sigfa holds stock per store
    // -- STORECODE is on its RIssue and its PhyStock alike -- and this app
    // does not: lib/itemLedger.mjs has no store column, so the stock report
    // cannot and will not separate them. The field is kept because the slip
    // has it and knowing where goods went is worth recording; the screen says
    // plainly that it does not split stock, so nobody reads a total as
    // belonging to one store.
    store: { type: String, trim: true, default: "" },

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
// One series PER KIND, so Goods Issue 5 and Production 5 can both exist --
// which they must, since each kind has its own counter. The old index was on
// (companyId, docNo) alone; scripts/backfill-stock-kind.mjs has to stamp the
// existing rows before this is built, or a row with no kind and a new FR row
// of the same number would both be allowed.
productionSchema.index({ companyId: 1, kind: 1, docNo: 1 }, { unique: true });

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
