/**
 * The inventory reports: stock summary, movement history, valuation.
 *
 * Pure and dependency-free, like the rest of lib/*.mjs, so `node` can run
 * scripts/inventory-reports.test.mjs directly. Never import Mongoose in here.
 *
 *
 * ONE STOCK FIGURE, EVERYWHERE
 * ----------------------------
 * Stock is the item's opening quantity plus every receipt minus every issue,
 * SUMMED from the stock ledger -- lib/itemStock.mjs's `buildStockIndex`, the
 * function the dashboard, the billing screens and the financial statements
 * already use. Every figure here goes through it, so this report cannot
 * disagree with them. The ledger's stored `balanceQuantity` is never read:
 * it is a cache, and the movement history computes its own running quantity
 * in date order instead.
 *
 *
 * THE COSTING METHOD, AND WHY IT IS THIS ONE
 * ------------------------------------------
 * Valuation is QUANTITY x THE ITEM MASTER'S `cost` -- a standard cost, the
 * method lib/financials.mjs's `stockValue` already uses for the closing stock
 * in the trading account and the balance sheet. It is used here so the
 * valuation report and the balance sheet show the same number.
 *
 * It is NOT FIFO and NOT weighted average, and those were not assumed:
 * neither can be computed reliably from what is stored. A stock ledger row
 * carries a quantity and no cost; opening stock has no historical cost;
 * a Goods Received slip and a production output carry no cost at all. Only
 * purchase invoice lines have a rate. A perpetual weighted average or a FIFO
 * layer needs a cost on EVERY receipt, which means a cost field on the stock
 * ledger and a backfill -- a migration, and one that would have to invent
 * costs for the rows that never had one. So: standard cost, stated on the
 * report, with every item that has stock and no cost listed by name rather
 * than valued at zero.
 */

import { round2 } from "./balance.mjs";
import { buildStockIndex } from "./itemStock.mjs";
import { istDayNumber } from "./istDate.mjs";
import { stockValue } from "./financials.mjs";
import { stockReason, STOCK_REASON_LABELS } from "./dashboard.mjs";

const text = (value) => String(value ?? "").trim();
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
// Stock is keyed by the EXACT (trimmed) name, as lib/itemStock.mjs keys it
// and as the ledger is joined -- so "Widget" and "widget" are two lines here
// exactly as they are on the dashboard and in the valuation. Lower-casing
// the key would merge them in one view and not the others, and the merge
// replaced one figure with the other rather than adding them.
const key = (name) => text(name);
const loose = (name) => text(name).toLowerCase();

export const COSTING_METHOD =
  "Standard cost: quantity x the cost in the item master -- the same basis as the closing stock in the financial statements. Not FIFO or weighted average: stock movements carry no cost.";

/** Quantities, to three places -- kilos and metres. */
export const roundQty = (n) => Math.round(num(n) * 1000) / 1000;

/* ───────────────────────────── movement types ─────────────────────────── */

/**
 * What a stock ledger row IS.
 *
 * The ledger stores `typeOfVoucher` as the invoice's type -- "Sale" or
 * "Purchase" -- for returns too, so a sale return reads "Sale". The
 * direction settles it: a sale that brings stock IN is a return. Stock
 * vouchers are told apart by their key's prefix (lib/stockVoucher.mjs).
 */
export const MOVEMENT_TYPES = {
  sale: "Sale",
  "sale-return": "Sale return",
  purchase: "Purchase",
  "purchase-return": "Purchase return",
  production: "Production",
  "goods-issued": "Goods issued",
  "goods-received": "Goods received",
  other: "Other",
};
export const MOVEMENT_TYPE_KEYS = Object.keys(MOVEMENT_TYPES);

export const movementType = (row) => {
  const ref = text(row?.invoiceNo);
  if (ref.startsWith("PRD-")) return "production";
  if (ref.startsWith("GI-")) return "goods-issued";
  if (ref.startsWith("GR-")) return "goods-received";
  const inward = num(row?.receiptQuantity) > 0;
  const voucher = text(row?.typeOfVoucher).toLowerCase();
  if (voucher === "sale") return inward ? "sale-return" : "sale";
  if (voucher === "purchase") return inward ? "purchase" : "purchase-return";
  return "other";
};

/* ───────────────────────────── shared pieces ─────────────────────────── */

/**
 * The item master, for an item's unit, HSN, minimum and cost: by exact name,
 * then by a case-insensitive match -- the same fallback `stockOf` uses, so a
 * ledger row whose name drifted in case still finds its master's details.
 */
const masterIndex = (items = []) => {
  const exact = new Map();
  const relaxed = new Map();
  for (const item of items) {
    if (!text(item?.name)) continue;
    exact.set(key(item.name), item);
    if (!relaxed.has(loose(item.name))) relaxed.set(loose(item.name), item);
  }
  return { get: (name) => exact.get(key(name)) || relaxed.get(loose(name)) };
};

/** Stock per item from a master and an aggregation, as a Map by name. */
const quantities = (items, movements) =>
  new Map(buildStockIndex({ items, movements }).map((e) => [key(e.name), e]));

/** Is this ledger row on or between two IST days? Blank bounds are open. */
export const inWindow = (date, from, to) => {
  const day = istDayNumber(date);
  if (day === null) return false;
  if (text(from) && day < istDayNumber(from)) return false;
  if (text(to) && day > istDayNumber(to)) return false;
  return true;
};

const matches = (value, q) => !text(q) || loose(value).includes(loose(q));

/* ═════════════════════════════ stock summary ═══════════════════════════ */

export const SUMMARY_STATUSES = ["all", "low", "negative", "out", "below", "in-stock"];

/**
 * One row per item: stock at the start of the period, what came in and went
 * out during it, and stock at the end.
 *
 *   before  movements dated BEFORE `from`, aggregated per item
 *           ({ _id: itemName, received, issued }) -- they fold into opening
 *   inside  movements dated from..to, aggregated the same way
 *
 * Opening is the master's opening quantity plus `before`, which is the rule
 * the stock ledger page settled on: starting a filtered period from the
 * master's opening quantity alone made every date-filtered report wrong.
 * An item with no master (deleted, or renamed outside the app) still
 * appears, from zero, rather than vanishing.
 */
export const stockSummaryRows = ({ items = [], before = [], inside = [], q = "", status = "all" } = {}) => {
  const master = masterIndex(items);
  const inMaster = new Set(items.map((i) => key(i?.name)).filter(Boolean));
  const opening = quantities(items, before);
  const moved = new Map();
  for (const m of inside) {
    const name = text(m?.itemName ?? m?._id);
    if (!name) continue;
    const prior = moved.get(key(name)) || { name, received: 0, issued: 0 };
    prior.received += num(m?.received);
    prior.issued += num(m?.issued);
    moved.set(key(name), prior);
  }

  const names = new Map();
  for (const [k, e] of opening) names.set(k, e.name);
  for (const [k, m] of moved) if (!names.has(k)) names.set(k, m.name);

  const rows = [...names.entries()].map(([k, name]) => {
    // Only an exact match carries the master's opening into this line (it
    // already did, in `quantities`); the relaxed match only lends details.
    const item = master.get(name);
    const open = roundQty(opening.get(k)?.quantity ?? 0);
    const received = roundQty(moved.get(k)?.received ?? 0);
    const issued = roundQty(moved.get(k)?.issued ?? 0);
    const closing = roundQty(open + received - issued);
    const minimum =
      item?.minQuantity === null || item?.minQuantity === undefined ? null : num(item.minQuantity);
    // A service holds no stock, so it is never "low" -- see lib/stockAlerts.mjs.
    const reason = item?.isService ? null : stockReason(closing, minimum);
    return {
      name,
      unit: text(item?.unit) || text(opening.get(k)?.unit),
      hsn: text(item?.hsn),
      group: text(item?.group),
      isService: Boolean(item?.isService),
      inMaster: inMaster.has(k),
      opening: open,
      received,
      issued,
      closing,
      minimum,
      status: reason || "ok",
      statusLabel: reason ? STOCK_REASON_LABELS[reason] : "",
    };
  });

  const wanted = SUMMARY_STATUSES.includes(text(status)) ? text(status) : "all";
  return rows
    .filter((r) => matches(r.name, q) || matches(r.hsn, q) || matches(r.group, q))
    .filter((r) => {
      if (wanted === "all") return true;
      if (wanted === "low") return r.status !== "ok";
      if (wanted === "in-stock") return r.closing > 0;
      return r.status === wanted;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
};

/** Counts above the summary -- quantities in mixed units are not added up. */
export const stockSummaryTotals = (rows = []) => ({
  items: rows.length,
  low: rows.filter((r) => r.status !== "ok").length,
  negative: rows.filter((r) => r.status === "negative").length,
  out: rows.filter((r) => r.status === "out").length,
  below: rows.filter((r) => r.status === "below").length,
});

/* ═════════════════════════════ movement history ═════════════════════════ */

/**
 * Every movement in the period, oldest first, with the running quantity.
 *
 *   before  movements before `from`, aggregated per item (the opening)
 *   rows    the ledger rows dated from..to, as stored
 *
 * The running quantity is computed over EVERY movement of the item in date
 * order (ties broken by `_id`, the order recomputeItemBalances uses), and
 * only THEN are the type, reference and search filters applied -- so a
 * filtered list still shows the true stock after each line it does show,
 * rather than a running total of only the lines that happened to match.
 */
export const movementRows = ({ items = [], before = [], rows = [], from = "", to = "", type = "", ref = "", q = "" } = {}) => {
  const master = masterIndex(items);
  const opening = quantities(items, before);
  const running = new Map();

  const ordered = rows
    .filter((r) => text(r?.itemName) && inWindow(r?.date, from, to))
    .slice()
    .sort((a, b) => {
      const da = new Date(a.date).getTime();
      const db = new Date(b.date).getTime();
      return da - db || String(a._id ?? "").localeCompare(String(b._id ?? ""));
    });

  const out = [];
  for (const r of ordered) {
    const k = key(r.itemName);
    const start = running.has(k) ? running.get(k) : num(opening.get(k)?.quantity);
    const received = roundQty(r.receiptQuantity);
    const issued = roundQty(r.issueQuantity);
    const after = roundQty(start + received - issued);
    running.set(k, after);
    const kind = movementType(r);
    out.push({
      id: text(r._id),
      date: r.date,
      itemName: text(r.itemName),
      unit: text(master.get(r.itemName)?.unit),
      type: kind,
      typeLabel: MOVEMENT_TYPES[kind],
      ref: text(r.invoiceNo),
      party: text(r.partyName),
      received,
      issued,
      running: after,
    });
  }

  const wantType = MOVEMENT_TYPE_KEYS.includes(text(type)) ? text(type) : "";
  return out.filter(
    (r) =>
      (!wantType || r.type === wantType) &&
      (!text(ref) || loose(r.ref).includes(loose(ref))) &&
      (!text(q) || matches(r.itemName, q) || matches(r.party, q) || matches(r.ref, q))
  );
};

/** Totals under the movement list: the quantities of the rows shown. */
export const movementTotals = (rows = []) => ({
  movements: rows.length,
  received: roundQty(rows.reduce((t, r) => t + num(r.received), 0)),
  issued: roundQty(rows.reduce((t, r) => t + num(r.issued), 0)),
});

/* ═════════════════════════════════ valuation ═════════════════════════════ */

/**
 * Stock as at a date, valued at standard cost -- see COSTING_METHOD above.
 *
 * `movements` is every movement up to and including `asAt`, aggregated per
 * item. The rows follow `stockValue`'s own rules exactly: an item with no
 * stock is not listed; an item with stock and no positive cost is listed with
 * no value and counted as missing; negative stock is valued negative, as the
 * balance sheet values it. The TOTAL is `stockValue`'s own figure, so this
 * report and the closing stock in the financial statements are one number.
 */
export const valuationRows = ({ items = [], movements = [], q = "" } = {}) => {
  const stock = buildStockIndex({ items, movements });
  const master = masterIndex(items);
  const rows = [];
  for (const entry of stock) {
    const name = text(entry?.name);
    const quantity = roundQty(entry?.quantity);
    if (!name || num(entry?.quantity) === 0) continue;
    // stockValue looks the cost up case-insensitively, and so does this --
    // the two must value the same line the same way.
    const item = master.get(name);
    const cost = num(item?.cost);
    const priced = cost > 0;
    rows.push({
      name,
      unit: text(entry?.unit) || text(item?.unit),
      hsn: text(item?.hsn),
      group: text(item?.group),
      quantity,
      cost: priced ? cost : null,
      value: priced ? round2(num(entry.quantity) * cost) : null,
      note: !priced ? "No cost in the item master" : quantity < 0 ? "Negative stock" : "",
    });
  }
  const valuation = stockValue({ stock, items });
  const shown = rows
    .filter((r) => matches(r.name, q) || matches(r.hsn, q) || matches(r.group, q))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    rows: shown,
    totals: {
      // The whole book's value, exactly as the balance sheet carries it --
      // a search narrows the rows, not the closing stock.
      value: valuation.value,
      valued: valuation.valued,
      held: valuation.held,
      missingCosts: valuation.missingCosts,
      // And the rows on screen, for the totals line under a filtered list.
      shownValue: round2(shown.reduce((t, r) => t + num(r.value), 0)),
    },
  };
};

/* ═════════════════════════════ export sheets ═════════════════════════════ */

const dmy = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text(iso));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : text(iso);
};

/** The sheets each view downloads as -- lib/reportHttp.js's contract. */
export const inventorySheets = ({ view, rows = [], totals = {}, from = "", to = "", filters = {}, company = null } = {}) => {
  const meta = [
    { label: "Firm", value: text(company?.name) },
    { label: "GSTIN", value: text(company?.gstin) },
    ...(view === "valuation"
      ? [{ label: "As at", value: dmy(to) || "today" }, { label: "Costing method", value: COSTING_METHOD }]
      : [{ label: "Period", value: `${dmy(from) || "start"} to ${dmy(to) || "today"}` }]),
    ...Object.entries(filters)
      .filter(([, v]) => text(v))
      .map(([label, value]) => ({ label, value: text(value) })),
  ].filter((m) => text(m.value));

  if (view === "movements") {
    return [
      {
        name: "Stock movements",
        title: "Stock movements",
        meta,
        columns: [
          { key: "date", label: "Date", type: "date", width: 12 },
          { key: "itemName", label: "Item", width: 28 },
          { key: "typeLabel", label: "Type", width: 16 },
          { key: "ref", label: "Document", width: 12 },
          { key: "party", label: "Party", width: 26 },
          { key: "received", label: "In", type: "qty", width: 11 },
          { key: "issued", label: "Out", type: "qty", width: 11 },
          { key: "running", label: "Running qty", type: "qty", width: 12 },
          { key: "unit", label: "Unit", width: 8 },
        ],
        rows,
        // Quantity totals here are for one item or one unit at a time; the
        // screen shows them, so the file does too.
        totals: { received: totals.received ?? 0, issued: totals.issued ?? 0 },
      },
    ];
  }

  if (view === "valuation") {
    return [
      {
        name: "Stock valuation",
        title: "Stock valuation",
        meta: [
          ...meta,
          { label: "Items valued", value: `${num(totals.valued)} of ${num(totals.held)} holding stock` },
          ...(totals.missingCosts?.length ? [{ label: "No cost for", value: totals.missingCosts.join(", ") }] : []),
        ],
        columns: [
          { key: "name", label: "Item", width: 30 },
          { key: "hsn", label: "HSN", width: 10 },
          { key: "unit", label: "Unit", width: 8 },
          { key: "quantity", label: "Quantity", type: "qty", width: 12 },
          { key: "cost", label: "Cost", type: "money", width: 12 },
          { key: "value", label: "Value", type: "money", width: 15 },
          { key: "note", label: "Note", width: 28 },
        ],
        rows,
        totals: { value: totals.shownValue ?? totals.value ?? 0 },
      },
    ];
  }

  return [
    {
      name: "Stock summary",
      title: "Stock summary",
      meta,
      columns: [
        { key: "name", label: "Item", width: 30 },
        { key: "hsn", label: "HSN", width: 10 },
        { key: "unit", label: "Unit", width: 8 },
        { key: "opening", label: "Opening", type: "qty", width: 12 },
        { key: "received", label: "In", type: "qty", width: 12 },
        { key: "issued", label: "Out", type: "qty", width: 12 },
        { key: "closing", label: "Closing", type: "qty", width: 12 },
        { key: "minimum", label: "Minimum", type: "qty", width: 10 },
        { key: "statusLabel", label: "Status", width: 16 },
      ],
      rows,
      totals: null,
    },
  ];
};
