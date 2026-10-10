import mongoose from "mongoose";
import { tenantPlugin } from "../lib/tenantPlugin.mjs";

const itemLedgerSchema = new mongoose.Schema({
  date: {
    type: Date,
    required: true,
  },
    itemName: {
    type: String,
    required: true,
  },
  invoiceNo: {
    type: String,
    required: true,
  },


  typeOfVoucher: {
    type: String,
    required: true,
  },
  partyName: {
    type: String,
    required: true,
  },
  receiptQuantity: {
    type: Number,
    default: 0,
  },
  issueQuantity: {
    type: Number,
    default: 0,
  },
  balanceQuantity: {
    type: Number,
    default: 0,
  },
});


// The stock report reads one item's rows in date order, and writing an
// invoice's stock rows deletes the previous ones by invoice number.
itemLedgerSchema.index({ itemName: 1, date: 1, _id: 1 });
itemLedgerSchema.index({ invoiceNo: 1 });
itemLedgerSchema.index({ partyName: 1 });

// Every row belongs to one firm. The plugin adds companyId, scopes every
// query to it, and stamps it onto everything created -- see lib/tenantPlugin.mjs.
itemLedgerSchema.plugin(tenantPlugin);

const ItemLedger =
  mongoose.models.ItemLedger || mongoose.model("ItemLedger", itemLedgerSchema);

export default ItemLedger;
