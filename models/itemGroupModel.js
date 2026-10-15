import mongoose from "mongoose";
import { tenantPlugin } from "../lib/tenantPlugin.mjs";

/**
 * The categories goods are filed under — Sigfa's `Masters > Item Group`.
 *
 * SEPARATE FROM THE ACCOUNTS GROUPS. models/customerGroupModel.js holds the
 * groups a PARTY belongs to, with reserved names that invoices use to find
 * the cash or bank account they settle into. Nothing here is load-bearing for
 * the ledger: an item group is a shelf. They were one shared list until this
 * model existed, which is why "Sundry Debtors" was offered as a category of
 * goods — lib/itemGroups.mjs records that under TWO GROUP MASTERS.
 *
 * `items.group` holds the NAME, not a reference, because that is how every
 * report that groups goods already reads it. A rename therefore cascades —
 * see api/item-group-update — and a group still in use cannot be deleted.
 */
const itemGroupSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Please provide a group name"],
      trim: true,
    },

    // Sigfa's `Main Group  Yes/No`. A main group is a top of the tree and
    // sits under nothing; any other group names its parent below.
    //
    // Declared, like every field here, or Mongoose strict mode drops it — and
    // a dropped flag is a group that silently rejoins the tree.
    mainGroup: {
      type: Boolean,
      default: false,
    },

    // The parent's NAME, for the same reason an item holds its group's name.
    // Always "" on a main group: lib/itemGroups.mjs clears it rather than
    // carrying a parent a row no longer uses.
    underGroup: {
      type: String,
      trim: true,
      default: "",
    },

    remark: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { timestamps: true }
);

// Every row belongs to one firm. The plugin adds companyId, scopes every
// query to it, and stamps it onto everything created -- see lib/tenantPlugin.mjs.
itemGroupSchema.plugin(tenantPlugin);

// Unique per FIRM: two unrelated shops may both keep a "Hardware" group.
// Not globally, which is how the first firm to use a name would take it from
// everybody else.
itemGroupSchema.index({ companyId: 1, name: 1 }, { unique: true });

// The tree is walked downwards on a rename and on a delete refusal, so the
// parent is worth an index of its own.
itemGroupSchema.index({ companyId: 1, underGroup: 1 });

const ItemGroup =
  mongoose.models.itemgroups || mongoose.model("itemgroups", itemGroupSchema);

export default ItemGroup;
