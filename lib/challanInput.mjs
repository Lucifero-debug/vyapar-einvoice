/**
 * A challan as the server accepts it: every field checked, every figure
 * recomputed, nothing the client says about billing or totals believed.
 *
 * Pure, like lib/invoiceInput.mjs (whose limits it shares), so
 * `node scripts/challans.test.mjs` runs it bare. Throws ChallanInputError
 * with a sentence the person can act on.
 */

import { MAX_AMOUNT, MAX_LINES, MAX_QUANTITY } from "./invoiceInput.mjs";
import { isChallanType, priceLine, roundQty } from "./challanStatus.mjs";
import { checkReceived, parseMriHeader, zeroAcceptedAllowed } from "./mri.mjs";

export class ChallanInputError extends Error {
  constructor(message) {
    super(message);
    this.name = "ChallanInputError";
  }
}

const fail = (message) => {
  throw new ChallanInputError(message);
};

const isBlank = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

const numberOf = (value, label, { min = -Infinity, max = Infinity, fallback } = {}) => {
  if (isBlank(value)) {
    if (fallback !== undefined) return fallback;
    fail(`${label} is required.`);
  }
  if (typeof value !== "number" && typeof value !== "string") fail(`${label} must be a number.`);
  if (typeof value === "string" && !DECIMAL.test(value.trim())) fail(`${label} must be a number.`);
  const n = Number(typeof value === "string" ? value.trim() : value);
  if (!Number.isFinite(n)) fail(`${label} must be a number.`);
  if (n < min) fail(`${label} cannot be less than ${min}.`);
  if (n > max) fail(`${label} is too large.`);
  return n;
};

const TEXT_MAX = { short: 60, long: 300, name: 200, description: 500, hsn: 20, id: 64 };

const textOf = (value, label, max) => {
  if (isBlank(value)) return "";
  if (typeof value !== "string" && typeof value !== "number") fail(`${label} must be text.`);
  const s = String(value).trim();
  if (s.length > max) fail(`${label} is too long (at most ${max} characters).`);
  return s;
};

const EARLIEST = Date.UTC(2000, 0, 1);
const MAX_FUTURE_MS = 366 * 24 * 60 * 60 * 1000;

const dateOf = (value, label, { required = false, now = Date.now() } = {}) => {
  if (isBlank(value)) {
    if (required) fail(`${label} is required.`);
    return null;
  }
  if (typeof value !== "string" && !(value instanceof Date)) fail(`${label} is not a date.`);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) fail(`${label} is not a date.`);
  if (d.getTime() < EARLIEST || d.getTime() > now + MAX_FUTURE_MS) fail(`${label} is out of range.`);
  return d;
};

const lineLabel = (index, name) => `Line ${index + 1}${name ? ` (${name})` : ""}`;

const prepareLine = (raw, index, { mriOn = false } = {}) => {
  if (!isPlainObject(raw)) fail(`${lineLabel(index)} is not a line item.`);
  if (typeof raw.name !== "string" || !raw.name.trim()) fail(`${lineLabel(index)} has no item name.`);
  if (raw.name.length > TEXT_MAX.name) fail(`${lineLabel(index)}: the item name is too long.`);
  const label = lineLabel(index, raw.name.trim());

  const quantity = roundQty(numberOf(raw.quantity, `${label}: quantity`, { max: MAX_QUANTITY }));
  // On a purchase M.R.I. this is the ACCEPTED quantity, and a lot rejected
  // outright is accepted at zero (lib/mri.mjs).
  if (!(quantity > 0) && !(quantity === 0 && zeroAcceptedAllowed(raw, { mriOn }))) {
    fail(`${label}: quantity must be more than zero.`);
  }
  const received = checkReceived(raw, quantity, { mriOn, label });
  if (received.error) fail(received.error);
  const cost = numberOf(raw.cost, `${label}: rate`, { min: 0, max: MAX_AMOUNT, fallback: 0 });
  const discount = numberOf(raw.discount, `${label}: discount`, { min: 0, max: 100, fallback: 0 });
  const gstRate = numberOf(raw.gstRate, `${label}: GST rate`, { min: 0, max: 100, fallback: 0 });

  const priced = priceLine({ cost, quantity, discount, gstRate });
  if (Math.abs(priced.total) > MAX_AMOUNT) fail(`${label}: the amount is too large.`);

  const line = {
    name: raw.name,
    description: textOf(raw.description, `${label}: description`, TEXT_MAX.description),
    hsn: textOf(raw.hsn, `${label}: HSN`, TEXT_MAX.hsn),
    quantity,
    cost: priced.cost,
    discount,
    gstRate,
    taxableAmount: priced.taxableAmount,
    gstAmount: priced.gstAmount,
    total: priced.total,
  };
  if (received.value !== undefined) line.receivedQty = received.value;

  // What the SUPPLIER'S challan said it was sending, for the M.R.I.'s short
  // figure (lib/mri.mjs). Only on an M.R.I. -- on an ordinary challan it is
  // this firm's own document and there is nothing to compare it against --
  // and blank is kept blank, because "no paper came with it" is not the same
  // as "they promised nothing".
  if (!isBlank(raw.challanQty)) {
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
  // An existing line's id, so an edit keeps it -- invoice lines point at it.
  // A database id or nothing: anything else is not a line this challan had.
  const id = raw._id ?? raw.id;
  if (!isBlank(id)) {
    const s = String(id).trim();
    if (!/^[0-9a-f]{24}$/i.test(s)) fail(`${label}: that is not a line of this challan.`);
    line._id = s;
  }
  return line;
};

/** Top-level keys a request may carry; anything else is refused. */
export const CHALLAN_FIELDS = [
  "type",
  "challanNo",
  "date",
  "customer",
  "stockEffect",
  "items",
  "partyChallanNo",
  "partyChallanDate",
  "transport",
  "vehicleNo",
  "grNo",
  "grDate",
  "ewayBillNo",
  "ewayBillDate",
  "shippedTo",
  "remarks",
  // Purchase M.R.I.: `{ on, remark, againstMriNo }` (lib/mri.mjs).
  "mri",
];

/** Never accepted from a client; set only by the server. */
const SERVER_ONLY = [
  "billedQty",
  "status",
  "totalAmount",
  "taxableAmount",
  "gstAmount",
  "companyId",
  "createdBy",
  "updatedBy",
  "editCount",
];

/**
 * The challan, checked. `stockEffectDefault` is the firm's "Stock Effect
 * With Challan" setting, used when the screen does not say.
 */
export function prepareChallanInput(body, { now = Date.now(), stockEffectDefault = true } = {}) {
  if (!isPlainObject(body)) fail("Nothing to save.");
  for (const key of Object.keys(body)) {
    if (SERVER_ONLY.includes(key)) fail(`"${key}" is worked out by the server, not sent.`);
    if (!CHALLAN_FIELDS.includes(key)) fail(`"${key}" is not a challan field.`);
  }

  const type = String(body.type ?? "").trim();
  if (!isChallanType(type)) fail("A challan must be a Sale or a Purchase challan.");

  const challanNo = isBlank(body.challanNo)
    ? null
    : numberOf(body.challanNo, "Challan No.", { min: 1, max: 1e9 });
  if (challanNo !== null && !Number.isInteger(challanNo)) fail("Challan No. must be a whole number.");

  if (!isPlainObject(body.customer) || typeof body.customer.name !== "string" || !body.customer.name.trim()) {
    fail(type === "Sale" ? "Choose the customer." : "Choose the supplier.");
  }

  const mriParsed = parseMriHeader(body.mri, { type, isReturn: false });
  if (mriParsed.error) fail(mriParsed.error);
  const mri = mriParsed.mri;

  if (!Array.isArray(body.items) || body.items.length === 0) fail("Add at least one item.");
  if (body.items.length > MAX_LINES) fail(`At most ${MAX_LINES} lines on one challan.`);
  const items = body.items.map((raw, index) => prepareLine(raw, index, { mriOn: mri.on }));
  const ids = items.map((l) => l._id).filter(Boolean);
  if (new Set(ids).size !== ids.length) fail("The same challan line is listed twice.");

  if (body.stockEffect !== undefined && typeof body.stockEffect !== "boolean") {
    fail("Stock effect must be yes or no.");
  }

  return {
    type,
    challanNo,
    date: dateOf(body.date, "Challan date", { now }) || new Date(now),
    customer: {
      name: body.customer.name.trim(),
      phone: textOf(body.customer.phone, "Phone", TEXT_MAX.short),
      email: textOf(body.customer.email, "Email", TEXT_MAX.long),
    },
    stockEffect: body.stockEffect === undefined ? Boolean(stockEffectDefault) : body.stockEffect,
    items,
    partyChallanNo: textOf(body.partyChallanNo, "Party challan No.", TEXT_MAX.short),
    partyChallanDate: dateOf(body.partyChallanDate, "Party challan date", { now }),
    transport: textOf(body.transport, "Transport", TEXT_MAX.short),
    vehicleNo: textOf(body.vehicleNo, "Vehicle No.", TEXT_MAX.short),
    grNo: textOf(body.grNo, "GR No.", TEXT_MAX.short),
    grDate: dateOf(body.grDate, "GR date", { now }),
    ewayBillNo: textOf(body.ewayBillNo, "E-way bill No.", TEXT_MAX.short),
    ewayBillDate: dateOf(body.ewayBillDate, "E-way bill date", { now }),
    shippedTo: textOf(body.shippedTo, "Shipped to", TEXT_MAX.long),
    remarks: textOf(body.remarks, "Remarks", TEXT_MAX.long),
    mri,
  };
}
