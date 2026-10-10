/**
 * The buyer's details, copied onto the invoice at the moment it is saved.
 *
 * WHY A COPY, when the party is one lookup away in `customers`.
 *
 * Because an e-invoice is a filing. The IRN the IRP returns is tied to the
 * details that were reported, and a party who moves shop next year must not
 * retroactively change the address on a bill that was already filed. Looking
 * the buyer up at print time would do exactly that: the document would quietly
 * stop matching the government's copy of itself, and the copy that matters is
 * theirs.
 *
 * So the invoice carries its own buyer block, written once, from the master as
 * it stood that day.
 *
 * WHERE EACH VALUE COMES FROM
 *
 *   name, phone, email   what the biller typed, falling back to the master.
 *                        A contact typed for one bill is meant for that bill.
 *   gstin ... stateCode   the master only. These are registration details; the
 *                        billing form has no field for them and should not.
 *
 * Pure, so the routes and a bare `node` test share one definition of the shape.
 */

import { normalizeStateCode } from "./gst.mjs";
// The place-of-supply rule lives on its own, in a file that is identical in
// `vyapaar`, because that project needs the same rule without any of the
// e-invoicing around it. Re-exported here so a caller that already has the
// buyer block does not need a second import.
import {
  needsStateLookup as needsStateLookupFor,
  placeOfSupply as placeOfSupplyFor,
  placeOfSupplyLabel as placeOfSupplyLabelFor,
} from "./placeOfSupply.mjs";

export const placeOfSupply = placeOfSupplyFor;
export const needsStateLookup = needsStateLookupFor;
export const placeOfSupplyLabel = placeOfSupplyLabelFor;

/** Every field the invoice's `customer` block holds. */
export const BUYER_FIELDS = [
  "name",
  "phone",
  "email",
  "custId",
  "gstin",
  "address",
  "city",
  "state",
  "pincode",
  "stateCode",
];

/** What a route has to ask Mongoose for to build a snapshot. */
export const BUYER_PROJECTION = {
  _id: 1,
  name: 1,
  phone: 1,
  email: 1,
  gstIn: 1,
  gstin: 1,
  address: 1,
  city: 1,
  state: 1,
  pincode: 1,
  stateCode: 1,
};

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

/** The first of these that has anything in it. */
const first = (...values) => {
  for (const value of values) {
    const t = text(value);
    if (t) return t;
  }
  return "";
};

/**
 * The buyer's GSTIN, whichever way it is spelled.
 *
 * `custModel` calls it `gstIn` -- capital I -- while `companyModel`, this
 * snapshot and the IRP's own payload all use `gstin`. Rather than rename a
 * column that every customer form already writes, both spellings are read
 * here, in one place, with this comment attached.
 */
export const partyGstin = (party) =>
  first(party?.gstin, party?.gstIn).toUpperCase();

/**
 * Build the invoice's buyer block.
 *
 * @param party  the row from `customers`, as the master stands now
 * @param typed  the `customer` object the billing form sent, if any
 */
export const buyerSnapshot = (party, typed = {}) => {
  const master = party || {};
  const sent = typed || {};

  return {
    name: first(sent.name, master.name),
    phone: first(sent.phone, master.phone),
    email: first(sent.email, master.email),
    // The master's own id, so a later rename can still find the party. What
    // the form sent is honoured first only because an upload may carry an id
    // for a party this lookup missed.
    custId: first(sent.custId, master._id),
    gstin: partyGstin(master),
    address: first(master.address),
    city: first(master.city),
    state: first(master.state),
    pincode: first(master.pincode),
    // The BUYER's registered state. NOT the place of supply, which is the
    // `stateCode` at the top level of the invoice -- they differ on exactly
    // the bills where it matters, a buyer in one state taking delivery in
    // another.
    stateCode: normalizeStateCode(master.stateCode),
  };
};

/**
 * Is this buyer block complete enough to report as a B2B supply?
 *
 * A sale to an unregistered buyer is B2C and needs none of this, so the answer
 * is about which kind of supply it is, not whether the row is tidy.
 */
export const isB2B = (buyer) => text(buyer?.gstin).length === 15;

/** Which mandatory buyer details are missing for a B2B e-invoice. */
export const buyerMissing = (buyer) => {
  const b = buyer || {};
  const needed = [
    ["gstin", "GSTIN"],
    ["address", "address"],
    ["city", "city"],
    ["pincode", "PIN code"],
    ["stateCode", "state code"],
  ];
  return needed.filter(([key]) => !text(b[key])).map(([, label]) => label);
};
