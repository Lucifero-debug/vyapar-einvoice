/**
 * The decisions the tenant plugin makes, with no Mongoose in sight.
 *
 * Split out so every rule here is exercised by `node scripts/tenant-scope.test.mjs`
 * under bare node. lib/tenantPlugin.mjs is then thin glue: it registers these
 * against Mongoose's hooks and does nothing else worth testing.
 */

/**
 * Every Mongoose query middleware that carries a filter.
 *
 * Listed in full rather than by prefix on purpose. A hook missing from this
 * list is a query shape that goes out unscoped, and the symptom would be one
 * customer reading another's rows -- so the list is spelled out where it can
 * be read and checked, not computed.
 */
export const FILTERED_HOOKS = [
  "count",
  "countDocuments",
  "deleteMany",
  "deleteOne",
  "distinct",
  "find",
  "findOne",
  "findOneAndDelete",
  "findOneAndReplace",
  "findOneAndUpdate",
  "replaceOne",
  "update",
  "updateMany",
  "updateOne",
];

/**
 * Query shapes that deliberately have no hook, with the reason.
 *
 * `findById` and friends are absent because Mongoose rewrites them into
 * `findOne` before middleware runs, so they are covered by that.
 * `estimatedDocumentCount` cannot be filtered at all -- it reads collection
 * metadata, not documents -- so it must never be used on a tenant collection.
 */
export const UNFILTERABLE = ["estimatedDocumentCount"];

/** The per-operation keys a bulkWrite may carry. */
export const BULK_OPS = [
  "insertOne",
  "updateOne",
  "updateMany",
  "deleteOne",
  "deleteMany",
  "replaceOne",
];

/**
 * Put `companyId` on each document about to be inserted, leaving any that
 * already names one alone -- the migration sets it explicitly.
 *
 * Mutates in place, because that is what the insertMany hook is handed.
 */
export function stampDocs(docs, companyId) {
  if (!companyId) throw new Error("stampDocs needs a company id.");
  for (const doc of docs || []) {
    if (doc && !doc.companyId) doc.companyId = companyId;
  }
  return docs;
}

/**
 * Scope every operation in a bulkWrite.
 *
 * bulkWrite carries a filter per operation rather than one on the query, so
 * `this.where()` cannot reach them -- each has to be rewritten. `companyId` is
 * applied last, so an operation that tried to name a different firm cannot
 * override it.
 */
export function scopeBulkOps(ops, companyId) {
  if (!companyId) throw new Error("scopeBulkOps needs a company id.");
  for (const op of ops || []) {
    if (!op) continue;
    for (const kind of BULK_OPS) {
      const body = op[kind];
      if (!body) continue;
      if (kind === "insertOne") {
        if (body.document && !body.document.companyId) body.document.companyId = companyId;
      } else {
        body.filter = { ...(body.filter || {}), companyId };
      }
    }
  }
  return ops;
}

/**
 * The `$match` stage to put at the front of an aggregation.
 *
 * `toObjectId` is passed in rather than imported so this file stays free of
 * Mongoose: an aggregation compares the raw stored value, which is an
 * ObjectId, so a plain string would match nothing and silently return an empty
 * report rather than erroring.
 */
export function aggregateMatch(companyId, toObjectId) {
  if (!companyId) throw new Error("aggregateMatch needs a company id.");
  if (typeof toObjectId !== "function") {
    throw new Error("aggregateMatch needs an ObjectId caster.");
  }
  return { $match: { companyId: toObjectId(companyId) } };
}
