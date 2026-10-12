/**
 * The rules of the stock-kind backfill (scripts/backfill-stock-kind.mjs).
 *
 * Pure and dependency-free, so scripts/migrations.test.mjs runs it under bare
 * node. The script does the reading and the one write.
 */

/**
 * The rows the backfill stamps: those with no kind at all. A row carrying
 * 'FR', 'IS' or 'RS' never matches, so a rerun touches nothing and a goods
 * issue can never be relabelled a production entry.
 */
export const MISSING_KIND = Object.freeze({
  $or: [{ kind: { $exists: false } }, { kind: null }, { kind: "" }],
});

/** Would this row be stamped? The same test as MISSING_KIND, for fixtures. */
export const isMissingKind = (row) =>
  !row || !Object.prototype.hasOwnProperty.call(row, "kind") || row.kind === null || row.kind === "";

/**
 * Production numbers that would be held twice in one firm once the
 * unstamped rows become 'FR'.
 *
 *   unstamped   rows about to be stamped:  { _id, companyId, docNo }
 *   stamped     rows already 'FR':         { _id, companyId, docNo }
 *
 * Returns [{ companyId, docNo, ids }], one entry per clash, ids as strings.
 * Any entry means the (companyId, kind, docNo) unique index could not be
 * built over the result, so the script stops before writing anything.
 */
export function kindCollisions({ unstamped = [], stamped = [] } = {}) {
  const groups = new Map();
  for (const row of [...unstamped, ...stamped]) {
    const key = `${String(row?.companyId ?? "")}|${String(row?.docNo ?? "")}`;
    if (!groups.has(key)) groups.set(key, { companyId: String(row?.companyId ?? ""), docNo: row?.docNo ?? null, ids: [] });
    groups.get(key).ids.push(String(row?._id));
  }
  return [...groups.values()].filter((g) => g.ids.length > 1);
}
