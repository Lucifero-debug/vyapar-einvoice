/**
 * Which party groups the app itself depends on.
 *
 * An invoice settles whatever was paid at the counter into an account it finds
 * by group: `lib/cashAccount.mjs` matches `group: /^cash$/i` for cash and
 * `/^bank$/i` for anything else. Rename or delete either group and a part-paid
 * sale has nowhere to post its receipt leg.
 *
 * So the group master treats these two as fixed. Kept here, free of Mongoose,
 * because the master dialog is a client component and must not pull a database
 * driver into the browser bundle.
 */

export const RESERVED_GROUPS = ["Cash", "Bank"];

/** Case- and whitespace-insensitive: the resolver matches that way too. */
export const isReservedGroup = (name) =>
  RESERVED_GROUPS.some(
    (g) => g.toLowerCase() === String(name || "").trim().toLowerCase()
  );

/** Case- and whitespace-insensitive identity, matching how the routes compare. */
const key = (name) => String(name || "").trim().toLowerCase();

/**
 * The groups a seed run should create: every distinct one already in use, plus
 * the reserved pair, minus whatever the master already holds.
 *
 * `inUse` accepts either bare names (what `distinct("group")` returns) or
 * customer-shaped objects, so callers need not reshape it.
 */
export function planSeed({ inUse = [], existing = [] } = {}) {
  const have = new Set(existing.map((g) => key(g.name)));
  const out = [];
  const seen = new Set();

  // Reserved first, so a fresh database gets them in a predictable order.
  const candidates = [
    ...RESERVED_GROUPS,
    ...inUse.map((c) => (typeof c === "string" ? c : c?.group)),
  ];

  for (const raw of candidates) {
    const name = String(raw || "").trim();
    if (!name) continue;
    const k = key(name);
    if (have.has(k) || seen.has(k)) continue;
    seen.add(k);
    out.push({ name, reserved: isReservedGroup(name) });
  }

  return out;
}
