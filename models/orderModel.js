import mongoose from 'mongoose';
import { tenantPlugin } from "../lib/tenantPlugin.mjs";

/**
 * A sales or purchase order.
 *
 * Modelled on Sigfa's SPORDER / SPORDER1, which is worth following closely
 * because it has survived ten major versions of real use:
 *
 *   - THE HEADER CARRIES NO TAX AND NO TOTALS. Their SPORDER has neither, and
 *     their SPORDER1B -- the per-line tax table for orders -- has no GST
 *     columns at all. An order is a commitment to supply; the GST is whatever
 *     the item master says on the day it is billed. `totalAmount` below is
 *     stored only so a list can be sorted and totalled without loading every
 *     line, and it is recomputed from the lines on every write.
 *
 *   - THE LINE CARRIES THREE QUANTITIES, not a "remaining" one. Ordered,
 *     cancelled, invoiced; pending is always the subtraction. Sigfa's QTY,
 *     CanQty and INVQTY. Storing the remainder instead is how it drifts.
 *
 * Every field is declared in full, because Mongoose strict mode silently
 * drops what is not -- the mistake that has cost this project five separate
 * afternoons. A dropped `invoicedQty` in particular would leave every order
 * looking permanently open while its invoices piled up.
 */

const orderLineSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String },
  hsn: { type: String },

  // === The three quantities ===
  //
  // `quantity` is what was ordered and never moves on its own. The other two
  // are written ONLY by lib/orderClaims.mjs (invoiced) and the alter route
  // (cancelled); nothing a client posts is trusted for them, which is why
  // order-add strips both.
  quantity: { type: Number, required: true },
  cancelledQty: { type: Number, default: 0 },
  invoicedQty: { type: Number, default: 0 },

  // `cost` rather than `rate`, matching the invoice item schema, so a pending
  // line can be handed to the billing form without translation.
  cost: { type: Number, required: true },
  discount: { type: Number, default: 0 },
  // quantity x cost less the discount percentage. No GST. lib/orderStatus.mjs.
  total: { type: Number },

  // Sigfa keeps a promised date on the LINE as well as the header (their
  // SPORDER1.DESPDATE beside SPORDER.DESPDATE), because a single order
  // routinely promises different items for different weeks.
  deliveryDate: { type: Date },

  // Copied from the item master when the line was entered, same as on an
  // invoice -- an order printed last month must keep reading in the unit it
  // was agreed in.
  uqc: { type: String },
  isService: { type: Boolean },
});

const orderSchema = new mongoose.Schema(
  {
    orderNo: { type: Number, required: true },
    // 'Sale' is Sigfa's SO, 'Purchase' its PO. Part of the unique key, so one
    // firm's sales order 1 and purchase order 1 can both exist.
    type: { type: String, required: true, enum: ["Sale", "Purchase"] },
    date: { type: Date, required: true },

    // When the whole order is promised, and the agreed lead time in days
    // (Sigfa's DESPDATE and DAYS). Both are kept: a client who works to
    // "30 days from order" wants the days, one supplying against a project
    // wants the date.
    deliveryDate: { type: Date },
    deliveryDays: { type: Number },

    // === The party as they stood when the order was taken ===
    //
    // A snapshot, exactly as on an invoice (lib/buyerSnapshot.mjs), and
    // declared in full for the same reason. An order is not a filing, so this
    // matters less than it does there -- but an order printed and sent to a
    // customer is a document they hold, and it must keep saying what it said.
    customer: {
      type: {
        name: { type: String, required: true },
        phone: { type: String },
        email: { type: String },
        custId: { type: String },
        gstin: { type: String },
        address: { type: String },
        city: { type: String },
        state: { type: String },
        pincode: { type: String },
        stateCode: { type: String },
      },
      required: false,
    },

    // The party's own state, from their master -- the same rule as on an
    // invoice. Stored so the order print can show it without a second lookup.
    stateOfSupply: { type: String },
    stateCode: { type: String },

    items: [orderLineSchema],

    // The sum of the lines, with no tax. DERIVED: recomputed on every write
    // from lib/orderStatus.mjs, never taken from the client.
    totalAmount: { type: Number, default: 0 },

    // === Status is DERIVED ===
    //
    // open / partial / closed / cancelled, computed by orderStatus() from the
    // lines on every write. Stored only so the list can filter and sort on it
    // in the database rather than loading every order to find the open ones.
    // No route accepts it from a client: a status that can be posted to is a
    // status that will eventually disagree with its own lines.
    status: {
      type: String,
      enum: ["open", "partial", "closed", "cancelled"],
      default: "open",
    },

    // The buyer's own reference for this order -- their PO number against our
    // sales order, or ours against a supplier's. Sigfa's REFNO/FORMNO. Free
    // text, because it is whatever the other side calls it.
    reference: { type: String },
    // A quotation this order came out of, if any. Just the number: quotations
    // are not a document this project has yet.
    quotationNo: { type: String },

    // Commercial terms, all free text, all Sigfa fields: PTERM, DLPRD, DESP,
    // TRANS, FREIGHT.
    paymentTerms: { type: String },
    deliveryPeriod: { type: String },
    despatchThrough: { type: String },
    transport: { type: String },
    freight: { type: String },
    remarks: { type: String },

    // Sigfa's HOLD: the order stands but nothing should be supplied against
    // it yet. Kept out of `status` deliberately -- a held order is still open,
    // and conflating the two loses whichever was set second.
    hold: { type: Boolean, default: false },

    // === Audit, copied from Sigfa and absent from the rest of this app ===
    //
    // LUSER / LUSERE / EDCNT / PRNCNT. An accountant looking at an order that
    // disagrees with the invoice wants to know who changed it and how often,
    // and these cost nothing to keep.
    createdBy: { type: String },
    updatedBy: { type: String },
    editCount: { type: Number, default: 0 },
    printCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// The list filters on type + status + date; the pending-orders picker looks
// orders up by party and status.
orderSchema.index({ type: 1, status: 1, date: 1 });
orderSchema.index({ "customer.name": 1, status: 1 });
orderSchema.index({ deliveryDate: 1 });

// Every row belongs to one firm. The plugin adds companyId, scopes every
// query to it, and stamps it onto everything created -- see lib/tenantPlugin.mjs.
orderSchema.plugin(tenantPlugin);

// Unique per FIRM and per DOCUMENT. Not globally: a global unique index is
// exactly what stopped the second firm writing invoice 1, and cost a day to
// find (scripts/sync-indexes.mjs). `type` is in the key so sales order 1 and
// purchase order 1 can coexist, which is how Sigfa's MKEY + DocNo works.
orderSchema.index({ companyId: 1, type: 1, orderNo: 1 }, { unique: true });

export default mongoose.models.Order || mongoose.model('Order', orderSchema);
