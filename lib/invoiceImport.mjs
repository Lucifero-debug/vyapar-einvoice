/**
 * Reading a bill off a photograph, and turning it into a draft -- a sale, a
 * purchase, or a return of either.
 *
 * WHICH SIDE IS US decides everything else: the party is whichever side of
 * the bill is NOT this firm, and the screen is the one for that direction.
 * See `resolveKind` below. (This module read purchase bills only until
 * 2026-10; the field names `supplier*` survive from then and mean the ISSUER
 * of the document, whoever that is.)
 *
 * Pure and dependency-free, like the rest of lib/*.mjs, so `node` can run
 * scripts/invoice-import.test.mjs directly. Never import Mongoose in here,
 * and never call the model from here -- the extraction arrives as an argument.
 *
 *
 * WHAT THIS REPLACES, AND WHY IT HAD TO BE REPLACED
 * ------------------------------------------------
 * `app/upload/page.js` sent the image to a service, took the JSON back and
 * POSTed it straight to `/api/save-invoice`. Six things were wrong with that,
 * and five of them wrote bad data into the books with nobody watching:
 *
 *   1. `invoiceNo: parseInt(aiInvoice.invoiceNo)` -- the SUPPLIER'S bill
 *      number used as OURS. Vyapaar's `invoiceNo` is its own per-firm
 *      sequence with a unique index on { companyId, invoiceNo }, so an
 *      import either collided with a real invoice or, when the number was
 *      unreadable, posted NaN into a required field.
 *
 *   2. `stateOfSupply: aiInvoice.stateOfSupply || "Delhi"` and
 *      `taxType: aiInvoice.taxType || "local"`. Those two decide CGST+SGST
 *      versus IGST. Defaulting them is a tax decision taken by a fallback.
 *      And they are not the model's to supply at all: lib/placeOfSupply.mjs
 *      takes the place of supply from the PARTY'S MASTER and nowhere else.
 *
 *   3. Every figure was the model's arithmetic -- `totalAmount`, `gst`,
 *      `finalAmount`, the HSN summary. This app computes those from the
 *      lines (lib/billingMath.mjs), the totals are tax-INCLUSIVE, and
 *      `balanceDue` and `received` are posted amounts that move a party's
 *      balance. A language model's addition has no business in a ledger.
 *
 *   4. `items: aiInvoice.items || []` went in unvalidated, while
 *      `models/invoiceModel.js` REQUIRES name, quantity, cost, discount and
 *      total on every line. A missing one fails validation; a present but
 *      wrong one posts a wrong stock movement.
 *
 *   5. No master matching whatsoever. A bill from "Bharat Steel Pvt. Ltd."
 *      wrote ledger rows under that string whether or not any such account
 *      existed -- so the party ledger held rows for a name with no account,
 *      no group and no opening balance, and the stock ledger held movements
 *      for items the item master had never heard of.
 *
 *   6. It saved first and showed the user afterwards.
 *
 * So what this module produces is a DRAFT and a list of things to look at.
 * Nothing here writes anything. The draft is handed to the ordinary purchase
 * screen, the person checks it, and the save goes through the same posting
 * path as a hand-typed bill.
 *
 *
 * AN EXACT MATCH IS APPLIED. A LIKELY ONE IS ONLY EVER SUGGESTED
 * -------------------------------------------------------------
 * The line between them is the whole design of the matching below.
 *
 * "bharat steel" and "Bharat Steel " are the same name -- a difference of
 * case or padding, which `nameKey` in lib/uniqueName.mjs already treats as
 * identical everywhere else in this app. Those are applied.
 *
 * "Bharat Steel Pvt Ltd" against a master holding "Bharat Steels" is a
 * GUESS. It is a good guess and it is worth showing, but applying it silently
 * would post a bill to the wrong account on the strength of a string
 * similarity -- and the wrong account is somebody whose balance is now wrong
 * and whose statement now shows a bill they never sent. So a fuzzy match
 * comes back as a suggestion with its score, and the person picks.
 *
 * `MATCH_APPLIED` and `MATCH_SUGGESTED` name the two outcomes so the screen
 * and the tests cannot blur them.
 */

import { round2 } from "./balance.mjs";
import { recalcItem, buildHsnTotals, hsnTotalsArray, totalGstOf } from "./billingMath.mjs";
import { normalizeStateCode } from "./gst.mjs";
import { nameKey, normalizeName } from "./uniqueName.mjs";
import { BILLING_TYPES } from "./billingTypes.mjs";
import { resolveGroup } from "./accountGroups.mjs";

const text = (value) => String(value ?? "").trim();

/** A number, or null -- never NaN, and never a silent zero. */
export const num = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const raw = text(value).replace(/[₹$\s]/g, "");
  if (!raw) return null;

  // A COMMA USED AS A DECIMAL POINT IS REFUSED, not stripped.
  //
  // Indian grouping puts a comma before a group of exactly three digits, or
  // before two digits that are themselves followed by another comma:
  // 1,18,000 and 1,00,000.00. A comma with only one or two digits after it
  // and then nothing is therefore not a group separator -- it is a European
  // decimal point, and "1 250,50" means 1250.50.
  //
  // Stripping it turns that into 125050: a hundredfold error in a rate, on a
  // bill nobody would think to re-check. Guessing which of a comma and a stop
  // is the separator is not a thing to do with somebody's money, so a value
  // written that way comes back as unread and the person types it in.
  const lastComma = raw.lastIndexOf(",");
  if (lastComma >= 0 && /^\d{1,2}$/.test(raw.slice(lastComma + 1))) return null;

  const cleaned = raw.replace(/,/g, "");
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
};

/* ─────────────────────── what the model is asked for ─────────────────── */

/**
 * The fields the extractor returns, and what each one means.
 *
 * Declared here rather than in the prompt so that ONE list drives the
 * prompt, the normaliser and the test that checks the two agree. A field the
 * prompt asks for and this does not know is dropped on the way in; a field
 * this expects and the prompt never mentions comes back empty on every bill,
 * which is the bug you only find by reading both.
 *
 * `supplierInvoiceNo` is deliberately NOT called `invoiceNo`. That name
 * belongs to Vyapaar's own sequence, and conflating the two is mistake 1 in
 * the header.
 */
export const EXTRACTION_FIELDS = [
  {
    name: "documentKind",
    note: 'What the document calls itself: "invoice" (tax invoice, bill, cash memo, bill of supply), "credit note" or "debit note".',
  },
  { name: "supplierName", note: "The ISSUER's name -- whoever issued this document, usually at the top. Not the addressee's." },
  { name: "supplierGstin", note: "The issuer's GSTIN, 15 characters." },
  { name: "supplierPhone", note: "Any phone number printed for the issuer." },
  { name: "supplierAddress", note: "The issuer's address as one line." },
  { name: "supplierState", note: "The issuer's state, spelled out." },
  { name: "buyerName", note: "Who the document is addressed to (Bill to / Buyer / M/s)." },
  { name: "buyerGstin", note: "The addressee's GSTIN, if printed." },
  { name: "buyerPhone", note: "Any phone number printed for the addressee." },
  { name: "buyerAddress", note: "The addressee's address as one line." },
  { name: "buyerState", note: "The addressee's state, spelled out." },
  { name: "supplierInvoiceNo", note: "The document's own number, exactly as printed, letters and all." },
  { name: "date", note: "The bill date as yyyy-mm-dd. Indian bills are dd-mm-yyyy; convert." },
  { name: "paymentType", note: "Cash, Credit, Cheque or a bank name, if said." },
  { name: "transport", note: "Transporter name." },
  { name: "grNo", note: "GR or LR number." },
  { name: "ewayBillNo", note: "E-way bill number." },
  { name: "printedTaxable", note: "The taxable value the bill prints, for checking only." },
  { name: "printedGst", note: "The total GST the bill prints, for checking only." },
  { name: "printedTotal", note: "The grand total the bill prints, for checking only." },
  { name: "printedRoundOff", note: "Any round-off line." },
  { name: "freight", note: "Freight or transport charged as a line." },
  {
    name: "lines",
    note:
      "One entry per item row: name, hsn, unit, quantity, rate, discountPercent, gstRate. " +
      "Read the RATE per unit, never the row total. Leave a field out rather than guessing it.",
  },
];

export const EXTRACTION_FIELD_NAMES = EXTRACTION_FIELDS.map((f) => f.name);

export const LINE_FIELDS = [
  "name",
  "hsn",
  "unit",
  "quantity",
  "rate",
  "discountPercent",
  "gstRate",
];

/**
 * Whatever came back, in the shape the rest of this module expects.
 *
 * Unknown keys are dropped rather than carried: the extraction is untrusted
 * input from a model that can return anything, and this is the only gate
 * between it and the draft.
 */
/** Longest text field kept, and most rows read, from any one bill. */
export const MAX_TEXT = 200;
export const MAX_LINES = 300;

export const normalizeExtraction = (raw) => {
  const source = raw && typeof raw === "object" ? raw : {};
  const out = {};

  for (const name of EXTRACTION_FIELD_NAMES) {
    if (name === "lines") continue;
    const value = source[name];
    // The printed figures and freight are numbers; everything else is text,
    // capped -- nothing printed on a bill is longer, and every name is
    // compared against the whole master.
    out[name] = /^printed|^freight$/.test(name) ? num(value) : text(value).slice(0, MAX_TEXT);
  }

  out.supplierGstin = out.supplierGstin.toUpperCase().replace(/\s/g, "");
  out.buyerGstin = out.buyerGstin.toUpperCase().replace(/\s/g, "");
  out.documentKind = documentKindOf(out.documentKind);

  const lines = Array.isArray(source.lines) ? source.lines.slice(0, MAX_LINES) : [];
  out.lines = lines
    .map((line) => {
      const l = line && typeof line === "object" ? line : {};
      return {
        name: normalizeName(text(l.name).slice(0, MAX_TEXT)),
        hsn: text(l.hsn).replace(/\s/g, "").slice(0, 20),
        unit: text(l.unit).toUpperCase().slice(0, 20),
        quantity: num(l.quantity),
        rate: num(l.rate),
        discountPercent: num(l.discountPercent),
        gstRate: num(l.gstRate),
      };
    })
    // A row with no name is not a row. Bills carry sub-totals, "Carried
    // forward" lines and the odd stray mark that a model reads as a line.
    .filter((l) => l.name);

  return out;
};

/**
 * What the model is told to do, built from the field list above.
 *
 * In the pure module rather than in the route so that a test can assert the
 * prompt and the normaliser describe the same fields -- a prompt asking for
 * `invoiceTotal` while the normaliser reads `printedTotal` comes back empty
 * on every bill and looks like a model that cannot read totals.
 *
 * The instructions are the ones that matter on an Indian GST bill, and every
 * one of them is here because of a way these are misread:
 *
 *   - the RATE, not the row total. The two columns sit next to each other and
 *     a row total read as a rate multiplies the bill by the quantity.
 *   - dd-mm-yyyy. An Indian bill dated 05-10-2026 is 5 October; read as
 *     American it lands in May and in the wrong GST return.
 *   - leave a field out rather than guess. A guessed quantity is ind
 *     istinguishable from a read one once it is in the draft, and the whole
 *     review screen depends on knowing which is which.
 *   - the SELLER, not the buyer. Both names are on the bill, in similar
 *     boxes, and getting them the wrong way round books the purchase against
 *     your own firm.
 */
export const extractionPrompt = () => {
  const fields = EXTRACTION_FIELDS.map((f) => `  "${f.name}": ${f.note}`).join("\n");

  return [
    "You are reading a photograph or scan of a BILL from an Indian business: a tax invoice, cash memo, credit note or debit note.",
    "It may have been issued BY the business reading it (a sale) or TO it (a purchase). Do not decide which; read both parties as printed.",
    "Return ONLY a JSON object. No prose, no explanation, no markdown fences.",
    "",
    "The keys, and what each one means:",
    fields,
    "",
    "Rules:",
    "- Read what is printed. Do not calculate, correct or complete anything.",
    "- If a field is not printed or you cannot read it, LEAVE THE KEY OUT. Never guess, and never write a placeholder like 'N/A' or 0.",
    "- Dates on Indian bills are dd-mm-yyyy. Convert to yyyy-mm-dd.",
    "- For each item row give the RATE PER UNIT, not the row's amount. They are adjacent columns and confusing them multiplies the bill.",
    "- The supplier* keys are whoever ISSUED the document. The buyer* keys are whoever it is addressed to. Both appear in similar boxes; do not swap them.",
    "- Numbers: digits only, with a full stop for the decimal. Drop currency symbols and thousands separators.",
    "- Include freight, loading, packing and round-off rows in `lines` exactly as printed. Do not fold them into other rows.",
    "- GST rate is the percentage for that row (5, 12, 18, 28), not the rupee amount.",
  ].join("\n");
};

/**
 * The JSON out of a model's reply, or null.
 *
 * Models wrap JSON in markdown fences and in sentences however firmly they
 * are told not to, and a parse that only tries `JSON.parse` on the whole
 * reply fails on a perfectly good extraction. So: the whole thing first, then
 * a fenced block, then the outermost braces.
 *
 * Returns null rather than throwing, because the route turns it into a
 * message the person can act on -- "could not read this bill" -- and a stack
 * trace is not that.
 */
export const parseExtractionJson = (reply) => {
  const body = text(reply);
  if (!body) return null;

  const attempts = [body];

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(body);
  if (fenced) attempts.push(fenced[1]);

  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  if (first >= 0 && last > first) attempts.push(body.slice(first, last + 1));

  for (const attempt of attempts) {
    try {
      const parsed = JSON.parse(attempt);
      // An array or a string is not an extraction, however valid the JSON.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next shape.
    }
  }
  return null;
};

/** "invoice", "credit note", "debit note", or "" when it did not say. */
export function documentKindOf(value) {
  const t = text(value).toLowerCase();
  if (!t) return "";
  if (/credit/.test(t)) return "credit note";
  if (/debit/.test(t)) return "debit note";
  if (/invoice|bill|memo|supply/.test(t)) return "invoice";
  return "";
}

/* ─────────────────────── which kind of bill is this ──────────────────── */

/**
 * The four kinds of bill, the same four keys as the billing screens
 * (lib/billingTypes.mjs). "auto" asks for the kind to be worked out.
 */
export const IMPORT_KINDS = ["sale", "purchase", "salereturn", "purchasereturn"];
export const AUTO_KIND = "auto";

/** Which way a kind faces: is the party a customer or a supplier? */
export const partyRoleOf = (kind) =>
  BILLING_TYPES[kind]?.type === "Sale" ? "customer" : "supplier";

// Exact (case and spacing aside), deliberately: "Shah Steels" is not "Shah
// Brothers", and a near-miss here turns a supplier's bill into a sale.
const sameName = (a, b) => {
  const x = nameKey(a);
  const y = nameKey(b);
  return Boolean(x && y && x === y);
};

/**
 * Which side of the bill is THIS firm: "issuer", "addressee", or null.
 *
 * By GSTIN first -- a registration is an identifier -- then by name. A
 * firm's own name on both sides, or on neither, is no answer.
 */
export function ourSide(read, company) {
  const gstin = text(company?.gstin).toUpperCase();
  if (gstin.length === 15) {
    const issuer = text(read?.supplierGstin) === gstin;
    const addressee = text(read?.buyerGstin) === gstin;
    if (issuer !== addressee) return { side: issuer ? "issuer" : "addressee", by: "gstin" };
  }
  // The trading name, or the legal name a GST bill usually prints.
  const names = [text(company?.name), text(company?.legalName)].filter(Boolean);
  if (names.length) {
    const issuer = names.some((n) => sameName(read?.supplierName, n));
    const addressee = names.some((n) => sameName(read?.buyerName, n));
    if (issuer !== addressee) return { side: issuer ? "issuer" : "addressee", by: "name" };
  }
  return null;
}

/**
 * The kind, from what the document calls itself and which side we are on.
 *
 *                      we issued it        it was issued to us
 *   invoice            sale                purchase
 *   credit note        sale return         purchase return  (supplier's note)
 *   debit note         -- ask --           -- ask --
 *
 * A DEBIT NOTE IS NEVER GUESSED. Under GST it is the supplier's document for
 * raising a price or tax; in trade it is just as often the buyer's note for
 * goods sent back. The two are opposite postings, so the person chooses.
 */
export function kindFrom(documentKind, side) {
  if (side !== "issuer" && side !== "addressee") return null;
  const weIssued = side === "issuer";
  if (documentKind === "debit note") return null;
  if (documentKind === "credit note") return weIssued ? "salereturn" : "purchasereturn";
  return weIssued ? "sale" : "purchase";
}

/**
 * The kind this draft is, and which side of the bill is the party.
 *
 * `chosen` is what the person picked ("auto" or one of IMPORT_KINDS). A
 * choice is respected; a choice that disagrees with what the bill shows is
 * kept and reported (`conflict`), because the person may know something the
 * paper does not. Auto with no way to tell gives `kind: null`, and the
 * screen asks -- a sale posted as a purchase is two wrong signs at once.
 *
 * The party is the side that is NOT us. When we cannot find ourselves on the
 * bill, the usual layout for the kind is assumed: a sale is addressed to the
 * customer, a purchase is issued by the supplier, and a purchase return is
 * our debit note TO the supplier or their credit note to us.
 */
export function resolveKind({ read, company, chosen = AUTO_KIND } = {}) {
  const us = ourSide(read, company);
  const detected = us ? kindFrom(read?.documentKind, us.side) : null;
  const picked = IMPORT_KINDS.includes(chosen) ? chosen : null;
  const kind = picked || detected;

  let partySide = null;
  if (us) partySide = us.side === "issuer" ? "addressee" : "issuer";
  else if (kind === "sale") partySide = "addressee";
  else if (kind === "purchase") partySide = "issuer";
  // A return is either side's note: our credit note TO a customer or their
  // debit note to us; their credit note to us or our debit note to them.
  else if (kind === "salereturn") partySide = read?.documentKind === "debit note" ? "issuer" : "addressee";
  else if (kind === "purchasereturn") partySide = read?.documentKind === "debit note" ? "addressee" : "issuer";

  return {
    kind,
    chosen: picked || AUTO_KIND,
    detected,
    detectedBy: us ? us.by : null,
    conflict: Boolean(picked && detected && picked !== detected),
    partySide,
  };
}

/** The party's printed details, from whichever side of the bill they are on. */
export function partyFromRead(read, partySide) {
  const p = partySide === "addressee" ? "buyer" : partySide === "issuer" ? "supplier" : null;
  if (!p) return { name: "", gstin: "", phone: "", address: "", state: "" };
  return {
    name: text(read?.[`${p}Name`]),
    gstin: text(read?.[`${p}Gstin`]).toUpperCase(),
    phone: text(read?.[`${p}Phone`]),
    address: text(read?.[`${p}Address`]),
    state: text(read?.[`${p}State`]),
  };
}

/* ───────────────────────────── matching ─────────────────────────────── */

export const MATCH_APPLIED = "applied";
export const MATCH_SUGGESTED = "suggested";
export const MATCH_NONE = "none";

/**
 * A name reduced to the tokens worth comparing.
 *
 * Punctuation and the legal-form words go, because "Bharat Steel Pvt. Ltd."
 * and "Bharat Steel Private Limited" are one supplier and a shop types
 * whichever it feels like. The TRADING words stay -- "Steel", "Traders",
 * "Enterprises" -- because dropping those is how "Bharat Steel" and "Bharat
 * Textiles" become the same account.
 */
const FORM_WORDS = new Set([
  "pvt", "private", "ltd", "limited", "llp", "inc", "co", "company", "and", "the",
]);

export const nameTokens = (value) =>
  nameKey(value)
    .replace(/[.,/\\&()'"-]+/g, " ")
    // Digits split from letters, so "10mm" and "10 mm" are the same two
    // tokens and "50x50" is three. A shop writes a size whichever way, and
    // the camera adds or loses the space as often as the typist does.
    .replace(/(\d)([a-z])/g, "$1 $2")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .split(/\s+/)
    .filter((t) => t && !FORM_WORDS.has(t));

/**
 * Are these two tokens the same word, allowing for one slip?
 *
 * Equal, or a prefix of at least four characters, or one edit apart at four
 * characters or more. "plat" and "plate", "angl" and "angle", "steel" and
 * "steeI" with a capital i -- all the same token. Four characters is the
 * floor because below it a single edit is most of the word: "rod" and "rid"
 * are an edit apart and are not the same item.
 */
const closeEnough = (a, b) => {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length < 4) return false;
  if (long.startsWith(short)) return true;
  if (long.length - short.length > 1) return false;

  // One insertion, deletion or substitution. Walked rather than computing a
  // full distance matrix, because the only answer wanted is "is it one?".
  let i = 0;
  let j = 0;
  let slips = 0;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i += 1;
      j += 1;
      continue;
    }
    slips += 1;
    if (slips > 1) return false;
    if (short.length === long.length) {
      i += 1;
      j += 1;
    } else {
      j += 1;
    }
  }
  return slips + (short.length - i) + (long.length - j) <= 1;
};

/**
 * How alike two names are, 0 to 1.
 *
 * Token overlap (Jaccard) with a bonus when one is a prefix of the other, so
 * "Bharat Steel" scores well against "Bharat Steel Corporation" -- a shop
 * abbreviating a long name is the commonest near-miss on a master.
 *
 * Token overlap rather than a distance over the WHOLE string: a distance
 * over the whole name ranks "Bharat Steel" against "Bharat Textiles" by how
 * many letters they share, which is most of them. Overlap asks the right
 * question -- how many of the same words -- and `closeEnough` then absorbs
 * the one-character slips a camera introduces inside a word.
 *
 * It is a generous measure on purpose, because of what a score is FOR: a
 * fuzzy match is only ever offered as a suggestion for a person to pick, so
 * a near-miss shown and rejected costs a glance, and a near-miss not shown
 * costs a master typed in again by hand. Nothing is ever applied on a score
 * -- see MATCH_APPLIED above.
 */
export const nameScore = (a, b) => {
  const left = nameTokens(a);
  const right = nameTokens(b);
  if (!left.length || !right.length) return 0;

  const setL = [...new Set(left)];
  const setR = [...new Set(right)];
  // A token on the left counts as shared when SOME token on the right is the
  // same word allowing for one slip -- see `closeEnough`. Each right-hand
  // token is spent once, so three tokens cannot all match one.
  const spent = new Set();
  let shared = 0;
  for (const token of setL) {
    const found = setR.findIndex((other, index) => !spent.has(index) && closeEnough(token, other));
    if (found >= 0) {
      spent.add(found);
      shared += 1;
    }
  }
  const union = setL.length + setR.length - shared;
  const jaccard = union ? shared / union : 0;

  const joinedL = left.join(" ");
  const joinedR = right.join(" ");
  const prefix = joinedL.startsWith(joinedR) || joinedR.startsWith(joinedL) ? 0.15 : 0;

  return Math.min(1, round2(jaccard + prefix));
};

/** Below this a suggestion is noise rather than a near-miss. */
export const SUGGEST_FLOOR = 0.45;

/** How many near-misses are worth showing beside a field. */
export const MAX_SUGGESTIONS = 4;

/**
 * Find `needle` among `records`, by name.
 *
 * Returns `{ how, record, score, suggestions }`:
 *
 *   how: "applied"    the same name -- exact, or differing only in case or
 *                     padding, which is what `nameKey` already treats as
 *                     identical everywhere else in this app
 *   how: "suggested"  a likely one, NOT applied. See the header.
 *   how: "none"       nothing close enough to mention
 *
 * `field` is which property holds the name, because an item master and a
 * party master both use `name` but a state master uses it for something
 * else -- the caller says.
 */
export const matchMaster = (needle, records = [], { field = "name" } = {}) => {
  const wanted = normalizeName(needle);
  const blank = { how: MATCH_NONE, record: null, score: 0, suggestions: [] };
  if (!wanted) return blank;

  const rows = (records || []).filter((r) => text(r?.[field]));

  const exact = rows.find((r) => text(r[field]) === wanted);
  if (exact) return { how: MATCH_APPLIED, record: exact, score: 1, suggestions: [] };

  // Case and padding only. `nameKey` lowercases and trims, which is the rule
  // `findNameClash` already enforces when a master is created -- so two rows
  // that differ only this way cannot both exist, and matching one is not a
  // guess.
  const key = nameKey(wanted);
  const loose = rows.find((r) => nameKey(r[field]) === key);
  if (loose) return { how: MATCH_APPLIED, record: loose, score: 1, suggestions: [] };

  const scored = rows
    .map((r) => ({ record: r, score: nameScore(wanted, r[field]) }))
    .filter((s) => s.score >= SUGGEST_FLOOR)
    .sort((a, b) => b.score - a.score || text(a.record[field]).localeCompare(text(b.record[field])));

  if (!scored.length) return blank;

  return {
    how: MATCH_SUGGESTED,
    // The best guess is carried so a screen can preselect it in a picker --
    // but `how` says it was not applied, and the draft does not use it.
    record: scored[0].record,
    score: scored[0].score,
    suggestions: scored.slice(0, MAX_SUGGESTIONS).map((s) => ({
      name: text(s.record[field]),
      id: text(s.record._id ?? s.record.id),
      score: s.score,
    })),
  };
};

/**
 * A party matched by GSTIN first, then by name.
 *
 * A GSTIN is an identifier and a name is a label, so a GSTIN that matches is
 * worth more than a name that matches: two shops can share a name and no two
 * share a registration. This is also the only way to recognise a supplier
 * whose bill spells their name differently from the master.
 */
export const matchParty = (extraction, parties = []) => {
  // Either a party's details ({ name, gstin }, from `partyFromRead`) or, as
  // before, a whole extraction -- whose issuer was always the supplier.
  const who =
    extraction && ("name" in extraction || "gstin" in extraction)
      ? extraction
      : { name: extraction?.supplierName, gstin: extraction?.supplierGstin };
  const gstin = text(who.gstin).toUpperCase();
  if (gstin.length === 15) {
    const byGstin = (parties || []).find(
      (p) => text(p?.gstIn ?? p?.gstin).toUpperCase() === gstin
    );
    if (byGstin) {
      return { how: MATCH_APPLIED, record: byGstin, score: 1, suggestions: [], by: "gstin" };
    }
  }
  return { ...matchMaster(who.name, parties), by: "name" };
};

/* ────────────────────────────── the lines ───────────────────────────── */

/**
 * Words that mean this row is a CHARGE, not something that came off a lorry.
 *
 * A bill's freight, loading, packing and insurance rows read exactly like
 * item rows to a camera, and the old import turned every one of them into an
 * item master entry and a stock movement -- so "Loading charges" became a
 * thing the firm had 1 of in stock.
 *
 * This only FLAGS them. Deciding is the person's: a firm that genuinely
 * trades in packing material has an item called packing, and a heuristic
 * that moved rows off the bill by itself would be wrong for them and
 * unnoticeable. The screen offers to move it to the freight or party-tax
 * field, which is where a charge belongs.
 */
const CHARGE_WORDS = [
  "freight", "transport", "cartage", "loading", "unloading", "packing", "packaging",
  "insurance", "handling", "courier", "labour", "round off", "roundoff", "discount",
];

export const looksLikeCharge = (line) => {
  const name = nameKey(line?.name);
  if (!name) return false;
  // Only when there is no HSN: a charge row has no HSN on an Indian bill,
  // and a real item called "Packing Tape" has one.
  if (text(line?.hsn)) return false;
  return CHARGE_WORDS.some((word) => name.includes(word));
};

/**
 * One bill row against the item master.
 *
 * Where the bill is silent, the MASTER fills in -- its HSN, its GST rate, its
 * unit. That is the right way round: the master is what the firm has decided
 * about that item, and a camera reading "18" off a smudged column is not
 * better evidence than the item's own record. Where the bill DOES say and the
 * master disagrees, the bill wins for this document and the difference is
 * reported, because a supplier who has changed their HSN is a thing to know
 * about rather than to overwrite.
 *
 * The money is then recomputed by `recalcItem` -- the same function all four
 * billing screens use. Nothing the model said about a row total is kept.
 */
export const importLine = (line, items = []) => {
  const match = matchMaster(line?.name, items);
  const master = match.how === MATCH_APPLIED ? match.record : null;

  const quantity = num(line?.quantity);
  const rate = num(line?.rate);

  const billHsn = text(line?.hsn);
  const billGst = num(line?.gstRate);
  const billUnit = text(line?.unit);

  const hsn = billHsn || text(master?.hsn);
  const gstRate = billGst === null ? num(master?.gst) : billGst;
  const unit = billUnit || text(master?.unit);

  const differs = [];
  if (master) {
    if (billHsn && text(master.hsn) && billHsn !== text(master.hsn)) {
      differs.push(`HSN on the bill is ${billHsn}; the master says ${text(master.hsn)}`);
    }
    if (billGst !== null && num(master.gst) !== null && billGst !== num(master.gst)) {
      differs.push(`GST on the bill is ${billGst}%; the master says ${num(master.gst)}%`);
    }
  }

  // The invoice line's own shape, with the five required fields present.
  // `cost` is the PURCHASE rate off the bill itself -- not a master rate
  // from `resolveItemPricing`. The supplier's bill is the authority on what
  // was paid.
  const draft = recalcItem({
    name: master ? text(master.name) : normalizeName(line?.name),
    quantity: quantity === null ? 0 : quantity,
    cost: rate === null ? 0 : rate,
    discount: num(line?.discountPercent) ?? 0,
    hsn,
    gstRate: gstRate === null ? 0 : gstRate,
    unit,
    description: "",
  });

  return {
    ...draft,
    // Everything the screen needs to show why this row looks as it does.
    match: {
      how: match.how,
      masterName: master ? text(master.name) : "",
      masterId: master ? text(master._id ?? master.id) : "",
      score: match.score,
      suggestions: match.suggestions,
      // What was read, kept beside what was decided, so a person checking
      // the draft can see the bill's own words without the photograph.
      read: {
        name: normalizeName(line?.name),
        hsn: billHsn,
        unit: billUnit,
        quantity,
        rate,
        gstRate: billGst,
        discountPercent: num(line?.discountPercent),
      },
      differs,
      // What is missing and has to be typed before this row can be saved.
      // An HSN is only missing on a row that is an ITEM: a charge has none,
      // and demanding one would block every bill that carries freight.
      missing: [
        quantity === null ? "quantity" : "",
        rate === null ? "rate" : "",
        !hsn && !looksLikeCharge(line) ? "hsn" : "",
      ].filter(Boolean),
      // Reads like freight or loading rather than goods -- see CHARGE_WORDS.
      charge: looksLikeCharge(line),
    },
  };
};

export const importLines = (extraction, items = []) =>
  (extraction?.lines || []).map((line) => importLine(line, items));

/* ──────────────────────────── the arithmetic ────────────────────────── */

/**
 * What the lines come to, and how that compares with what the bill printed.
 *
 * Our figures are the lines'; the printed ones are evidence that the lines
 * were read correctly. A difference is NOT corrected -- the draft keeps the
 * figures the lines produce, because those are the ones the posting path will
 * use and silently bending them to match a number read off a photograph is
 * how a bill comes to disagree with its own rows.
 *
 * It is reported instead, with the difference, so the person knows to look.
 * `tolerance` allows for the round-off line that most bills carry.
 */
export const reconcileTotals = (lines = [], extraction = {}, { tolerance = 1 } = {}) => {
  const gst = round2(totalGstOf(lines));
  const taxable = round2(lines.reduce((t, l) => t + (Number(l.taxableAmount) || 0), 0));
  // Tax-INCLUSIVE, like `Invoice.totalAmount` everywhere else in this app.
  const total = round2(lines.reduce((t, l) => t + (Number(l.total) || 0), 0));

  const compare = (ours, printed) => {
    if (printed === null || printed === undefined) return null;
    const difference = round2(ours - round2(printed));
    return { ours, printed: round2(printed), difference, agrees: Math.abs(difference) <= tolerance };
  };

  return {
    taxable,
    gst,
    total,
    checks: {
      taxable: compare(taxable, extraction?.printedTaxable),
      gst: compare(gst, extraction?.printedGst),
      total: compare(total, extraction?.printedTotal),
    },
  };
};

/**
 * Intra-state or inter-state, from the two state codes.
 *
 * "local" is CGST + SGST and "central" is IGST, which are the two values the
 * rest of this app uses (`lib/invoiceGl.mjs` reads `taxType`). Returns null
 * when either code is missing, because the honest answer then is "nobody has
 * told me" -- and the old code's `|| "local"` is a tax decision made by a
 * fallback.
 */
export const taxTypeFor = (sellerStateCode, buyerStateCode) => {
  const seller = normalizeStateCode(sellerStateCode);
  const buyer = normalizeStateCode(buyerStateCode);
  if (!seller || !buyer) return null;
  return seller === buyer ? "local" : "central";
};

/** The state code a GSTIN begins with, or "". */
export const stateCodeOfGstin = (gstin) => {
  const value = text(gstin).toUpperCase();
  return value.length === 15 ? normalizeStateCode(value.slice(0, 2)) : "";
};

/* ───────────────────────────── the draft ────────────────────────────── */

/**
 * The whole draft: the party, the lines, the figures and everything to check.
 *
 * `company` is the importing firm, for the buyer-side state code. `parties`
 * and `items` are the firm's own masters. NOTHING is written -- the draft is
 * handed to the purchase screen and saved from there, through the same path
 * as a typed bill.
 *
 * THE PLACE OF SUPPLY IS NOT IN HERE, and that is deliberate. It comes from
 * the matched party's master (lib/placeOfSupply.mjs) and from nowhere else,
 * so a draft cannot carry a state read off the paper onto the invoice. When
 * the party is NEW, the state read off the bill goes into the proposed
 * MASTER -- which is where it belongs and what makes the next bill from them
 * right as well.
 */
export const draftFromExtraction = ({
  extraction,
  parties = [],
  items = [],
  company = null,
  // "auto" works it out from the bill; a key from IMPORT_KINDS is the
  // person's choice. Defaults to a purchase, which is all this read before.
  kind: chosen = "purchase",
} = {}) => {
  const read = normalizeExtraction(extraction);
  const kindOf = resolveKind({ read, company, chosen });
  const who = partyFromRead(read, kindOf.partySide);
  const party = kindOf.partySide ? matchParty(who, parties) : { how: MATCH_NONE, score: 0, suggestions: [], by: "name" };
  const lines = importLines(read, items);
  const totals = reconcileTotals(lines, read);

  const partyRecord = party.how === MATCH_APPLIED ? party.record : null;
  const role = kindOf.kind ? partyRoleOf(kindOf.kind) : null;

  // From the two registrations, not from the bill's own words about it. A
  // side without a GSTIN takes its code from whoever it is: us (the firm's
  // profile) or the party (their master).
  const codeFor = (side) => {
    const gstin = side === "issuer" ? read.supplierGstin : read.buyerGstin;
    const fromGstin = stateCodeOfGstin(gstin);
    if (fromGstin) return fromGstin;
    if (kindOf.partySide === side) return normalizeStateCode(partyRecord?.stateCode);
    if (kindOf.partySide) return normalizeStateCode(company?.stateCode);
    return "";
  };
  const issuerCode = codeFor("issuer");
  const addresseeCode = codeFor("addressee");

  const config = kindOf.kind ? BILLING_TYPES[kindOf.kind] : null;

  return {
    read,
    kind: kindOf.kind,
    kindChosen: kindOf.chosen,
    kindDetected: kindOf.detected,
    kindDetectedBy: kindOf.detectedBy,
    kindConflict: kindOf.conflict,
    partySide: kindOf.partySide,
    partyRole: role,
    // The screen this draft is for (lib/billingTypes.mjs), or null until the
    // kind is known.
    target: config ? { type: config.type, isReturn: config.isReturn } : null,
    route: config ? config.route : "",
    party: {
      how: party.how,
      by: party.by,
      name: partyRecord ? text(partyRecord.name) : "",
      id: partyRecord ? text(partyRecord._id ?? partyRecord.id) : "",
      score: party.score,
      suggestions: party.suggestions,
      // What the bill prints for the party, whichever side they are on.
      read: who,
      // The matched account's group disagrees with the kind: a supplier on a
      // sale, a customer on a purchase. Reported, not refused -- some firms
      // buy from and sell to the same party.
      groupMismatch: Boolean(partyRecord && role && !groupFits(partyRecord.group, role)),
      // What to put in a new party's master if the person creates one: a
      // customer (Sundry Debtors) for a sale or sale return, a supplier
      // (Sundry Creditors, group 28) for a purchase or purchase return.
      // Nothing here guesses that from a balance.
      proposed: partyRecord || !role
        ? null
        : {
            name: who.name,
            group: role,
            gstIn: who.gstin,
            phone: who.phone,
            address: who.address,
            state: who.state,
            stateCode: stateCodeOfGstin(who.gstin),
          },
    },
    lines,
    totals,
    // Our own sequence provides the invoice number. The bill's own number is
    // the PARTY's bill number only when the party issued it (their invoice,
    // their credit note); a bill we issued carries our number, which
    // Vyapaar gives itself. Mistake 1 in the header.
    partyBillNo: kindOf.partySide === "issuer" ? read.supplierInvoiceNo : "",
    printedNo: read.supplierInvoiceNo,
    date: read.date,
    paymentType: read.paymentType,
    transport: read.transport,
    grNo: read.grNo,
    ewayBillNo: read.ewayBillNo,
    freight: read.freight,
    taxType: taxTypeFor(issuerCode, addresseeCode),
    // Kept under their old names: the issuer is the seller of the goods on
    // an invoice, the addressee the buyer.
    sellerStateCode: issuerCode,
    buyerStateCode: addresseeCode,
    hsnTotals: hsnTotalsArray(buildHsnTotals(lines)),
  };
};

/**
 * Does an account in this group suit the role? Only Sundry Debtors (27) and
 * Sundry Creditors (28) say anything; any other group, or none, is not a
 * contradiction.
 */
export const groupFits = (group, role) => {
  const code = resolveGroup(text(group))?.code;
  if (code === 27) return role === "customer";
  if (code === 28) return role === "supplier";
  return true;
};

/** "Sale", "Purchase return", ... for messages. */
export const KIND_LABELS = {
  sale: "Sale",
  purchase: "Purchase",
  salereturn: "Sale return",
  purchasereturn: "Purchase return",
};

/**
 * Everything the person has to look at, worst first.
 *
 * `blocking` is what stops a save; the rest is worth a glance. A draft with
 * no warnings at all is possible and means the bill read cleanly against
 * masters that already existed -- which, for a regular supplier, is the
 * ordinary case after the first import.
 */
export const importWarnings = (draft) => {
  const out = [];
  const add = (severity, field, message) => out.push({ severity, field, message });

  if (!draft?.lines?.length) {
    add("blocking", "lines", "No item rows were read off this bill. Check the photo, or type it in.");
  }

  // --- the kind ---
  // A draft from before kinds existed is a purchase; one with `kind: null`
  // could not be told apart and must be chosen.
  const kind = draft && "kind" in draft ? draft.kind : "purchase";
  const role = draft?.partyRole || (kind ? partyRoleOf(kind) : "party");
  const partyName = draft?.party?.read ? draft.party.read.name : draft?.read?.supplierName;
  if (!kind) {
    add(
      "blocking",
      "kind",
      draft?.read?.documentKind === "debit note"
        ? "This is a debit note: it can be a supplier raising a price or a customer returning goods, which post the opposite way. Choose the type."
        : "Could not tell whether this is a sale or a purchase: your firm's GSTIN or name was not found on either side of the bill. Choose the type."
    );
  } else if (draft?.kindConflict && draft?.kindDetected) {
    add(
      "check",
      "kind",
      `You chose ${KIND_LABELS[kind]}, but the bill reads like a ${KIND_LABELS[draft.kindDetected].toLowerCase()} (your ${
        draft.kindDetectedBy === "gstin" ? "GSTIN" : "name"
      } is on the ${draft.partySide === "addressee" ? "issuing" : "receiving"} side). Check the type before saving.`
    );
  }

  // --- the party ---
  if (kind && draft?.party?.how === MATCH_NONE) {
    add(
      "blocking",
      "party",
      partyName
        ? `"${partyName}" is not in your accounts. Create the ${role}, or pick an existing one.`
        : `No ${role} name was read. Pick the ${role}.`
    );
  } else if (kind && draft?.party?.how === MATCH_APPLIED && draft?.party?.groupMismatch) {
    add(
      "check",
      "party",
      `"${draft.party.name}" is in your accounts as a ${role === "customer" ? "supplier" : "customer"}, but this is a ${KIND_LABELS[
        kind
      ].toLowerCase()}. Check the type, and that this is the right party.`
    );
  } else if (kind && draft?.party?.how === MATCH_SUGGESTED) {
    add(
      "blocking",
      "party",
      `"${partyName}" is not an exact match. Did you mean ${draft.party.suggestions
        .map((s) => `"${s.name}"`)
        .join(" or ")}? Pick one, or create the ${role}.`
    );
  }

  // --- the lines ---
  for (const [index, line] of (draft?.lines || []).entries()) {
    const where = `Row ${index + 1} (${line.name || "no name"})`;
    if (line.match.charge && line.match.how !== MATCH_APPLIED) {
      // Not blocking, and not an item to create: it is a charge that was
      // printed as a row. The person moves it or keeps it.
      add(
        "check",
        `lines.${index}`,
        `${where}: reads like a charge rather than goods. Move it to Freight, or keep it as a line if you do trade in it.`
      );
    } else if (line.match.how === MATCH_NONE) {
      add("blocking", `lines.${index}`, `${where}: not in your item master. Create the item, or pick one.`);
    } else if (line.match.how === MATCH_SUGGESTED) {
      add(
        "blocking",
        `lines.${index}`,
        `${where}: no exact match. Did you mean ${line.match.suggestions
          .map((s) => `"${s.name}"`)
          .join(" or ")}?`
      );
    }
    for (const missing of line.match.missing) {
      add("blocking", `lines.${index}.${missing}`, `${where}: no ${missing} was read. Type it in.`);
    }
    for (const difference of line.match.differs) {
      add("check", `lines.${index}`, `${where}: ${difference}.`);
    }
  }

  // --- the figures ---
  for (const [what, check] of Object.entries(draft?.totals?.checks || {})) {
    if (!check || check.agrees) continue;
    add(
      "check",
      `totals.${what}`,
      `The ${what} adds up to ${check.ours.toFixed(2)} from the rows, but the bill prints ${check.printed.toFixed(
        2
      )} -- a difference of ${Math.abs(check.difference).toFixed(2)}. The rows are what will be saved.`
    );
  }

  // --- the tax type ---
  if (!draft?.taxType) {
    add(
      "check",
      "taxType",
      `Could not tell whether this is CGST+SGST or IGST: a state code is missing on one side. It follows the ${role}'s master once they are picked.`
    );
  }

  if (!draft?.date) add("check", "date", "No bill date was read. Today's date will be used.");
  // The bill's own number: the party's when they issued it, ours when we did.
  const partyIssued = !draft || !("partySide" in draft) || draft.partySide === "issuer";
  if (partyIssued && !draft?.partyBillNo) {
    add("check", "partyBillNo", `No ${role} bill number was read. Worth typing in -- it is how you find this bill again.`);
  } else if (!partyIssued && draft?.printedNo) {
    add(
      "check",
      "printedNo",
      `The bill is numbered ${draft.printedNo} in your own series, but Vyapaar saves it under the next number in ITS series. If they differ, the customer's copy will not match your GST return -- enter it by hand under the right number instead.`
    );
  }

  const order = { blocking: 0, check: 1 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
};

/** Can this draft be saved as it stands? */
export const importIsReady = (draft) =>
  importWarnings(draft).every((w) => w.severity !== "blocking");

/**
 * The masters this draft would need, for the screen to offer creating.
 *
 * Offered, never created here and never created without being seen: this
 * returns what to put in a form, and the existing QuickMaster posts it
 * through the ordinary master routes with their own validation.
 *
 * Only rows that matched NOTHING. A row with a suggestion is a question, not
 * a missing master -- see the note inside.
 */
export const newMasters = (draft) => {
  const proposed = draft?.party?.proposed || null;
  const customerSide = proposed?.group === "customer";
  const suppliers = proposed && !customerSide ? [proposed] : [];
  const customers = proposed && customerSide ? [proposed] : [];

  const seen = new Set();
  const items = [];
  for (const line of draft?.lines || []) {
    if (line.match.how === MATCH_APPLIED) continue;
    // A row with a near-miss does not NEED a new master -- it needs somebody
    // to say whether the near-miss is the same item. Offering to create one
    // beside a suggestion is how a master ends up holding both "MS Plate
    // 10mm" and "MS Plat 10 mm", which is the duplicate this matching exists
    // to prevent. A person who genuinely wants both creates the second from
    // the item master, deliberately.
    if (line.match.how === MATCH_SUGGESTED) continue;
    // A freight row is not an item master entry. See CHARGE_WORDS.
    if (line.match.charge) continue;
    const key = nameKey(line.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    items.push({
      name: line.name,
      hsn: line.hsn,
      unit: line.unit,
      gst: line.gstRate,
      // On a purchase the bill's rate is what we PAID, so it seeds the
      // purchase price and the cost -- never `salePrice`, which the firm
      // sets for itself. On a sale it is what we CHARGED, so the reverse.
      ...(customerSide || draft?.partyRole === "customer"
        ? { salePrice: line.cost }
        : { purchasePrice: line.cost, cost: line.cost }),
    });
  }

  return { suppliers, customers, items };
};

/**
 * Where the draft waits while the person is sent to the purchase screen.
 *
 * `sessionStorage`, under one key, and NOT the URL. The old page put the
 * whole items array through `encodeURIComponent` into a query string, which
 * is a bill's worth of data in the address bar, in the browser history and in
 * every server log that records a URL.
 *
 * Session rather than local storage: an import that was abandoned should not
 * still be sitting there tomorrow waiting to be applied to a different bill.
 */
export const IMPORT_DRAFT_KEY = "vyapaar:invoice-import";

/**
 * WHO THE DRAFT IS FOR.
 *
 * The key above is one string for the whole browser tab, and the screen that
 * reads it is shared by all four billing screens. Untagged, a parcel waiting
 * in a tab was applied by WHICHEVER screen was opened with `?import=1` --
 * a supplier's bill landing on the SALE screen -- and by whichever firm and
 * user that tab was signed in as by then: sign out, sign in to another
 * company, open the purchase screen, and the first firm's supplier bill is
 * filled in.
 *
 * So the parcel names its screen (a purchase, not a return) and its owner
 * (the firm and the user who read the photo, from /api/auth/me), and the
 * reader checks both before applying anything.
 */
export const IMPORT_TARGET = Object.freeze({ type: "Purchase", isReturn: false });

/** The owner of a parcel, from an /api/auth/me body. Null when it says nobody. */
export const importScopeOf = (me) => {
  const companyId = String(me?.company?.id ?? "").trim();
  const user = String(me?.user?.email ?? "").trim().toLowerCase();
  return companyId && user ? { companyId, user } : null;
};

/** What `app/upload/page.js` stores under IMPORT_DRAFT_KEY. */
export const importParcel = ({ draft, warnings, newMasters } = {}, scope) => ({
  // The screen the draft was read for; a draft from before kinds is a
  // purchase.
  target: draft?.target
    ? { type: draft.target.type, isReturn: Boolean(draft.target.isReturn) }
    : { ...IMPORT_TARGET },
  scope: scope ? { companyId: scope.companyId, user: scope.user } : null,
  draft,
  warnings,
  newMasters,
});

/**
 * May this screen apply this parcel?
 *
 *   "ok"            the right screen, the same firm and user
 *   "missing"       nothing there (or nothing readable)
 *   "wrong-screen"  a draft opened on a different one of the four screens.
 *                   Left in place: it is still good for the screen it was read for.
 *   "wrong-owner"   another firm or user, or no owner recorded at all (a
 *                   parcel from before this check). Dropped: it must never
 *                   land on somebody else's books, and the tab that read it
 *                   is no longer signed in as its owner.
 *   "unverified"    the reader could not tell who it is (sign-in lookup
 *                   failed). Left in place, so a retry can still use it.
 */
export const importParcelVerdict = (parcel, { type, isReturn, scope } = {}) => {
  if (!parcel || typeof parcel !== "object" || !parcel.draft) return "missing";
  // A parcel with no screen or owner on it predates this check. Nobody can
  // say whose it is, so it is treated as somebody else's.
  if (!parcel.target || !parcel.scope) return "wrong-owner";
  const target = parcel.target;
  if (target.type !== String(type ?? "") || Boolean(target.isReturn) !== Boolean(isReturn)) {
    return "wrong-screen";
  }
  if (!scope) return "unverified";
  const owner = parcel.scope;
  if (owner.companyId !== scope.companyId || owner.user !== scope.user) {
    return "wrong-owner";
  }
  return "ok";
};
