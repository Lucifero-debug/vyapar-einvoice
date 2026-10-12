import mongoose from "mongoose";
import { tenantPlugin } from "../lib/tenantPlugin.mjs";

/**
 * A low-stock alert that persists: raised once per item while the item stays
 * low, resolved when it recovers. The rules are lib/stockAlerts.mjs; the
 * writes are lib/stockAlertSync.mjs.
 *
 * Every field is set by the server -- there is no route that creates or edits
 * one from a request body. The only thing a person does to an alert is
 * acknowledge it, and `acknowledgedBy` comes from the session.
 */
const stockAlertSchema = new mongoose.Schema(
  {
    itemName: { type: String, required: true, trim: true },
    // lib/dashboard.mjs's STOCK_REASONS.
    reason: { type: String, enum: ["below", "out", "negative"], required: true },
    quantity: { type: Number, default: 0 },
    // The minimum it was measured against; null when the item has none set
    // (then only "out" and "negative" can raise it).
    minimum: { type: Number, default: null },
    unit: { type: String, default: "" },
    status: { type: String, enum: ["open", "resolved"], default: "open", required: true },
    raisedAt: { type: Date, required: true },
    // When the reason or the figures last moved -- not every time the
    // dashboard was opened.
    lastChangedAt: { type: Date },
    resolvedAt: { type: Date, default: null },
    acknowledgedAt: { type: Date, default: null },
    acknowledgedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

stockAlertSchema.plugin(tenantPlugin);

// THE de-duplication rule: at most one OPEN alert per item per firm. Partial,
// so any number of resolved ones can sit in the history. A second dashboard
// raising the same alert at the same instant hits this index instead of
// writing a duplicate. Created by Mongoose's autoIndex (on by default), and by
// `npm run sync:indexes -- --apply`, which builds every declared unique index
// that is missing (after checking the data for duplicates).
stockAlertSchema.index(
  { companyId: 1, itemName: 1 },
  { unique: true, partialFilterExpression: { status: "open" }, name: "one_open_alert_per_item" }
);
stockAlertSchema.index({ companyId: 1, status: 1, raisedAt: -1 });

export default mongoose.models.StockAlert || mongoose.model("StockAlert", stockAlertSchema);
