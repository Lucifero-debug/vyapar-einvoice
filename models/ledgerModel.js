import mongoose from "mongoose";
import { tenantPlugin } from "../lib/tenantPlugin.mjs";

const ledgerSchema = new mongoose.Schema({
  customerName: {
    type: String,
  },
  date: {
    type: Date,
  },
  account: {
    type: String, // The acName from Voucher
  },
  paymentType: {
    type: String, // cash/bank etc.
  },
  debit: {
    type: Number,
    default: 0,
  },
  credit: {
    type: Number,
    default: 0,
  },
  balance: {
    type: Number,
    default: 0,
  },
    narration: {
    type: String, 
  },
  voucherId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Voucher",
  },
}, {
  timestamps: true,
});


// Every ledger report groups by customerName, and `recomputeLedgerBalances`
// runs a sorted find per account on EVERY save. Unindexed these were full
// collection scans. voucherId is how an invoice or voucher finds its own rows
// to delete, which happens on every edit and delete.
ledgerSchema.index({ customerName: 1, date: 1, _id: 1 });
ledgerSchema.index({ voucherId: 1 });
ledgerSchema.index({ account: 1 });

// Every row belongs to one firm. The plugin adds companyId, scopes every
// query to it, and stamps it onto everything created -- see lib/tenantPlugin.mjs.
ledgerSchema.plugin(tenantPlugin);

const Ledger = mongoose.models.Ledger || mongoose.model("Ledger", ledgerSchema);

export default Ledger;
