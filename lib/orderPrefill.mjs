/**
 * Turning an order into the lines a billing form expects.
 *
 * Pure and dependency-free, like the rest of lib/*.mjs. The caller passes its
 * own `recalc` -- the billing pages already have `recalcItem`, which is what
 * decides taxableAmount, gstAmount and total -- so this module never has to
 * know how a line's money is worked out. It only decides WHICH lines, WHAT
 * quantity, and which fields come from where.
 *
 * THE RULE ABOUT TAX
 * ------------------
 * The GST rate comes from the ITEM MASTER as it stands today, never from the
 * order. An order placed in March and billed in October is billed at
 * October's rate -- that is the law, and it is also why nothing tax-shaped is
 * stored on an order in the first place (models/orderModel.js).
 *
 * The rate and discount, by contrast, come from the ORDER. Those were agreed
 * with the customer; silently re-pricing them from the master at billing time
 * is how a client ends up invoicing a figure they never quoted.
 */

import {
  QTY_EPSILON,
  cancelledQty,
  invoicedQty,
  orderedQty,
  pendingQty,
  roundQty,
  trim,
} from "./orderStatus.mjs";

const key = (name) => String(name ?? "").trim().toLowerCase();
const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Build billing lines from an order's pending quantities.
 *
 *   order  - as /api/get-order returns it
 *   items  - the item master list the page already holds
 *   recalc - the page's own recalcItem
 *
 * Returns `{ lines, customerName, skipped }`. `skipped` names any order line
 * whose item is no longer in the master: those are still billed, using the
 * order's own rate and no GST rate, because dropping them silently would
 * under-bill the order and leave it looking part-pending for good. The page
 * shows the names so the user knows to check the tax on them.
 */
export const prefillFromOrder = ({ order, items, recalc }) => {
  const masters = new Map((items || []).filter(Boolean).map((i) => [key(i.name), i]));
  const skipped = [];

  const lines = (order?.items || [])
    .filter(Boolean)
    .map((line) => ({ line, pending: pendingQty(line) }))
    .filter(({ pending }) => pending > QTY_EPSILON)
    .map(({ line, pending }) => {
      const master = masters.get(key(line.name));
      if (!master) skipped.push(line.name);

      const merged = {
        ...(master || {}),
        name: line.name,
        description: line.description || "",
        hsn: line.hsn || master?.hsn || "",
        quantity: pending,
        // From the ORDER: this is the price that was agreed.
        cost: num(line.cost),
        discount: num(line.discount),
        // From the MASTER, today. Never from the order.
        gstRate: num(master?.gst ?? master?.gstRate),
        uqc: master?.uqc || line.uqc,
        isService: master ? Boolean(master.isService) : Boolean(line.isService),
        // The reference that lets save-invoice settle this order line.
        // lib/orderClaims.mjs refuses a claim unless all three are present.
        orderNo: Number(order?.orderNo),
        orderType: String(order?.type || ""),
        orderLineId: String(line._id || ""),
        // Carried so the print can list every order this bill draws on.
        orderDate: order?.date || null,
      };

      return typeof recalc === "function" ? recalc(merged) : merged;
    });

  return {
    lines,
    customerName: order?.customer?.name || "",
    skipped,
    // === What goes on the HEADER of the bill ===
    //
    // Sigfa prints ORDNO and ORDATE on the invoice ("Your Order No. / Date"),
    // and components/InvoiceDocument.jsx already prints the same two fields --
    // they were simply never filled when a bill came from an order, so the
    // printed invoice carried no reference to it at all. That is most of what
    // "the order module is not linked to invoices" means on paper.
    //
    // `reference` is the BUYER's own paperwork number, which is a different
    // thing and belongs in the remarks, not in a Number field.
    header: {
      orderNo: Number(order?.orderNo) || "",
      orderDate: order?.date ? new Date(order.date).toISOString().substring(0, 10) : "",
      reference: order?.reference || "",
    },
  };
};

// ── billing chosen lines, in chosen quantities ────────────────────────────

/**
 * The rows an order-item picker shows.
 *
 * WHY A PICKER AT ALL, rather than "bill the order"
 * -------------------------------------------------
 * Measured on MCSFAST's live file, where 9,260 invoice lines reference an
 * order line:
 *
 *   - 29.8% of order lines (1,199 of 4,020) are billed across MORE THAN ONE
 *     invoice. One line was billed by 93 separate invoices. This is a
 *     running-supply trade: an order for 10,000 fasteners is drawn down over
 *     months. So billing has to take PART of a line's pending quantity --
 *     all-or-nothing is wrong for nearly a third of their real lines.
 *   - Of the (invoice, order) pairs whose order is still in this year's file,
 *     64.6% billed only SOME of the order's lines. So selection is per line.
 *   - Invoices spanning more than one order: 4 of 4,055, or 0.1%. So the
 *     picker works within one order and nothing is built for the other case.
 *
 * Returns display figures and the invoice-ready fields together, so the
 * picker itself does no arithmetic -- the moment a screen computes a pending
 * quantity it forgets the cancelled one.
 */
export const pickableLines = (order) =>
  (order?.items || [])
    .filter(Boolean)
    .map((line) => ({ line, pending: pendingQty(line) }))
    .filter(({ pending }) => pending > QTY_EPSILON)
    .map(({ line, pending }) => ({
      orderNo: Number(order?.orderNo) || 0,
      orderType: String(order?.type || ""),
      orderLineId: String(line._id || ""),
      orderDate: order?.date || null,
      party: order?.customer?.name || "",
      item: String(line.name || ""),
      hsn: line.hsn || "",
      uqc: line.uqc || "",
      ordered: orderedQty(line),
      billed: invoicedQty(line),
      cancelled: cancelledQty(line),
      pending,
      // What the picker offers to bill, which the user may reduce.
      billNow: pending,
      rate: num(line.cost),
      discount: num(line.discount),
      promised: line.deliveryDate || null,
    }));

/**
 * Build invoice lines for the quantities actually chosen.
 *
 *   picks: [{ orderLineId, quantity }]
 *
 * Returns `{ lines, problems, skipped }`. A pick for more than is pending is
 * REFUSED rather than clamped: silently billing less than the user typed is
 * how a clerk ends up thinking they have invoiced 500 when the bill says 300.
 * A pick of zero is simply left out -- that is how you deselect a row.
 *
 * The rate and GST follow the same split as `prefillFromOrder`: the rate is
 * the ORDER's, because it was agreed; the GST rate is the item master's
 * today, because that is the law on the day of billing.
 */
export const pickFromOrder = ({ order, items, recalc, picks }) => {
  const rows = new Map(pickableLines(order).map((r) => [r.orderLineId, r]));
  const masters = new Map((items || []).filter(Boolean).map((i) => [key(i.name), i]));

  const problems = [];
  const skipped = [];
  const lines = [];

  for (const pick of picks || []) {
    const id = String(pick?.orderLineId || "");
    const want = roundQty(pick?.quantity);
    if (!id) continue;

    const row = rows.get(id);
    if (!row) {
      problems.push(`A chosen line is no longer pending on this order.`);
      continue;
    }
    if (want <= 0) continue;

    if (want > row.pending + QTY_EPSILON) {
      problems.push(
        `${row.item}: only ${trim(row.pending)} is pending, so ${trim(want)} cannot be billed.`
      );
      continue;
    }

    const master = masters.get(key(row.item));
    if (!master) skipped.push(row.item);

    const merged = {
      ...(master || {}),
      name: row.item,
      description: "",
      hsn: row.hsn || master?.hsn || "",
      quantity: want,
      cost: row.rate,
      discount: row.discount,
      gstRate: num(master?.gst ?? master?.gstRate),
      uqc: master?.uqc || row.uqc,
      isService: master ? Boolean(master.isService) : false,
      orderNo: row.orderNo,
      orderType: row.orderType,
      orderLineId: id,
      orderDate: row.orderDate || null,
    };

    lines.push(typeof recalc === "function" ? recalc(merged) : merged);
  }

  return { lines, problems: problems.slice(0, 3), skipped };
};
