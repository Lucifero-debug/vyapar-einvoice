/**
 * Which indexes make a shared instance behave as if it were one firm.
 *
 * THE BUG THIS EXISTS FOR
 *
 * Every unique index on a tenant collection is declared per firm --
 * `{ companyId: 1, invoiceNo: 1 }`, not `{ invoiceNo: 1 }`. The schemas were
 * changed to that during the multi-tenancy work. But **MongoDB does not drop
 * an index because a schema stopped declaring it**: Mongoose's autoIndex
 * creates what is missing and never retires what is obsolete. So the old
 * global `invoiceNo_1` sat there afterwards, still unique across every firm,
 * and the second firm to open could not write invoice 1.
 *
 * The symptom is a duplicate-key error that makes no sense to the user: they
 * have never used that invoice number, because somebody else did.
 *
 * Pure, so the audit can be tested without a database.
 */

/** The index Mongo maintains on every collection. Never ours to touch. */
export const ID_INDEX = "_id_";

const keysOf = (index) => Object.keys(index?.key || {});

/**
 * Is this a unique index that spans every firm?
 *
 * Unique and NOT led by companyId. The leading field is what matters: an index
 * on `{ companyId: 1, invoiceNo: 1 }` is unique per firm, which is what we
 * want, while `{ invoiceNo: 1, companyId: 1 }` would be unique globally on
 * invoiceNo for any document missing companyId -- so the order is the whole
 * question, not merely whether companyId appears somewhere.
 */
export const isGlobalUnique = (index) => {
  if (!index || index.name === ID_INDEX) return false;
  if (!index.unique) return false;
  const keys = keysOf(index);
  if (keys.length === 0) return false;
  return keys[0] !== "companyId";
};

/** Is this the per-firm shape we expect to keep? */
export const isTenantScoped = (index) => keysOf(index)[0] === "companyId";

/**
 * The indexes on one collection that have to go, and the ones that stay.
 *
 * `indexes` is what `collection.indexes()` returns.
 */
export const auditIndexes = (indexes = []) => {
  const drop = [];
  const keep = [];
  for (const index of indexes) {
    (isGlobalUnique(index) ? drop : keep).push(index);
  }
  return { drop, keep };
};

/**
 * The fields a dropped global index used to protect, so the caller can check
 * for duplicates WITHIN a firm before the per-firm index tries to build.
 *
 * This matters: if two rows in the same firm already share an invoice number,
 * dropping the old index and letting autoIndex create the new one fails
 * silently at startup, and the collection ends up with no protection at all.
 */
export const protectedFields = (index) =>
  keysOf(index).filter((k) => k !== "companyId");

/** A human line for a report. */
export const describeIndex = (index) => {
  const keys = keysOf(index)
    .map((k) => `${k}: ${index.key[k]}`)
    .join(", ");
  const flags = [
    index.unique ? "unique" : null,
    index.sparse ? "sparse" : null,
    index.partialFilterExpression ? "partial" : null,
  ].filter(Boolean);
  return `${index.name}  { ${keys} }${flags.length ? `  [${flags.join(", ")}]` : ""}`;
};

/* -------------------------------------------- the ones that must be present -- */

/** An index's keys as a comparable string: order matters, so this keeps it. */
export const keySignature = (key = {}) =>
  Object.entries(key)
    .map(([field, direction]) => `${field}:${direction}`)
    .join(",");

/**
 * Per-firm unique indexes a schema declares but the database does not have.
 *
 * WHY THIS IS CHECKED
 *
 * Dropping the old global index is only half the job. If the per-firm
 * replacement is missing -- autoIndex turned off, or it failed to build
 * because of duplicates -- the collection ends up with NO uniqueness
 * protection, and two invoices in one firm can take the same number. That is
 * a quieter failure than the one being fixed and a worse one, so it is worth
 * a check of its own rather than a hopeful "restart the app".
 *
 * @param declared  what `schema.indexes()` returns: [keyObject, options] pairs
 * @param actual    what `collection.indexes()` returns
 */
export const missingTenantUniques = (declared = [], actual = []) =>
  declared
    .filter(([key, options]) => options?.unique && Object.keys(key || {})[0] === "companyId")
    .filter(([key, options]) => !actual.some((index) => satisfies(index, key, options)))
    .map(([key]) => key);

/* -------------------------------------- an index is its key AND options -- */

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const collationOf = (c) => (c ? { locale: c.locale, strength: c.strength ?? 3 } : null);

/**
 * Does this existing index do what the declaration asks?
 *
 * The key alone is not enough. A NON-unique `companyId_1_invoiceNo_1` has the
 * declared key and protects nothing; an `{ companyId, irn }` built sparse
 * instead of partial refuses every unreported invoice. Both used to pass as
 * "present" -- and the first would have let the global index be dropped with
 * no uniqueness left at all.
 */
export const satisfies = (index, key, options = {}) =>
  Boolean(index) &&
  keySignature(index.key) === keySignature(key) &&
  Boolean(index.unique) === Boolean(options?.unique) &&
  same(index.partialFilterExpression, options?.partialFilterExpression) &&
  Boolean(index.sparse) === Boolean(options?.sparse) &&
  same(collationOf(index.collation), collationOf(options?.collation));

/**
 * Declared unique indexes whose key exists in the database with DIFFERENT
 * options. `createIndex` refuses to build over one ("an index with the same
 * key but different options already exists"), and neither can be called
 * present, so the script stops and a person decides which is right.
 */
export const indexConflicts = (declared = [], actual = []) => {
  const out = [];
  for (const [key, options] of declared) {
    if (!options?.unique) continue;
    for (const index of actual) {
      if (keySignature(index?.key) !== keySignature(key)) continue;
      if (!satisfies(index, key, options)) out.push({ key, options, index });
    }
  }
  return out;
};

/* ------------------------------------------- stale per-firm indexes too -- */

const declaredUniqueSignatures = (declared = []) =>
  new Set(
    declared
      .filter(([, options]) => options?.unique)
      .map(([key]) => keySignature(key))
  );

/**
 * Unique indexes in the database that the schema no longer declares.
 *
 * `isGlobalUnique` catches the first generation of the bug -- `invoiceNo_1`,
 * unique across every firm. It cannot catch the second: a unique index that
 * IS led by companyId but has since been replaced by a finer one. Stock
 * vouchers were unique on (companyId, docNo) before they gained a kind; the
 * schema now declares (companyId, kind, docNo), and while the old index
 * survives, Goods Issue 5 and Production 5 still cannot both exist in one
 * firm -- the very thing the new index was written to allow.
 *
 * So: every unique index whose key the schema does not declare, whoever leads
 * it. `_id_` is never one. A collection with no model (nothing declared) is
 * left to the global-unique rule alone, rather than having every unique index
 * on it called stale.
 */
export const staleUniques = (actual = [], declared = [], { hasModel = true } = {}) => {
  const wanted = declaredUniqueSignatures(declared);
  return actual.filter((index) => {
    if (!index || index.name === ID_INDEX || !index.unique) return false;
    // Same key as a declared unique, different options: a CONFLICT, which
    // `indexConflicts` reports. Not this list's business.
    if (wanted.has(keySignature(index.key))) return false;
    if (isGlobalUnique(index)) return true;
    return hasModel;
  });
};

/**
 * The declared per-firm unique index that takes over from a stale one, or null.
 *
 * It must be led by companyId, be unique, cover every field the stale index
 * protected (a finer key -- adding `kind` or `type` -- is the intended
 * replacement; a key that drops one of the fields is not), and be PRESENT in
 * `actual`. Dropping a stale index is only safe once its replacement has been
 * built; the caller passes the index list as it stands after building.
 */
export const replacementFor = (stale, declared = [], actual = []) => {
  const needs = protectedFields(stale);
  for (const [key, options] of declared) {
    if (!options?.unique) continue;
    const fields = Object.keys(key || {});
    if (fields[0] !== "companyId") continue;
    if (!needs.every((f) => fields.includes(f))) continue;
    // Present means present AS DECLARED: unique, same partial filter.
    if (!actual.some((index) => satisfies(index, key, options))) continue;
    return { key, options };
  }
  return null;
};

/**
 * The aggregation that finds rows a unique index would refuse to build over.
 *
 * Same scope as the index: a partial index only constrains the rows its
 * filter selects, a sparse one only rows that have the fields. Missing fields
 * group as null, exactly as a non-sparse unique index treats them. Returns at
 * most `limit` groups, each with up to five `_id`s to look at -- identifiers,
 * not the documents.
 */
export const duplicatePipeline = (key = {}, options = {}, { limit = 20 } = {}) => {
  const fields = Object.keys(key);
  const match = {};
  if (options?.partialFilterExpression) Object.assign(match, options.partialFilterExpression);
  // A sparse compound index holds a row that has ANY of its fields.
  if (options?.sparse) match.$or = fields.map((f) => ({ [f]: { $exists: true } }));
  // A case-insensitive index (collation strength 1 or 2) treats "Acme" and
  // "acme" as one key, so the check must too.
  const folds = options?.collation && (options.collation.strength ?? 3) <= 2;
  const group = {};
  for (const f of fields) {
    // $ifNull: in $group a MISSING field is left out of the key while an
    // explicit null is kept, so the two would land in different groups --
    // but the unique index treats them as the same key.
    const value = { $ifNull: [`$${f}`, null] };
    group[f.replace(/\./g, "_")] = folds && f !== "companyId" ? { $toLower: value } : value;
  }
  return [
    ...(Object.keys(match).length ? [{ $match: match }] : []),
    { $group: { _id: group, n: { $sum: 1 }, ids: { $push: "$_id" } } },
    { $match: { n: { $gt: 1 } } },
    { $sort: { n: -1 } },
    { $limit: limit },
    { $project: { _id: 1, n: 1, ids: { $slice: ["$ids", 5] } } },
  ];
};

/** The options a declared index is built with: only what the schema said. */
export const buildOptions = (options = {}) => {
  const out = {};
  for (const k of ["unique", "partialFilterExpression", "sparse", "name", "collation"]) {
    if (options[k] !== undefined) out[k] = options[k];
  }
  return out;
};
