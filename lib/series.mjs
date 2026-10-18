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
 * NUMBERING: EACH SERIES COUNTS ON ITS OWN
 * ----------------------------------------
 * Confirmed against Sigfa on 15 October 2026: switching the series on a bill
 * restarts the number, so TAX's first bill of the year and RETAIL's first
 * bill of the year are BOTH 26-27/1. Earlier builds of this module recorded
 * the opposite -- one sequence, the series a label only -- as the cautious
 * reading of a screen with no next-number box. That was wrong and is gone.
 *
 * THE NUMBER IS THE FINANCIAL YEAR, A SLASH, AND THE RUNNING NUMBER.
 * `26-27/1`: the year the financial year started and the year it ends, then
 * the series' own count. The series code does NOT appear in it -- Sigfa's
 * Sales Invoice screen shows `Series: TAX` beside `Invoice No. 26-27/1`, with
 * no TAX in the number. `fillLeftSpaceWithZero` pads the running part, so a
 * series set to 4 prints `26-27/0001`.
 *
 * TWO NUMBERS, AND ONLY ONE OF THEM IS THE CUSTOMER'S.
 * `seriesNo` is the running count inside one series and one financial year,
 * and `voucherNo` -- composed below -- is what prints on the bill and what
 * GST requires to be consecutive within its series. `invoiceNo` stays what it
 * has always been: this firm's own unbroken sequence, unique, never shown,
 * and the key every lookup in this app joins on. Keeping it means adding
 * per-series numbering renumbers nothing that has already gone out and
 * breaks no link to a bill that already exists -- which is the constraint
 * lib/challan.mjs names and the one that could not be taken back.
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
 *
 *
 * `short` -- THE TWO LETTERS A REPORT COLUMN SHOWS
 * -----------------------------------------------
 * Added 18 Oct 2026 for the Type column on the ledger, which needs to say
 * what raised a row inside about four characters.
 *
 * WHERE AN MKEY EXISTS, `short` IS THAT MKEY. 'SC', 'PC', 'IS', 'RS' and
 * 'FR' were read out of SIGFA105.exe and are already recorded above, so the
 * column prints Sigfa's own letters for those five documents and a test
 * below asserts the two never drift apart.
 *
 * THE REST ARE THIS APP'S OWN ABBREVIATIONS, not findings. 'SI', 'PI', 'SR',
 * 'PR', 'SO', 'PO' and 'MRI' were asked for by name; no MKEY for a sale
 * invoice, a purchase invoice, either return or either order was read out of
 * the binary, and none is invented here. If Sigfa's own keys for those turn
 * up later, these are the values to correct -- they are presentation, and
 * nothing is stored by them (rows store the long `code`).
 */
export const SERIES_DOC_TYPES = [
  { code: "SALE_INVOICE", label: "Sales Invoice", short: "SI", billingKey: "sale" },
  { code: "SALE_CHALLAN", label: "Sales Challan", short: "SC", challanType: "Sale", mkey: "SC" },
  { code: "SALE_RETURN", label: "Sales Return", short: "SR", billingKey: "salereturn" },
  { code: "GOODS_ISSUED", label: "Goods Issued", short: "IS", stockKind: "IS", mkey: "IS" },
  // Sigfa's screen spells this "Goods Recieved". Kept correct here, because
  // reproducing a typo in this app's own interface helps nobody -- the note
  // is the record that the two differ.
  { code: "GOODS_RECEIVED", label: "Goods Received", short: "RS", stockKind: "RS", mkey: "RS" },
  { code: "PURCHASE_RETURN", label: "Purchase Return", short: "PR", billingKey: "purchasereturn" },
  { code: "SALE_ORDER", label: "Sales Order", short: "SO", orderDoc: "Sale" },
  { code: "PURCHASE_ORDER", label: "Purchase Order", short: "PO", orderDoc: "Purchase" },
  { code: "PRODUCTION", label: "Production", short: "FR", stockKind: "FR", mkey: "FR" },
  { code: "MRI", label: "M.R.I.", short: "MRI", mri: true },
  { code: "PURCHASE_INVOICE", label: "Purchase Inv.", short: "PI", billingKey: "purchase" },
  { code: "PURCHASE_CHALLAN", label: "Purchase Challan", short: "PC", challanType: "Purchase", mkey: "PC" },
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
 * The two or three letters a narrow report column shows: 'SI', 'PR', 'SC'.
 *
 * Empty for anything unrecognised, so a column prints nothing rather than
 * inventing a code for a document type this app does not have.
 */
export const docTypeShort = (value) => seriesDocType(value)?.short ?? "";

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

/**
 * A bill's document type, from the two fields the INVOICE ROW carries.
 *
 * The billing screens know their own key ('salereturn'); a saved invoice does
 * not -- it has `type` and `return`, which is what the save routes and every
 * reader have to work from. One place that knows both spellings, so a route
 * cannot assemble the key itself and get a return filed under the invoice.
 */
export const docTypeForBill = ({ type, isReturn } = {}) => {
  const side = text(type).toLowerCase();
  if (side !== "sale" && side !== "purchase") return "";
  return docTypeForBilling(isReturn ? `${side}return` : side);
};

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

/* ───────────────────── the financial year in the number ───────────────────── */

/** April, the Indian financial year -- the same one lib/reportPeriods.mjs uses. */
export const FY_START_MONTH = 4;

/**
 * Which calendar year a date's financial year STARTED in.
 *
 * Takes "YYYY-MM-DD", which is what every date box in this app holds, and
 * reads the month off the STRING rather than through `new Date`: a date-only
 * string is parsed as UTC midnight, which anywhere west of Greenwich is the
 * evening before -- and on 1 April that is the whole previous financial year,
 * so a bill raised on the first day of the year would be numbered into the
 * last one. A Date is accepted too, and read in local time for the same
 * reason.
 */
export const fyStartYear = (date) => {
  let year;
  let month;

  if (typeof date === "string") {
    const parts = /^\s*(\d{4})-(\d{2})/.exec(date);
    if (!parts) return null;
    year = Number(parts[1]);
    month = Number(parts[2]);
  } else if (date instanceof Date && !Number.isNaN(date.getTime())) {
    year = date.getFullYear();
    month = date.getMonth() + 1;
  } else {
    return null;
  }

  if (!(month >= 1 && month <= 12)) return null;
  return month >= FY_START_MONTH ? year : year - 1;
};

/** "26-27", from the year the financial year started. */
export const fyTag = (start) => {
  const year = Math.trunc(Number(start));
  if (!Number.isFinite(year) || year < 1000 || year > 9998) return "";
  return `${String(year).slice(2)}-${String(year + 1).slice(2)}`;
};

/**
 * The number as it prints: the financial year, a slash, and the series' own
 * running number padded to `fillLeftSpaceWithZero` digits. `26-27/1`.
 *
 * `docNo` here is the SERIES' count -- `seriesNo` on the bill -- not the
 * firm-wide `invoiceNo`. See NUMBERING in the header for why there are two.
 *
 * The date decides the financial year, so it has to be the DOCUMENT'S date,
 * never today's: a bill entered in April for the March just gone belongs to
 * the year it was dated in. With no date there is no year to print and the
 * bare number comes back, which is what the Series Master's preview shows
 * before a document exists.
 */
export const formatDocNo = (docNo, series = {}, date = null) => {
  // Blank first: `Number("")` is 0, so a document with no number yet would
  // otherwise be previewed as "26-27/0" -- a number that does not exist.
  if (docNo === "" || docNo === null || docNo === undefined) return "";
  const n = Number(docNo);
  if (!Number.isFinite(n)) return "";
  const digits = String(Math.trunc(Math.abs(n)));
  const width = Math.trunc(seriesNumber(series?.fillLeftSpaceWithZero));
  const padded = width > digits.length ? digits.padStart(width, "0") : digits;
  const tag = fyTag(fyStartYear(date));
  return tag ? `${tag}/${padded}` : padded;
};

/* ───────────── what a series does to the document it labels ───────────── */

/**
 * The part of a series a document KEEPS, frozen onto it when it is saved.
 *
 * WHY FROZEN AND NOT READ BACK LIVE. lib/invoicePrefs.mjs draws the line and
 * states the reason: this app prints a bill from the invoice row plus the
 * firm's CURRENT profile, so a presentation setting applied to last year's
 * bill changes how it looks -- tolerable -- while a setting that changes a
 * FIGURE makes it a different bill from the one the customer holds and the
 * one that was filed. That module names "no invoice-number prefix" among the
 * things that must never be a live setting, for exactly this reason.
 *
 * A series carries both kinds at once. Editing one must not renumber or
 * re-caption a bill that has gone out, so the whole profile is copied onto
 * the document at save, like the buyer block and `uqc` before it.
 *
 * `lockVoucher` is deliberately NOT in here: a lock is a thing you want to
 * take off again, so the routes read it live from the master.
 */
export const seriesSnapshot = (series) => ({
  topHeading: text(series?.topHeading),
  topSubHeading: text(series?.topSubHeading),
  invoiceNoCaption: text(series?.invoiceNoCaption),
  declarationCaption: text(series?.declarationCaption),
  declaration: text(series?.declaration),
  bookNo: text(series?.bookNo),
  store: text(series?.store),
  printCompName: seriesFlag(series?.printCompName, true),
  compressPrinting: seriesFlag(series?.compressPrinting, false),
  rollStationary: seriesFlag(series?.rollStationary, false),
  effectInStock: seriesFlag(series?.effectInStock, true),
});

export const SERIES_SNAPSHOT_FIELDS = Object.keys(seriesSnapshot());

/**
 * Does a document under this series move stock?
 *
 * Sigfa's "Effect In Stock". NO SERIES MEANS YES -- every bill moves stock
 * today, and a firm that has defined no series must go on behaving exactly as
 * it does now. Only a series that deliberately says no turns it off.
 */
export const effectsStock = (series) =>
  series === null || series === undefined ? true : seriesFlag(series?.effectInStock, true);

/**
 * Is a document under this series locked against alteration?
 *
 * Read LIVE from the master rather than from the snapshot above, because a
 * lock is meant to be removable: unticking Lock Voucher must free the
 * documents it was holding.
 */
export const isSeriesLocked = (series) => seriesFlag(series?.lockVoucher, false);

/**
 * The number as this series writes it -- Sigfa's `VOUCHER Text(16)`.
 *
 * The initial, then the number padded to `fillLeftSpaceWithZero` digits, both
 * off the series. Frozen onto the document at save by the save routes, which
 * is what keeps it true after somebody edits the series.
 *
 * "" when there is no series, and the document then shows its plain number as
 * it always has.
 */
export const voucherNoFor = (docNo, series, date = null) =>
  series ? formatDocNo(docNo, series, date) : "";

/**
 * WHAT AN ALTER MAY NOT DO TO A BILL'S NUMBER -- Sigfa's rule.
 *
 * Read out of SIGFA105.exe on 15 October 2026. Its sale screen, in Alter,
 * refuses a change of series outright, with one of two messages:
 *
 *   "Changing Series Would Disturb Effect In Stock !"   (the two series
 *                                                        differ on stock)
 *   "Can't Change Series !"                              (otherwise)
 *
 * and it keeps each financial year in its own data file (S01yyyy.mdb), so a
 * bill can never be re-dated into another year's book either. A bill's
 * series and year are therefore fixed once it is saved, which is what keeps
 * its number fixed: in Sigfa the number is the series' own (Max(RVoucher) per
 * Mkey and Series), so moving a bill would either collide with that book's
 * numbers or leave the customer holding a number the books no longer have.
 *
 * This app used to allow both, numbering the moved bill afresh in the other
 * book. That is exactly where the number on screen and the number in the
 * lists drifted apart, so it now refuses them as Sigfa does.
 *
 *   before      the bill as stored: { series, finYear, seriesNo }
 *   after       what the alter would save: { series, date }
 *   beforeRow   the master's row for the stored series (null if none)
 *   afterRow    the master's row for the series being saved (null if none)
 *
 * Returns the message to show, or "" when the alter is fine. A bill with no
 * series at all is untouched by this: it has no book to leave.
 */
export const alterNumberProblem = ({ before = {}, after = {}, beforeRow = null, afterRow = null } = {}) => {
  const was = normalizeSeriesCode(before?.series);
  const now = normalizeSeriesCode(after?.series);

  if (was !== now) {
    if (effectsStock(beforeRow) !== effectsStock(afterRow)) {
      return "Changing the series would disturb Effect In Stock, so the series of a saved bill cannot be changed.";
    }
    return `The series of a saved bill cannot be changed (it is ${was || "None"}). To raise it under ${now || "None"}, make a new bill and delete this one.`;
  }

  // Same series: the year must stay the year it was numbered in.
  const year = Number(before?.finYear);
  if (was && Number.isFinite(year) && before?.finYear !== null && before?.finYear !== undefined) {
    const target = fyStartYear(after?.date);
    if (target !== null && target !== year) {
      return `This bill is numbered in financial year ${fyTag(year)}. A date in ${fyTag(target)} needs a new bill.`;
    }
  }
  return "";
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
