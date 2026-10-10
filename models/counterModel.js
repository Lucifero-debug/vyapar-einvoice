// models/counterModel.js
import mongoose from 'mongoose';
import { tenantPlugin } from "../lib/tenantPlugin.mjs";

const counterSchema = new mongoose.Schema({
  name: { type: String, required: true },
  value: { type: Number, default: 1 },
});

// Every row belongs to one firm. The plugin adds companyId, scopes every
// query to it, and stamps it onto everything created -- see lib/tenantPlugin.mjs.
counterSchema.plugin(tenantPlugin);

// Unique per FIRM, so each firm's invoice numbering runs independently.
counterSchema.index({ companyId: 1, name: 1 }, { unique: true });

const Counter = mongoose.models.Counter || mongoose.model('Counter', counterSchema);

export default Counter;
