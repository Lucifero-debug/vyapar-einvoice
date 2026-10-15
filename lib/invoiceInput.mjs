/**
 * What a billing request is allowed to say, and what the server works out
 * for itself.
 *
 * Pure and dependency-free, like the rest of lib/*.mjs, so `node` can run
 * scripts/invoice-input.test.mjs directly. Never import Mongoose in here.
 *
 *
 * WHY THIS EXISTS
 * ---------------
 * `save-invoice` used to do `Invoice.create([{ ...body, ... }])`. Every key
 * the request carried reached the document, and a few of them were not the
 * client's to set:
 *
 *   companyId       the tenant plugin only stamps a firm onto a document that
 *                   has NONE (lib/tenantPlugin.mjs, `if (this.companyId)
 *                   return`), so a body naming another firm's id wrote the
 *                   invoice into THAT firm's books -- while the ledger, stock
 *                   and balance rows, which are built server-side, landed in
 *                   the caller's. Two sets of books corrupted by one request.
 *   irn, ackNo,     a bill could arrive already "reported to the IRP", which
 *   einvoiceStatus  freezes it against edit and delete (lib/einvoiceLock.mjs).
 *   emailLog        a forged "emailed to ... on ..." history.
 *   _id, createdAt  internal identity and timestamps.
 *
 * And the money was half-derived. `balanceDue` was already recomputed, but
 * `finalAmount`, `totalAmount`, `gst`, `hsnTotals` and every line's
 * `taxableAmount` / `gstAmount` / `total` were stored exactly as sent, and
 * `sale-alter` stored even `balanceDue` as sent.
 *
 *
 * WHAT THIS DOES
 * --------------
 * `prepareInvoiceInput()` builds a NEW object from an explicit list of fields
 * -- nothing is spread from the request -- validates each one, and derives
 * every figure from the lines with the SAME functions the billing screen uses
 * (lib/billingMath.mjs). So an honest screen and the server agree to the paisa,
 * and a request whose figures disagree with its own lines is refused rather
 * than quietly re-totalled: the person saw one total, and storing another
 * behind their back would be the worse outcome.
 *
 * It does NOT touch the database. Whether the party, the items and the orders
 * exist -- in THIS firm -- is checked by the routes, through tenant-scoped
 * queries, with the helpers at the bottom of this file.
 */

import { round2 } from "./balance.mjs";
import {
  PAYLOAD_KEYS,
  buildHsnTotals,
  hsnTotalsArray,
  recalcItem,
  totalGstOf,
} from "./billingMath.mjs";
import { DIRECTIONS } from "./billingTypes.mjs";
import { SERIES_CODE_MAX, normalizeSeriesCode } from "./series.mjs";
import { lineRef } from "./orderStatus.mjs";
import { challanRef } from "./challanStatus.mjs";
import { checkReceived, parseMriHeader, roundQty, zeroAcceptedAllowed } from "./mri.mjs";
import { GL_ACCOUNT_GROUPS } from "./invoiceGl.mjs";
import { isBankGroup, isCashGroup } from "./accountGroups.mjs";
import { defaultAccountName } from "./paymentType.mjs";

/* ─────────────────────────────── limits ──────────────────────────────── */

/** More lines than any real bill, few enough that a request cannot be a flood. */
export const MAX_LINES = 500;
export const MAX_PARTY_TAXES = 25;
/** ₹1,000 crore. Far past any bill this app will raise; short of float trouble. */
export const MAX_AMOUNT = 1e10;
export const MAX_QUANTITY = 1e9;
export const MAX_INVOICE_NO = 1e9;

/**
 * How far the client's total may stand from the server's before the request
 * is refused. The screen rounds with `toFixed(2)` and the server with
 * `round2`; on a half-paisa those can differ by 0.01. Anything past five paise
 * is not rounding.
 */
export const TOTAL_TOLERANCE = 0.05;

/** A bill dated before this is a typo, not a bill. */
export const EARLIEST_YEAR = 2000;
/** How far ahead a bill may be dated. A year covers advance billing. */
export const MAX_FUTURE_MS = 366 * 24 * 60 * 60 * 1000;

/** Two identical saves this close together are one double-click. */
export const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;

const TEXT_MAX = {
  name: 200,
  phone: 50,
  email: 254,
  paymentType: 100,
  taxType: 30,
  description: 1000,
  hsn: 30,
  orderLineId: 64,
  short: 200,
  long: 1000,
};

/** The screen's two choices, and blank for an old bill. */
export const TAX_TYPES = ["local", "central", ""];

/* ─────────────────────────────── fields ──────────────────────────────── */

/**
 * Set only by the server: the tenant, identity, timestamps, the e-invoice
 * routes and the email route. A request naming any of them is refused
 * outright -- the honest screen never sends one (PAYLOAD_KEYS), so seeing one
 * means somebody is trying.
 */
export const PROTECTED_FIELDS = [
  "companyId",
  "_id",
  "id",
  "__v",
  "createdAt",
  "updatedAt",
  "irn",
  "ackNo",
  "ackDt",
  "signedQrCode",
  "signedInvoice",
  "einvoiceStatus",
  "einvoiceCancelledAt",
  "einvoiceError",
  "emailLog",
  "againstInvoiceNo",
  "createdBy",
];

/**
 * Sent by the screen, and recomputed here rather than trusted. `finalAmount`
 * is read once -- to check the client agrees with the server -- and then
 * replaced. The place of supply comes from the party's master
 * (lib/buyerSnapshot.mjs), not from these.
 */
export const DERIVED_FIELDS = [
  "balanceDue",
  "finalAmount",
  "totalAmount",
  "gst",
  "hsnTotals",
  "stateOfSupply",
  "stateCode",
];

/**
 * Every top-level key a request may carry. Exactly the frozen payload the
 * billing screen builds (lib/billingMath.mjs) -- a test asserts the two agree,
 * so a field added to the screen and not here fails the build instead of
 * vanishing on save.
 */
export const ACCEPTED_FIELDS = [...PAYLOAD_KEYS];

/* ─────────────────────────────── parsing ─────────────────────────────── */

class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = "InputError";
  }
}

const fail = (message) => {
  throw new InputError(message);
};

const isBlank = (value) =>
  value === undefined || value === null || (typeof value === "string" && value.trim() === "");

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * A number from a form field.
 *
 * Strings are what most inputs produce, so "12.50" is fine; an object, an
 * array or a boolean is not a number however Number() would read it --
 * `Number([5])` is 5 and `Number(true)` is 1, and neither is what anybody
 * typed.
 */
/**
 * A decimal as a person types it: digits, one point, an optional exponent.
 * Number() alone would also take "0x10" as 16 and "0b11" as 3, which the
 * screen's parseFloat reads as 0 -- the two would disagree about the bill.
 */
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

const numberOf = (value, label, { min = -Infinity, max = Infinity, fallback, integer = false } = {}) => {
  if (isBlank(value)) {
    if (fallback !== undefined) return fallback;
    fail(`${label} is required.`);
  }
  if (typeof value !== "number" && typeof value !== "string") {
    fail(`${label} must be a number.`);
  }
  if (typeof value === "string" && !DECIMAL.test(value.trim())) {
    fail(`${label} must be a number.`);
  }
  const n = Number(typeof value === "string" ? value.trim() : value);
  if (!Number.isFinite(n)) fail(`${label} must be a number.`);
  if (integer && !Number.isInteger(n)) fail(`${label} must be a whole number.`);
  if (n < min) fail(`${label} cannot be less than ${min}.`);
  if (n > max) fail(`${label} is too large.`);
  return n;
};

/**
 * A string from a form field. Numbers are accepted and stringified (a GR
 * number or a phone is often typed as one); objects are not, because an
 * object here is how `{ "$ne": null }` would reach a query.
 */
const textOf = (value, label, max) => {
  if (value === undefined || value === null) return "";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") fail(`${label} must be text.`);
  if (value.length > max) fail(`${label} is too long (at most ${max} characters).`);
  return value;
};

/** A date, or null when blank and allowed to be. */
const dateOf = (value, label, { required = false, now = Date.now() } = {}) => {
  if (isBlank(value)) {
    if (required) fail(`${label} is required.`);
    return null;
  }
  if (!(value instanceof Date) && typeof value !== "string" && typeof value !== "number") {
    fail(`${label} is not a date.`);
  }
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) fail(`${label} is not a valid date.`);
  if (at.getUTCFullYear() < EARLIEST_YEAR) fail(`${label} is before ${EARLIEST_YEAR}.`);
  if (at.getTime() > now + MAX_FUTURE_MS) fail(`${label} is more than a year in the future.`);
  return at;
};

const lineLabel = (index, name) => `Line ${index + 1}${name ? ` (${name})` : ""}`;

/* ──────────────────────────────── lines ──────────────────────────────── */

/**
 * One invoice line: the fields a line may carry, and its figures recomputed.
 *
 * The screen spreads the WHOLE item master into each line -- its _id, its
 * companyId, salePrice, purchasePrice and the rest -- so unknown keys here are
 * dropped rather than refused. Refusing them would refuse every honest bill.
 * The unit code and the goods/service flag are dropped too: they are stamped
 * from the item master (lib/uqc.mjs).
 *
 * The figures come from `recalcItem`, the very function the screen uses, fed
 * the line's own `cost`. That is deliberate on two counts. It keeps the
 * screen's arithmetic (unrounded line figures -- see lib/billingMath.mjs) so
 * nothing stored changes shape. And it honours a cost of ZERO: the screen
 * has already resolved `cost || salePrice` before the line reaches here, so
 * what arrives as 0 was billed at 0, and must not pick up a master rate the
 * request never mentioned.
 */
const prepareLine = (raw, index, { type, isReturn, mriOn = false }) => {
  if (!isPlainObject(raw)) fail(`${lineLabel(index)} is not a line item.`);

  const nameRaw = raw.name;
  if (typeof nameRaw !== "string" || !nameRaw.trim()) {
    fail(`${lineLabel(index)} has no item name.`);
  }
  if (nameRaw.length > TEXT_MAX.name) fail(`${lineLabel(index)}: the item name is too long.`);
  const label = lineLabel(index, nameRaw.trim());

  const quantity = numberOf(raw.quantity, `${label}: quantity`, { max: MAX_QUANTITY });
  // On a purchase M.R.I. the quantity is the ACCEPTED one, and a lot
  // rejected outright is accepted at zero (lib/mri.mjs).
  if (!(quantity > 0) && !(quantity === 0 && zeroAcceptedAllowed(raw, { mriOn }))) {
    fail(`${label}: quantity must be more than zero.`);
  }
  const received = checkReceived(raw, quantity, { mriOn, label });
  if (received.error) fail(received.error);

  const cost = numberOf(raw.cost, `${label}: rate`, { min: 0, max: MAX_AMOUNT, fallback: 0 });
  const discount = numberOf(raw.discount, `${label}: discount`, { min: 0, max: 100, fallback: 0 });
  const gstRate = numberOf(raw.gstRate, `${label}: GST rate`, { min: 0, max: 100, fallback: 0 });

  const priced = recalcItem({ cost, quantity, discount, gstRate });
  if (Math.abs(priced.total) > MAX_AMOUNT) fail(`${label}: the amount is too large.`);

  // The client's own figure for this line, when it sent one. A line whose
  // stored total disagrees with its own rate and quantity -- an old bill, or a
  // tampered request -- is named, so the person knows which line to re-enter.
  if (!isBlank(raw.total)) {
    const sent = numberOf(raw.total, `${label}: total`);
    if (Math.abs(sent - priced.total) > TOTAL_TOLERANCE) {
      fail(
        `${label}: the total ${sent.toFixed(2)} does not match its rate, quantity, ` +
          `discount and GST (${priced.total.toFixed(2)}). Re-enter the line and save again.`
      );
    }
  }

  const line = {
    name: nameRaw,
    quantity,
    cost: priced.cost,
    discount,
    gstRate,
    taxableAmount: priced.taxableAmount,
    gstAmount: priced.gstAmount,
    total: priced.total,
  };
  if (received.value !== undefined) line.receivedQty = received.value;

  if (!isBlank(raw.description)) {
    line.description = textOf(raw.description, `${label}: description`, TEXT_MAX.description);
  }
  if (raw.hsn !== undefined && raw.hsn !== null) {
    line.hsn = textOf(raw.hsn, `${label}: HSN`, TEXT_MAX.hsn);
  }

  // === Which order line this fulfils ===
  //
  // All three parts or none (models/invoiceModel.js). A partial reference was
  // silently ignored by lib/orderStatus.mjs, which left the order pending
  // with no way to find out why -- so it is refused here instead, by name.
  const anyRef =
    !isBlank(raw.orderLineId) ||
    !isBlank(raw.orderType) ||
    (!isBlank(raw.orderNo) && Number(raw.orderNo) !== 0);

  if (anyRef) {
    if (typeof raw.orderLineId !== "string" && typeof raw.orderLineId !== "number") {
      fail(`${label}: the order reference is incomplete.`);
    }
    if (String(raw.orderLineId).length > TEXT_MAX.orderLineId) {
      fail(`${label}: the order reference is not valid.`);
    }
    const ref = lineRef(raw);
    if (!ref || !Number.isInteger(ref.orderNo)) {
      fail(`${label}: the order reference is incomplete.`);
    }
    // A sale bills a sale order and a purchase a purchase order; a return
    // bills no order at all (lib/billingTypes.mjs, `orderDoc: null`).
    if (isReturn) fail(`${label}: a return cannot settle an order.`);
    if (ref.orderType !== type) {
      fail(`${label}: a ${type} cannot settle a ${ref.orderType} order.`);
    }
    line.orderNo = ref.orderNo;
    line.orderType = ref.orderType;
    line.orderLineId = ref.lineId;
    const orderDate = dateOf(raw.orderDate, `${label}: order date`);
    if (orderDate) line.orderDate = orderDate;
  }

  // === Which challan line this bills (lib/challanStatus.mjs) ===
  //
  // All three parts or none, for the same reason as the order reference.
  // `challanStock` is NOT read here: the route sets it from the challan.
  const anyChallan =
    !isBlank(raw.challanLineId) ||
    !isBlank(raw.challanType) ||
    (!isBlank(raw.challanNo) && Number(raw.challanNo) !== 0);
  if (anyChallan) {
    const ref = challanRef(raw);
    if (!ref || String(raw.challanLineId).length > TEXT_MAX.orderLineId) {
      fail(`${label}: the challan reference is incomplete.`);
    }
    if (isReturn) fail(`${label}: a return cannot bill a challan.`);
    if (ref.challanType !== type) fail(`${label}: a ${type} bill cannot bill a ${ref.challanType} challan.`);
    if (line.orderLineId) fail(`${label}: a line bills an order or a challan, not both.`);
    line.challanNo = ref.challanNo;
    line.challanType = ref.challanType;
    line.challanLineId = ref.lineId;
    const challanDate = dateOf(raw.challanDate, `${label}: challan date`);
    if (challanDate) line.challanDate = challanDate;

    // What that challan said it was sending, for the M.R.I.'s short figure
    // (lib/mri.mjs). Kept ONLY on a line that names a challan: without one
    // there is nothing it could be the quantity of, and a figure standing
    // alone would read as a shortfall against a promise nobody made.
    if (!isBlank(raw.challanQty)) {
      const promised = Number(raw.challanQty);
      if (!Number.isFinite(promised) || promised < 0) {
        fail(`${label}: the challan quantity must be a number, not below zero.`);
      }
      if (promised > 1e9) fail(`${label}: the challan quantity is too large.`);
      line.challanQty = roundQty(promised);
    }
  } else if (!isBlank(raw.challanQty)) {
    // A purchase bill keyed in directly, with the supplier's own challan in
    // hand: on an M.R.I. the figure is TYPED, exactly as the purchase
    // challan screen takes it (lib/challanInput.mjs). Off an M.R.I. there is
    // nothing to compare it against, so it is refused rather than stored
    // where nothing reads it.
    if (received.value === undefined) {
      fail(`${label}: a challan quantity is only kept on an M.R.I.`);
    }
    const promised = Number(raw.challanQty);
    if (!Number.isFinite(promised) || promised < 0) {
      fail(`${label}: the challan quantity must be a number, not below zero.`);
    }
    if (promised > 1e9) fail(`${label}: the challan quantity is too large.`);
    line.challanQty = roundQty(promised);
  }

  return line;
};

/* ───────────────────────────── party taxes ───────────────────────────── */

/**
 * The bill-level charges, recomputed the way the screen computes them.
 *
 * A rate-based charge is `base * rate / 100` with `toFixed(2)`, where base is
 * the GST-inclusive line total -- charged AFTER tax and not itself taxed,
 * which BillingScreen.addPartyTax records as a reviewed decision. A fixed
 * charge is its amount. A negative fixed amount is a bill-level discount and
 * is allowed; the bill as a whole may not go below zero.
 */
const preparePartyTaxes = (list, base) => {
  if (isBlank(list)) return [];
  if (!Array.isArray(list)) fail("Party taxes must be a list.");
  if (list.length > MAX_PARTY_TAXES) fail(`At most ${MAX_PARTY_TAXES} party taxes per bill.`);

  return list.map((raw, index) => {
    if (!isPlainObject(raw)) fail(`Party tax ${index + 1} is not valid.`);
    const name = textOf(raw.name, `Party tax ${index + 1}: name`, TEXT_MAX.name);
    if (!name.trim()) fail(`Party tax ${index + 1} has no name.`);

    const rate = numberOf(raw.rate, `${name}: rate`, { min: 0, max: 100, fallback: 0 });
    let total;
    if (rate) {
      total = Number(((base * rate) / 100).toFixed(2));
      if (!isBlank(raw.total)) {
        const sent = numberOf(raw.total, `${name}: amount`);
        if (Math.abs(sent - total) > TOTAL_TOLERANCE) {
          fail(`${name}: ${sent.toFixed(2)} is not ${rate}% of the bill (${total.toFixed(2)}).`);
        }
      }
    } else {
      // The screen keeps a fixed charge in `total` (and echoes it in
      // `amount`); a stored row has `total` only.
      const sentRaw = !isBlank(raw.total) ? raw.total : !isBlank(raw.amount) ? raw.amount : raw.Amount;
      const sent = numberOf(sentRaw, `${name}: amount`, { min: -MAX_AMOUNT, max: MAX_AMOUNT });
      total = Number(sent.toFixed(2));
    }

    // `rate` is null rather than 0 when there is none, which is what Mongoose
    // has always stored for the screen's "" -- and what the edit screen reads
    // as "a fixed amount".
    return { name, rate: rate || null, total };
  });
};

/* ─────────────────────────────── the bill ────────────────────────────── */

/**
 * The money, derived. Mirrors BillingScreen's "GST and Final Amount" effect
 * operator for operator, so the stored total is the total that was on screen.
 */
export const invoiceTotals = ({ items = [], partyTaxes = [], freightAmount = 0, received = 0 }) => {
  const lineSum = items.reduce((acc, item) => acc + (parseFloat(item.total) || 0), 0);
  const totalAmount = Number(lineSum.toFixed(2));
  const partyTaxTotal = partyTaxes.reduce((acc, tax) => acc + (parseFloat(tax.total) || 0), 0);
  const finalAmount = round2(Number((totalAmount + partyTaxTotal + freightAmount).toFixed(2)));
  const gst = totalGstOf(items);
  const hsnTotals = hsnTotalsArray(buildHsnTotals(items));
  return {
    totalAmount,
    finalAmount,
    gst,
    hsnTotals,
    received: round2(received),
    balanceDue: round2(finalAmount - round2(received)),
  };
};

/**
 * Validate a billing request and build the invoice the server will store.
 *
 *   mode "create"  save-invoice. `invoiceNo` is a request, not a rule.
 *   mode "edit"    sale-alter. `originalInvoiceNo` (or `invoiceNo`) names the
 *                  bill being edited; `invoiceNo` is what it becomes.
 *
 * Returns `{ ok: true, invoice, ignored }` or `{ ok: false, error }`, where
 * `error` is a sentence for the person at the screen. `ignored` lists the
 * unknown top-level keys that were dropped, for logging.
 */
export function prepareInvoiceInput(body, { mode = "create", now = Date.now() } = {}) {
  try {
    return { ok: true, ...build(body, { mode, now }) };
  } catch (err) {
    if (err instanceof InputError) return { ok: false, error: err.message };
    throw err;
  }
}

function build(body, { mode, now }) {
  if (!isPlainObject(body)) fail("The request is not an invoice.");

  // Protected first, and by name: an attempt to set the tenant or the IRN is
  // worth an explicit refusal, not a silent drop.
  for (const key of Object.keys(body)) {
    if (PROTECTED_FIELDS.includes(key) || key.startsWith("$") || key.includes(".")) {
      fail(`"${key}" cannot be set on an invoice.`);
    }
  }
  const ignored = Object.keys(body).filter(
    (key) => !ACCEPTED_FIELDS.includes(key) && !DERIVED_FIELDS.includes(key)
  );

  // === What kind of document ===
  const type = typeof body.type === "string" ? body.type.trim() : body.type;
  if (!DIRECTIONS.includes(type)) fail(`Invoice type must be one of: ${DIRECTIONS.join(", ")}.`);
  if (body.return !== undefined && body.return !== null && typeof body.return !== "boolean") {
    fail("Return must be true or false.");
  }
  const isReturn = body.return === true;

  // === A purchase M.R.I.? (lib/mri.mjs) ===
  // Read before the lines, which it changes: an MRI line carries a received
  // quantity, and may accept none of it.
  const mriParsed = parseMriHeader(body.mri, { type, isReturn });
  if (mriParsed.error) fail(mriParsed.error);
  const mri = mriParsed.mri;

  // === Numbers ===
  const invoiceNo = isBlank(body.invoiceNo)
    ? undefined
    : numberOf(body.invoiceNo, "Invoice No", { min: 1, max: MAX_INVOICE_NO, integer: true });

  let originalInvoiceNo;
  if (mode === "edit") {
    const lookup = isBlank(body.originalInvoiceNo) ? body.invoiceNo : body.originalInvoiceNo;
    if (isBlank(lookup)) fail("Invoice number missing.");
    originalInvoiceNo = numberOf(lookup, "Invoice No being edited", {
      min: 1,
      max: MAX_INVOICE_NO,
      integer: true,
    });
  }

  const date = dateOf(body.date, "Invoice date", { required: true, now });

  // === The party ===
  //
  // Name, and the phone and email as typed. `custId` is NOT taken: the
  // snapshot copies the master's own _id (lib/buyerSnapshot.mjs), and a
  // client-supplied one could name another firm's party.
  if (!isPlainObject(body.customer)) fail("Select a customer.");
  const customerName = body.customer.name;
  if (typeof customerName !== "string" || !customerName.trim()) fail("Select a customer.");
  if (customerName.length > TEXT_MAX.name) fail("The customer name is too long.");
  const customer = {
    name: customerName,
    phone: textOf(body.customer.phone, "Phone", TEXT_MAX.phone),
    email: textOf(body.customer.email, "Email", TEXT_MAX.email),
  };

  // === Lines ===
  if (!Array.isArray(body.items) || body.items.length === 0) fail("Add at least one item.");
  if (body.items.length > MAX_LINES) fail(`At most ${MAX_LINES} lines on one bill.`);
  const items = body.items.map((raw, index) => prepareLine(raw, index, { type, isReturn, mriOn: mri.on }));
  // A bill bills something. A delivery rejected outright is recorded on a
  // purchase challan MRI, which bills nothing (lib/mri.mjs).
  if (!items.some((line) => line.quantity > 0)) {
    fail("Nothing was accepted, so there is nothing to bill. Record a fully rejected delivery as a purchase challan M.R.I.");
  }

  // === Charges and settlement ===
  const base = items.reduce((sum, item) => sum + Number(item.total || 0), 0);
  const partyTaxes = preparePartyTaxes(body.partyTaxes, base);

  // Freight is TEXT on the invoice -- it prints under Order Details and may
  // say "To Pay" -- and its number is `parseFloat(freight) || 0`, exactly as
  // the screen adds it to the total.
  const freight = textOf(body.freight, "Freight", TEXT_MAX.short);
  const freightAmount = parseFloat(freight) || 0;
  if (freightAmount < 0) fail("Freight cannot be negative.");
  if (freightAmount > MAX_AMOUNT) fail("Freight is too large.");

  const received = numberOf(body.received, "Amount received", { min: 0, max: MAX_AMOUNT, fallback: 0 });

  const totals = invoiceTotals({ items, partyTaxes, freightAmount, received });
  if (totals.finalAmount < 0) fail("The bill total cannot be below zero.");
  if (totals.finalAmount > MAX_AMOUNT) fail("The bill total is too large.");

  // The screen's total is checked, never used. A disagreement means the
  // request's figures are not the ones its own lines produce.
  if (!isBlank(body.finalAmount)) {
    const sent = Number(body.finalAmount);
    if (
      (typeof body.finalAmount !== "number" && typeof body.finalAmount !== "string") ||
      !Number.isFinite(sent)
    ) {
      fail("The bill total is not a number.");
    }
    if (Math.abs(sent - totals.finalAmount) > TOTAL_TOLERANCE) {
      fail(
        `The bill total ${sent.toFixed(2)} does not match its lines and charges ` +
          `(${totals.finalAmount.toFixed(2)}). Reload the bill and save again.`
      );
    }
  }

  // === Local or central ===
  //
  // The two radio buttons on the screen. It decides CGST+SGST against IGST in
  // lib/invoiceGl.mjs, so a free-text value is refused rather than read as
  // "not central". Blank is what an old bill may carry, and reads as local,
  // as it always has.
  const taxType = textOf(body.taxType, "Tax type", TEXT_MAX.taxType);
  if (!TAX_TYPES.includes(taxType)) fail(`Tax type must be one of: ${TAX_TYPES.filter(Boolean).join(", ")}.`);

  // === Everything else on the form ===
  const weight = numberOf(body.weight, "Weight", { min: 0, max: MAX_AMOUNT, fallback: 0 });
  const headerOrderNo = isBlank(body.orderNo)
    ? undefined
    : numberOf(body.orderNo, "Order No", { min: 0, max: Number.MAX_SAFE_INTEGER, integer: true });

  const invoice = {
    invoiceNo,
    ...(mode === "edit" ? { originalInvoiceNo } : {}),
    date,
    customer,
    type,
    return: isReturn,
    paymentType: textOf(body.paymentType, "Payment type", TEXT_MAX.paymentType),
    taxType,
    items,
    partyTaxes,
    freight,
    ...totals,
    weight,
    orderNo: headerOrderNo,
    shippedTo: textOf(body.shippedTo, "Shipped to", TEXT_MAX.long),
    dispatchFrom: textOf(body.dispatchFrom, "Dispatch from", TEXT_MAX.long),
    transport: textOf(body.transport, "Transport", TEXT_MAX.short),
    grNo: textOf(body.grNo, "GR No", TEXT_MAX.short),
    grDate: dateOf(body.grDate, "GR date", { now }),
    pvtMark: textOf(body.pvtMark, "Pvt mark", TEXT_MAX.short),
    caseDetails: textOf(body.caseDetails, "Case details", TEXT_MAX.long),
    ewayBillNo: textOf(body.ewayBillNo, "E-way bill No", TEXT_MAX.short),
    ewayBillDate: dateOf(body.ewayBillDate, "E-way bill date", { now }),
    orderDate: dateOf(body.orderDate, "Order date", { now }),
    partyBillNo: textOf(body.partyBillNo, "Party bill No", TEXT_MAX.short).trim(),
    mri,
    // Sigfa's Series Master code for this document. Normalized to the form
    // the master stores -- upper case, sixteen characters -- so a bill and
    // the series it names cannot differ by their spelling. NOT checked
    // against the master: a series deleted after a bill was raised must not
    // stop that bill being edited, exactly as a renamed party does not.
    series: normalizeSeriesCode(textOf(body.series, "Series", SERIES_CODE_MAX)),
  };

  return { invoice, ignored };
}

/* ──────────────────── checks against this firm's data ─────────────────── */
//
// Pure, and fed by the routes' own tenant-scoped queries: a party, an item or
// an order that belongs to another firm is simply not found, and that is the
// whole of the cross-tenant check. Nothing here may be handed a list that was
// read with runAcrossAllTenants().

/**
 * The line names that are not in this firm's item master.
 *
 * Exact match, as `Item.find({ name: { $in } })` matches -- the screen picks
 * from the master list, so an honest line always has its master's spelling.
 */
export const unknownItems = (items = [], masters = []) => {
  const known = new Set((masters || []).map((m) => m?.name));
  return [...new Set((items || []).map((i) => i?.name))].filter((name) => !known.has(name));
};

/**
 * The orders a bill's lines settle, as `{ orderNo, type }` pairs -- what the
 * route has to read (tenant-scoped) before it can check them.
 */
export const orderRefsOf = (items = []) => {
  const seen = new Map();
  for (const line of items || []) {
    if (!line?.orderLineId) continue;
    seen.set(`${line.orderType}#${line.orderNo}`, { orderNo: line.orderNo, type: line.orderType });
  }
  return [...seen.values()];
};

const sameItem = (a, b) =>
  String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

/**
 * What is wrong with the order lines a bill claims to settle.
 *
 * `orders` is what this firm's tenant-scoped `Order.find` returned for
 * `orderRefsOf(items)`, so an order belonging to another firm is simply
 * absent. Each invoice line must point at a line that exists on that order
 * AND names the same item -- lib/orderStatus.mjs settles by line id alone, so
 * without this a line for one item could draw down the pending quantity of a
 * different one.
 */
export const orderLineProblems = (items = [], orders = []) => {
  const byKey = new Map((orders || []).map((o) => [`${o?.type}#${Number(o?.orderNo)}`, o]));
  const problems = [];
  (items || []).forEach((line, index) => {
    if (!line?.orderLineId) return;
    const label = lineLabel(index, line.name);
    const order = byKey.get(`${line.orderType}#${line.orderNo}`);
    if (!order) {
      problems.push(`${label}: ${line.orderType} order ${line.orderNo} does not exist.`);
      return;
    }
    const orderLine = (order.items || []).find((l) => String(l?._id) === String(line.orderLineId));
    if (!orderLine) {
      problems.push(`${label}: that line is not on ${line.orderType} order ${line.orderNo}.`);
    } else if (!sameItem(orderLine.name, line.name)) {
      problems.push(`${label}: ${line.orderType} order ${line.orderNo} ordered "${orderLine.name}" on that line, not "${line.name}".`);
    }
  });
  return problems;
};

/**
 * The lines that need an item-master entry: every line except one settling a
 * verified order line. Order prefill deliberately bills an order line whose
 * item has since left the master (lib/orderPrefill.mjs, `skipped`), so those
 * stay billable -- their identity is vouched for by the order instead.
 */
export const linesNeedingMaster = (items = []) => (items || []).filter((line) => !line?.orderLineId);

/**
 * Why this account cannot be the party on a bill, or null.
 *
 * The posting heads (Sales, Purchase, the GST heads, Round Off) are accounts
 * in the same collection as parties, so a request naming one would post the
 * bill against the books' own contra side. The cash account itself stays
 * allowed: a counter sale billed to "Cash" is supported on purpose
 * (lib/invoicePosting.mjs, balanceMovesFromRows).
 */
const GL_HEADS = new Set(Object.keys(GL_ACCOUNT_GROUPS).map((n) => n.toLowerCase()));

export const partyProblem = (name) =>
  // Case-insensitive, as lib/glAccounts.mjs matches heads: a firm whose head
  // is stored as "Round off" must not be able to bill that spelling.
  GL_HEADS.has(String(name ?? "").trim().toLowerCase())
    ? `"${String(name).trim()}" is a ledger head, not a party. Bill a customer or supplier.`
    : null;

/**
 * Why the account a payment resolved to cannot take the money, or null.
 *
 * `findPaymentAccount` matches the payment type against EVERY account name
 * first, so a payment type naming another party would book the receipt to
 * that party. The account it lands on has to be a cash or bank account -- by
 * its group, or by being the default Cash / Bank account the resolver itself
 * creates.
 */
export const paymentAccountProblem = (account, paymentType) => {
  if (!account) return "No account to receive the payment.";
  const name = String(account.name ?? "").trim();
  if (name === defaultAccountName(paymentType)) return null;
  if (isCashGroup(account.group) || isBankGroup(account.group)) return null;
  return `"${name}" is not a cash or bank account, so it cannot receive the payment. Choose Cash or Cheque.`;
};

/* ───────────────────────── duplicate submissions ─────────────────────── */

/**
 * What makes two saves the same bill: party, date, kind, money and lines.
 * Not the number -- a double-click sends the same number twice, and the
 * second request is exactly the one that finds it taken.
 */
export const submissionFingerprint = (invoice) =>
  JSON.stringify([
    String(invoice?.type ?? ""),
    invoice?.return === true,
    new Date(invoice?.date ?? 0).getTime(),
    String(invoice?.customer?.name ?? ""),
    round2(invoice?.finalAmount),
    round2(invoice?.received),
    (invoice?.items || []).map((line) => [
      String(line?.name ?? ""),
      Number(line?.quantity) || 0,
      Number(line?.cost) || 0,
      Number(line?.discount) || 0,
      Number(line?.gstRate) || 0,
      line?.orderLineId ? String(line.orderLineId) : "",
      line?.challanLineId ? `${line.challanType}#${line.challanNo}:${line.challanLineId}` : "",
    ]),
  ]);

/**
 * Is `incoming` a resubmission of `existing` -- the bill that already holds
 * the number it asked for?
 *
 * Only within a short window of that bill being created, and only by the
 * SAME signed-in user. Two clerks at two counters can peek the same next
 * number and bill the same counter sale in the same minute: those are two
 * sales, and the second one must get a number of its own, not be told it was
 * already saved. One user's second request for the number their own first
 * request just took is a double-click or a retry -- after a successful save
 * the screen moves on and peeks a fresh number, so nothing else produces it.
 *
 * A bill saved before `createdBy` existed has none, and is never matched.
 */
export const isDuplicateSubmission = (
  existing,
  incoming,
  { userId, now = Date.now(), windowMs = DUPLICATE_WINDOW_MS } = {}
) => {
  if (!existing || !incoming) return false;
  if (!userId || !existing.createdBy || String(existing.createdBy) !== String(userId)) return false;
  const created = new Date(existing.createdAt ?? 0).getTime();
  if (!Number.isFinite(created) || now - created > windowMs || created > now + 1000) return false;
  return submissionFingerprint(existing) === submissionFingerprint(incoming);
};
