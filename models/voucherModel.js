import mongoose from "mongoose";
import { tenantPlugin } from "../lib/tenantPlugin.mjs";
import { VOUCHER_KINDS, VOUCHER_KIND_CODES } from "../lib/voucherKinds.mjs";
import { JOURNAL_TYPE_CODES } from "../lib/journalTypes.mjs";

const voucherSchema = new mongoose.Schema({
  /*
    Receipt, Payment, Journal or Contra -- lib/voucherKinds.mjs.

    ABSENT on every entry saved before the four kinds existed, and nothing
    backfills it: `kindOf` reads an absent one off the figures, the same way
    stockVoucher reads an absent MKEY as Production. So no `default` here
    either -- a default would stamp a guess on the next save of an old row
    and turn a reading into a stored fact.
  */
  kind: {
    type: String,
    enum: VOUCHER_KIND_CODES,
  },
  /*
    The cash or bank account the money moved through. Required for the three
    kinds that move money and absent for a journal, which moves none -- a
    journal carrying one would post a cash leg for an adjustment that never
    touched cash.

    Not required for the two notes either, since their "Booked to" box was
    removed (18 Oct 2026): the head is one of the lines. Old notes keep the
    one they were saved with. An absent kind is an entry from before kinds
    existed -- always a receipt or a payment -- so it is still required.
  */
  acName: {
    type: String,
    required: [
      function () {
        const spec = VOUCHER_KINDS[this.kind];
        return spec ? spec.needsAccount : true;
      },
      "Please provide an Ac Name",
    ],
  },
   date: { type: Date }, 

customers: [
  {
    name: { type: String, required: true },
    debit: { type: Number, default: 0 },
    credit: { type: Number, default: 0 },
    custId:{type:String},
    // Per-line narration. Both routes send it and it is written onto the
    // ledger rows; without it declared here, strict mode dropped it and every
    // edit re-saved the voucher with blank narrations.
    narration:{type:String},
    // === Which bills this line settles ===
    //
    // Sigfa's "Against Bill": its OUTBILL1 table holds the same thing, a
    // voucher-to-bill link with an amount. Declared in full, or Mongoose
    // strict mode drops the array and every adjustment is lost on save --
    // the mistake that has cost this project seven separate afternoons.
    //
    // They live HERE, on the line that paid, rather than as a counter on the
    // invoice. That is what makes `outstanding` derivable and the whole
    // OUTBILL table unnecessary: deleting the voucher removes its
    // allocations in the same write, so there is no stored figure that can
    // drift and nothing to reverse. See the note atop lib/billAdjust.mjs for
    // why the order module needed the opposite arrangement.
    allocations:[
      {
        // Type AND number: sale 7 and purchase 7 are different bills.
        invoiceNo:{type:Number, required:true},
        invoiceType:{type:String},
        // The bill's own date, copied. Same reason as every other snapshot
        // here: a printed adjustment has to keep saying what it said.
        invoiceDate:{type:Date},
        amount:{type:Number, required:true},
        _id:false,
      }
    ]
  }
],
  /*
    Sigfa's `Type` box at the top of the Journal screen: a general journal,
    or `Expense With GST`. lib/journalTypes.mjs.

    NO DEFAULT, and for the same reason `kind` above has none: an entry saved
    before this field existed has none, `journalTypeOf` reads an absent one
    as the general journal, and a default would stamp that reading onto an
    old voucher the next time it was saved.
  */
  journalType: {
    type: String,
    enum: JOURNAL_TYPE_CODES,
  },

  /*
    === The one expense an `Expense With GST` journal carries ===

    Sigfa prints "Only One Entry Per Voucher" under that grid, so this is a
    single block rather than an array. The LINES it expands into are written
    to `customers` above like any other journal's, so the ledger, the trial
    balance and the delete path need to know nothing about expenses.

    WHY THE TAX IS STORED AND NOT RECOMPUTED. The figures here were claimed
    as input credit against a supplier's document on a date. Recomputing them
    at read time from the party's CURRENT state would re-decide the place of
    supply of a credit already filed -- the same hazard lib/invoicePrefs.mjs
    draws the line at for invoice numbering, and a sharper one, because this
    is a figure on a return. So `taxType` and the three amounts are frozen
    when the voucher is saved.

    Every field is declared. Mongoose strict mode drops what is not, and a
    dropped GSTIN is an input credit with nothing behind it.
  */
  expense: {
    party: { type: String, trim: true, default: "" },
    expenseAccount: { type: String, trim: true, default: "" },
    taxable: { type: Number, default: 0 },
    gstRate: { type: Number, default: 0 },
    // "local" or "central", decided once, from lib/gst.mjs's taxTypeFor.
    // Never defaulted: a voucher with tax and no tax type is refused before
    // it is written, not saved with a guess.
    taxType: { type: String, trim: true, default: "" },
    cgst: { type: Number, default: 0 },
    sgst: { type: Number, default: 0 },
    igst: { type: Number, default: 0 },
    // What the supplier is owed: the expense plus its tax.
    total: { type: Number, default: 0 },
    // What the credit is claimed AGAINST. Without these three there is
    // nothing for the return to point at, which is why the rules refuse a
    // taxed expense that is missing any of them.
    supplierGstin: { type: String, trim: true, uppercase: true, default: "" },
    billNo: { type: String, trim: true, default: "" },
    // Kept as the "YYYY-MM-DD" string the date box holds, NOT a Date: a
    // date-only value parsed as UTC midnight reads as the day before
    // anywhere west of Greenwich, and this one dates a tax claim.
    billDate: { type: String, trim: true, default: "" },
    sac: { type: String, trim: true, default: "" },
    _id: false,
  },

   narration: { type: String },
   paymentType: { type: String },
againstBill:{type:Boolean,default:false},
  acType: {
    type: String,
  },
}, {
  timestamps: true,
});


// delete-cust checks both of these before letting a party go.
voucherSchema.index({ acName: 1 });
voucherSchema.index({ "customers.name": 1 });
voucherSchema.index({ date: 1 });

// "What has been settled against this bill?" -- asked every time the bill
// picker opens and again when a voucher saves, so it must not be a scan.
// Multikey over the nested allocations array.
voucherSchema.index({ "customers.allocations.invoiceNo": 1, "customers.allocations.invoiceType": 1 });

// The GST return asks for one period's expense vouchers and nothing else, so
// it must not scan the whole voucher book to find them. Partial, on the type
// being present at all: every voucher saved before this field existed has
// none, and they are exactly the ones the return is not looking for.
voucherSchema.index(
  { companyId: 1, journalType: 1, date: 1 },
  { partialFilterExpression: { journalType: { $type: "string" } } }
);

// Every row belongs to one firm. The plugin adds companyId, scopes every
// query to it, and stamps it onto everything created -- see lib/tenantPlugin.mjs.
voucherSchema.plugin(tenantPlugin);

const Voucher = mongoose.models.Voucher || mongoose.model("Voucher", voucherSchema);

export default Voucher;
