import mongoose from "mongoose";
import { tenantPlugin } from "../lib/tenantPlugin.mjs";

/**
 * A sales or purchase challan -- SIGFA's SC and PC (lib/challanStatus.mjs).
 *
 * Goods sent out or taken in ahead of the bill. It carries the goods' value
 * and GST, and moves stock when `stockEffect` is set, but posts NOTHING to the
 * accounts; the invoice made from it does that.
 *
 * Every field is declared in full, because Mongoose strict mode silently
 * drops what is not -- a dropped `billedQty` would leave every challan
 * looking permanently pending while its invoices piled up.
 */

const challanLineSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String },
  hsn: { type: String },
  quantity: { type: Number, required: true },
  // Written ONLY by lib/challanClaims.mjs, from a real invoice. Never taken
  // from the client: challan-add sets it to 0 and challan-alter carries the
  // stored figure forward (lib/challanStatus.mjs carryBilled).
  billedQty: { type: Number, default: 0 },
  // `cost` rather than `rate`, matching the invoice line, so a pending line
  // can be handed to the billing screen without translation.
  cost: { type: Number, required: true },
  discount: { type: Number, default: 0 },
  gstRate: { type: Number, default: 0 },
  taxableAmount: { type: Number, default: 0 },
  gstAmount: { type: Number, default: 0 },
  total: { type: Number, default: 0 },
  // Copied from the item master when the line was entered, as on an invoice.
  uqc: { type: String },
  isService: { type: Boolean },
  // Purchase M.R.I.: received, beside `quantity` = accepted (lib/mri.mjs).
  receivedQty: { type: Number },
});

const challanSchema = new mongoose.Schema(
  {
    challanNo: { type: Number, required: true },
    // 'Sale' is SIGFA's SC, 'Purchase' its PC. Part of the unique key.
    type: { type: String, required: true, enum: ["Sale", "Purchase"] },
    date: { type: Date, required: true },

    // The party as they stood when the challan was made -- a snapshot, as on
    // an invoice (lib/buyerSnapshot.mjs).
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
    stateOfSupply: { type: String },
    stateCode: { type: String },

    items: [challanLineSchema],

    // SIGFA's Dsale: did this challan move the stock? Fixed once billed.
    stockEffect: { type: Boolean, default: true },

    // Derived from the lines on every write; stored so the list can filter.
    taxableAmount: { type: Number, default: 0 },
    gstAmount: { type: Number, default: 0 },
    totalAmount: { type: Number, default: 0 },
    status: { type: String, enum: ["pending", "partial", "billed"], default: "pending" },

    // The other side's own challan number (a supplier's challan against our
    // purchase challan), free text.
    partyChallanNo: { type: String },
    partyChallanDate: { type: Date },
    // "Enter Grno And Transport In Sale Challan", and the e-way bill SIGFA
    // asks for on a sale challan.
    transport: { type: String },
    vehicleNo: { type: String },
    grNo: { type: String },
    grDate: { type: Date },
    ewayBillNo: { type: String },
    ewayBillDate: { type: Date },
    shippedTo: { type: String },
    remarks: { type: String },

    // Purchase M.R.I. -- the same series as on purchase bills (lib/mri.mjs).
    mriNo: { type: Number },
    mriRemark: { type: String },
    againstMriNo: { type: Number },
    mriLock: { type: Number }, // see models/invoiceModel.js

    createdBy: { type: String },
    updatedBy: { type: String },
    editCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

challanSchema.index({ type: 1, status: 1, date: 1 });
challanSchema.index({ "customer.name": 1, type: 1, status: 1 });

challanSchema.plugin(tenantPlugin);

// Unique per FIRM and per kind, so sales challan 1 and purchase challan 1
// coexist -- SIGFA's MKEY + DocNo.
challanSchema.index({ companyId: 1, type: 1, challanNo: 1 }, { unique: true });
challanSchema.index(
  { companyId: 1, mriNo: 1 },
  { unique: true, partialFilterExpression: { mriNo: { $type: "number" } } }
);
challanSchema.index(
  { companyId: 1, againstMriNo: 1 },
  // One Re-MRI per MRI, as SIGFA's pending query assumes.
  { unique: true, partialFilterExpression: { againstMriNo: { $type: "number" } } }
);

export default mongoose.models.Challan || mongoose.model("Challan", challanSchema);
