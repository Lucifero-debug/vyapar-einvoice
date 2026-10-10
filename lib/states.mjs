import { normalizeStateCode } from "./gst.mjs";

/**
 * Indian states and union territories, with their GST state codes.
 *
 * The code is the first two digits of a GSTIN, so it is the thing that decides
 * whether a supply is intra-state (CGST + SGST) or inter-state (IGST). The
 * billing pages used to offer a hard-coded list of three — "Delhi", "Mumbai",
 * "Jaipur" — two of which are cities, not states, and none of which carried a
 * code.
 *
 * Codes 25 (Daman & Diu) and 28 (the old Andhra Pradesh) are deliberately
 * absent: 25 was merged into 26 and 28 was replaced by 37. They are left out so
 * nobody picks a retired code off a dropdown. Seed this list, then edit the
 * master if your records disagree — the master is the authority once seeded,
 * not this file.
 *
 * Dependency-free: the seed script, its tests and the client forms all read it.
 */

export const INDIAN_STATES = [
  { code: "01", name: "Jammu and Kashmir" },
  { code: "02", name: "Himachal Pradesh" },
  { code: "03", name: "Punjab" },
  { code: "04", name: "Chandigarh" },
  { code: "05", name: "Uttarakhand" },
  { code: "06", name: "Haryana" },
  { code: "07", name: "Delhi" },
  { code: "08", name: "Rajasthan" },
  { code: "09", name: "Uttar Pradesh" },
  { code: "10", name: "Bihar" },
  { code: "11", name: "Sikkim" },
  { code: "12", name: "Arunachal Pradesh" },
  { code: "13", name: "Nagaland" },
  { code: "14", name: "Manipur" },
  { code: "15", name: "Mizoram" },
  { code: "16", name: "Tripura" },
  { code: "17", name: "Meghalaya" },
  { code: "18", name: "Assam" },
  { code: "19", name: "West Bengal" },
  { code: "20", name: "Jharkhand" },
  { code: "21", name: "Odisha" },
  { code: "22", name: "Chhattisgarh" },
  { code: "23", name: "Madhya Pradesh" },
  { code: "24", name: "Gujarat" },
  { code: "26", name: "Dadra and Nagar Haveli and Daman and Diu" },
  { code: "27", name: "Maharashtra" },
  { code: "29", name: "Karnataka" },
  { code: "30", name: "Goa" },
  { code: "31", name: "Lakshadweep" },
  { code: "32", name: "Kerala" },
  { code: "33", name: "Tamil Nadu" },
  { code: "34", name: "Puducherry" },
  { code: "35", name: "Andaman and Nicobar Islands" },
  { code: "36", name: "Telangana" },
  { code: "37", name: "Andhra Pradesh" },
  { code: "38", name: "Ladakh" },
  { code: "97", name: "Other Territory" },
];

// The two-digit rule already lives in gst.mjs, which the customer form and the
// invoice routes import. Imported AND re-exported here so callers that only
// care about states need one import, without a second definition that could
// drift. (`export { x } from` alone re-exports without binding x locally, and
// the helpers below use it.)
export { normalizeStateCode };

/** Find a state in a list by its name, case- and space-insensitively. */
export const findStateByName = (states, name) => {
  const key = String(name || "").trim().toLowerCase();
  if (!key) return null;
  return states.find((s) => String(s.name || "").trim().toLowerCase() === key) || null;
};

/** Find a state in a list by its code, tolerating "7" for "07". */
export const findStateByCode = (states, code) => {
  const key = normalizeStateCode(code);
  if (!key) return null;
  return states.find((s) => normalizeStateCode(s.code) === key) || null;
};

/** "07 — Delhi", for a dropdown. */
export const stateLabel = (state) =>
  state ? `${normalizeStateCode(state.code)} — ${state.name}` : "";

/** Which states the seed should create: those the master does not already hold. */
export function planStateSeed({ existing = [] } = {}) {
  const haveCode = new Set(existing.map((s) => normalizeStateCode(s.code)).filter(Boolean));
  const haveName = new Set(
    existing.map((s) => String(s.name || "").trim().toLowerCase()).filter(Boolean)
  );

  return INDIAN_STATES.filter(
    (s) => !haveCode.has(normalizeStateCode(s.code)) && !haveName.has(s.name.toLowerCase())
  );
}
