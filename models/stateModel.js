import mongoose from "mongoose";
import { tenantPlugin } from "../lib/tenantPlugin.mjs";

/**
 * A state or union territory and its GST state code.
 *
 * The code is the first two digits of a GSTIN and decides whether a supply is
 * intra-state (CGST + SGST) or inter-state (IGST), so BOTH fields are unique:
 * two records for one code, or one name, would make the lookup ambiguous.
 *
 * `code` is a String on purpose — Delhi is "07", and a Number drops the zero.
 */
const stateSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Please provide a state name"],
      trim: true,
    },
    code: {
      type: String,
      required: [true, "Please provide a GST state code"],
      trim: true,
    },
  },
  { timestamps: true }
);

// No explicit .index() calls: `unique: true` on each field already builds one,
// and declaring it twice makes Mongoose 8 throw at module load.

// Every row belongs to one firm. The plugin adds companyId, scopes every
// query to it, and stamps it onto everything created -- see lib/tenantPlugin.mjs.
stateSchema.plugin(tenantPlugin);

// Unique per FIRM: every firm seeds its own copy of the state master.
stateSchema.index({ companyId: 1, name: 1 }, { unique: true });
stateSchema.index({ companyId: 1, code: 1 }, { unique: true });

const State = mongoose.models.states || mongoose.model("states", stateSchema);

export default State;
