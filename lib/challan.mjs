/**
 * Sales and purchase challans.
 *
 * Pure and dependency-free except for lib/orderStatus.mjs, whose quantity
 * arithmetic this REUSES rather than copies -- see below. `node` can run
 * scripts/challan.test.mjs directly; never import Mongoose in here.
 *
 *
 * WHAT SIGFA CALLS THESE, AND WHERE THEY LIVE
 * -------------------------------------------
 * Two of the Mkeys its MkeyMaster is seeded with:
 *
 *     Insert Into MkeyMaster(Mkey,MkeyName) Values('SC','Sales Challan')
 *     Insert Into MkeyMaster(Mkey,MkeyName) Values('PC','Purchase Challan')
 *
 * reached by `Sales &Challan` (Ctl+B) and `Purchase &Challan` (Ctl+E), printed
 * as `SALES CHALLAN` / `PURCHASE CHALLAN` with `CHALLAN NO.` and
 * `Challan Date`, and reported through `Pending Challan Book`. Its third,
 * `TC` Transfer Challan, is a branch-to-branch movement and this app has no
 * branches.
 *
 * A challan is the document that goes WITH THE GOODS when the tax invoice is
 * not being raised at dispatch: material sent for job work, goods sent on
 * approval, a part delivery against a running order, a van load billed at
 * month end. Under GST that is Rule 55, and the paper that travels is a
 * delivery challan, not an invoice.
 *
 *
 * A CHALLAN POSTS NOTHING
 * -----------------------
 * Not a party balance, not GST, not a ledger leg, and not a stock movement.
 * That is the whole reason it is a separate document rather than an invoice
 * with a flag:
 *
 *   - **No party balance.** Nothing is owed yet. A challan that moved
 *     `Customer.lastBal` would put a receivable on the books for goods that
 *     have not been billed, and the party's statement would show a debit with
 *     no invoice behind it.
 *   - **No GST.** The liability arises on the invoice. Sigfa's own challan
 *     header carries the tax columns because SALPUR is one table for six
 *     document types, but its GST returns read `Mkey in ('SI','PI',...)` and
 *     never SC or PC.
 *   - **No stock.** The firm's decision, and Sigfa's default: its
 *     `Stock Effect With Challan` setup switch is what makes a challan feed
 *     the stock ledger, and with it off the stock moves when the invoice is
 *     raised. This app has one answer rather than a setting, because a
 *     setting that changes posting is a setting that changes last year's
 *     books. So: the stock ledger is fed by invoices and stock vouchers
 *     exactly as it is today, and a challan changes nothing about it.
 *
 * What a challan DOES is carry a commitment: these goods went out, and an
 * invoice is still owed for them. That makes it, mechanically, the same
 * document as an order -- which is why this module reuses the order's
 * arithmetic rather than keeping a second copy of it.
 *
 *
 * THE ARITHMETIC IS lib/orderStatus.mjs's, DELIBERATELY
 * ----------------------------------------------------
 * A challan line has the same three quantities an order line has -- what went
 * out, what was called off, what has been billed -- and pending is the same
 * subtraction, with the same rounding and the same epsilon. Every one of
 * those helpers in lib/orderStatus.mjs reads only `line.quantity`,
 * `line.cancelledQty`, `line.invoicedQty` and `doc.items`: not one of them
 * mentions an order. They are re-exported here under the challan's own names
 * so this module has ONE implementation of the subtraction, not two that
 * drift. The §8.4 rule about editing four pages applies to rules modules too.
 *
 * What is NOT shared is the LINK from an invoice line back to a challan line,
 * because the field names differ and must: Sigfa's Salpur1 carries
 * `CBRCODE / COPNG / CHALLAN / CHRefNo` for the challan AND
 * `OBRCODE / OMKEY / ORDERNO / OREFNO` for the order, side by side, so one
 * invoice line can be raised against an order AND delivered on a challan at
 * the same time. Collapsing the two into one reference would make that
 * ordinary case unrepresentable.
 */

import {
  QTY_EPSILON,
  applyCancel,
  applyDeltas,
  applyRestore,
  cancellableQty,
  cancellationEntry,
  cancellationSummary,
  cancelledQty,
  deleteBlockedReason,
  editBlockedReason,
  invoicedQty,
  isOpenOrder,
  isSettled,
  lineStatus,
  lineSummary,
  lineTotal,
  nothingToCancel,
  orderStatus,
  orderTotal,
  pendingLines,
  pendingQty,
  pendingValue,
  restoreBlockedReason,
  roundQty,
  trim,
} from "./orderStatus.mjs";

const text = (value) => String(value ?? "").trim();
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const qty = (value) => {
  const n = roundQty(value);
  return n > 0 ? n : 0;
};
const lineId = (line) => text(line?._id ?? line?.id);

/* ─────────────── the shared arithmetic, under challan names ───────────── */

export { QTY_EPSILON, roundQty, lineTotal, trim, lineSummary };

/** What went out on this line, and what is left to bill. */
export const challanedQty = (line) => qty(line?.quantity);
export { cancelledQty, invoicedQty, pendingQty, isSettled, lineStatus, pendingLines };

/** The whole challan's state, and whether it still owes an invoice. */
export const challanStatus = (challan) => orderStatus(challan);
export const isOpenChallan = (challan) => isOpenOrder(challan);

/** Its value, and the value still to bill. No GST -- see the header. */
export const challanTotal = (items) => orderTotal(items);
export const pendingChallanValue = (challan) => pendingValue(challan);

/** The claim, cancellation and deletion guards, unchanged. */
export { applyDeltas, applyCancel, applyRestore, cancellableQty, nothingToCancel };
export { cancellationEntry, cancellationSummary, restoreBlockedReason };

/**
 * Why this challan may not be edited / deleted.
 *
 * The order module's reasons, re-worded for the document the user is looking
 * at: "already billed" means the same thing, but a message that says "order"
 * on a challan screen is a message somebody reports as a bug.
 */
export const challanEditBlockedReason = (previousLines, nextLines) => {
  const reason = editBlockedReason(previousLines, nextLines);
  return reason ? reason.replace(/\border\b/g, "challan") : null;
};

export const challanDeleteBlockedReason = (challan) => {
  const reason = deleteBlockedReason(challan);
  if (!reason) return null;
  return "This challan has already been billed. Delete or amend the invoices raised against it first.";
};

/* ─────────────────────────── the two kinds ───────────────────────────── */

/**
 * `SC` and `PC`, with everything the screens and the print need.
 *
 * `title` is what Sigfa prints at the head of the paper, in its own capitals.
 * `slip` is the second name the same document has there -- `Sale Challan & MRO`
 * and `Purchase Challan & MRI` -- the way a production voucher has both
 * "Goods Issued" and "Issue Slip" (lib/stockVoucher.mjs's STOCK_KINDS).
 */
export const CHALLAN_KINDS = {
  Sale: {
    type: "Sale",
    mkey: "SC",
    label: "Sales Challan",
    plural: "Sales challans",
    title: "SALES CHALLAN",
    slip: "M.R.O",
    party: "Customer",
    // Which way the goods are going, for the wording on screen. NOT a stock
    // direction: a challan writes no stock row at all.
    direction: "out",
    going: "Goods going out, to be billed later.",
    shortcut: "Ctrl+B",
  },
  Purchase: {
    type: "Purchase",
    mkey: "PC",
    label: "Purchase Challan",
    plural: "Purchase challans",
    title: "PURCHASE CHALLAN",
    slip: "M.R.I",
    party: "Supplier",
    direction: "in",
    going: "Goods received against no bill yet.",
    shortcut: "Ctrl+E",
  },
};

export const CHALLAN_TYPES = Object.keys(CHALLAN_KINDS);

export const isChallanType = (type) => CHALLAN_TYPES.includes(text(type));

export const challanKind = (type) => CHALLAN_KINDS[text(type)] || null;

/** The document's name, or "" for something that is not a challan type. */
export const challanLabel = (type) => challanKind(type)?.label || "";

export const challanTitle = (type) => challanKind(type)?.title || "";

/**
 * Which counter a challan of this type draws its number from.
 *
 * ONE SERIES PER TYPE, and neither is the invoice series. A challan that took
 * the next invoice number would leave a hole in the invoice sequence, and GST
 * invoice numbering has to be consecutive -- Sigfa keeps them apart too
 * (`VOUCHER Text(16)` per Mkey, with `Ask Series In Purchase Challan`).
 */
export const counterFor = (type) =>
  isChallanType(type) ? `challanNo:${text(type)}` : "";

/** Every state a challan can be in -- derived from the lines, never stored. */
export const CHALLAN_STATUSES = ["open", "partial", "closed", "cancelled"];

export const STATUS_LABELS = {
  open: "Pending",
  partial: "Part billed",
  closed: "Billed",
  cancelled: "Cancelled",
};

/* ──────────── the link from an invoice line to a challan line ─────────── */

/**
 * The challan reference an invoice line carries, or null for a plain line.
 *
 * All three parts are required, the same rule `lineRef` follows for orders: a
 * reference naming a challan but not which line of it cannot be settled, and
 * claiming against the first matching item name instead is how two lines of
 * the same item on one challan end up both billed and both still pending.
 */
export const challanRef = (invoiceLine) => {
  const challanNo = Number(invoiceLine?.challanNo);
  const challanType = text(invoiceLine?.challanType);
  const id = text(invoiceLine?.challanLineId);

  if (!Number.isFinite(challanNo) || challanNo <= 0) return null;
  if (!isChallanType(challanType)) return null;
  if (!id) return null;

  return { challanNo, challanType, lineId: id };
};

/** Sale #1 and Purchase #1 are different documents. */
export const challanKey = (challanType, challanNo) =>
  `${text(challanType)}#${Number(challanNo)}`;

/**
 * Group an invoice's lines into one claim per challan.
 *
 * Returns `[{ challanNo, challanType, byLine: Map<lineId, quantity> }]`.
 *
 * Quantities ACCUMULATE per line, because one challan line legitimately
 * splits across two invoice lines -- part of a delivery billed at the agreed
 * rate and part at a revised one is an ordinary thing. Taking the last value
 * instead would under-claim and leave the challan pending forever.
 */
export const claimsFromItems = (items) => {
  const groups = new Map();

  for (const item of items || []) {
    const ref = challanRef(item);
    if (!ref) continue;
    const want = qty(item?.quantity);
    if (want <= 0) continue;

    const key = challanKey(ref.challanType, ref.challanNo);
    if (!groups.has(key)) {
      groups.set(key, {
        challanNo: ref.challanNo,
        challanType: ref.challanType,
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
 * Lines only in `before` come back negative (released), lines only in `after`
 * positive (claimed), and a changed quantity comes back as the difference.
 * Entries that net to zero are dropped, so an edit that did not touch any
 * challan produces no work at all.
 */
export const netClaims = (beforeItems, afterItems) => {
  const signed = new Map();

  const walk = (items, sign) => {
    for (const group of claimsFromItems(items)) {
      const key = challanKey(group.challanType, group.challanNo);
      if (!signed.has(key)) {
        signed.set(key, {
          challanNo: group.challanNo,
          challanType: group.challanType,
          byLine: new Map(),
        });
      }
      const byLine = signed.get(key).byLine;
      for (const [id, want] of group.byLine) {
        byLine.set(id, roundQty((byLine.get(id) || 0) + sign * want));
      }
    }
  };

  walk(beforeItems, -1);
  walk(afterItems, 1);

  const out = [];
  for (const group of signed.values()) {
    const byLine = new Map();
    for (const [id, delta] of group.byLine) {
      if (Math.abs(delta) > QTY_EPSILON) byLine.set(id, delta);
    }
    if (byLine.size) out.push({ ...group, byLine });
  }
  return out;
};

/* ─────────────────── challan -> invoice, Sigfa's Alt+H ───────────────── */

/**
 * The pending lines of a challan, shaped for the billing form.
 *
 * `cost` rather than `rate`, matching the invoice item schema, so a line can
 * be handed to the form untranslated -- and Sigfa's own option says the same:
 * `1 Pick Item From Challan [GetChallan], Get Rate As Defined In Setup`. The
 * rate comes off the challan and may be edited on the bill, which is the
 * normal case: the challan went out before the rate was settled.
 */
export const toInvoiceLines = (challan) =>
  pendingLines(challan).map((line) => ({
    name: line.name,
    description: line.description || "",
    hsn: line.hsn || "",
    quantity: line.pending,
    cost: num(line.cost),
    discount: num(line.discount),
    // Carried so save-invoice can settle the challan line this came from.
    challanNo: Number(challan?.challanNo),
    challanType: text(challan?.type),
    challanLineId: lineId(line),
    challanDate: challan?.date || null,
  }));

/**
 * Why these challans cannot be billed together, or null when they can.
 *
 * Sigfa's own refusal is `Please Select Challans With Same Effect Value !` --
 * one invoice, one party and one tax treatment. Billing a customer's challan
 * together with a supplier's, or two customers' together, would produce an
 * invoice that cannot be addressed to anybody.
 */
export const mixedSelectionReason = (challans = []) => {
  const live = (challans || []).filter(Boolean);
  if (!live.length) return "Pick at least one challan.";

  const types = new Set(live.map((c) => text(c?.type)));
  if (types.size > 1) {
    return "Those are a sales challan and a purchase challan. Bill them separately.";
  }

  const parties = new Set(live.map((c) => text(c?.customer?.name).toLowerCase()).filter(Boolean));
  if (parties.size > 1) {
    return "Those challans are for different parties. One invoice goes to one party.";
  }

  const open = live.filter((c) => isOpenChallan(c));
  if (!open.length) return "Every challan picked has already been billed.";

  return null;
};

/**
 * Sigfa's `Received Qty. Is More Than Challan Qty. !`, as a check.
 *
 * Returns null when the quantity may be billed. The authoritative refusal is
 * `applyDeltas`, which the save path runs inside the transaction; this is the
 * same rule stated early so the screen can say it before anybody saves.
 */
export const overBilledReason = (line, wanted) => {
  const want = qty(wanted);
  const left = pendingQty(line);
  if (want <= left + QTY_EPSILON) return null;
  return `Received Qty. is more than challan qty: ${trim(want)} against ${trim(left)} still to bill.`;
};

/* ─────────────────── what the printed bill says ──────────────────────── */

/**
 * Every challan an invoice was raised against, from its LINES.
 *
 * Deduplicated and sorted, and it falls back to the header's own
 * `challanNo` / `challanDate` pair -- which is the OTHER party's challan
 * reference, typed into the dispatch block the way `grNo` and `orderNo` are.
 * Sigfa keeps both too: `SALPUR.CHALLAN` is a memo typed by hand while
 * `Salpur1.CHALLAN` is the link to a challan document in the same book.
 * Without the fallback, adding this feature would blank the "Challan No" line
 * on every historical bill that had one typed in.
 */
export const printableChallanRefs = (invoice) => {
  const seen = new Map();

  for (const line of (invoice?.items || []).filter(Boolean)) {
    const no = Number(line.challanNo);
    if (!Number.isFinite(no) || no <= 0) continue;
    const key = challanKey(text(line.challanType), no);
    if (!seen.has(key)) {
      seen.set(key, {
        challanNo: no,
        challanType: text(line.challanType),
        date: line.challanDate || null,
      });
    } else if (!seen.get(key).date && line.challanDate) {
      seen.get(key).date = line.challanDate;
    }
  }

  if (seen.size) {
    return [...seen.values()].sort(
      (a, b) => a.challanNo - b.challanNo || a.challanType.localeCompare(b.challanType)
    );
  }

  const typed = text(invoice?.challanNo);
  if (typed) {
    return [{ challanNo: typed, challanType: "", date: invoice?.challanDate || null }];
  }
  return [];
};

/** Sigfa heads this `CHALLAN NO.`; plural when a bill covers several. */
export const challanRefsLabel = (refs) =>
  (refs || []).length > 1 ? "Challan Nos" : "Challan No";

/**
 * "7 (01/10/2026), 12 (05/10/2026)".
 *
 * `formatDate` is passed in rather than chosen here, so the bill keeps the
 * same en-IN formatting as every other date on it and this stays pure.
 */
export const challanRefsText = (refs, formatDate) =>
  (refs || [])
    .map((ref) => {
      const when = ref?.date && typeof formatDate === "function" ? formatDate(ref.date) : "";
      return when ? `${ref.challanNo} (${when})` : String(ref?.challanNo ?? "");
    })
    .filter(Boolean)
    .join(", ");

/* ──────────────────── the Pending Challan Book ───────────────────────── */

/**
 * Sigfa's `Pending Challan Book`, whose scope line reads:
 *
 *     SALES PENDING CHALLAN : PURCHASE PENDING CHALLAN :
 *     DEBIT NOTE PENDING SALES CHALLAN :
 *
 * The third is its excise-era job-work case (a debit note raised against a
 * sales challan that never came back). This app keeps the first two and
 * reports the job-work flag as a column instead.
 */
export const PENDING_SCOPES = ["sale", "purchase"];

export const PENDING_SCOPE_LABELS = {
  sale: "Sales pending challan",
  purchase: "Purchase pending challan",
};

export const isPendingScope = (scope) => PENDING_SCOPES.includes(text(scope));

/** The type a scope asks about. */
export const scopeType = (scope) => (text(scope) === "purchase" ? "Purchase" : "Sale");

/**
 * One row per pending challan line, oldest first.
 *
 * LINE level, not document level, because the question the book answers is
 * "what has gone out that we have not billed" -- and a challan half billed
 * has some lines that matter and some that do not. Sigfa's own book is per
 * line too (`select sum(qty),cbrcode,challan,ChRefNo,Mkey,COpng`).
 */
export const pendingBook = ({ challans = [], scope = "sale" } = {}) => {
  const wanted = scopeType(scope);
  const rows = [];

  for (const challan of (challans || []).filter(Boolean)) {
    if (text(challan?.type) !== wanted) continue;
    for (const line of pendingLines(challan)) {
      rows.push({
        challanNo: Number(challan.challanNo),
        challanType: text(challan.type),
        date: challan.date || null,
        party: text(challan?.customer?.name),
        jobWork: challan?.jobWork === true,
        item: text(line.name),
        hsn: text(line.hsn),
        challaned: challanedQty(line),
        invoiced: invoicedQty(line),
        cancelled: cancelledQty(line),
        pending: line.pending,
        cost: num(line.cost),
        value: lineTotal({ ...line, quantity: line.pending }),
        status: lineStatus(line),
      });
    }
  }

  return rows.sort(
    (a, b) =>
      new Date(a.date || 0) - new Date(b.date || 0) ||
      a.challanNo - b.challanNo ||
      a.item.localeCompare(b.item)
  );
};

export const pendingBookTotals = (rows = []) => ({
  lines: rows.length,
  challans: new Set(rows.map((r) => challanKey(r.challanType, r.challanNo))).size,
  parties: new Set(rows.map((r) => text(r.party).toLowerCase()).filter(Boolean)).size,
  challaned: roundQty(rows.reduce((t, r) => t + num(r.challaned), 0)),
  invoiced: roundQty(rows.reduce((t, r) => t + num(r.invoiced), 0)),
  pending: roundQty(rows.reduce((t, r) => t + num(r.pending), 0)),
  value: Math.round(rows.reduce((t, r) => t + num(r.value), 0) * 100) / 100,
});

/** Sigfa's own column names on this book, as far as it prints them. */
export const PENDING_COLUMNS = [
  { key: "date", label: "Challan Date", type: "date", width: 12 },
  { key: "challanNo", label: "Challan No.", type: "int", width: 11 },
  { key: "party", label: "Party Name", type: "text", width: 26 },
  { key: "item", label: "Item Name", type: "text", width: 30 },
  { key: "challaned", label: "Challan Qty.", type: "qty", width: 13 },
  { key: "invoiced", label: "Invoiced Qty.", type: "qty", width: 13 },
  { key: "pending", label: "Pending Qty.", type: "qty", width: 13 },
  { key: "cost", label: "Rate", type: "money", width: 11 },
  { key: "value", label: "Pending Value", type: "money", width: 14 },
];

/* ───────────────────────────── the header ────────────────────────────── */

/**
 * Why this challan cannot be saved, in words. Null when it can.
 *
 * Deliberately short: a challan has no tax, no totals to reconcile and no
 * payment, so almost nothing can be wrong with one that is not wrong with the
 * party or an item. What IS checked is the thing Sigfa checks -- a line with
 * no quantity is not a delivery.
 */
export const challanProblem = (challan) => {
  if (!isChallanType(challan?.type)) return "Pick a sales or a purchase challan.";
  if (!text(challan?.customer?.name)) {
    return `Pick the ${challanKind(challan.type).party.toLowerCase()} this challan is for.`;
  }
  if (!challan?.date) return "Give the challan a date.";

  const lines = (challan?.items || []).filter(Boolean);
  if (!lines.length) return "A challan with no items is not a delivery.";

  for (const line of lines) {
    if (!text(line?.name)) return "Every line needs an item.";
    if (challanedQty(line) <= 0) return `${text(line.name)}: give the quantity going out.`;
  }

  return null;
};

/**
 * The line a challan register shows under each row.
 *
 * "3 of 5 lines billed · 120 KGS still to bill", or the plain state when
 * nothing has been billed yet -- a register row that says "open" and nothing
 * else makes somebody open the document to find out how much is left.
 */
export const challanSubtext = (challan) => {
  const lines = (challan?.items || []).filter(Boolean);
  if (!lines.length) return "No items yet";

  const billed = lines.filter((l) => invoicedQty(l) > QTY_EPSILON).length;
  const left = roundQty(lines.reduce((t, l) => t + pendingQty(l), 0));
  const status = challanStatus(challan);

  if (status === "cancelled") return "Cancelled";
  if (status === "closed") return `Fully billed · ${lines.length} line${lines.length === 1 ? "" : "s"}`;
  const head = billed
    ? `${billed} of ${lines.length} line${lines.length === 1 ? "" : "s"} billed`
    : `${lines.length} line${lines.length === 1 ? "" : "s"}, none billed`;
  return left > QTY_EPSILON ? `${head} · ${trim(left)} still to bill` : head;
};
