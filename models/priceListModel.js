import mongoose from "mongoose";
import { tenantPlugin } from "../lib/tenantPlugin.mjs";

/**
 * One line of a party's price list, shaped like the row on the price-list
 * screen: Item Name | Unit | Sale Price | MRP | Discount %.
 *
 * `salePrice` and `mrp` are nullable on purpose. Blank means "use the item
 * master", which is not the same as zero -- an item priced at 0 is free, an
 * item with no price listed simply bills at its master rate.
 *
 * One discount per row, the same single percentage an invoice line carries.
 */
const priceListItemSchema = new mongoose.Schema({
  itemId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "items",
    required: true,
  },
  name: {
    type: String,
  },
  unit: {
    type: String,
  },
  salePrice: {
    type: Number,
    default: null,
    min: 0,
  },
  mrp: {
    type: Number,
    default: null,
    min: 0,
  },
  // No default: on an old list a default of 0 would mask the dis1-3 chain
  // below. cleanPriceListItems always writes it.
  discount: { type: Number, min: 0, max: 100 },

  // The three successive discounts the screen used to have. Left declared so
  // lists saved then still load (lib/priceList.mjs collapses them into
  // `discount`); nothing writes them any more.
  dis1: { type: Number, min: 0, max: 100 },
  dis2: { type: Number, min: 0, max: 100 },
  dis3: { type: Number, min: 0, max: 100 },

  // What `salePrice` was called before this screen grew its discount columns.
  // Left declared so lists saved then still load; nothing writes it any more.
  price: {
    type: Number,
    min: 0,
  },
}, { _id: false });

const priceListSchema = new mongoose.Schema({
  party: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "customers",
    required: [true, "Please select a party"],
  },
  // Snapshot of the party's name; the get route refreshes it from the party.
  partyName: {
    type: String,
  },
  date: {
    type: Date,
    required: [true, "Please provide a date"],
    default: Date.now,
  },
  items: {
    type: [priceListItemSchema],
    default: [],
  },
  remark: {
    type: String,
    trim: true,
  },
}, {
  timestamps: true,
});

priceListSchema.index({ party: 1, date: -1 });

// Every row belongs to one firm. The plugin adds companyId, scopes every
// query to it, and stamps it onto everything created -- see lib/tenantPlugin.mjs.
priceListSchema.plugin(tenantPlugin);

const PriceList = mongoose.models.pricelists || mongoose.model("pricelists", priceListSchema);

export default PriceList;
