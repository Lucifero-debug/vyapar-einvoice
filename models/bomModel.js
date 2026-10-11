import mongoose from "mongoose";
import { tenantPlugin } from "../lib/tenantPlugin.mjs";
import { LINE_KINDS } from "../lib/bom.mjs";

/**
 * A bill of material -- Sigfa's Masters > Misc > Bill of Material, which its
 * own code calls the Formula Master and stores in FMAST.
 *
 * FMAST is one flat table that repeats the output item, its unit and the
 * output quantity on every single row. This is a document with lines instead,
 * because a formula whose output quantity is corrected should not need every
 * row rewritten, and because rows that disagree about what the formula makes
 * is a state no screen can show honestly. lib/bom.mjs carries the full
 * mapping, field by field.
 *
 * ITEMS ARE REFERENCED BY NAME, not by id. That is not a shortcut -- it is how
 * the rest of this database already joins: stock rows carry `itemName`, invoice
 * lines carry `name`, order lines carry `name`. A formula pointing at an
 * ObjectId while the ledger beside it points at a string would be the one join
 * in the app that works differently, and lib/uniqueName.mjs exists to keep
 * those names unique per firm, case and all.
 */

const bomLineSchema = new mongoose.Schema(
  {
    // The component. Joined by name to the item master, like everything else.
    itemName: { type: String, required: true, trim: true },

    // Sigfa's ADDLESS column, named. "Less" records the sign but not the
    // reason, and the two reasons behave differently in stock: wastage is
    // consumed and gone, a by-product is RECEIVED as something sellable.
    // Sigfa's own strings carry both words (WASTAGE, ByProduct) -- only the
    // column never did.
    kind: {
      type: String,
      enum: LINE_KINDS,
      default: "material",
    },

    // Per `forQuantity` of the output, NOT per one. Sigfa's FQTY against its
    // FORQTY, and the reason is practical: a formula for one piece of
    // something made in hundreds has to be written in fractions nobody can
    // check.
    quantity: { type: Number, required: true },

    // Stamped from the item master when the formula is saved, for display and
    // for print. Not used in arithmetic -- the quantity is always in the
    // master's own unit -- so a unit corrected later is cosmetic.
    unit: { type: String, trim: true },

    note: { type: String, trim: true },
  },
  // No separate _id per line: nothing points AT a formula line. Production
  // entries snapshot their lines by value (see productionModel), precisely so
  // that editing a formula cannot rewrite history.
  { _id: false }
);

const bomSchema = new mongoose.Schema(
  {
    // The key the user types. Sigfa's BOM TEXT(25) -- its "Duplicate BOM Name"
    // check is the same guard `bom-add` and `bom-alter` apply with
    // findNameClash, case-insensitively.
    name: { type: String, required: true, trim: true },

    // What it makes, and how much of it the lines below produce.
    outputItem: { type: String, required: true, trim: true },
    outputUnit: { type: String, trim: true },
    forQuantity: { type: Number, required: true, default: 1 },

    lines: [bomLineSchema],

    remarks: { type: String, trim: true },

    // Sigfa's HOLD, which it carries on orders and production alike. A held
    // formula stays in the master but is kept out of the production picker.
    hold: { type: Boolean, default: false },

    // Sigfa's LUSER / CRDATE / LUSERE / CRDATEE / EDCNT, the audit block every
    // one of its masters carries. Declared, or Mongoose strict mode drops them
    // and the audit silently records nothing -- the mistake this project has
    // now paid for six separate times.
    createdBy: { type: String },
    updatedBy: { type: String },
    editCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Every row belongs to one firm. The plugin adds companyId, scopes every
// query to it, and stamps it onto everything created -- see lib/tenantPlugin.mjs.
bomSchema.plugin(tenantPlugin);

// One name per firm, not globally: the second firm to open must be able to
// have its own "MS Angle 50x50" formula. Mirrors the invoice and order
// numbering indexes for the same reason.
bomSchema.index({ companyId: 1, name: 1 }, { unique: true });

// "Which formula makes this item?" -- asked by the production picker and by
// every level of a nested explosion, so it must not be a scan.
bomSchema.index({ companyId: 1, outputItem: 1 });

// "Is this item used by any formula?" -- the item-master delete guard, which
// is the check Sigfa runs as part of
// "Check From Salpur1,Sporder1,Quot1,Fmast,PrList,Itmast". Multikey over the
// lines array.
bomSchema.index({ companyId: 1, "lines.itemName": 1 });

const Bom = mongoose.models.Bom || mongoose.model("Bom", bomSchema);

export default Bom;
