/**
 * Create, alter and delete a master from the field you are standing in.
 *
 * Pure and dependency-free, so `node` can run scripts/master-actions.test.mjs
 * directly. The components do the fetching; this decides WHICH master a field
 * belongs to, WHERE each one's endpoints are, and -- the part that matters --
 * exactly what an alter has to send so it does not destroy the record.
 *
 *
 * SIGFA'S THREE KEYS, FROM ITS OWN STATUS BAR
 * -------------------------------------------
 * Read out of SIGFA105.exe, where this line appears four times over:
 *
 *     Create [ Alt + A ]     Alter [ Alt + M ]     Ledger [ Alt + I ]
 *
 * and, at one offset, these two side by side:
 *
 *     Delete Row (Alt + E)      Delete (Alt + D)
 *
 * So Sigfa has FOUR keys, not three, and the distinction is the whole point:
 * Alt+E takes a line off the bill in front of you, Alt+D deletes a RECORD
 * from the master. They were conflated here once -- Alt+D was wired as an
 * alias for the row delete -- which left no way at all to delete a master and
 * made a mis-key on Alt+D silently drop an invoice line.
 *
 *
 * WHY AN ALTER SENDS THE WHOLE RECORD BACK
 * ----------------------------------------
 * `api/item-alter` and `api/customer-alter` both end in `existing.set({...})`
 * with EVERY field assigned unconditionally. Two of those assignments do not
 * merely pass a missing value through:
 *
 *     isService: Boolean(itemData.isService)        // undefined -> false
 *     uqc: normalizeUqc(itemData.uqc) || UQC_DEFAULT // undefined -> "OTH"
 *
 * so a dialog that posted only the four fields a bill cares about would flip
 * `isService` off and reset the GST unit code on every item it touched -- and
 * `uqc` is reported to the IRP, so that is a wrong e-invoice, not a cosmetic
 * loss.
 *
 * Therefore: an alter LOADS the record, merges the edits over it, and posts
 * the lot. `toPayload` below is the record-shaped-as-the-route-reads-it
 * mapping, and it exists because the two disagree:
 *
 *     item      openingQuantity -> openBal      minQuantity  -> minBal
 *               lastQuantity    -> lastBal     reorderLevel -> reorderBal
 *               maxLevel        -> maxBal
 *     customer  openingBal      -> openBal      lastYearBal -> lastBal
 *
 * A field missing from `toPayload` is a field the alter route will read as
 * undefined and write away. scripts/master-actions.test.mjs sweeps each
 * route's source for the identifiers it reads and fails if `toPayload` does
 * not produce one of them, so the mapping cannot fall behind the route.
 */

import { SERIES_FIELDS } from "./series.mjs";

const text = (value) => String(value ?? "").trim();
const num = (value) => (value === "" || value === null || value === undefined ? undefined : Number(value));

/** Sigfa's four keys, named so one table states the distinction. */
export const MASTER_ACTION_KEYS = {
  create: "Alt+A",
  alter: "Alt+M",
  deleteRecord: "Alt+D",
  deleteRow: "Alt+E",
};

/**
 * Which master is behind a field.
 *
 * Keyed on `data-master-field`, so a BILLING screen and a MASTER screen use
 * the same attribute and the same map: the item master's HSN box and a bill's
 * HSN column both mean "the HSN master". That is the whole of what makes the
 * three keys work everywhere rather than on one screen.
 */
export const MASTER_FIELDS = {
  // the bill
  item: "item",
  itemName: "item",
  party: "customer",
  customer: "customer",
  hsn: "hsn",
  unit: "unit",
  group: "group",
  state: "state",
  stateOfSupply: "state",
  // the slip header -- Sigfa's SubKey box
  series: "series",
  // the master screens, which name some of the same things differently
  hsncode: "hsn",
  itemGroup: "group",
  customerGroup: "group",
  stateCode: "state",
  stateName: "state",
  slipSeries: "series",
};

export const masterKindFor = (field) => MASTER_FIELDS[text(field)] ?? null;

/**
 * Every master's endpoints, and how a value in a field finds its record.
 *
 * `matchField` is what the FIELD's value holds: an item field holds a name, an
 * HSN field holds a code. Matching the wrong one is how Alt+D comes to delete
 * nothing and report that the record is missing.
 */
export const MASTER_SPECS = {
  item: {
    label: "item",
    listEndpoint: "/api/get-item",
    listKey: "item",
    createEndpoint: "/api/item-add",
    alterEndpoint: "/api/item-alter",
    deleteEndpoint: "/api/delete-item",
    matchField: "name",
    toPayload: (record = {}) => ({
      id: text(record._id ?? record.id),
      name: record.name,
      short: record.short,
      hsn: record.hsn,
      group: record.group,
      unit: record.unit,
      uqc: record.uqc,
      isService: record.isService,
      mrp: record.mrp,
      cost: record.cost,
      salePrice: record.salePrice,
      purchasePrice: record.purchasePrice,
      discount: record.discount,
      gst: record.gst,
      weight: record.weight,
      itemType: record.itemType,
      // The three the route reads under different names than the schema.
      openBal: record.openingQuantity,
      // Sigfa's three levels, under the names the routes read them by.
      // Omitting one here would have Alt+M wipe it: an ALTER sends the whole
      // record, and a field the payload leaves out is set to undefined.
      minBal: record.minQuantity,
      reorderBal: record.reorderLevel,
      maxBal: record.maxLevel,
      lastBal: record.lastQuantity,
    }),
  },

  customer: {
    label: "party",
    listEndpoint: "/api/get-customer",
    listKey: "customer",
    createEndpoint: "/api/customer-add",
    alterEndpoint: "/api/customer-alter",
    deleteEndpoint: "/api/delete-cust",
    matchField: "name",
    toPayload: (record = {}) => ({
      id: text(record._id ?? record.id),
      name: record.name,
      short: record.short,
      email: record.email,
      group: record.group,
      address: record.address,
      city: record.city,
      state: record.state,
      stateCode: record.stateCode,
      pincode: record.pincode,
      phone: record.phone,
      gstIn: record.gstIn,
      pan: record.pan,
      aadhar: record.aadhar,
      bank: record.bank,
      interest: record.interest,
      discount: record.discount,
      dealerType: record.dealerType,
      // The route signs these from a magnitude plus a mode, and reads the
      // OPENING balance under `openBal` and LAST YEAR's under `lastBal`.
      // `lastBal` on the record is the live running balance, maintained by
      // the posting path -- sending that as last year's would corrupt the
      // party's books, so it is deliberately NOT read here.
      openBal: record.openingBal,
      openingMode: record.openingMode,
      lastBal: record.lastYearBal,
      lastMode: record.lastYearMode,
    }),
  },

  hsn: {
    label: "HSN code",
    listEndpoint: "/api/get-hsn",
    listKey: "hsn",
    createEndpoint: "/api/hsn-add",
    alterEndpoint: "/api/hsn-update",
    deleteEndpoint: "/api/delete-hsn",
    matchField: "hsncode",
    toPayload: (record = {}) => ({
      id: text(record._id ?? record.id),
      hsncode: record.hsncode,
      hsnname: record.hsnname,
      gst: record.gst,
      gstunit: record.gstunit,
    }),
  },

  group: {
    label: "group",
    listEndpoint: "/api/get-group",
    listKey: "group",
    createEndpoint: "/api/group-add",
    alterEndpoint: "/api/group-update",
    deleteEndpoint: "/api/delete-group",
    matchField: "name",
    toPayload: (record = {}) => ({
      id: text(record._id ?? record.id),
      name: record.name,
      note: record.note,
    }),
  },

  state: {
    label: "state",
    listEndpoint: "/api/get-state",
    listKey: "state",
    createEndpoint: "/api/state-add",
    alterEndpoint: "/api/state-update",
    deleteEndpoint: "/api/delete-state",
    matchField: "name",
    toPayload: (record = {}) => ({
      id: text(record._id ?? record.id),
      name: record.name,
      code: record.code,
    }),
  },

  /**
   * The document series -- Sigfa's SubKey, which it seeds with MI, MO and RMI.
   *
   * `matchField` is the CODE, not the description: the Series box on a slip
   * header holds "MI", and matching on the description would have Alt+M
   * report that a series plainly on screen does not exist.
   *
   * Every field of a series is produced below, FROM THE ONE LIST, rather than
   * named here. series-update rebuilds the whole record with
   * `normalizeSeries(body)`, so a field this payload leaves out is written as
   * its default -- clearing a declaration, a heading, or switching the series
   * off. There are twenty-four of them and Sigfa's screen will grow more, so
   * listing them twice is a guarantee of drift; scripts/series.test.mjs sweeps
   * that this produces every field in SERIES_FIELDS.
   */
  series: {
    label: "series",
    listEndpoint: "/api/get-series",
    listKey: "series",
    createEndpoint: "/api/series-add",
    alterEndpoint: "/api/series-update",
    deleteEndpoint: "/api/delete-series",
    matchField: "code",
    toPayload: (record = {}) => {
      const payload = { id: text(record._id ?? record.id) };
      for (const field of SERIES_FIELDS) payload[field] = record[field];
      return payload;
    },
  },

  /**
   * Units are typed straight onto an item in this app -- there is no unit
   * master and no endpoint. Listed so the keys ANSWER in a unit field rather
   * than doing nothing, which reads as the shortcut being broken.
   */
  unit: {
    label: "unit",
    unavailable:
      "Units are typed straight onto an item in this app — there is no unit master to create, alter or delete.",
  },
};

export const masterSpec = (kind) => MASTER_SPECS[text(kind)] ?? null;

/** Is there anything these keys can do for this kind? */
export const masterIsEditable = (kind) => {
  const spec = masterSpec(kind);
  return Boolean(spec && !spec.unavailable);
};

/**
 * The record a field's value refers to, or null.
 *
 * Case-insensitive and trimmed, because every join in this app is by name and
 * a stray space is how two records become one ambiguous one. HSN codes match
 * on the code; everything else on the name.
 */
export const findMaster = (records = [], kind, value) => {
  const spec = masterSpec(kind);
  if (!spec?.matchField) return null;
  const needle = text(value).toLowerCase();
  if (!needle) return null;
  return (
    (records || []).find((record) => text(record?.[spec.matchField]).toLowerCase() === needle) ??
    null
  );
};

/** What a record is called, for a message about it. */
export const masterNameOf = (kind, record) => {
  const spec = masterSpec(kind);
  if (!spec?.matchField) return "";
  return text(record?.[spec.matchField]);
};

/**
 * The body an alter posts: the record as it stands, with the edits over it.
 *
 * EDITS LAST, so a cleared box clears the field -- but only a box that was on
 * the form. A field the dialog never showed keeps its stored value, which is
 * the whole reason the record is loaded first.
 */
export const alterPayload = (kind, record, edits = {}) => {
  const spec = masterSpec(kind);
  if (!spec?.toPayload) return null;
  const base = spec.toPayload(record);
  if (!text(base.id)) return null;
  return { ...base, ...edits, id: base.id };
};

/** The query a delete is sent with. The routes all take `?id=`. */
export const deleteUrl = (kind, record) => {
  const spec = masterSpec(kind);
  const id = text(record?._id ?? record?.id);
  if (!spec?.deleteEndpoint || !id) return null;
  return `${spec.deleteEndpoint}?id=${encodeURIComponent(id)}`;
};

/**
 * What to ask before deleting, naming the record.
 *
 * Named because "Delete this record?" on a shortcut nobody meant to press is
 * not a question anybody reads. The routes refuse with 409 when history
 * references the record, so this guards the UNUSED ones -- which are exactly
 * the ones that vanish without anybody noticing.
 */
export const deletePrompt = (kind, record) => {
  const spec = masterSpec(kind);
  if (!spec) return null;
  const name = masterNameOf(kind, record);
  if (!name) return null;
  return `Delete the ${spec.label} "${name}" from the master? This cannot be undone.`;
};

/**
 * Why these keys can do nothing here, or null when they can.
 *
 * A sentence rather than silence: a shortcut that does nothing is
 * indistinguishable from a shortcut that is broken, which is how nine of
 * these came to be reported as "not working".
 */
export const masterActionProblem = ({ field, kind, value, action } = {}) => {
  const resolved = kind || masterKindFor(field);
  if (!resolved) {
    return "There is no master behind this field.";
  }
  const spec = masterSpec(resolved);
  if (spec?.unavailable) return spec.unavailable;
  if (action === "create") return null;
  if (!text(value)) {
    return `Choose ${spec.label === "party" ? "a party" : `an ${spec.label}`} first — ${
      action === "alter" ? "Alt+M alters" : "Alt+D deletes"
    } the one in this field.`;
  }
  return null;
};
