/**
 * What an order still owes, in one place.
 *
 * Pure and dependency-free, like the rest of lib/*.mjs, so `node` can run the
 * fixture test directly. Never import Mongoose in here -- the Mongoose side
 * lives in lib/orderClaims.mjs.
 *
 * THE ONE SUM THAT MATTERS
 * ------------------------
 *
 *     pending = ordered - cancelled - invoiced
 *
 * Every question an order screen asks is that subtraction: what is still to
 * bill, whether the order is finished, whether a line may be reduced. It is
 * written once, here, because the same sum computed in three places is how a
 * pending quantity ends up disagreeing with the invoices that consumed it.
 *
 * WHAT SIGFA ACTUALLY DOES, having now read their live file
 * ---------------------------------------------------------
 * Not what the column names suggest. `SPORDER1` has QTY, INVQTY, DESPQTY and
 * CanQty, and it is tempting to read those as ordered / invoiced / despatched
 * / cancelled. In 702 live order lines, INVQTY equals QTY on every single one
 * (ratio exactly 1.0): it is the quantity in the INVOICING unit, not a
 * fulfilment counter -- ITMAST carries UNIT and Unit2, and these items have
 * one unit each. DESPQTY is filled on 1 line of 702, CanQty on none.
 *
 * What IS maintained is the link the other way: 9,260 of their 12,413 invoice
 * lines carry a complete back-reference to a sales order line (OMKEY='SO'
 * with ORDERNO, OREFNO, OBRCODE, OOPNG). So Sigfa DERIVES pending by joining
 * invoices back to orders. It keeps no running total anywhere.
 *
 * This module keeps one -- `invoicedQty`, written by lib/orderClaims.mjs
 * inside the invoice's own transaction. The trade is deliberate:
 *
 *   a stored counter can drift; a derived figure cannot.
 *   a stored counter can refuse an over-bill AT THE MOMENT OF SAVING, which
 *   is the guard Sigfa has no equivalent of, and it reads in one query
 *   instead of a join across every invoice line.
 *
 * The drift is answered by the reconciliation report (lib/orderReports.mjs),
 * which derives pending Sigfa's way and compares. Nothing stores "remaining"
 * in either design.
 *
 * NO TAX LIVES ON AN ORDER
 * ------------------------
 * Deliberately, and again following Sigfa, whose SPORDER has no totals at all
 * and whose SPORDER1B has no GST columns. An order is a commitment to supply,
 * not a filing. The GST on the eventual bill is whatever the item master says
 * on the day it is billed, so freezing a rate at order time would only let it
 * go stale. `lineTotal` below is therefore qty x rate less discount, and
 * stops there.
 */

/** The two documents. 'Sale' is Sigfa's SO, 'Purchase' its PO. */
export const ORDER_TYPES = ["Sale", "Purchase"];

/**
 * Every state an order can be in. All four are DERIVED from the lines by
 * `orderStatus` below -- none is ever set by a client. A stored status that
 * can be posted to is a stored status that will eventually lie.
 */
export const ORDER_STATUSES = ["open", "partial", "closed", "cancelled"];

/**
 * Quantities are rounded to three decimals, money to two.
 *
 * Three because quantities here are weights and volumes -- 0.125 kg is a real
 * line -- and because `0.1 + 0.2` is what makes a pending quantity settle at
 * 5.999999999999998 and never compare equal to zero. The epsilon below is the
 * tolerance for "nothing left", one tenth of the smallest quantity that can
 * be stored.
 */
export const QTY_DECIMALS = 3;
export const QTY_EPSILON = 0.0001;

export const roundQty = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000) / 1000;
};

const round2 = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
};

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/** A quantity, never below zero. A negative order line is not a thing. */
const qty = (value) => {
  const n = roundQty(value);
  return n > 0 ? n : 0;
};

const text = (value) => String(value ?? "").trim();

/** Is this one of the two order documents? */
export const isOrderType = (type) => ORDER_TYPES.includes(text(type));

// ── the three quantities on a line ────────────────────────────────────────

export const orderedQty = (line) => qty(line?.quantity);
export const cancelledQty = (line) => qty(line?.cancelledQty);
export const invoicedQty = (line) => qty(line?.invoicedQty);

/**
 * How much of this line is still to bill.
 *
 * Clamped at zero: a line whose cancelled and invoiced quantities somehow
 * exceed what was ordered owes nothing, and must not report a negative
 * pending figure that would then be offered for billing.
 */
export const pendingQty = (line) =>
  Math.max(0, roundQty(orderedQty(line) - cancelledQty(line) - invoicedQty(line)));

/** Nothing left to bill on this line, within the rounding tolerance. */
export const isSettled = (line) => pendingQty(line) <= QTY_EPSILON;

// ── status ────────────────────────────────────────────────────────────────

/**
 * One line's state.
 *
 * Order matters. 'cancelled' is tested before 'closed' because a line
 * cancelled outright also has nothing pending, and calling that "closed"
 * would show a cancelled line as fulfilled.
 */
export const lineStatus = (line) => {
  const ordered = orderedQty(line);
  // A zero-quantity line owes nothing and was never cancelled; treating it as
  // closed would close an order somebody is still typing.
  if (ordered <= QTY_EPSILON) return "open";
  if (cancelledQty(line) >= ordered - QTY_EPSILON) return "cancelled";
  if (isSettled(line)) return "closed";
  if (invoicedQty(line) > QTY_EPSILON || cancelledQty(line) > QTY_EPSILON) {
    return "partial";
  }
  return "open";
};

/**
 * The whole order's state, from its lines.
 *
 * An order with no lines is 'open', not 'closed' -- it is a draft, not a
 * finished job.
 */
export const orderStatus = (order) => {
  const lines = (order?.items || []).filter(Boolean);
  if (!lines.length) return "open";

  const statuses = lines.map(lineStatus);
  if (statuses.every((s) => s === "cancelled")) return "cancelled";
  if (statuses.every((s) => s === "closed" || s === "cancelled")) return "closed";
  if (statuses.some((s) => s !== "open")) return "partial";
  return "open";
};

/** Still worth showing on a "what do we owe" list? */
export const isOpenOrder = (order) => {
  const status = orderStatus(order);
  return status === "open" || status === "partial";
};

/** The lines that still have something to bill, with their pending figure. */
export const pendingLines = (order) =>
  (order?.items || [])
    .filter(Boolean)
    .map((line) => ({ ...line, pending: pendingQty(line) }))
    .filter((line) => line.pending > QTY_EPSILON);

// ── money ─────────────────────────────────────────────────────────────────

/**
 * One line's value: quantity x rate, less the percentage discount.
 *
 * No GST, by design -- see the header. `cost` is the field name the billing
 * pages already use for a rate, kept the same so an order line can be handed
 * to the invoice form untranslated.
 */
export const lineTotal = (line) => {
  const base = qty(line?.quantity) * num(line?.cost);
  const discount = (base * num(line?.discount)) / 100;
  return round2(base - discount);
};

/** The order's value: the sum of its lines, cancelled quantities included. */
export const orderTotal = (items) =>
  round2((items || []).filter(Boolean).reduce((sum, l) => sum + lineTotal(l), 0));

/**
 * What is still to bill, in money -- the pending quantity at the line's rate.
 * This is the figure a "pending orders" report wants, not `orderTotal`.
 */
export const pendingValue = (order) =>
  round2(
    pendingLines(order).reduce(
      (sum, line) => sum + lineTotal({ ...line, quantity: line.pending }),
      0
    )
  );

// ── the link from an invoice line back to an order line ───────────────────

/**
 * The reference an invoice line carries, or null when it is a plain line.
 *
 * All three parts are required. A reference naming an order but not which
 * line of it cannot be settled, and silently claiming against the first
 * matching item name instead is how two lines of the same item on one order
 * end up both billed and both still pending.
 */
export const lineRef = (invoiceLine) => {
  const orderNo = Number(invoiceLine?.orderNo);
  const orderType = text(invoiceLine?.orderType);
  const lineId = text(invoiceLine?.orderLineId);

  if (!Number.isFinite(orderNo) || orderNo <= 0) return null;
  if (!isOrderType(orderType)) return null;
  if (!lineId) return null;

  return { orderNo, orderType, lineId };
};

/** The key an order is grouped under. Sale #1 and Purchase #1 are different. */
export const orderKey = (orderType, orderNo) => `${text(orderType)}#${Number(orderNo)}`;

/**
 * Group an invoice's lines into one claim per order.
 *
 * Returns [{ orderNo, orderType, byLine: Map<lineId, quantity> }].
 *
 * Quantities ACCUMULATE per line, because one order line legitimately splits
 * across two invoice lines -- half at the agreed rate and half at a revised
 * one is an ordinary thing to bill. Taking the last value instead would
 * under-claim and leave the order looking half open forever.
 */
export const claimsFromItems = (items) => {
  const groups = new Map();

  for (const item of items || []) {
    const ref = lineRef(item);
    if (!ref) continue;
    const want = qty(item?.quantity);
    if (want <= 0) continue;

    const key = orderKey(ref.orderType, ref.orderNo);
    if (!groups.has(key)) {
      groups.set(key, {
        orderNo: ref.orderNo,
        orderType: ref.orderType,
        byLine: new Map(),
      });
    }
    const byLine = groups.get(key).byLine;
    byLine.set(ref.lineId, roundQty((byLine.get(ref.lineId) || 0) + want));
  }

  return [...groups.values()];
};

/**
 * What an edit changes: the signed difference between the claims an invoice
 * held before and the ones it holds now.
 *
 * Lines that appear only in `before` come back negative (released), lines
 * only in `after` positive (claimed), and a line whose quantity merely
 * changed comes back as the difference. Entries that net to zero are dropped,
 * so an edit that did not touch the orders produces no work at all.
 */
export const netClaims = (beforeItems, afterItems) => {
  const signed = new Map();

  const walk = (items, sign) => {
    for (const group of claimsFromItems(items)) {
      const key = orderKey(group.orderType, group.orderNo);
      if (!signed.has(key)) {
        signed.set(key, {
          orderNo: group.orderNo,
          orderType: group.orderType,
          byLine: new Map(),
        });
      }
      const byLine = signed.get(key).byLine;
      for (const [lineId, want] of group.byLine) {
        byLine.set(lineId, roundQty((byLine.get(lineId) || 0) + sign * want));
      }
    }
  };

  walk(beforeItems, -1);
  walk(afterItems, +1);

  const out = [];
  for (const group of signed.values()) {
    const byLine = new Map();
    for (const [lineId, delta] of group.byLine) {
      if (Math.abs(delta) > QTY_EPSILON) byLine.set(lineId, delta);
    }
    if (byLine.size) out.push({ ...group, byLine });
  }
  return out;
};

// ── applying a claim to an order ──────────────────────────────────────────

const lineId = (line) => text(line?._id ?? line?.id);

/**
 * Apply signed quantity changes to one order's lines.
 *
 * Returns `{ items, problems }`. `items` is a new array -- the input is never
 * mutated -- and `problems` lists every reason the change cannot stand. When
 * `problems` is non-empty the caller must abort: `items` is still returned so
 * a test can see what was attempted, but it has not been validated.
 *
 * Refused, and why:
 *   - a line id that is not on this order. A reference that resolves to
 *     nothing means the order was edited underneath the invoice, and
 *     silently ignoring it would bill goods against no commitment at all.
 *   - claiming more than is pending. This is the over-billing guard, and the
 *     whole reason the arithmetic is centralised.
 *   - releasing more than was claimed, which would drive invoicedQty
 *     negative and make the line look pending twice over.
 */
export const applyDeltas = (order, byLine) => {
  const problems = [];
  const deltas = byLine instanceof Map ? byLine : new Map(Object.entries(byLine || {}));
  const seen = new Set();

  const items = (order?.items || []).filter(Boolean).map((line) => {
    const id = lineId(line);
    if (!deltas.has(id)) return line;
    seen.add(id);

    const delta = roundQty(deltas.get(id));
    const already = invoicedQty(line);
    const next = roundQty(already + delta);

    if (next < -QTY_EPSILON) {
      problems.push(
        `${label(line)}: cannot un-bill ${trim(-delta)} when only ${trim(already)} was billed.`
      );
      return line;
    }

    const room = roundQty(orderedQty(line) - cancelledQty(line));
    if (next > room + QTY_EPSILON) {
      problems.push(
        `${label(line)}: only ${trim(pendingQty(line))} left to bill of ${trim(orderedQty(line))} ordered.`
      );
      return line;
    }

    return { ...line, invoicedQty: Math.max(0, next) };
  });

  for (const id of deltas.keys()) {
    if (!seen.has(id)) {
      problems.push(`A billed line no longer exists on this order.`);
      break;
    }
  }

  return { items, problems };
};

/**
 * Can this order be edited at all, and can this line be reduced?
 *
 * An order with nothing billed is freely editable. Once part of it has been
 * invoiced, its quantity may not fall below what has already gone out on a
 * bill -- that would leave an invoice claiming against a commitment that no
 * longer covers it.
 */
export const editBlockedReason = (previousLines, nextLines) => {
  const before = new Map();
  for (const line of (previousLines || []).filter(Boolean)) {
    before.set(lineId(line), line);
  }

  const problems = [];
  const kept = new Set();

  for (const line of (nextLines || []).filter(Boolean)) {
    const id = lineId(line);
    if (!id || !before.has(id)) continue;
    kept.add(id);
    const billed = invoicedQty(before.get(id));
    if (billed <= QTY_EPSILON) continue;

    if (orderedQty(line) < billed - QTY_EPSILON) {
      problems.push(
        `${label(line)}: ${trim(billed)} is already billed, so the order cannot drop to ${trim(orderedQty(line))}.`
      );
    }
    const room = roundQty(orderedQty(line) - cancelledQty(line));
    if (room < billed - QTY_EPSILON) {
      problems.push(
        `${label(line)}: ${trim(billed)} is already billed, so only ${trim(roundQty(orderedQty(line) - billed))} may be cancelled.`
      );
    }
  }

  for (const [id, line] of before) {
    if (kept.has(id)) continue;
    if (invoicedQty(line) > QTY_EPSILON) {
      problems.push(`${label(line)}: already billed, so the line cannot be removed.`);
    }
  }

  return problems.length ? problems.join(" ") : null;
};

/**
 * Why this order may not be deleted, or null when it may.
 *
 * Anything billed anchors the order in place, the same way a reported IRN
 * anchors an invoice (lib/einvoiceLock.mjs). Delete the invoices first.
 */
export const deleteBlockedReason = (order) => {
  if (!order) return null;
  const billed = (order.items || [])
    .filter(Boolean)
    .reduce((sum, line) => sum + invoicedQty(line), 0);
  if (billed > QTY_EPSILON) {
    return `This order has already been billed. Delete or amend the invoices raised against it first.`;
  }
  return null;
};

// ── cancelling ────────────────────────────────────────────────────────────

/**
 * How much of this line may still be called off.
 *
 * Exactly the pending quantity, and that is the whole rule: a quantity that
 * has gone out on an invoice cannot be cancelled, because the bill exists and
 * the goods are accounted for. So cancelling a part-billed order SHORT-CLOSES
 * it -- the billed part stays, the balance is written off.
 */
export const cancellableQty = (line) => pendingQty(line);

/** Nothing on this order can be cancelled any more. */
export const nothingToCancel = (order) =>
  (order?.items || []).filter(Boolean).every((l) => cancellableQty(l) <= QTY_EPSILON);

/**
 * Why this order cannot be cancelled, or null when it can.
 *
 * A fully billed order is not refused for being "closed" -- it is refused
 * because there is nothing left to call off, which is a different sentence
 * and the one that answers the user's question.
 */
export const cancelBlockedReason = (order) => {
  if (!order) return null;
  if (!(order.items || []).filter(Boolean).length) {
    return "This order has no items to cancel.";
  }
  if (nothingToCancel(order)) {
    const billed = (order.items || []).some((l) => invoicedQty(l) > QTY_EPSILON);
    return billed
      ? "Nothing left to cancel -- every line is either billed or already cancelled."
      : "This order is already cancelled.";
  }
  return null;
};

/** Why a cancellation cannot be undone, or null when it can. */
export const restoreBlockedReason = (order) => {
  if (!order) return null;
  const cancelled = (order.items || [])
    .filter(Boolean)
    .some((l) => cancelledQty(l) > QTY_EPSILON);
  return cancelled ? null : "Nothing on this order is cancelled.";
};

/**
 * Call off the unbilled balance.
 *
 * `lineIds` names the lines to cancel; omit it (or pass null) to cancel the
 * whole order. Returns `{ items, cancelled, problems }` -- a NEW array, the
 * input untouched -- where `cancelled` lists what was actually called off, so
 * the caller can record it without recomputing.
 *
 * Lines with nothing pending are skipped SILENTLY rather than refused. On a
 * forty-line order where three are already billed out, refusing the whole
 * action because three lines had nothing to give would be useless; the user
 * asked to cancel what remains, and what remains is what gets cancelled.
 * `cancelBlockedReason` above is what refuses the action when NOTHING remains.
 */
export const applyCancel = (order, lineIds = null) => {
  const wanted = lineIds ? new Set((lineIds || []).map((id) => String(id))) : null;
  const cancelled = [];
  const problems = [];
  const seen = new Set();

  const items = (order?.items || []).filter(Boolean).map((line) => {
    const id = String(line?._id ?? line?.id ?? "");
    if (wanted && !wanted.has(id)) return line;
    if (wanted) seen.add(id);

    const give = cancellableQty(line);
    if (give <= QTY_EPSILON) return line;

    cancelled.push({ name: text(line.name), quantity: give, lineId: id });
    return { ...line, cancelledQty: roundQty(cancelledQty(line) + give) };
  });

  if (wanted) {
    for (const id of wanted) {
      if (!seen.has(id)) problems.push("A line being cancelled is not on this order.");
    }
  }

  return { items, cancelled, problems: problems.slice(0, 1) };
};

/**
 * Put a cancelled quantity back.
 *
 * Sets the cancelled quantity to zero, which is the only coherent reverse of
 * the above: the quantity was never posted anywhere, so there is nothing to
 * unwind. The line becomes pending again and can be billed or cancelled
 * afresh.
 *
 * It cannot over-restore: `invoicedQty` is untouched, so a line that was part
 * billed and part cancelled returns to "part billed, rest pending", never to
 * more than was ordered.
 */
export const applyRestore = (order, lineIds = null) => {
  const wanted = lineIds ? new Set((lineIds || []).map((id) => String(id))) : null;
  const restored = [];

  const items = (order?.items || []).filter(Boolean).map((line) => {
    const id = String(line?._id ?? line?.id ?? "");
    if (wanted && !wanted.has(id)) return line;

    const back = cancelledQty(line);
    if (back <= QTY_EPSILON) return line;

    restored.push({ name: text(line.name), quantity: back, lineId: id });
    return { ...line, cancelledQty: 0 };
  });

  return { items, restored, problems: [] };
};

/**
 * One entry for the order's cancellation log.
 *
 * A LOG rather than a single reason field, because two of the three ways to
 * cancel are partial: a lone `cancelReason` would be overwritten by the
 * second partial cancellation and the first reason lost -- which is the one
 * thing the field exists to answer.
 */
export const cancellationEntry = ({ lines, reason, by, at = new Date(), restore = false }) => ({
  at: at instanceof Date ? at : new Date(at),
  by: text(by),
  reason: text(reason),
  action: restore ? "restore" : "cancel",
  quantity: roundQty((lines || []).reduce((sum, l) => sum + num(l.quantity), 0)),
  lines: (lines || []).map((l) => ({ name: text(l.name), quantity: roundQty(l.quantity) })),
});

/** "12 pcs called off on 11 Oct -- customer deferred" for a register row. */
export const cancellationSummary = (order) => {
  const log = (order?.cancellations || []).filter(Boolean);
  if (!log.length) return "";
  const last = log[log.length - 1];
  const what = last.action === "restore" ? "restored" : "cancelled";
  const why = text(last.reason);
  return `${trim(last.quantity)} ${what}${why ? ` -- ${why}` : ""}`;
};

// ── presentation ──────────────────────────────────────────────────────────

const label = (line) => text(line?.name) || "This line";

/** A quantity without trailing zeros: 5 not 5.000, 0.125 not 0.13. */
export const trim = (value) => {
  const n = roundQty(value);
  return String(Number(n.toFixed(QTY_DECIMALS)));
};

/** "4 of 10 billed, 6 pending" -- the one line a list row needs. */
export const lineSummary = (line) => {
  const ordered = orderedQty(line);
  const billed = invoicedQty(line);
  const cancelled = cancelledQty(line);
  const pending = pendingQty(line);

  const parts = [`${trim(ordered)} ordered`];
  if (billed > QTY_EPSILON) parts.push(`${trim(billed)} billed`);
  if (cancelled > QTY_EPSILON) parts.push(`${trim(cancelled)} cancelled`);
  parts.push(pending > QTY_EPSILON ? `${trim(pending)} pending` : "nothing pending");
  return parts.join(", ");
};

/** What the form should offer when an order is carried into a bill. */
export const toInvoiceLines = (order) =>
  pendingLines(order).map((line) => ({
    name: line.name,
    description: line.description || "",
    hsn: line.hsn || "",
    quantity: line.pending,
    cost: num(line.cost),
    discount: num(line.discount),
    // Carried so save-invoice can settle the order line this came from.
    orderNo: Number(order?.orderNo),
    orderType: text(order?.type),
    orderLineId: lineId(line),
  }));
