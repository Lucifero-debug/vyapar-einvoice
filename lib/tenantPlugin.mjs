/**
 * The Mongoose plugin that makes every tenant collection scope itself.
 *
 * Applied to each tenant schema before its model is compiled. It does three
 * things:
 *
 *   1. adds a required, indexed `companyId`
 *   2. adds `companyId` to the filter of EVERY read, update and delete
 *   3. stamps `companyId` onto everything created
 *
 * So a route does not remember to scope its queries; it cannot forget. The one
 * thing a route must do is establish the tenant, and a route that does not
 * throws on its first query rather than returning somebody else's rows.
 *
 * WHY NOT EXPLICIT FILTERS EVERYWHERE
 * -----------------------------------
 * There were 135 model call sites across 49 files when this was written.
 * Adding `companyId` to each by hand is 135 chances to miss one, and a missed
 * filter is invisible until a customer sees another customer's ledger. This is
 * one place to get right instead of 135 to keep right.
 *
 * Deliberately thin: every decision lives in lib/tenantScope.mjs, which has no
 * Mongoose in it and is covered by the fixture test.
 */

import mongoose from "mongoose";
import { isUnscoped, requireTenant } from "./tenantContext.mjs";
import {
  FILTERED_HOOKS,
  aggregateMatch,
  scopeBulkOps,
  stampDocs,
} from "./tenantScope.mjs";

export function tenantPlugin(schema) {
  schema.add({
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "companies",
      required: true,
      index: true,
    },
  });

  // Reads, updates, deletes. `findById` is rewritten to `findOne` before
  // middleware runs, so it is covered here too -- and an id belonging to
  // another firm then returns null rather than their document.
  schema.pre(FILTERED_HOOKS, function tenantFilter() {
    if (isUnscoped()) return;
    this.where({ companyId: requireTenant(`${this.model?.modelName || "A"} query`) });
  });

  // Aggregations never reach the filter hooks.
  schema.pre("aggregate", function tenantMatch() {
    if (isUnscoped()) return;
    const id = requireTenant(`${this._model?.modelName || "An"} aggregation`);
    this.pipeline().unshift(
      aggregateMatch(id, (value) => new mongoose.Types.ObjectId(value))
    );
  });

  // Creates and saves. On `validate` rather than `save`, so a document that
  // somehow has no tenant fails with a clear message instead of being written
  // without one.
  schema.pre("validate", function tenantStamp() {
    if (this.companyId || isUnscoped()) return;
    this.companyId = requireTenant(`A new ${this.constructor?.modelName || "document"}`);
  });

  schema.pre("insertMany", function tenantStampMany(next, docs) {
    if (isUnscoped()) return next();
    try {
      stampDocs(docs, requireTenant("insertMany"));
      next();
    } catch (err) {
      next(err);
    }
  });

  schema.pre("bulkWrite", function tenantBulk(next, ops) {
    if (isUnscoped()) return next();
    try {
      scopeBulkOps(ops, requireTenant("bulkWrite"));
      next();
    } catch (err) {
      next(err);
    }
  });
}

export default tenantPlugin;
