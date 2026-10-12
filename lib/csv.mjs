/**
 * The one CSV writer for the whole app.
 *
 * Pure and dependency-free, like the rest of lib/*.mjs, so `node` can run
 * scripts/report-export.test.mjs directly. Never import Mongoose in here.
 *
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `csvCell` and `toCsv` were written inside lib/orderReports.mjs, because the
 * order reports were the first thing that downloaded a sheet. Every report
 * since has imported them from there, and lib/accountBooks.mjs carries a
 * comment apologising for it:
 *
 *     "It deserves a module of its own rather than living in
 *      orderReports.mjs; until it has one, importing is the lesser of the
 *      two evils."
 *
 * This is that module. `orderReports.mjs` now imports from here and re-exports
 * both names, so every existing caller -- and every existing test -- keeps
 * working unchanged while there is only one copy of the escaping rules.
 *
 *
 * THE TWO HARDENINGS, AND WHY NEITHER IS OPTIONAL
 * -----------------------------------------------
 * RFC 4180 quoting, because a party name here routinely contains a comma
 * ("Acme Traders, Delhi"). An unquoted comma does not corrupt the file
 * visibly: it shifts every later column of that one row by one, so the sheet
 * opens fine and a single invoice's amount lands under "Balance Due".
 *
 * A leading quote on =, + , - or @, because a spreadsheet treats such a cell
 * as a formula. "-Reliance Traders" is a plausible party name and
 * "=cmd|'/c calc'!A0" is the published DDE attack; both are the same bug, and
 * the guard is one character. This is CSV INJECTION, and it matters most
 * precisely where the data came from a human typing into a master -- which is
 * every text column in this app.
 */

const text = (value) => String(value ?? "").trim();

/**
 * One cell, escaped.
 *
 * Quoted whenever it holds a comma, a quote, a newline or leading/trailing
 * space, with embedded quotes doubled -- RFC 4180.
 *
 * A leading =, +, - or @ is prefixed with a single quote, for the reason in
 * the header. Note the test is on the RAW string, before quoting: a value
 * that needs both treatments gets both, and the apostrophe goes INSIDE the
 * quotes where the spreadsheet will see it.
 */
export const csvCell = (value) => {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  // A NUMBER is never a formula. Prefixing it turned every negative figure
  // -- a credit balance, a return, a negative GST row -- into the text
  // '-120.5, which a spreadsheet will not add up.
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  let s = String(value);
  // Tab and carriage return lead a formula too, in some spreadsheets.
  if (/^[=+\-@\t\r]/.test(s) && !/^-\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * One row of cells, already escaped, joined.
 *
 * Separate from `toCsv` so the metadata block below can emit a row that is
 * not driven by a column spec.
 */
export const csvRow = (cells = []) => cells.map(csvCell).join(",");

/** Rows plus a header, as CSV with CRLF line endings (what Excel expects). */
export const toCsv = (columns, rows) => {
  const head = csvRow((columns || []).map((c) => c.label ?? c.key));
  const body = (rows || []).map((row) =>
    csvRow(
      (columns || []).map((c) =>
        typeof c.value === "function" ? c.value(row) : row?.[c.key]
      )
    )
  );
  return [head, ...body].join("\r\n");
};

/**
 * Excel's byte-order mark.
 *
 * Without it, Excel on Windows reads a UTF-8 CSV as the system code page, and
 * a rupee sign or a party name in Devanagari comes out as mojibake. It is
 * three bytes and it is the difference between a sheet the shop can use and
 * one they mail back asking what happened to the names.
 *
 * Exported separately because it must NOT go into a file that something other
 * than a spreadsheet will parse.
 */
export const CSV_BOM = "\uFEFF";

/**
 * The header block a printed report carries, above the column headings.
 *
 * Sigfa prints the firm, the report and the period at the top of every sheet,
 * and a download that drops them is a column of numbers nobody can place six
 * months later. Each line is one cell in column A, so the block never
 * disturbs the columns below it, and a blank row separates it from the
 * headings so a spreadsheet's "use first row as header" still finds the right
 * row when the user deletes the block.
 *
 * `meta` is an array of { label, value } rather than an object, because the
 * ORDER is the point -- firm, report, period, then whatever else.
 *
 * A row with no VALUE is dropped, label and all. A firm that has not entered
 * a GSTIN must not export a line reading "GSTIN:," -- which reads as a firm
 * whose GSTIN is blank rather than as one we were not told. A row with a
 * value and no label is kept: that is the title line.
 */
export const csvMetaBlock = (meta = []) =>
  (meta || [])
    .filter((m) => text(m?.value))
    .map((m) => csvRow([text(m.label) ? `${text(m.label)}:` : "", m.value]));

/**
 * A complete report sheet: metadata, a blank line, the headings, the rows,
 * and an optional totals row.
 *
 * `totals` is a row object like any other, flagged so the first column can
 * say "Total" rather than being blank -- a sheet whose last line is a row of
 * numbers with no label is a sheet somebody will mistake for data.
 */
export const reportCsv = ({
  columns = [],
  rows = [],
  meta = [],
  totals = null,
  totalsLabel = "Total",
  bom = true,
} = {}) => {
  const parts = [];
  const block = csvMetaBlock(meta);
  if (block.length) parts.push(...block, "");

  parts.push(csvRow(columns.map((c) => c.label ?? c.key)));

  for (const row of rows || []) {
    parts.push(
      csvRow(
        columns.map((c) => (typeof c.value === "function" ? c.value(row) : row?.[c.key]))
      )
    );
  }

  if (totals) {
    parts.push(
      csvRow(
        columns.map((c, index) => {
          if (index === 0) return totalsLabel;
          // A totals row only fills the columns it HAS a figure for. Running
          // `c.value(totals)` would invent one for every derived column --
          // a "Document" column reading "Invoice" under a Total label.
          const key = c.key;
          return key in (totals || {}) ? totals[key] : "";
        })
      )
    );
  }

  return (bom ? CSV_BOM : "") + parts.join("\r\n");
};
