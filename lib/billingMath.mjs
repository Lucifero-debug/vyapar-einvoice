/**
 * The money a billing screen computes, lifted out of the four pages verbatim.
 *
 * Pure -- it imports only other pure lib modules -- so `node` can run the
 * regression test directly.
 *
 *
 * READ THIS BEFORE CHANGING A SINGLE OPERATOR
 * -------------------------------------------
 * These functions were COPIED, not rewritten. Every oddity below is
 * deliberate, because the browser's arithmetic is what gets stored:
 * `save-invoice` derives `balanceDue` and rounds `finalAmount`, and it derives
 * the ledger legs, the party balance and the stock movement from `items` --
 * but the per-line `taxableAmount`, `gstAmount` and `total`, and the whole
 * `hsnTotals` array, are stored exactly as the screen sent them.
 *
 * So a "tidy-up" here silently rewrites figures on invoices. The quirks, all
 * of them preserved:
 *
 *   1. NOTHING IS ROUNDED. `recalcItem` returns raw floats, so 1/3 of a rupee
 *      reaches the database as 0.33333333333333337. The server rounds the
 *      invoice total once, at the end, and the lines keep their dust. Adding
 *      round2 here would change stored line totals on every future invoice
 *      and make them disagree with every past one.
 *
 *   2. `item.cost || item.salePrice` -- in that order, and with `||` rather
 *      than `??`, so a cost of 0 falls through to the sale price. An item
 *      deliberately billed at zero therefore picks up its master rate. That
 *      is how it has always behaved.
 *
 *   3. (FIXED) HSN groups used to take the gstRate of the FIRST line that
 *      landed in them. They are now one group per HSN code and rate, from
 *      lib/hsnTotals.mjs. See the note on `buildHsnTotals`.
 *
 *   4. `hsn || 'N/A'` -- a line with no HSN groups under the literal string
 *      "N/A", which is then stored as an HSN code.
 *
 * All four were recorded as pre-existing issues by the refactor that created
 * this file. Quirk 3 has since been fixed deliberately; the regression test
 * pins the other three, and the fix.
 */

import { hsnRateGroups } from "./hsnTotals.mjs";

/**
 * One line's derived figures.
 *
 * Copied from the identical `recalcItem` in all four billing pages. Do not
 * add rounding; see quirk 1 above.
 */
export const recalcItem = (item) => {
  // Always prefer item.cost over item.salePrice so edited values are
  // respected. (The original comment read "FIX 1".)
  const cost = Number(item.cost || item.salePrice || 0);
  const qty = Number(item.quantity) || 0;
  const discountPct = Number(item.discount) || 0;
  const gstRate = Number(item.gstRate) || 0;

  const baseAmount = cost * qty;
  const discountAmount = (baseAmount * discountPct) / 100;
  const taxableAmount = baseAmount - discountAmount;
  const gstAmount = (taxableAmount * gstRate) / 100;
  const total = taxableAmount + gstAmount;

  return { ...item, cost, taxableAmount, gstAmount, total };
};

/**
 * The HSN summary, one group per HSN code AND rate.
 *
 * Was copied from the identical `buildHsnTotals` in all four pages, which
 * keyed on the code alone and kept the FIRST line's rate: a 5% and an 18%
 * item under one HSN showed as one row "at 5%" carrying both taxes, and that
 * row was stored on the invoice. It is now lib/hsnTotals.mjs's
 * `hsnRateGroups` -- the same grouping the print, the GL and the GST returns
 * use -- with each group's money rounded once.
 *
 * The tax is the lines' own `gstAmount` ("stored"), as it always was here:
 * `recalcItem` has just produced it, and the screen shows what it computed.
 *
 * Keyed by `hsnKey` (`7308@18`); each row carries its `hsn` for display.
 */
export const buildHsnTotals = (items) => {
  const grouped = {};
  for (const group of hsnRateGroups(items || [], { source: "stored" })) {
    grouped[group.key] = {
      hsn: group.hsn,
      gstRate: group.gstRate,
      taxable: group.taxable,
      gstAmount: group.gstAmount,
      total: group.total,
    };
  }
  return grouped;
};

/**
 * The HSN summary in the shape the payload carries.
 *
 * Copied from the inline `Object.entries(hsnTotals).map(...)` in the save
 * handler. Note the key rename: the grouped object's `gstAmount` is sent as
 * `amount`, which is what `models/invoiceModel.js` declares and what
 * `lib/hsnTotals.mjs` reads back.
 */
export const hsnTotalsArray = (hsnTotals) =>
  Object.entries(hsnTotals || {}).map(([key, data]) => ({
    // The key is `hsn@rate` now; a hand-built object keyed by code alone
    // (and the rows the edit screen rebuilds) still works.
    hsn: data?.hsn ?? key,
    gstRate: data.gstRate,
    amount: data.gstAmount,
    total: data.total,
  }));

/** The GST on an invoice: the lines' own tax, added up. */
export const totalGstOf = (items) =>
  (items || []).reduce((sum, i) => sum + (Number(i.gstAmount) || 0), 0);

/**
 * THE FROZEN PAYLOAD CONTRACT.
 *
 * Extracted mechanically from all four pages before anything was moved. All
 * four sent exactly these 31 keys, in this order; only the values of `return`
 * and `type` differed between them.
 *
 * `save-invoice` and `sale-alter` read this shape. The order matters to
 * nothing but a diff, and the diff is the point: the regression test asserts
 * the builder below still produces this list, so a key quietly dropped during
 * the refactor fails the build instead of arriving at the server as undefined.
 */
export const PAYLOAD_KEYS = [
  "invoiceNo",
  "originalInvoiceNo",
  "date",
  "customer",
  "return",
  "paymentType",
  "balanceDue",
  "stateOfSupply",
  "stateCode",
  "taxType",
  "gst",
  "totalAmount",
  "finalAmount",
  "received",
  "items",
  "partyTaxes",
  "shippedTo",
  "dispatchFrom",
  "type",
  "transport",
  "grNo",
  "grDate",
  "pvtMark",
  "hsnTotals",
  "caseDetails",
  "freight",
  "weight",
  "ewayBillNo",
  "ewayBillDate",
  "orderDate",
  "orderNo",
  // THE CONTRACT GREW BY ONE, and this is the note the frozen-list comment
  // above asks for. `partyBillNo` is the OTHER party's own bill number -- the
  // number a supplier printed on the bill they sent. It is not `invoiceNo`,
  // which is this firm's own sequence with a unique index on it, and until
  // this field existed there was nowhere for it to go: the AI import put it
  // in `invoiceNo` and collided with a real invoice. See
  // models/invoiceModel.js.
  "partyBillNo",
  // And the date printed beside it -- required, with the number, on a
  // purchase M.R.I. (lib/invoiceInput.mjs).
  "partyBillDate",
  // And by one more: `mri`, the purchase M.R.I. block -- `{ on, remark,
  // againstMriNo }` -- on a purchase bill only (lib/mri.mjs). Absent on the
  // other three screens. The MRI number is never sent; the server reserves it.
  "mri",
  // And by one more again: `series`, Sigfa's Series Master code for this
  // document (lib/series.mjs). A LABEL ONLY -- `invoiceNo` above is still the
  // firm's own sequence and the series does not number anything. Blank is the
  // normal state: a firm that has defined no series sends "".
  "series",
];

/**
 * The request body, built exactly as the four pages built it.
 *
 * `config` supplies the two fields that differ (lib/billingTypes.mjs);
 * everything else comes from the form. The Number() coercions, the `|| 0` on
 * `received` and the `|| undefined` on `originalInvoiceNo` are the originals'
 * -- `originalInvoiceNo` has to be absent rather than empty, because
 * `sale-alter` uses its presence to find the row being edited.
 */
export const buildInvoicePayload = (form, config) => {
  const hsnTotals = form.hsnTotals ?? buildHsnTotals(form.items);

  return {
    invoiceNo: form.invoiceNo,
    originalInvoiceNo: form.originalInvoiceNo || undefined,
    date: form.date,
    customer: {
      name: form.customer?.name,
      phone: form.customer?.phone,
      email: form.customer?.email,
      custId: form.customer?._id ?? form.customer?.custId,
    },
    return: config.isReturn,
    paymentType: form.paymentType,
    balanceDue: form.balanceDue,
    stateOfSupply: form.stateOfSupply,
    stateCode: form.stateCode,
    taxType: form.taxType,
    gst: form.gst,
    totalAmount: Number(form.totalAmount),
    finalAmount: Number(form.finalAmount),
    received: Number(form.received) || 0,
    items: form.items,
    partyTaxes: form.partyTaxes,
    shippedTo: form.shippedTo,
    dispatchFrom: form.dispatchFrom,
    type: config.type,
    transport: form.transport,
    grNo: form.grNo,
    grDate: form.grDate,
    pvtMark: form.pvtMark,
    hsnTotals: hsnTotalsArray(hsnTotals),
    caseDetails: form.caseDetails,
    freight: form.freight,
    weight: form.weight,
    ewayBillNo: form.ewayBillNo,
    ewayBillDate: form.ewayBillDate,
    orderDate: form.orderDate,
    orderNo: form.orderNo,
    partyBillNo: form.partyBillNo,
    partyBillDate: form.partyBillDate,
    mri: form.mri || undefined,
    series: form.series,
  };
};

/** Which endpoint a save goes to: editing an existing bill, or raising one. */
export const saveEndpoint = (isEditing) =>
  isEditing ? "/api/sale-alter" : "/api/save-invoice";
