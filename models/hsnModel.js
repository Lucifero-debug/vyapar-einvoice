import mongoose from "mongoose";
import { tenantPlugin } from "../lib/tenantPlugin.mjs";

const hsnSchema = new mongoose.Schema({
  hsncode: {
    type: String,
    required: [true, "Please provide an HSN Code"],
    trim: true,
  },
  hsnname: {
    type: String,
  },
  gst: {
    type: Number,
  },
  gstunit: {
    type: String,
  },
}, {
  timestamps: true,
});

// Every row belongs to one firm. The plugin adds companyId, scopes every
// query to it, and stamps it onto everything created -- see lib/tenantPlugin.mjs.
hsnSchema.plugin(tenantPlugin);

// Unique per FIRM, not globally. A global unique meant the first firm to use
// an HSN code took it from everybody else.
hsnSchema.index({ companyId: 1, hsncode: 1 }, { unique: true });

const HSN = mongoose.models.hsn || mongoose.model("hsn", hsnSchema);

export default HSN;
