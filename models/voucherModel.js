import mongoose from "mongoose";
import { tenantPlugin } from "../lib/tenantPlugin.mjs";

const voucherSchema = new mongoose.Schema({
  acName: {
    type: String,
    required: [true, "Please provide an Ac Name"],
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

// Every row belongs to one firm. The plugin adds companyId, scopes every
// query to it, and stamps it onto everything created -- see lib/tenantPlugin.mjs.
voucherSchema.plugin(tenantPlugin);

const Voucher = mongoose.models.Voucher || mongoose.model("Voucher", voucherSchema);

export default Voucher;
