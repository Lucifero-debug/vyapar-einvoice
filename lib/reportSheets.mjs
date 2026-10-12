/**
 * The worksheets the sales book, the GST returns and the financial
 * statements download as.
 *
 * Pure and dependency-free, like the rest of lib/*.mjs, so `node` can run
 * scripts/report-sheets.test.mjs directly. Never import Mongoose in here.
 *
 *
 * THE SAME CONTRACT AS THE STATEMENT AND THE ACCOUNT BOOKS
 * -------------------------------------------------------
 * Each builder returns the `sheets` array lib/reportHttp.js turns into a CSV
 * (the first sheet) or an .xlsx (every sheet) -- `{ name, title, meta,
 * columns, rows, totals, totalsLabel }`, exactly what `statementSheets` in
 * lib/statements.mjs returns. Columns carry a `type` (text, date, money, qty,
 * int) so lib/xlsx.mjs writes figures as figures.
 *
 * NOTHING IS RECOMPUTED HERE. Every row and every total is the object the
 * report's own route already built for the screen -- `periodWise`,
 * `gstr1Sheet`, `trialBalance` and the rest -- so the download is the visible
 * report by construction. This module only lays those objects out as tables.
 * A figure that is wrong in a download is wrong on the screen too, and is
 * fixed in the module that computed it, not here.
 *
 * SIGNS are kept as the report computes them: the sales book shows a return
 * at face value with its own "Document" column and subtracts it in the
 * totals, exactly as the screen does; the period sheets carry signed monthly
 * figures; the financial statements carry each side's amounts as the
 * horizontal form prints them.
 */

import { CSV_COLUMNS, reportName } from "./salesReports.mjs";
import { returnTitle } from "./gstReturns.mjs";
import { STATEMENT_KINDS, STATEMENT_TITLES } from "./financials.mjs";

const text = (value) => String(value ?? "").trim();

/** "2026-10-12" -> "12-10-2026", the way every printed date in this app reads. */
export const displayDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text(iso));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : text(iso);
};

/** The period line: "01-04-2026 to 30-06-2026", or what there is of it. */
export const periodLine = (from, to) => {
  if (!text(from) && !text(to)) return "All dates";
  return `${displayDate(from) || "start"} to ${displayDate(to) || "today"}`;
};

/**
 * The portal's `dd-mm-yyyy` as an ISO instant at IST midnight, so lib/xlsx.mjs
 * writes it as a real date on the same calendar day. A string it cannot read
 * is passed through and written as text rather than as a wrong date.
 */
export const portalToIso = (value) => {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(text(value));
  return m ? `${m[3]}-${m[2]}-${m[1]}T00:00:00+05:30` : text(value);
};

/** The firm block every sheet opens with -- the statement's own first rows. */
export const firmMeta = ({ company, companyAddressLine = "" } = {}) =>
  [
    { label: "Firm", value: text(company?.name) },
    { label: "Address", value: text(companyAddressLine) },
    { label: "GSTIN", value: text(company?.gstin) },
  ].filter((m) => text(m.value));

const withTypes = (columns, types) =>
  columns.map((c) => ({ ...c, type: types[c.key] || "text", width: WIDTHS[c.key] || 14 }));

const WIDTHS = {
  label: 14,
  date: 12,
  invoiceNo: 11,
  party: 28,
  gstin: 17,
  state: 16,
  kind: 10,
  item: 28,
  hsn: 10,
  unit: 8,
};

/* ═════════════════════════════ the sales book ═══════════════════════════ */

const SALES_TYPES = {
  label: "text",
  date: "date",
  invoiceNo: "int",
  party: "text",
  gstin: "text",
  state: "text",
  kind: "text",
  documents: "int",
  returns: "int",
  taxable: "money",
  gst: "money",
  net: "money",
  others: "money",
  total: "money",
  received: "money",
  balanceDue: "money",
  item: "text",
  hsn: "text",
  unit: "text",
  quantity: "qty",
  rate: "money",
};

const GRAIN_WORDS = { month: "Month wise", date: "Date wise", document: "Bill wise" };

/**
 * Which column set a sales sheet uses -- the same choice the page makes
 * (`csvView` in app/sales-report/page.js): the period columns for the month
 * and date grains, the bill columns for the register, and the party and item
 * sheets as they are.
 */
export const salesSheetKind = ({ view, grain } = {}) => {
  if (text(view) === "book") return text(grain) === "document" ? "book" : "period";
  return text(view) === "item" ? "item" : "party";
};

/**
 * The sales or purchase book, party-wise or item-wise, as one worksheet.
 *
 * `rows` and `totals` are the route's own -- the same JSON the screen draws.
 * The columns are lib/salesReports.mjs's CSV_COLUMNS, the list the screen
 * reads its own headings off, so the browser CSV, the workbook and the
 * printed sheet cannot disagree about what a column is called. The period
 * sheet's first column is "Date" at the date grain, as on screen.
 */
export const salesReportSheets = ({
  view = "book",
  side = "Sale",
  grain = "month",
  month = "",
  rows = [],
  totals = null,
  covers = "",
  from = "",
  to = "",
  company = null,
  companyAddressLine = "",
} = {}) => {
  const kind = salesSheetKind({ view, grain });
  let columns = withTypes(CSV_COLUMNS[kind] || [], SALES_TYPES);
  if (kind === "period" && text(grain) === "date") {
    columns = columns.map((c, i) => (i === 0 ? { ...c, label: "Date" } : c));
  }

  const meta = [
    ...firmMeta({ company, companyAddressLine }),
    { label: "Period", value: periodLine(from, to) },
    { label: "Covering", value: text(covers) },
    ...(text(view) === "book" ? [{ label: "Grouped by", value: GRAIN_WORDS[text(grain)] || "" }] : []),
    ...(text(month) ? [{ label: "Month", value: text(month) }] : []),
    ...(kind === "book"
      ? [
          {
            label: "Bills",
            value: totals
              ? `${n(totals.documents)}${n(totals.returns) ? `, ${n(totals.returns)} of them returns` : ""}`
              : "",
          },
          { label: "Note", value: "Returns are listed at face value and subtracted in the totals." },
        ]
      : []),
  ].filter((m) => text(m.value));

  return [
    {
      name: reportName(view, side),
      title: reportName(view, side),
      meta,
      columns,
      rows: Array.isArray(rows) ? rows : [],
      // Only the figures the route totalled -- lib/xlsx.mjs leaves every other
      // column of the totals row empty rather than inventing one.
      totals: totals || null,
      totalsLabel: "Total",
    },
  ];
};

/* ═════════════════════════════ the GST returns ══════════════════════════ */

const money = (key, label) => ({ key, label, type: "money", width: 14 });
const rate = { key: "rate", label: "Rate %", type: "qty", width: 8 };

/** The column sets of the GSTR-1 tables, as the screen shows each one. */
export const GSTR1_COLUMNS = {
  B2B: [
    { key: "ctin", label: "GSTIN", width: 17 },
    { key: "party", label: "Party", width: 28 },
    { key: "number", label: "Invoice No", type: "int", width: 11 },
    { key: "date", label: "Date", type: "date", width: 12 },
    { key: "pos", label: "POS", width: 6 },
    rate,
    money("txval", "Taxable"),
    money("iamt", "IGST"),
    money("camt", "CGST"),
    money("samt", "SGST"),
    money("val", "Value"),
  ],
  B2CL: [
    { key: "pos", label: "POS", width: 6 },
    { key: "number", label: "Invoice No", type: "int", width: 11 },
    { key: "date", label: "Date", type: "date", width: 12 },
    rate,
    money("txval", "Taxable"),
    money("iamt", "IGST"),
    money("val", "Value"),
  ],
  B2CS: [
    { key: "sply_ty", label: "Supply", width: 8 },
    { key: "pos", label: "POS", width: 6 },
    rate,
    money("txval", "Taxable"),
    money("iamt", "IGST"),
    money("camt", "CGST"),
    money("samt", "SGST"),
  ],
  CDNR: [
    { key: "ctin", label: "GSTIN", width: 17 },
    { key: "party", label: "Party", width: 28 },
    { key: "number", label: "Note No", type: "int", width: 11 },
    { key: "date", label: "Date", type: "date", width: 12 },
    { key: "pos", label: "POS", width: 6 },
    rate,
    money("txval", "Taxable"),
    money("iamt", "IGST"),
    money("camt", "CGST"),
    money("samt", "SGST"),
    money("val", "Value"),
  ],
  CDNUR: [
    { key: "typ", label: "Type", width: 8 },
    { key: "number", label: "Note No", type: "int", width: 11 },
    { key: "date", label: "Date", type: "date", width: 12 },
    { key: "pos", label: "POS", width: 6 },
    rate,
    money("txval", "Taxable"),
    money("tax", "Tax"),
    money("val", "Value"),
  ],
  HSN: [
    { key: "num", label: "#", type: "int", width: 5 },
    { key: "hsn_sc", label: "HSN", width: 10 },
    { key: "desc", label: "Description", width: 28 },
    { key: "uqc", label: "UQC", width: 7 },
    rate,
    { key: "qty", label: "Quantity", type: "qty", width: 11 },
    money("txval", "Taxable"),
    money("iamt", "IGST"),
    money("camt", "CGST"),
    money("samt", "SGST"),
    money("val", "Value"),
  ],
  DOCS: [
    { key: "doc_typ", label: "Nature of document", width: 30 },
    { key: "from", label: "From", type: "int", width: 10 },
    { key: "to", label: "To", type: "int", width: 10 },
    { key: "totnum", label: "Total", type: "int", width: 9 },
    { key: "cancel", label: "Cancelled", type: "int", width: 10 },
    { key: "net_issue", label: "Net issued", type: "int", width: 11 },
  ],
};

const n = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const round2 = (value) => Math.round(n(value) * 100) / 100;

/**
 * One table's rows, flattened to one row per rate line -- the screen's rows.
 *
 * The document's own identifiers (GSTIN, party, number, date, place) repeat
 * on every line so a filtered spreadsheet still says which bill a line is.
 * Its VALUE does not: it sits on the document's first line only, exactly as
 * on screen, so summing the column gives the documents' value once each.
 */
export const gstr1TableRows = (tag, rows = []) => {
  const docLines = (doc, extra) =>
    (doc?.itms || []).map((item, i) => ({
      ...extra,
      number: n(doc.inum ?? doc.nt_num),
      date: portalToIso(doc.idt ?? doc.nt_dt),
      pos: text(doc.pos ?? extra.pos),
      rate: n(item?.itm_det?.rt),
      txval: n(item?.itm_det?.txval),
      iamt: n(item?.itm_det?.iamt),
      camt: n(item?.itm_det?.camt),
      samt: n(item?.itm_det?.samt),
      tax: round2(n(item?.itm_det?.iamt) + n(item?.itm_det?.camt) + n(item?.itm_det?.samt)),
      val: i === 0 ? n(doc.val) : null,
    }));

  switch (tag) {
    case "B2B":
      return rows.flatMap((b) => (b.inv || []).flatMap((doc) => docLines(doc, { ctin: b.ctin, party: b.party })));
    case "CDNR":
      return rows.flatMap((b) => (b.nt || []).flatMap((doc) => docLines(doc, { ctin: b.ctin, party: b.party })));
    case "B2CL":
      return rows.flatMap((b) => (b.inv || []).flatMap((doc) => docLines(doc, { pos: b.pos })));
    case "CDNUR":
      return rows.flatMap((doc) => docLines(doc, { typ: doc.typ }));
    case "B2CS":
      return rows.map((r) => ({ ...r, rate: n(r.rt) }));
    case "HSN":
      return rows.map((r) => ({ ...r, rate: n(r.rt) }));
    case "DOCS":
      return rows.flatMap((det) => (det.docs || []).map((d) => ({ doc_typ: det.doc_typ, ...d })));
    default:
      return [];
  }
};

/**
 * The money columns of a table, summed -- what its totals row shows.
 * Quantities are not totalled: an HSN table mixes units, and 40 KGS plus
 * 12 PCS is not 52 of anything.
 */
export const columnTotals = (columns, rows) => {
  const totals = {};
  for (const c of columns) {
    if (c.type !== "money") continue;
    totals[c.key] = round2(rows.reduce((t, r) => t + n(r?.[c.key]), 0));
  }
  return totals;
};

const SECTION_COLUMNS = [
  { key: "no", label: "Table", width: 8 },
  { key: "label", label: "Particulars", width: 60 },
  { key: "value", label: "Amount", type: "money", width: 16 },
  { key: "note", label: "Note", width: 50 },
];

/**
 * A return, as worksheets.
 *
 * GSTR-1 is ten tables of different shapes, so it is a Summary sheet --
 * every table by its number, with its row count or the field it would need --
 * and then one sheet per table the app can build, in the screen's columns.
 * GSTR-3 and GSTR-3B are label-and-figure tables, so each is one sheet, which
 * is also what makes their CSV meaningful. The tables this app cannot fill
 * are listed with the reason, never silently left out.
 */
export const gstReturnSheets = ({ view = "gstr1", sheet = {}, from = "", to = "", company = null, companyAddressLine = "" } = {}) => {
  const title = returnTitle(view);
  const meta = [
    ...firmMeta({ company, companyAddressLine }),
    { label: "Return", value: title },
    { label: "Tax period", value: text(sheet?.period) },
    { label: "Period", value: periodLine(from, to) },
    { label: "Documents", value: String(n(sheet?.documents)) },
  ].filter((m) => text(m.value));

  const sections = Array.isArray(sheet?.sections) ? sheet.sections : [];

  if (text(view) !== "gstr1") {
    const rows = sections.flatMap((s) =>
      s.filled && !(s.rows || []).length
        ? [{ no: s.no, label: s.title, value: null, note: "Nothing in this period." }]
        : s.filled
        ? (s.rows || []).map((r) => ({
            no: s.no,
            label: r.label,
            value: r.value === null || r.value === undefined ? null : r.value,
            note: r.value === null || r.value === undefined ? text(r.note) : "",
          }))
        : [{ no: s.no, label: s.title, value: null, note: `Not built: needs ${text(s.needs)}.` }]
    );
    return [{ name: title, title, meta, columns: SECTION_COLUMNS, rows, totals: null }];
  }

  const t = sheet?.totals || {};
  const summaryMeta = [
    ...meta,
    { label: "Taxable value (net)", value: Number(n(t.taxable)).toFixed(2) },
    { label: "Invoice value (net)", value: Number(n(t.value)).toFixed(2) },
    { label: "IGST", value: Number(n(t.iamt)).toFixed(2) },
    { label: "CGST", value: Number(n(t.camt)).toFixed(2) },
    { label: "SGST", value: Number(n(t.samt)).toFixed(2) },
    { label: "Total tax", value: Number(n(t.tax)).toFixed(2) },
  ];

  const tables = sections.filter((s) => s.filled && GSTR1_COLUMNS[s.tag]);
  const summary = {
    name: "Summary",
    title,
    meta: summaryMeta,
    columns: [
      { key: "no", label: "Table", width: 8 },
      { key: "title", label: "Title", width: 70 },
      { key: "rows", label: "Rows", type: "int", width: 8 },
      { key: "note", label: "Note", width: 50 },
    ],
    rows: sections.map((s) => ({
      no: s.no,
      title: s.title,
      rows: s.filled && GSTR1_COLUMNS[s.tag] ? gstr1TableRows(s.tag, s.rows || []).length : null,
      note: s.filled ? "" : `Not built: needs ${text(s.needs)}.`,
    })),
    totals: null,
  };

  return [
    summary,
    ...tables.map((s) => {
      const columns = GSTR1_COLUMNS[s.tag];
      const rows = gstr1TableRows(s.tag, s.rows || []);
      return {
        name: `${s.no} ${s.tag}`,
        title: s.title,
        meta,
        columns,
        rows,
        totals: s.tag === "DOCS" ? null : columnTotals(columns, rows),
      };
    }),
  ];
};

/* ═════════════════════════ the financial statements ═════════════════════ */

const TRIAL_COLUMNS = [
  { key: "group", label: "Group", width: 30 },
  { key: "account", label: "Account", width: 32 },
  { key: "level", label: "Row", width: 9 },
  { key: "debit", label: "Debit", type: "money", width: 16 },
  { key: "credit", label: "Credit", type: "money", width: 16 },
];

const hColumns = (leftWord, rightWord) => [
  { key: "leftLabel", label: leftWord, width: 34 },
  // The group the screen prints under each account's name.
  { key: "leftGroup", label: "Group", width: 22 },
  { key: "leftAmount", label: "Amount", type: "money", width: 16 },
  { key: "rightLabel", label: rightWord, width: 34 },
  { key: "rightGroup", label: "Group", width: 22 },
  { key: "rightAmount", label: "Amount", type: "money", width: 16 },
];

/** The group, when the screen would print one (not when it repeats the name). */
const groupOf = (r) => (r?.group && r.group !== r.label ? text(r.group) : "");

const rowLabel = (r) =>
  `${text(r?.label)}${r?.derived ? " (from stock)" : ""}${r?.carried ? " (carried)" : ""}`;

/**
 * A horizontal account -- Dr left, Cr right -- as the screen and the printed
 * form lay it out: the two sides side by side, padded to the longer, with
 * both totals on the totals row. Amounts exactly as each side carries them.
 */
export const horizontalRows = (left = [], right = []) => {
  const length = Math.max(left.length, right.length);
  return Array.from({ length }, (_, i) => ({
    leftLabel: left[i] ? rowLabel(left[i]) : "",
    leftGroup: left[i] ? groupOf(left[i]) : "",
    leftAmount: left[i] ? left[i].amount : null,
    rightLabel: right[i] ? rowLabel(right[i]) : "",
    rightGroup: right[i] ? groupOf(right[i]) : "",
    rightAmount: right[i] ? right[i].amount : null,
  }));
};

/**
 * The trial balance as rows: each group, then its accounts beneath it.
 *
 * The screen's own rule for an account's side: a positive closing is a
 * debit, a negative one a credit shown positive. A `Row` column says which
 * lines are groups, so a spreadsheet filter can take the accounts alone --
 * summing groups and accounts together would count every figure twice, as
 * it would on the printed sheet.
 */
export const trialRows = (trial = {}) =>
  (trial?.groups || []).flatMap((g) => [
    {
      group: g.group,
      account: g.collapsed ? `${n(g.accountCount)} accounts, net` : "",
      level: "Group",
      debit: n(g.debit) ? g.debit : null,
      credit: n(g.credit) ? g.credit : null,
    },
    ...(g.accounts || []).map((a) => ({
      group: "",
      account: a.name,
      level: "Account",
      debit: n(a.closing) > 0 ? a.closing : null,
      credit: n(a.closing) < 0 ? -a.closing : null,
    })),
  ]);

/**
 * The trial balance and the three final accounts, one sheet each, with the
 * one on screen first -- so its CSV is the statement the person was looking
 * at. `data` is the route's own JSON (`trial`, `trading`, `pl`, `sheet`,
 * `stock`, `profit`, `warnings`). Its warnings travel with every sheet: a
 * statement that cannot be trusted has to say so in the file too.
 */
export const financialSheets = ({ kind = "trial", data = {}, from = "", to = "", company = null, companyAddressLine = "" } = {}) => {
  const warnings = (data?.warnings || []).map((w, i) => ({ label: `Warning ${i + 1}`, value: text(w) }));
  const base = firmMeta({ company, companyAddressLine });
  const period = { label: "Period", value: periodLine(from, to) };
  const asAt = { label: "As at", value: displayDate(to) || "today" };

  const trial = data?.trial || {};
  const trading = data?.trading || {};
  const pl = data?.pl || {};
  const bs = data?.sheet || {};

  const sheets = {
    trial: {
      name: STATEMENT_TITLES.trial,
      title: STATEMENT_TITLES.trial,
      meta: [
        ...base,
        period,
        {
          label: "Status",
          value: trial.balanced ? "Balanced" : `Out by ${Math.abs(n(trial.difference)).toFixed(2)}`,
        },
        ...warnings,
      ],
      columns: TRIAL_COLUMNS,
      rows: trialRows(trial),
      totals: { debit: n(trial?.totals?.debit), credit: n(trial?.totals?.credit) },
    },
    trading: {
      name: STATEMENT_TITLES.trading,
      title: STATEMENT_TITLES.trading,
      meta: [
        ...base,
        period,
        { label: "Opening stock", value: n(trading.openingStock).toFixed(2) },
        { label: "Closing stock", value: n(trading.closingStock).toFixed(2) },
        {
          label: "Closing stock basis",
          value: data?.stock ? (data.stock.closingOverridden ? "typed in" : "valued at cost") : "",
        },
        { label: n(trading.gross) < 0 ? "Gross loss" : "Gross profit", value: Math.abs(n(trading.gross)).toFixed(2) },
        ...warnings,
      ],
      columns: hColumns("Dr", "Cr"),
      rows: horizontalRows(trading.left, trading.right),
      totals: { leftAmount: n(trading.leftTotal), rightAmount: n(trading.rightTotal) },
    },
    pl: {
      name: STATEMENT_TITLES.pl,
      title: STATEMENT_TITLES.pl,
      meta: [
        ...base,
        period,
        { label: n(pl.net) < 0 ? "Net loss" : "Net profit", value: Math.abs(n(pl.net)).toFixed(2) },
        {
          label: "Carried on the balance sheet",
          value: data?.profit ? n(data.profit.accumulated).toFixed(2) : "",
        },
        ...warnings,
      ],
      columns: hColumns("Dr", "Cr"),
      rows: horizontalRows(pl.left, pl.right),
      totals: { leftAmount: n(pl.leftTotal), rightAmount: n(pl.rightTotal) },
    },
    balance: {
      name: STATEMENT_TITLES.balance,
      title: STATEMENT_TITLES.balance,
      meta: [
        ...base,
        asAt,
        { label: "Status", value: bs.balanced ? "Balanced" : `Out by ${Math.abs(n(bs.difference)).toFixed(2)}` },
        ...warnings,
      ],
      columns: hColumns("Liabilities", "Assets"),
      rows: horizontalRows(bs.liabilities, bs.assets),
      totals: { leftAmount: n(bs.liabilitiesTotal), rightAmount: n(bs.assetsTotal) },
    },
  };

  const first = STATEMENT_KINDS.includes(text(kind)) ? text(kind) : "trial";
  return [first, ...STATEMENT_KINDS.filter((k) => k !== first)].map((k) => sheets[k]);
};
