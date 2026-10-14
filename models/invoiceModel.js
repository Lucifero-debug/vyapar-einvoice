import mongoose from 'mongoose';
import { tenantPlugin } from "../lib/tenantPlugin.mjs";

const itemSchema = new mongoose.Schema({
  name: { type: String, required: true },
  quantity: { type: Number, required: true },
  cost: { type: Number, required: true },
  discount: { type: Number, required: true },
  total: { type: Number, required: true },
  description: {type: String},
  hsn:{type:String},
  gstRate:{type:Number},
  taxableAmount:{type:Number},
  // Also sent on every save and also silently dropped until now. Readers
  // fall back to taxableAmount * gstRate, so nothing depended on it.
  gstAmount:{type:Number},
  // === Copied from the item master when this invoice was saved ===
  //
  // A snapshot, like the buyer block below: an item whose unit code is
  // corrected next year must not change the unit on a bill already reported.
  // Written by stampItemLines() in lib/uqc.mjs.
  uqc:{type:String},
  isService:{type:Boolean},
  // === Which order line this fulfils, if any ===
  //
  // All three or none. Sigfa's ORDERNO + OMKEY + OREFNO on their invoice
  // line, and the same reason for all three parts: an order number alone
  // cannot say WHICH line of it was billed, and two lines of the same item
  // on one order is ordinary. `orderLineId` is the order subdocument's own
  // _id, which order-alter preserves across an edit precisely so this keeps
  // pointing at the right line.
  //
  // Only lib/orderClaims.mjs acts on these. Declared here because Mongoose
  // strict mode drops what is not -- and a dropped reference would leave the
  // order permanently pending with no way to find out why.
  orderNo:{type:Number},
  orderType:{type:String},
  orderLineId:{type:String},
  // The order's OWN date, copied onto the line.
  //
  // Denormalised deliberately, like `uqc` and the buyer block: a printed bill
  // has to keep saying what it said, and an order whose date is corrected next
  // year must not change the date on an invoice already issued. It also means
  // the print can list every order a bill draws on -- with its date -- from
  // the lines alone, with no second query and no header array to keep in step.
  orderDate:{type:Date},
  // === Which challan line this bills, if any (SIGFA's Challan + ChRefNo) ===
  //
  // All three or none, like the order reference above. Only
  // lib/challanClaims.mjs acts on them.
  challanNo:{type:Number},
  challanType:{type:String},
  challanLineId:{type:String},
  // The challan's own date, copied for the print ("Challan No. / Date").
  challanDate:{type:Date},
  // Did that challan already move the stock (its stock effect)? Then this
  // line writes no stock row of its own. Set by the server FROM THE CHALLAN
  // (lib/challanStatus.mjs stampChallanStock), never from the screen.
  challanStock:{type:Boolean},
  // === Purchase M.R.I.: what came in (lib/mri.mjs) ===
  // `quantity` above is the ACCEPTED quantity -- billed, taxed and stocked as
  // always -- and this is what was received; the difference was rejected.
  // Set only on a bill that is an MRI (it has an `mriNo`).
  receivedQty:{type:Number}
});

const partyTaxSchema = new mongoose.Schema({
  name: { type: String, required: true },
  rate: { type: Number },
  Amount: { type: Number },
  total: { type: Number, required: true },
});

const invoiceSchema = new mongoose.Schema(
  {
    invoiceNo: { type: Number, required: true },
    // === The series this bill was raised under (Sigfa's Series Master) ===
    //
    // A LABEL, not part of the number. `invoiceNo` above is still this firm's
    // own sequence with a unique index on it, and lib/series.mjs records why a
    // series deliberately numbers nothing. Stored as the master's own
    // upper-cased code so a bill and its series cannot differ by spelling.
    //
    // Declared, or Mongoose strict mode drops it -- and a dropped series is a
    // bill that comes back with an empty Series box on every edit.
    series: { type: String, trim: true, default: "" },
    againstInvoiceNo: { type: Number },
    date: { type: Date, required: true },
    
customer: {
  type: {
    name: { type: String, required: true },
    phone: { type: String },
    email: { type: String },
    custId: { type: String },
    // === The buyer as they stood when this invoice was saved ===
    //
    // A SNAPSHOT, not a live lookup. Once an invoice has been reported to the
    // IRP, these are the details the government holds; a party who moves next
    // year must not retroactively change the address on a bill already filed.
    // Written by lib/buyerSnapshot.mjs in save-invoice and sale-alter.
    //
    // Declared in full because Mongoose strict mode drops what is not -- the
    // mistake that has cost this project five separate afternoons.
    gstin: { type: String },
    address: { type: String },
    city: { type: String },
    state: { type: String },
    pincode: { type: String },
    // The BUYER's own registered state. The place of supply is the
    // `stateCode` at the top level of this document, and on a bill where
    // they differ, swapping them is a wrong filing.
    stateCode: { type: String },
  },
  required: false
},
    // Declared in full. Only { hsn, amount } used to be here, so Mongoose
    // strict mode dropped the gstRate and total the form sends with every
    // row: the HSN summary on the printed bill then read them back as zero
    // and showed the tax as a negative taxable amount against a total of 0.
    hsnTotals: [
  {
    hsn: { type: String, required: true },
    gstRate: { type: Number },
    // The GST charged on this HSN group, not the taxable value.
    amount: { type: Number, required: true },
    total: { type: Number },
  }
],
    paymentType: { type: String },  // e.g. Cash / Cheque
    stateOfSupply: { type: String }, // e.g. Delhi
    // The GST state code of the state of supply, copied from the state master
    // when the bill is raised. Declared, or Mongoose strict mode drops it and
    // the printed bill has no code to show.
    stateCode: { type: String },
    taxType: { type: String },  // local / central
    gst: { type: Number },
    totalAmount: { type: Number, required: true },
    finalAmount: { type: Number, required: true },
    received: { type: Number, required: true },
    balanceDue: { type: Number, required: true },
      dispatchfrom: {
      name: { type: String },
    },
      billedTo: {
      name: { type: String },
    },

    // Where the goods went / came from, as typed on the form. These used to
    // exist only in the URL that carried the user to the print page, so they
    // were gone the moment that page was reloaded or the invoice reopened.
    shippedTo: { type: String },
    dispatchFrom: { type: String },

    items: [itemSchema],

    partyTaxes: [partyTaxSchema],
     transport: { type: String },         // Transport
    grNo: { type: String },              // Gr No.
    grDate: { type: Date },              // Date
    orderDate: { type: Date },              // Date
    pvtMark: { type: String },           // Pvt Mark
    caseDetails: { type: String },       // Case
    freight: { type: String },           // Freight
    weight: { type: Number },            // Weight
    // The BUYER'S OWN order reference, as typed on the bill -- their PO
    // number against our sale. Not to be confused with `items[].orderNo`,
    // which is one of OUR order documents (models/orderModel.js). They are
    // different things that happen to share a name: this one is whatever the
    // customer calls their paperwork, that one settles a pending quantity.
    // (The comment here used to read "// Weight", copied from the line above.)
    orderNo: { type: Number },
    // === The OTHER party's own bill number ===
    //
    // On a purchase, the number the SUPPLIER printed on the bill they sent:
    // "BS/2026-27/4417". Not a number, and not ours.
    //
    // `invoiceNo` above is this firm's own sequence, with a unique index on
    // { companyId, invoiceNo }. The AI import used to do
    // `parseInt(aiInvoice.invoiceNo)` and put the supplier's number there,
    // which collided with a real invoice when it parsed and wrote NaN into a
    // required field when it did not. There was nowhere else for it to go,
    // which is why this field exists.
    //
    // A String, because a bill number is an identifier and most of them
    // carry a series prefix, a financial year and slashes. The same
    // reasoning custModel gives for `phone` and `pincode`.
    //
    // Declared, or Mongoose strict mode drops it -- and a dropped supplier
    // bill number is a purchase you cannot find again when they chase it.
    partyBillNo: { type: String, trim: true },
    // === Purchase M.R.I. (SIGFA's MRINo / MRI Remark / Ag. MRI No.) ===
    // Its own series, shared with purchase challans and reserved by the
    // server (lib/mriSave.mjs). `againstMriNo` makes this a Re-MRI of an
    // earlier MRI's rejected material. lib/mri.mjs.
    mriNo: { type: Number },
    mriRemark: { type: String },
    againstMriNo: { type: Number },
    // Written by a Re-MRI raised against this one, so concurrent ones
    // conflict (lib/mriSave.mjs). Means nothing on its own.
    mriLock: { type: Number },
    ewayBillNo: { type: String },        // E-Way No.
    ewayBillDate: { type: Date },
    // === E-invoicing (IRN) ===
    //
    // Set only by the e-invoice routes, never by the billing form. Their
    // presence is what freezes the row: see lib/einvoiceLock.mjs. companyId is
    // NOT declared here -- tenantPlugin adds it (PROJECT_CONTEXT.md 6.14).
    irn: { type: String },
    ackNo: { type: String },
    ackDt: { type: Date },
    // The IRP's signed QR payload and signed invoice, both stored verbatim.
    // The QR is what gets printed; the signed invoice is the proof of what was
    // reported, and is worth keeping even though nothing reads it yet.
    signedQrCode: { type: String },
    signedInvoice: { type: String },
    einvoiceStatus: {
      type: String,
      enum: ["none", "generated", "cancelled", "failed"],
      default: "none",
    },
    einvoiceCancelledAt: { type: Date },
    einvoiceError: { type: String },
    // === Every time this bill was emailed ===
    //
    // Append-only, and written by `/api/send-email` AFTER the provider accepts
    // the message — never by the browser. "Did you send me the bill?" is a
    // daily question in a trading business and nothing could answer it before.
    //
    // `by` is the signed-in user from the session, not from the request body:
    // a log that records who sent something, where the sender is whoever the
    // request claimed to be, is worse than no log.
    //
    // Declared, or Mongoose strict mode drops it — and a dropped send log is a
    // feature that silently never records anything.
    emailLog: [
      {
        _id: false,
        to: [{ type: String }],
        cc: [{ type: String }],
        // The provider's own id, so a bounce can be traced back to this row.
        messageId: { type: String, default: "" },
        by: { type: String, default: "" },
        at: { type: Date },
      },
    ],
    // === Who raised this bill ===
    //
    // The signed-in user's id, from the session, written by save-invoice and
    // never accepted from a request (lib/invoiceInput.mjs PROTECTED_FIELDS).
    // It is what lets the double-submit check tell one clerk's double-click
    // from two clerks billing the same sale. Absent on bills raised before it
    // existed, which are simply never treated as duplicates.
    createdBy: { type: String },
    type:{ type: String, required: true },
    return:{type:Boolean,default:false}
  },
  { timestamps: true }
);


// The date-range print filters on date + type; delete-cust and the rename
// cascade look an invoice up by its party's name. invoiceNo already has a
// unique index from its field definition.
invoiceSchema.index({ date: 1, invoiceNo: 1 });
invoiceSchema.index({ type: 1, return: 1, date: 1 });
invoiceSchema.index({ "customer.name": 1 });
invoiceSchema.index({ "items.name": 1 });

// Every row belongs to one firm. The plugin adds companyId, scopes every
// query to it, and stamps it onto everything created -- see lib/tenantPlugin.mjs.
invoiceSchema.plugin(tenantPlugin);

// Which invoices billed a given order. Multikey over the items array, led by
// companyId like every other index here, so get-order answers "what has
// billed this?" without scanning the book. NOT unique -- one order is
// routinely billed by several invoices, which is the whole point of tracking
// a pending quantity.
invoiceSchema.index({ companyId: 1, "items.orderNo": 1, "items.orderType": 1 });
// And which invoices billed a given challan (get-challan's "Used In Invoice").
invoiceSchema.index({ companyId: 1, "items.challanNo": 1, "items.challanType": 1 });

// One MRI number per firm (the series is shared with purchase challans,
// whose own index does the same there; the counter keeps the two apart).
// Partial, so the many bills that are not MRIs do not collide on null.
invoiceSchema.index(
  { companyId: 1, mriNo: 1 },
  { unique: true, partialFilterExpression: { mriNo: { $type: "number" } } }
);
invoiceSchema.index(
  { companyId: 1, againstMriNo: 1 },
  // One Re-MRI per MRI, as SIGFA's pending query assumes.
  { unique: true, partialFilterExpression: { againstMriNo: { $type: "number" } } }
);

// Unique per FIRM. Globally unique invoice numbers meant the second firm to
// open could not write invoice 1.
invoiceSchema.index({ companyId: 1, invoiceNo: 1 }, { unique: true });

// One IRN can belong to exactly one invoice. A retry that reported the same
// bill twice would otherwise leave two rows claiming the same government
// record, which is the one e-invoice bug you cannot untangle afterwards.
// Partial rather than sparse: a sparse index still indexes an explicit
// `irn: null`, so every un-reported invoice would collide with every other.
invoiceSchema.index(
  { companyId: 1, irn: 1 },
  { unique: true, partialFilterExpression: { irn: { $type: "string" } } }
);

export default mongoose.models.Invoice || mongoose.model('Invoice', invoiceSchema);
