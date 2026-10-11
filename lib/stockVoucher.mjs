/**
 * The three vouchers that move stock without a bill.
 *
 * Pure and dependency-free, like the rest of lib/*.mjs, so `node` can run the
 * test directly. The rules about what a formula explodes to stay in
 * lib/bom.mjs; what is here is which direction each KIND of voucher moves
 * stock in.
 *
 *
 * SIGFA KEEPS ALL THREE IN ONE TABLE, AND SO DO WE
 * ------------------------------------------------
 * Read out of SIGFA105.exe, from the table it seeds its own voucher-kind
 * master with:
 *
 *     Insert Into MkeyMaster(Mkey, MkeyName) Values('FR', 'Production')
 *     Insert Into MkeyMaster(Mkey, MkeyName) Values('IS', 'Goods Issued')
 *     Insert Into MkeyMaster(Mkey, MkeyName) Values('RS', 'Goods Received')
 *
 * and all three are rows in RIssue, told apart by that three-character MKEY.
 * Its money vouchers -- 'CA' Cash and 'BA' Bank -- live somewhere else
 * entirely, in JOURNAL. So goods and money are separate books in Sigfa, and
 * the three goods vouchers are one book.
 *
 * `models/productionModel.js` is therefore the model for all three, with a
 * `kind` field standing in for MKEY. Not because sharing is tidy: because a
 * second copy of the stock-writing is where a direction gets inverted without
 * anybody noticing, and a direction inverted on a goods receipt means stock
 * that should have arrived has instead gone out.
 *
 *
 * WHAT A MISSING KIND MEANS
 * -------------------------
 * "FR". Every entry written before this feature existed was a production
 * entry and carries no `kind` at all, so `kindOf` reads an absent one as
 * Production. That is also why Production keeps the "PRD-" ledger prefix it
 * already had: its existing stock rows are keyed that way, and renaming the
 * prefix would orphan every one of them.
 */

import { consumes, lineKind, roundQty } from "./bom.mjs";
// The same name rules the rest of the masters join on -- imported from where
// bom.mjs gets them rather than re-exported through it.
import { nameKey, normalizeName } from "./uniqueName.mjs";

const text = (value) => String(value ?? "").trim();

/**
 * Sigfa's MKEY codes, kept as the stored value.
 *
 * Its own three characters rather than a prettier slug, so a row in this
 * database and a row in theirs say the same thing -- and so anybody reading
 * both can tell at a glance that they match.
 */
export const STOCK_KINDS = {
  FR: {
    code: "FR",
    label: "Production",
    // What the FORM is headed. Sigfa titles its screens "Issue Slip" and
    // "Receipt Slip" while its MkeyMaster calls the same documents "Goods
    // Issued" and "Goods Received" -- so the voucher has two names in Sigfa
    // too, and both are kept: `label` for the register and the dashboard,
    // `slipTitle` for the form itself.
    slipTitle: "Production",
    plural: "Production entries",
    // The existing prefix, unchanged. Its rows are already in the ledger.
    prefix: "PRD-",
    counter: "productionNo",
    // Explodes a formula, has a finished item, and its lines move BOTH ways:
    // materials and wastage out, output and by-products in.
    usesFormula: true,
    hasOutput: true,
    // null means "ask the line's own kind" -- see lineDirection below.
    lineDirection: null,
    blurb: "Issues the materials and receives the finished item, in one entry.",
  },
  IS: {
    code: "IS",
    label: "Goods Issued",
    slipTitle: "Issue Slip",
    plural: "Goods issued",
    prefix: "GI-",
    counter: "goodsIssueNo",
    usesFormula: false,
    hasOutput: false,
    // Every line leaves stock. Sent to a job worker, drawn for a department,
    // written off -- whatever the reason, the goods go out.
    lineDirection: "issue",
    blurb: "Stock going out without a sale.",
  },
  RS: {
    code: "RS",
    label: "Goods Received",
    slipTitle: "Receipt Slip",
    plural: "Goods received",
    prefix: "GR-",
    counter: "goodsReceiptNo",
    usesFormula: false,
    hasOutput: false,
    // Every line enters stock. Back from a job worker, found at a count,
    // received against no purchase bill.
    lineDirection: "receipt",
    blurb: "Stock coming in without a purchase.",
  },
};

export const STOCK_KIND_CODES = Object.keys(STOCK_KINDS);

/** The default, and what an entry written before this feature reads as. */
export const DEFAULT_KIND = "FR";

/** This entry's kind. An absent one is Production -- see the header. */
export const kindOf = (entryOrCode) => {
  const code = text(
    typeof entryOrCode === "string" ? entryOrCode : entryOrCode?.kind
  ).toUpperCase();
  return code in STOCK_KINDS ? code : DEFAULT_KIND;
};

/**
 * One kind's configuration.
 *
 * Unknown codes fall back to Production rather than throwing, because this is
 * also what reads rows off the database: an entry written by a future version
 * with a kind this one does not know must still be listed, not crash the
 * register. A request asking to CREATE an unknown kind is refused separately,
 * by `isStockKind` on the route.
 */
export const stockKind = (entryOrCode) => STOCK_KINDS[kindOf(entryOrCode)];

/** Is this a kind a request may ask for? Strict, unlike `kindOf`. */
export const isStockKind = (code) => text(code).toUpperCase() in STOCK_KINDS;

/**
 * The ledger key a voucher's stock rows carry.
 *
 * Each kind has its OWN prefix, which is what lets the three share a table
 * and still have independent numbering. Goods Issue 5 and Production 5 are
 * different vouchers; "GI-5" and "PRD-5" are different keys, so writing one
 * cannot delete the other's rows -- and `writeProductionLedgerRows` opens by
 * deleting every row under the key it is given.
 *
 * This is the same reasoning that gave Production its prefix in the first
 * place: a bare number would have collided with invoice 5's stock history.
 */
export const stockLedgerKey = (kind, docNo) =>
  `${stockKind(kind).prefix}${Number(docNo) || 0}`;

/** Which key prefixes belong to stock vouchers rather than to invoices. */
export const STOCK_PREFIXES = STOCK_KIND_CODES.map((k) => STOCK_KINDS[k].prefix);

export const isStockLedgerKey = (key) =>
  STOCK_PREFIXES.some((prefix) => String(key ?? "").startsWith(prefix));

/**
 * Which way one line moves, given the voucher it is on.
 *
 * On a production entry it depends on the LINE -- a material is issued, a
 * by-product is received -- so the existing `consumes` rule decides. On a
 * goods issue or receipt the VOUCHER decides and the line's own kind is
 * ignored, because there is only one direction on the document.
 */
export const lineDirection = (kind, line) => {
  const fixed = stockKind(kind).lineDirection;
  if (fixed) return fixed;
  return consumes(line?.kind) ? "issue" : "receipt";
};

/**
 * The stock movements one voucher makes, both sides, merged by item.
 *
 * The same shape `productionMovements` returns, and for Production it returns
 * exactly what that returns -- this is a generalisation of it, not a second
 * implementation beside it.
 */
export const stockMovements = ({
  kind,
  outputItem,
  outputQuantity = 0,
  lines = [],
} = {}) => {
  const config = stockKind(kind);
  const issues = new Map();
  const receipts = new Map();

  const add = (bucket, itemName, quantity) => {
    const name = normalizeName(itemName);
    const qty = roundQty(quantity);
    if (!name || qty <= 0) return;
    const key = nameKey(name);
    if (!bucket.has(key)) bucket.set(key, { itemName: name, quantity: 0 });
    const row = bucket.get(key);
    row.quantity = roundQty(row.quantity + qty);
  };

  // Only Production has a finished item. A goods issue with an output would
  // be receiving stock on a document whose whole purpose is to send it out.
  if (config.hasOutput) add(receipts, outputItem, outputQuantity);

  for (const line of lines) {
    add(lineDirection(config.code, line) === "issue" ? issues : receipts, line?.itemName, line?.quantity);
  }

  const sort = (bucket) =>
    [...bucket.values()].sort((a, b) => a.itemName.localeCompare(b.itemName));

  return { issues: sort(issues), receipts: sort(receipts) };
};

/**
 * What reversing this voucher puts back, and takes away.
 *
 * For the confirmation dialog on delete, and the warning on alter. A reversal
 * is the opposite of the movement, so whatever was RECEIVED comes out and
 * whatever was ISSUED goes back in -- which `stockMovements` already works
 * out, so this swaps its two sides rather than deciding anything again.
 *
 * Deciding it separately is how the first version of this had by-products
 * going back INTO stock alongside the materials, which is the one direction
 * they never move.
 */
export const reversalOf = (entry) => {
  if (!entry) return { outOfStock: [], backIntoStock: [] };

  const { issues, receipts } = stockMovements({
    kind: kindOf(entry),
    outputItem: entry.outputItem,
    outputQuantity: entry.outputQuantity,
    lines: entry.lines || [],
  });

  // The movements carry a name and a quantity; the dialog also wants the unit
  // and a word for why each row is there. Both are looked up from the entry's
  // OWN lines rather than recomputed, so the direction still has exactly one
  // rule above and this only labels what it decided.
  const unitOf = new Map();
  const whyOf = new Map();
  const output = text(entry.outputItem);
  if (output) {
    unitOf.set(nameKey(output), text(entry.outputUnit));
    whyOf.set(nameKey(output), "produced");
  }
  for (const line of entry.lines || []) {
    const name = nameKey(line?.itemName);
    if (!name) continue;
    if (!unitOf.has(name)) unitOf.set(name, text(line?.unit));
    // On a goods voucher every line moves the way the voucher moves, so the
    // line's own kind is not a reason -- "issued" or "received" is.
    if (!whyOf.has(name)) {
      whyOf.set(
        name,
        stockKind(entry).lineDirection ? "" : lineKind(line?.kind)
      );
    }
  }

  const label = (rows) =>
    rows.map((row) => ({
      ...row,
      unit: unitOf.get(nameKey(row.itemName)) || "",
      why: whyOf.get(nameKey(row.itemName)) || "",
    }));

  return {
    // Received on the voucher, so a reversal takes it out again.
    outOfStock: label(receipts),
    // Issued on the voucher, so a reversal puts it back.
    backIntoStock: label(issues),
  };
};

/** What a voucher of this kind is called in a list. */
export const stockTitle = (kind) => stockKind(kind).label;

/** What the FORM is headed -- Sigfa's own screen title. */
export const slipTitle = (kind) => stockKind(kind).slipTitle;

/**
 * The grid on Sigfa's Issue Slip and Receipt Slip, column for column.
 *
 * Read off its screen. "S.No." with the full stops it prints, and Rate and
 * Amount included even though a goods voucher has no money consequence --
 * Sigfa shows what the stock was worth, and so does this.
 */
export const SLIP_COLUMNS = ["S.No.", "Item Name", "Unit", "Quantity", "Rate", "Amount"];

/**
 * Sigfa's header fields, in the order its form lays them out.
 *
 * Recorded here so the screen and its test read the same list rather than
 * both being written out by hand.
 */
export const SLIP_HEADER_FIELDS = ["Series", "Slip No.", "Date", "Store", "Party"];

/**
 * The day in brackets after the date, as Sigfa prints it: "11-10-2026 (Sun)".
 *
 * Taken from the IST calendar day, like every other date in this app: the
 * container runs Asia/Calcutta and Vercel runs UTC, so a local-clock call
 * gives a different day either side of midnight.
 */
export const SLIP_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const slipDayName = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  // Shifted to IST before the weekday is read, for the reason above.
  const ist = new Date(date.getTime() + (5 * 60 + 30) * 60 * 1000);
  return SLIP_DAYS[ist.getUTCDay()] || "";
};

/** "11-10-2026", the way Sigfa dates its slips. */
export const slipDate = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const ist = new Date(date.getTime() + (5 * 60 + 30) * 60 * 1000);
  const dd = String(ist.getUTCDate()).padStart(2, "0");
  const mm = String(ist.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${ist.getUTCFullYear()}`;
};

/**
 * One line's amount, and the slip's total.
 *
 * Quantity times rate, and nothing cleverer: a goods voucher carries no
 * discount, no tax and no rounding of its own. The rate itself is the item
 * master's cost, frozen onto the line by the server -- never sent by the
 * browser, which is why these are shown and not saved.
 */
export const slipAmount = (line) =>
  roundQty(line?.quantity) * (Number(line?.rate) || 0);

export const slipTotal = (lines = []) =>
  lines.reduce((total, line) => total + slipAmount(line), 0);

/**
 * The series a firm has actually used on this kind of slip.
 *
 * Sigfa backs its Series box with a master (its SubKey, seeded with MI, MO
 * and RMI). There is no such master here, so the suggestions come from the
 * vouchers already written -- the list fills itself from use, and nothing has
 * to be maintained for it.
 */
export const seriesUsed = (entries = []) => {
  const seen = new Map();
  for (const entry of entries) {
    const value = text(entry?.series);
    if (!value) continue;
    // Case-insensitively unique, so "mi" and "MI" are one suggestion -- but
    // the spelling first used is the one offered back.
    const key = value.toLowerCase();
    if (!seen.has(key)) seen.set(key, value);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
};

/**
 * Why this voucher cannot be saved, in words. [] when it can be.
 *
 * Only the rules that differ BY KIND live here; the quantity, date and item
 * checks every stock voucher shares stay in `productionProblems`.
 */
export const stockKindProblems = ({ kind, outputItem, lines = [] } = {}) => {
  const config = stockKind(kind);
  const problems = [];

  if (!config.hasOutput && text(outputItem)) {
    problems.push(
      `${config.label} records no finished item -- it only moves the lines listed.`
    );
  }
  if (!lines.length) {
    problems.push(`Add at least one item to this ${config.label.toLowerCase()}.`);
  }

  return problems;
};
