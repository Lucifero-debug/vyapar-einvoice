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
    narration:{type:String}
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

// Every row belongs to one firm. The plugin adds companyId, scopes every
// query to it, and stamps it onto everything created -- see lib/tenantPlugin.mjs.
voucherSchema.plugin(tenantPlugin);

const Voucher = mongoose.models.Voucher || mongoose.model("Voucher", voucherSchema);

export default Voucher;
