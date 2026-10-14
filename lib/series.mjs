/**
 * The series master -- Sigfa's Series Master screen, field for field.
 *
 * Pure and dependency-free, so `node scripts/series.test.mjs` runs it
 * directly. No React, no Mongoose, no model imports, and -- deliberately --
 * no imports at all, so the tables below can be cross-checked against the
 * app's own kind tables by the test without this file depending on them.
 *
 *
 * WHAT THIS IS BUILT FROM
 * -----------------------
 * A screenshot of SIGFA 10.5-G16's "Series Master", which cannot be read out
 * of SIGFA105.exe from here. Everything below is what that screen shows, and
 * nothing below is inferred from anything else. Two notes on reading it:
 *
 *   - The document is chosen by a RADIO BUTTON on the left. A series belongs
 *     to exactly one document type; there is no "applies to everything"
 *     option, and the panel on the right is headed with the document chosen
 *     ("Sales Invoice" in the screenshot).
 *
 *   - The screen has NO next-number or last-number box. Taken with
 *     `VOUCHER Text(16)` in lib/challan.mjs, that is the evidence for the
 *     decision recorded under NUMBERING below.
 *
 * Earlier builds of this module had three scopes (the stock slips) and an
 * "every slip" option of this app's own invention. Both were wrong and are
 * gone.
 *
 *
 * NUMBERING: A SERIES DOES NOT NUMBER ANYTHING
 * --------------------------------------------
 * No counter, no next number, no reserved range. A document's number still
 * comes from one sequence per document type -- lib/getNextInvoiceNo.js,
 * lib/getNextProductionNo.js, `counterFor` in lib/challan.mjs.
 *
 * Deliberate, and the one decision here that could not be taken back: a
 * counter per series changes what number the NEXT document gets, and a
 * document that has gone out cannot be renumbered. lib/challan.mjs states the
 * constraint it would run into -- "GST invoice numbering has to be
 * consecutive". `fillLeftSpaceWithZero` and the series initial format a
 * number for PRINTING (`formatDocNo` below); they do not choose it.
 *
 *
 * THE PRINT AND BEHAVIOUR FIELDS ARE STORED, NOT YET ACTED ON
 * -----------------------------------------------------------
 * Every field on Sigfa's screen is carried on the record. None of them
 * currently changes what this app prints, what it moves or what it locks:
 *
 *   print      topHeading, topSubHeading, invoiceNoCaption, declarationCaption,
 *              declaration, printCompName, compressPrinting, rollStationary,
 *              slipWidthCm, slipHeightCm, dmpFont, djFont, invoiceToBePrint
 *   behaviour  effectInStock, lockVoucher
 *
 * Three of those already exist as FIRM-wide settings here -- Roll Stationary
 * in Setup, and the declaration and company name on the company profile -- so
 * honouring the series version is a decision about which one wins, taken
 * separately and visibly rather than inside the change that added the master.
 * `effectInStock` is the sharpest of them: a document saved without moving
 * stock cannot be made to have moved it afterwards.
 */

/** Sigfa's `VOUCHER Text(16)`. */
export const SERIES_CODE_MAX = 16;

/**
 * The documents a series can be created for: Sigfa's radio list, in its
 * order, with its wording.
 *
 * `stockKind`, `billingKey`, `challanType` and `orderDoc` are the link into
 * this app's own kind tables. They are literals rather than imports so this
 * module stays dependency-free; scripts/series.test.mjs reads STOCK_KINDS,
 * BILLING_TYPES and CHALLAN_KINDS and fails if any link here names something
 * that does not exist, which is the drift that would actually matter.
 */
export const SERIES_DOC_TYPES = [
  { code: "SALE_INVOICE", label: "Sales Invoice", billingKey: "sale" },
  { code: "SALE_CHALLAN", label: "Sales Challan", challanType: "Sale", mkey: "SC" },
  { code: "SALE_RETURN", label: "Sales Return", billingKey: "salereturn" },
  { code: "GOODS_ISSUED", label: "Goods Issued", stockKind: "IS", mkey: "IS" },
  // Sigfa's screen spells this "Goods Recieved". Kept correct here, because
  // reproducing a typo in this app's own interface helps nobody -- the note
  // is the record that the two differ.
  { code: "GOODS_RECEIVED", label: "Goods Received", stockKind: "RS", mkey: "RS" },
  { code: "PURCHASE_RETURN", label: "Purchase Return", billingKey: "purchasereturn" },
  { code: "SALE_ORDER", label: "Sales Order", orderDoc: "Sale" },
  { code: "PURCHASE_ORDER", label: "Purchase Order", orderDoc: "Purchase" },
  { code: "PRODUCTION", label: "Production", stockKind: "FR", mkey: "FR" },
  { code: "MRI", label: "M.R.I.", mri: true },
  { code: "PURCHASE_INVOICE", label: "Purchase Inv.", billingKey: "purchase" },
  { code: "PURCHASE_CHALLAN", label: "Purchase Challan", challanType: "Purchase", mkey: "PC" },
];

/**
 * The rows on Sigfa's list that this app has no document for.
 *
 * Recorded rather than offered. A radio button for a document that cannot be
 * raised here would be a series nobody could ever put on anything, and
 * leaving them out silently would lose the fact that Sigfa has them.
 */
export const SERIES_DOC_TYPES_NOT_HERE = [
  "Sales Enquiry",
  "Sales Quotation",
  "M.R.O.",
  "Purchase Enquiry",
  "Purchase Quotation",
  "Sale Ord. Schedule",
  "Purc Ord. Schedule",
];

export const SERIES_DOC_TYPE_CODES = SERIES_DOC_TYPES.map((doc) => doc.code);

const text = (value) => String(value ?? "").trim();
const upper = (value) => text(value).toUpperCase();

/** One document's row, or null. */
export const seriesDocType = (value) =>
  SERIES_DOC_TYPES.find((doc) => doc.code === upper(value)) ?? null;

export const isSeriesDocType = (value) => Boolean(seriesDocType(value));

/** What a document is called, for a message or a heading about it. */
export const docTypeLabel = (value) => seriesDocType(value)?.label ?? "";

/**
 * The document type as it will be stored, or "" for one this build does not
 * know.
 *
 * NOT widened to a default. Every series belongs to exactly one document, so
 * a row whose type cannot be resolved must be offered on NOTHING -- it is
 * still listed on the master screen, where it can be corrected, and that is
 * the only place it appears.
 */
export const normalizeDocType = (value) => (isSeriesDocType(value) ? upper(value) : "");

/* ───────────── finding the document type a screen is ───────────── */

const docTypeBy = (field, value) => {
  const needle = text(value);
  if (!needle) return "";
  return SERIES_DOC_TYPES.find((doc) => doc[field] === needle)?.code ?? "";
};

/** The slip kinds: 'FR', 'IS', 'RS' (lib/stockVoucher.mjs). */
export const docTypeForStockKind = (kind) => docTypeBy("stockKind", upper(kind));

/** The billing screens: 'sale', 'purchase', 'salereturn', 'purchasereturn'. */
export const docTypeForBilling = (key) => docTypeBy("billingKey", text(key).toLowerCase());

/** The challans: 'Sale', 'Purchase' (lib/challan.mjs). */
export const docTypeForChallan = (type) => docTypeBy("challanType", type);

/** The order book: 'Sale', 'Purchase'. */
export const docTypeForOrder = (doc) => docTypeBy("orderDoc", doc);

/* ──────────────────────── the code ──────────────────────── */

/**
 * The code as it will be stored: trimmed, upper-cased, cut to sixteen.
 *
 * UPPER-CASED because the register already treats "mi" and "MI" as one
 * series -- `seriesUsed` in lib/stockVoucher.mjs dedupes case-insensitively --
 * and a master that let both exist would put two rows behind one column.
 */
export const normalizeSeriesCode = (value) => upper(value).slice(0, SERIES_CODE_MAX);

/** Two codes are the same series when these match. */
export const seriesKey = (value) => normalizeSeriesCode(value);

export const sameSeries = (a, b) => {
  const left = seriesKey(a);
  return Boolean(left) && left === seriesKey(b);
};

/**
 * Characters a code may hold.
 *
 * Letters, digits, and the three separators a series is written with in
 * practice. Spaces are out: the code goes in a column of its own on the
 * register and " MI" and "MI " would read as one value and sort as two.
 */
export const SERIES_CODE_PATTERN = /^[A-Z0-9][A-Z0-9/_-]*$/;

/** Why this code cannot be stored, in words. null when it can. */
export const seriesCodeProblem = (value) => {
  const code = normalizeSeriesCode(value);
  if (!code) return "Enter a series code, for example A.";
  if (upper(value).length > SERIES_CODE_MAX) {
    return `A series code is at most ${SERIES_CODE_MAX} characters.`;
  }
  if (!SERIES_CODE_PATTERN.test(code)) {
    return "A series code holds letters, digits and - / _ only, and starts with a letter or digit.";
  }
  return null;
};

/* ─────────────────────── the stored record ─────────────────────── */

/**
 * Every field on Sigfa's screen, with the value a new series starts at.
 *
 * ONE TABLE, read by the schema, the routes, the dialog and the alter
 * payload. A field that exists on the form but not here is dropped silently
 * by Mongoose's strict mode, which is the mistake this project has made
 * repeatedly; a field here but not in `toPayload` is written as undefined by
 * the alter route, which is the mistake lib/masterActions.mjs exists to stop.
 * Both are swept by scripts/series.test.mjs against this list.
 *
 * The defaults are the ones the screenshot shows: Print Comp. Name and Effect
 * In Stock on, Compress Printing and Roll Stationary off, the sizes and the
 * zero-fill at 0, the fonts at "None".
 */
export const SERIES_DEFAULTS = {
  // Series [Initial] and Series Name.
  code: "",
  name: "",
  // Which radio button on the left. "" is a series this build cannot place.
  docType: "",

  // The boxes down the middle of the screen.
  invoiceToBePrint: "",
  compressPrinting: false,
  rollStationary: false,
  printCompName: true,
  effectInStock: true,
  remark: "",
  topHeading: "",
  topSubHeading: "",
  invoiceNoCaption: "",
  declarationCaption: "",
  declaration: "",
  store: "",

  // The boxes down the right.
  fillLeftSpaceWithZero: 0,
  bookNo: "",
  lockVoucher: false,

  // "Slip Size For DJ/Laser Printer".
  slipWidthCm: 0,
  slipHeightCm: 0,

  // "Font Size Setting For PrnInvB". Sigfa shows "None" for both.
  dmpFont: "",
  djFont: "",

  // NOT Sigfa's. `active` retires a series without deleting it, which is what
  // makes the delete refusal below workable; `isDefault` picks the series a
  // new document starts on. Both are this app's, and are marked as such on
  // the screen.
  active: true,
  isDefault: false,
};

export const SERIES_FIELDS = Object.keys(SERIES_DEFAULTS);

/** Which fields hold which kind of value, so one rule normalizes each. */
export const SERIES_FLAG_FIELDS = [
  "compressPrinting",
  "rollStationary",
  "printCompName",
  "effectInStock",
  "lockVoucher",
  "active",
  "isDefault",
];

export const SERIES_NUMBER_FIELDS = ["fillLeftSpaceWithZero", "slipWidthCm", "slipHeightCm"];

/**
 * A tick box as it arrives from a form.
 *
 * `false` ARRIVES AS THE STRING "false" often enough to matter: anything that
 * builds a body by stringifying its fields sends "false", and `Boolean("false")`
 * is true -- so a series switched off would save as switched on, and the one
 * default per document would quietly become two. The fallback is for a field
 * that was not sent at all, which must keep its default rather than becoming
 * false.
 */
export const seriesFlag = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string") {
    return !["false", "0", "no", "off"].includes(value.trim().toLowerCase());
  }
  return Boolean(value);
};

/** A measurement or a digit count. Never NaN, never negative. */
export const seriesNumber = (value, fallback = 0) => {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * The record as it will be stored: every field, normalized, nothing else.
 *
 * Anything the caller sent that is not a field of a series is DROPPED here
 * rather than at the schema, so the route never hands Mongoose a key it would
 * discard in silence -- and `_id`, `companyId` and `createdAt` cannot be
 * written through a request body.
 */
export const normalizeSeries = (input = {}) => {
  const out = {};
  for (const field of SERIES_FIELDS) {
    const value = input?.[field];
    const fallback = SERIES_DEFAULTS[field];
    if (field === "code") out[field] = normalizeSeriesCode(value);
    else if (field === "docType") out[field] = normalizeDocType(value);
    else if (SERIES_FLAG_FIELDS.includes(field)) out[field] = seriesFlag(value, fallback);
    else if (SERIES_NUMBER_FIELDS.includes(field)) out[field] = seriesNumber(value, fallback);
    else out[field] = text(value);
  }
  return out;
};

/** Why this series cannot be saved, in words. [] when it can be. */
export const seriesProblems = (input = {}) => {
  const problems = [];
  const codeProblem = seriesCodeProblem(input?.code);
  if (codeProblem) problems.push(codeProblem);
  // Required, because Sigfa's radio list is always on one document and a
  // series belonging to nothing could never be offered anywhere.
  if (!text(input?.docType)) {
    problems.push("Choose which document this series is for.");
  } else if (!isSeriesDocType(input.docType)) {
    problems.push(`"${text(input.docType)}" is not a document this app raises.`);
  }
  if (seriesNumber(input?.fillLeftSpaceWithZero) > SERIES_CODE_MAX) {
    problems.push(`Fill Left Space With Zero is at most ${SERIES_CODE_MAX}.`);
  }
  return problems;
};

/* ───────────────── what a screen offers and shows ───────────────── */

/** Is this series offered on that document? */
export const appliesTo = (series, docType) => {
  const stored = normalizeDocType(series?.docType);
  const asked = normalizeDocType(docType);
  return Boolean(stored) && stored === asked;
};

/**
 * The series a document of this type may carry, in the order the dropdown
 * shows.
 *
 * Inactive ones are left out: that is what `active` is for -- a series a firm
 * has finished with stops being offered without the documents that carry it
 * losing their label. Pass `includeInactive` for the master screen, which has
 * to show them in order to switch them back on.
 */
export const seriesFor = (list = [], docType, { includeInactive = false } = {}) =>
  (Array.isArray(list) ? list : [])
    .filter((series) => includeInactive || series?.active !== false)
    .filter((series) => appliesTo(series, docType))
    .slice()
    .sort((a, b) => seriesKey(a?.code).localeCompare(seriesKey(b?.code)));

/**
 * The series to start a new document on, or "".
 *
 * Nothing marked means nothing selected -- the field is optional and putting
 * a value nobody chose onto a document is worse than leaving it blank.
 */
export const defaultSeries = (list = [], docType) =>
  normalizeSeriesCode(seriesFor(list, docType).find((series) => series?.isDefault)?.code);

/**
 * What a Series box offers: the master, plus whatever the documents already
 * carry that is not in it.
 *
 * THE SECOND HALF IS THE POINT on the slip screens, where this box was free
 * text before the master existed: a firm with a year of slips labelled "MI"
 * would otherwise be unable to pick "MI" on the next one, and the register's
 * own column would become unusable. History is offered, marked as not being
 * in the master, so adding it properly stays a deliberate act.
 *
 * Returns [{ code, name, docType, inMaster }], master rows first.
 */
export const seriesOptions = (master = [], used = [], docType) => {
  const rows = seriesFor(master, docType).map((series) => ({
    code: normalizeSeriesCode(series?.code),
    name: text(series?.name),
    docType: normalizeDocType(series?.docType),
    inMaster: true,
  }));

  const known = new Set(rows.map((row) => row.code));
  const history = [...new Set((Array.isArray(used) ? used : []).map(normalizeSeriesCode))]
    .filter((code) => code && !known.has(code))
    .sort((a, b) => a.localeCompare(b))
    .map((code) => ({ code, name: "", docType: normalizeDocType(docType), inMaster: false }));

  return [...rows, ...history];
};

/**
 * A document's number as this series would print it: the initial, then the
 * number padded to `fillLeftSpaceWithZero` digits.
 *
 * DISPLAY ONLY, and currently shown only as a preview on the master screen so
 * the two settings mean something while they are entered. It does not choose
 * a number and must never be stored as one -- see NUMBERING in the header.
 *
 * No separator between the initial and the digits: Sigfa's screen does not
 * show one, and inventing a slash here would put it on every printed bill.
 */
export const formatDocNo = (docNo, series = {}) => {
  // Blank first: `Number("")` is 0, so a document with no number yet would
  // otherwise be previewed as "A0000" -- a number that does not exist.
  if (docNo === "" || docNo === null || docNo === undefined) return "";
  const n = Number(docNo);
  if (!Number.isFinite(n)) return "";
  const digits = String(Math.trunc(Math.abs(n)));
  const width = Math.trunc(seriesNumber(series?.fillLeftSpaceWithZero));
  const padded = width > digits.length ? digits.padStart(width, "0") : digits;
  return `${normalizeSeriesCode(series?.code)}${padded}`;
};

/**
 * How many of these documents carry this series.
 *
 * Pure, so the delete route's refusal and the master screen's "in use" count
 * are the same number arrived at the same way. Case-insensitive, because the
 * slips were written when the field was free text.
 */
export const seriesInUse = (code, entries = []) => {
  const needle = seriesKey(code);
  if (!needle) return 0;
  return (Array.isArray(entries) ? entries : []).filter(
    (entry) => seriesKey(entry?.series) === needle
  ).length;
};

export default SERIES_DOC_TYPES;
