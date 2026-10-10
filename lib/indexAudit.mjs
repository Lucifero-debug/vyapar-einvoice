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
export const missingTenantUniques = (declared = [], actual = []) => {
  const present = new Set(actual.map((i) => keySignature(i.key)));
  return declared
    .filter(([key, options]) => options?.unique && Object.keys(key || {})[0] === "companyId")
    .map(([key]) => key)
    .filter((key) => !present.has(keySignature(key)));
};
