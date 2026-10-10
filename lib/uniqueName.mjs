/**
 * One rule for "a master cannot hold the same name twice".
 *
 * WHY IT HAS TO BE CASE-INSENSITIVE
 * ---------------------------------
 * Every master in this app is joined BY NAME, not by reference: ledger rows
 * carry `customerName`, stock rows carry `itemName`, items carry an HSN `code`,
 * customers carry a group `name`. Two records differing only in case are two
 * records to Mongo but one account to a human, so their history silently splits
 * in half and neither view is right.
 *
 * The guards were inconsistent: `customer-add` and `item-add` compared with
 * collation, while `customer-alter`, `item-alter`, `hsn-add` and `hsn-update`
 * compared exactly — so a name blocked on create could be reached by renaming.
 *
 * Takes the model as an argument rather than importing it, so the pure parts
 * run under bare node in the tests.
 */

/** What actually gets stored: trimmed, inner spacing left alone. */
export const normalizeName = (value) => String(value ?? "").trim();

/** Two names are the same record when these match. */
export const nameKey = (value) => normalizeName(value).toLowerCase();

/**
 * The existing record that would collide, or null.
 *
 * `excludeId` leaves the record being edited out of its own comparison, so
 * re-saving a party without touching its name is not a clash.
 */
export async function findNameClash(
  Model,
  field,
  value,
  { excludeId, session } = {}
) {
  const name = normalizeName(value);
  if (!name) return null;

  const filter = { [field]: name };
  if (excludeId) filter._id = { $ne: excludeId };

  let query = Model.findOne(filter, { _id: 1, [field]: 1 });
  if (session) query = query.session(session);

  // strength: 2 compares letters but not case or accents. Without an index to
  // match it this is a scan, which is fine for a master of this size.
  return query.collation({ locale: "en", strength: 2 }).lean();
}

/**
 * Records that already share a name, for the duplicate report.
 *
 * Returns [{ key, name, records: [...] }] for every name held more than once.
 */
export function findDuplicates(records = [], field = "name") {
  const buckets = new Map();

  for (const record of records) {
    const k = nameKey(record?.[field]);
    if (!k) continue;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(record);
  }

  const out = [];
  for (const [k, group] of buckets) {
    if (group.length < 2) continue;
    out.push({
      key: k,
      name: normalizeName(group[0][field]),
      // The spellings actually stored, so a report can show "Cash" vs "cash".
      spellings: [...new Set(group.map((r) => normalizeName(r[field])))],
      records: group,
    });
  }

  return out.sort((a, b) => a.key.localeCompare(b.key));
}
