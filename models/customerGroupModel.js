import mongoose from "mongoose";
import { tenantPlugin } from "../lib/tenantPlugin.mjs";

// Re-exported so the routes can reach it from the model they already import.
export { RESERVED_GROUPS, isReservedGroup } from "../lib/customerGroups.mjs";

/**
 * The list of groups a party can belong to — Sundry Debtors, Sundry Creditors,
 * Cash, Bank, and whatever else the business uses.
 *
 * `customers.group` holds the group's NAME, not a reference, because that is
 * how the rest of the app already reads it: `lib/cashAccount.mjs` resolves an
 * invoice's cash or bank account with `group: /^cash$/i`. Renaming a group
 * therefore has to cascade to every customer in it — see api/group-update.
 */
const customerGroupSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Please provide a group name"],
      trim: true,
    },
    note: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true }
);

// NOTE: no `schema.index({ name: 1 })` here. `unique: true` on the field above
// already builds that index, and declaring it twice makes Mongoose 8 throw
// "Schema already has an index on {name:1}" when the model is first evaluated —
// which took the whole route down with a 500.

// Every row belongs to one firm. The plugin adds companyId, scopes every
// query to it, and stamps it onto everything created -- see lib/tenantPlugin.mjs.
customerGroupSchema.plugin(tenantPlugin);

// Unique per FIRM: two unrelated shops may both have a "Retail" group.
customerGroupSchema.index({ companyId: 1, name: 1 }, { unique: true });

const CustomerGroup =
  mongoose.models.customergroups ||
  mongoose.model("customergroups", customerGroupSchema);

export default CustomerGroup;
