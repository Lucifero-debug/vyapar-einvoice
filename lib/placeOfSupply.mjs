/**
 * The place of supply for an invoice: the party's own state, and nothing else.
 *
 * It used to be a dropdown on the billing form, picked per bill. That is one
 * more thing to get right on every invoice, and getting it wrong is not
 * cosmetic -- the state code is the first two digits of a GSTIN and it is what
 * decides whether a supply is intra-state (CGST + SGST) or inter-state (IGST).
 * The party's state is already recorded once, in their master, so that is
 * where it comes from, and the form shows it read only.
 *
 * Pure, with two pure imports, so the billing pages, the invoice routes and a
 * bare `node` test all read the same rule.
 *
 * NOTE: this file is deliberately identical in `vyapaar` and in
 * `vyapaar-einvoice`. Keep it that way -- the rule has to be one rule, and an
 * identical file merges cleanly when the two are reconciled.
 */

import { normalizeStateCode } from "./gst.mjs";
import { findStateByCode, findStateByName } from "./states.mjs";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

/**
 * The party's state and GST state code.
 *
 * `party` may be a `customers` row or an invoice's embedded customer block:
 * both carry `state` and `stateCode` and mean the same thing by them.
 *
 * `states` is the states master, used only to fill in whichever half is
 * missing -- a party recorded before the state dropdown existed may have the
 * name and no code. A blank state code on a GST invoice is worth the lookup.
 */
export const placeOfSupply = (party, states = []) => {
  let stateOfSupply = text(party?.state);
  let stateCode = normalizeStateCode(party?.stateCode);

  if (stateOfSupply && !stateCode) {
    stateCode = normalizeStateCode(findStateByName(states, stateOfSupply)?.code);
  } else if (!stateOfSupply && stateCode) {
    stateOfSupply = text(findStateByCode(states, stateCode)?.name);
  }

  return { stateOfSupply, stateCode };
};

/**
 * True when the states master still has to be consulted, because the party
 * has one half of the answer and not the other.
 *
 * The routes check this before reading the master, so the usual save -- a
 * party who has both -- costs no extra query.
 */
export const needsStateLookup = (party) =>
  Boolean(text(party?.state)) !== Boolean(normalizeStateCode(party?.stateCode));

/**
 * "07 — Delhi", for the line the billing form shows instead of its old
 * dropdown. Blank reads as blank, never as a stray dash.
 */
export const placeOfSupplyLabel = (place) => {
  const name = text(place?.stateOfSupply);
  const code = normalizeStateCode(place?.stateCode);
  if (name && code) return `${code} — ${name}`;
  return name || code || "";
};
