/**
 * The sales book, GST return and financial statement downloads.
 *
 *   node scripts/report-sheets.test.mjs
 *
 * Every fixture goes through the REAL report builders -- documentsFor,
 * periodWise, gstr1Sheet, trialBalance and the rest, exactly as the routes
 * call them -- then lib/reportSheets.mjs, then the real writers (lib/xlsx.mjs,
 * lib/csv.mjs), and the bytes are read back. So these assert what a person
 * opening the file sees: the headings, that figures are numbers, the totals,
 * that the rows are the filtered report and nothing else, and the dates.
 *
 * The last section reads the three routes and pages, the way
 * scripts/report-export.test.mjs checks the statement's.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { inflateRawSync } from "node:zlib";
import { buildWorkbook } from "../lib/xlsx.mjs";
import { reportCsv } from "../lib/csv.mjs";
import { reportFilename } from "../lib/reportExport.mjs";
import {
  displayDate,
  financialSheets,
  gstReturnSheets,
  gstr1TableRows,
  horizontalRows,
  periodLine,
  portalToIso,
  salesReportSheets,
  salesSheetKind,
  trialRows,
} from "../lib/reportSheets.mjs";
import {
  documentsFor,
  itemTotals,
  itemWise,
  partyTotals,
  partyWise,
  periodTotals,
  periodWise,
  totalsOf,
  zoomInto,
} from "../lib/salesReports.mjs";
import { gstr1Sheet, gstr3Sheet, gstr3bSheet } from "../lib/gstReturns.mjs";
import {
  accountPositions,
  accumulatedProfit,
  balanceSheet,
  profitAndLoss,
  tradingAccount,
  trialBalance,
} from "../lib/financials.mjs";

/* ----------------------------------------------------------- harness ---- */

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  }
};

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

/** The archive's files, by name. Structure is checked by report-export.test. */
const unzip = (buf) => {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < count; i += 1) {
    const compressed = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const offset = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    files[name] = inflateRawSync(buf.subarray(start, start + compressed)).toString("utf8");
    at += 46 + nameLen + extraLen + commentLen;
  }
  return files;
};

const unxml = (s) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/**
 * A worksheet as a grid: rows of `{ ref, kind, value }`, where `kind` is
 * "n" for a number cell (with its style) and "s" for text.
 */
const grid = (xml) =>
  [...xml.matchAll(/<row r="(\d+)">(.*?)<\/row>/g)].map(([, r, body]) =>
    [...body.matchAll(/<c r="([A-Z]+)\d+" s="(\d+)"( t="inlineStr")?>(?:<v>([^<]*)<\/v>|<is><t[^>]*>([\s\S]*?)<\/t><\/is>)<\/c>/g)].map(
      ([, col, style, inline, v, t]) => ({
        col,
        style: Number(style),
        kind: inline ? "s" : "n",
        value: inline ? unxml(t) : Number(v),
      })
    )
  );

/** The workbook: sheet names, and each sheet's grid. */
const workbook = (sheets) => {
  const files = unzip(buildWorkbook({ sheets }));
  const names = [...files["xl/workbook.xml"].matchAll(/<sheet name="([^"]+)"/g)].map((m) => unxml(m[1]));
  return {
    names,
    sheet: (i) => grid(files[`xl/worksheets/sheet${i + 1}.xml`]),
  };
};

/** The heading row: the first row whose cells use the heading style (1). */
const headings = (rows) => rows.find((r) => r.length && r.every((c) => c.style === 1)).map((c) => c.value);
const headingIndex = (rows) => rows.findIndex((r) => r.length && r.every((c) => c.style === 1));
const bodyRows = (rows) => rows.slice(headingIndex(rows) + 1);
const lastRow = (rows) => rows[rows.length - 1];
const cell = (row, col) => row.find((c) => c.col === col);

/* ---------------------------------------------------------- fixtures ---- */

const at = (iso) => new Date(`${iso}T10:00:00+05:30`);

const line = (name, hsn, quantity, rate, gstRate) => {
  const taxableAmount = quantity * rate;
  const gstAmount = (taxableAmount * gstRate) / 100;
  return { name, hsn, quantity, cost: rate, gstRate, taxableAmount, gstAmount, total: taxableAmount + gstAmount, uqc: "PCS" };
};

const invoice = (no, iso, party, items, extra = {}) => {
  const totalAmount = items.reduce((t, l) => t + l.total, 0);
  return {
    invoiceNo: no,
    type: "Sale",
    return: false,
    date: at(iso),
    customer: { name: party, gstin: extra.gstin || "" },
    stateOfSupply: "Delhi",
    stateCode: extra.stateCode || "07",
    taxType: extra.taxType || "local",
    totalAmount,
    gst: items.reduce((t, l) => t + l.gstAmount, 0),
    finalAmount: totalAmount + (extra.freight || 0),
    received: extra.received || 0,
    balanceDue: totalAmount + (extra.freight || 0) - (extra.received || 0),
    items,
    ...extra.doc,
  };
};

const INVOICES = [
  invoice(1, "2026-04-03", "Shah Traders", [line("Widget", "8471", 10, 100, 18)], { gstin: "07AAAAA0000A1Z5" }),
  invoice(2, "2026-04-20", "Walk-in", [line("Bolt", "7318", 100, 2.5, 12)], { received: 280 }),
  invoice(3, "2026-05-02", "Shah Traders", [line("Widget", "8471", 2, 100, 18)], { gstin: "07AAAAA0000A1Z5", doc: { return: true } }),
  invoice(4, "2026-05-15", "Mehta & Sons <Delhi>", [line("Widget", "8471", 5, 100, 18), line("Bolt", "7318", 10, 2.5, 12)], {
    gstin: "27BBBBB1111B1Z2", stateCode: "27", taxType: "central", freight: 50,
  }),
  // Outside the filtered period: must never reach a sheet.
  invoice(5, "2026-07-01", "Shah Traders", [line("Widget", "8471", 99, 100, 18)], { gstin: "07AAAAA0000A1Z5" }),
  // Late evening IST on the last day: still April, not May (and not March).
  invoice(6, "2026-04-30", "Walk-in", [line("Bolt", "7318", 4, 2.5, 12)], { doc: { date: new Date("2026-04-30T23:30:00+05:30") } }),
];

const round2 = (n) => Math.round(n * 100) / 100;

const FROM = "2026-04-01";
const TO = "2026-05-31";
const COMPANY = { name: "Acme Fasteners", gstin: "07ZZZZZ9999Z1Z9" };

/* ====================================================== the sales book == */

console.log("\n--- the sales book ---");

const docs = documentsFor({ invoices: INVOICES, side: "Sale", from: FROM, to: TO, scope: "both" });

test("the sheet kind follows the page's own choice", () => {
  assert.equal(salesSheetKind({ view: "book", grain: "month" }), "period");
  assert.equal(salesSheetKind({ view: "book", grain: "date" }), "period");
  assert.equal(salesSheetKind({ view: "book", grain: "document" }), "book");
  assert.equal(salesSheetKind({ view: "party" }), "party");
  assert.equal(salesSheetKind({ view: "item" }), "item");
});

test("month sheet: headings, numbers as numbers, the route's totals", () => {
  const rows = periodWise(docs, "month");
  const totals = periodTotals(rows);
  const wb = workbook(salesReportSheets({ view: "book", side: "Sale", grain: "month", rows, totals, from: FROM, to: TO, covers: "Invoices and returns", company: COMPANY }));
  assert.deepEqual(wb.names, ["Sales Book"]);
  const g = wb.sheet(0);
  assert.deepEqual(headings(g), ["Month", "Bills", "Returns", "Taxable Amount", "GST", "Net Amount", "Others", "Bill Amount"]);
  const body = bodyRows(g);
  assert.equal(body.length, rows.length + 1, "one row per month plus the totals row");
  assert.deepEqual(body.slice(0, -1).map((r) => cell(r, "A").value), ["Apr 2026", "May 2026"]);
  for (const r of body) {
    for (const col of ["D", "E", "H"]) {
      const c = cell(r, col);
      assert.equal(c.kind, "n", `${col} is text, not a number`);
    }
  }
  const total = lastRow(g);
  assert.equal(cell(total, "A").value, "Total");
  assert.equal(cell(total, "H").value, totals.total);
  assert.equal(cell(total, "D").value, totals.taxable);
  // The figures add up the way the screen's do: the totals are the column sums.
  const sum = round2(body.slice(0, -1).reduce((t, r) => t + cell(r, "H").value, 0));
  assert.equal(sum, totals.total);
});

test("the filter is the export's filter: nothing outside the period", () => {
  const nos = docs.map((d) => d.invoiceNo);
  assert.ok(!nos.includes(5), "a July invoice reached a sheet for April-May");
  assert.ok(nos.includes(6), "a late-evening IST invoice on the 30th fell out of April");
  const april = periodWise(docs, "month").find((r) => r.key === "2026-04");
  assert.equal(april.documents, 3);
});

test("a return is subtracted in the month and in the totals -- the sign survives", () => {
  const may = periodWise(docs, "month").find((r) => r.key === "2026-05");
  // May: invoice 4 (taxable 525) less the return of 200.
  assert.equal(may.taxable, round2(525 - 200));
  const g = workbook(salesReportSheets({ view: "book", grain: "month", rows: [may], totals: periodTotals([may]) })).sheet(0);
  assert.equal(cell(bodyRows(g)[0], "D").value, 325);
});

test("bill-wise register: dates as dates, invoice numbers as numbers, returns at face value", () => {
  const totals = totalsOf(docs);
  const wb = workbook(salesReportSheets({ view: "book", grain: "document", rows: docs, totals, from: FROM, to: TO, company: COMPANY }));
  const g = wb.sheet(0);
  assert.deepEqual(headings(g).slice(0, 6), ["Date", "Invoice No", "Party", "GSTIN", "State", "Document"]);
  const body = bodyRows(g).slice(0, -1);
  assert.equal(body.length, docs.length);
  const first = body[0];
  assert.equal(cell(first, "A").kind, "n", "the date is text");
  assert.equal(cell(first, "A").style, 2, "the date is not date-formatted");
  // 3 April 2026 is Excel serial 46115.
  assert.equal(cell(first, "A").value, 46115);
  assert.equal(cell(first, "B").value, 1);
  const ret = body.find((r) => cell(r, "F").value === "Return");
  assert.equal(cell(ret, "G").value, 200, "a return is listed at face value, as on screen");
  // ...and subtracted in the totals row, which is the route's own.
  assert.equal(cell(lastRow(g), "G").value, totals.taxable);
  // The late-evening bill on the 30th is dated the 30th, not the 1st.
  const late = body.find((r) => cell(r, "B").value === 6);
  assert.equal(cell(late, "A").value, 46142);
});

test("the meta block says what was filtered", () => {
  const [sheet] = salesReportSheets({ view: "book", grain: "document", rows: docs, totals: totalsOf(docs), from: FROM, to: TO, covers: "Invoices only", company: COMPANY, companyAddressLine: "Delhi" });
  const meta = Object.fromEntries(sheet.meta.map((m) => [m.label, m.value]));
  assert.equal(meta.Firm, "Acme Fasteners");
  assert.equal(meta.Period, "01-04-2026 to 31-05-2026");
  assert.equal(meta.Covering, "Invoices only");
  assert.equal(meta["Grouped by"], "Bill wise");
  assert.match(meta.Note, /face value/);
  // The count the screen's totals line prints.
  assert.equal(meta.Bills, "5, 1 of them returns");
});

test("date-wise zoom: the first heading is Date, and the month is named", () => {
  const rows = zoomInto(docs, "2026-04");
  const [sheet] = salesReportSheets({ view: "book", grain: "date", month: "2026-04", rows, totals: periodTotals(rows) });
  assert.equal(sheet.columns[0].label, "Date");
  assert.equal(sheet.meta.find((m) => m.label === "Month").value, "2026-04");
  assert.equal(sheet.rows.length, 3);
});

test("party-wise and item-wise sheets carry their own totals", () => {
  const parties = partyWise(docs);
  const pg = workbook(salesReportSheets({ view: "party", rows: parties, totals: partyTotals(parties) })).sheet(0);
  assert.equal(headings(pg)[0], "Party");
  assert.ok(bodyRows(pg).some((r) => cell(r, "A").value === "Mehta & Sons <Delhi>"), "a party name with & and < did not survive");
  assert.equal(cell(lastRow(pg), "H").value, partyTotals(parties).total);

  const items = itemWise({ invoices: INVOICES, side: "Sale", from: FROM, to: TO, scope: "both" });
  const ig = workbook(salesReportSheets({ view: "item", rows: items, totals: itemTotals(items) })).sheet(0);
  assert.deepEqual(headings(ig), ["Item", "HSN", "Unit", "Documents", "Quantity", "Avg Rate", "Taxable", "GST", "Total"]);
  assert.equal(cell(lastRow(ig), "E").value, itemTotals(items).quantity);
});

test("an empty period still makes a valid workbook: headings and nothing else", () => {
  const sheets = salesReportSheets({ view: "book", grain: "month", rows: [], totals: periodTotals([]), from: "2030-01-01", to: "2030-01-31" });
  const g = workbook(sheets).sheet(0);
  assert.equal(headings(g).length, 8);
  // Only the totals row below the headings, at zero.
  assert.equal(bodyRows(g).length, 1);
  assert.equal(cell(lastRow(g), "H").value, 0);
});

test("the CSV is the same sheet: same headings, same rows", () => {
  const rows = periodWise(docs, "month");
  const [sheet] = salesReportSheets({ view: "book", grain: "month", rows, totals: periodTotals(rows), from: FROM, to: TO });
  const csv = reportCsv({ columns: sheet.columns, rows: sheet.rows, meta: sheet.meta, totals: sheet.totals });
  assert.ok(csv.includes("Month,Bills,Returns,Taxable Amount,GST,Net Amount,Others,Bill Amount"));
  assert.ok(csv.includes("Apr 2026"));
});

test("a large book exports every row", () => {
  const many = Array.from({ length: 3000 }, (_, i) =>
    invoice(1000 + i, i % 2 ? "2026-04-10" : "2026-05-10", `Party ${i % 40}`, [line("Widget", "8471", 1, 10 + (i % 7), 18)])
  );
  const rows = documentsFor({ invoices: many, side: "Sale", from: FROM, to: TO, scope: "both" });
  const totals = totalsOf(rows);
  const g = workbook(salesReportSheets({ view: "book", grain: "document", rows, totals })).sheet(0);
  assert.equal(bodyRows(g).length, 3001);
  assert.equal(cell(lastRow(g), "K").value, totals.total);
});

/* ======================================================= the GST returns == */

console.log("\n--- the GST returns ---");

const g1 = gstr1Sheet({ invoices: INVOICES, from: FROM, to: TO });

test("GSTR-1: a summary, then one sheet per table the app builds", () => {
  const sheets = gstReturnSheets({ view: "gstr1", sheet: g1, from: FROM, to: TO, company: COMPANY });
  const wb = workbook(sheets);
  assert.equal(wb.names[0], "Summary");
  assert.deepEqual(wb.names.slice(1), ["4 B2B", "5 B2CL", "7 B2CS", "9 CDNR", "10 CDNUR", "12 HSN", "13 DOCS"]);
  // The tables it cannot build are listed with the reason, not dropped.
  const summary = bodyRows(wb.sheet(0));
  const exp = summary.find((r) => cell(r, "A").value === "6");
  assert.match(cell(exp, "D").value, /Not built: needs an export/);
});

test("GSTR-1 B2B: one row per rate line, value once per document, totals summed", () => {
  const rows = gstr1TableRows("B2B", g1.sections.find((s) => s.tag === "B2B").rows);
  // Shah Traders' invoice 1 and Mehta's invoice 4 (two rates).
  assert.deepEqual(rows.map((r) => r.number), [1, 4, 4]);
  const mehta = rows.filter((r) => r.number === 4);
  assert.equal(mehta.filter((r) => r.val !== null).length, 1, "the document's value repeats on every line");
  assert.ok(mehta.every((r) => r.ctin === "27BBBBB1111B1Z2"), "the GSTIN does not repeat on each line");

  const sheets = gstReturnSheets({ view: "gstr1", sheet: g1, from: FROM, to: TO });
  const b2b = workbook(sheets).sheet(1);
  assert.deepEqual(headings(b2b), ["GSTIN", "Party", "Invoice No", "Date", "POS", "Rate %", "Taxable", "IGST", "CGST", "SGST", "Value"]);
  const body = bodyRows(b2b).slice(0, -1);
  assert.equal(cell(body[0], "D").kind, "n", "the portal date was written as text, not as a date");
  assert.equal(cell(body[0], "D").value, 46115);
  assert.equal(cell(body[0], "F").value, 18);
  // IGST on the inter-State bill, CGST+SGST on the local one.
  assert.equal(cell(body[0], "H").value, 0, "a local bill shows IGST 0.00, as on screen");
  assert.ok(cell(body[0], "I").value > 0);
  assert.ok(cell(body[1], "H").value > 0);
  const totals = lastRow(b2b);
  const sum = (col) => round2(body.reduce((t, r) => t + (cell(r, col)?.value || 0), 0));
  assert.equal(cell(totals, "G").value, sum("G"));
  assert.equal(cell(totals, "K").value, sum("K"));
});

test("GSTR-1 credit notes are their own table", () => {
  const rows = gstr1TableRows("CDNR", g1.sections.find((s) => s.tag === "CDNR").rows);
  assert.deepEqual(rows.map((r) => r.number), [3]);
});

test("GSTR-3B: label and figure, with the unfilled tables explained", () => {
  const sheet = gstr3bSheet({ invoices: INVOICES, from: FROM, to: TO });
  const sheets = gstReturnSheets({ view: "gstr3b", sheet, from: FROM, to: TO });
  assert.equal(sheets.length, 1, "3B is one table");
  const g = workbook(sheets).sheet(0);
  assert.deepEqual(headings(g), ["Table", "Particulars", "Amount", "Note"]);
  const body = bodyRows(g);
  const taxable = body.find((r) => cell(r, "A").value === "3.1(a)" && cell(r, "B").value === "Taxable value");
  const expected = sheet.sections.find((s) => s.no === "3.1(a)").rows[0].value;
  assert.equal(cell(taxable, "C").value, expected);
  assert.equal(cell(taxable, "C").kind, "n");
  assert.ok(body.some((r) => /Not built/.test(cell(r, "D")?.value || "")));
  // The note-only row has no amount rather than a zero.
  const noteOnly = body.find((r) => /document\(s\)/.test(cell(r, "D")?.value || ""));
  assert.equal(cell(noteOnly, "C"), undefined);
});

test("GSTR-3B: a table with nothing in the period says so, as the screen does", () => {
  const sheet = { sections: [{ no: "4", filled: true, title: "4. Eligible ITC", rows: [] }] };
  const [only] = gstReturnSheets({ view: "gstr3b", sheet });
  assert.deepEqual(only.rows, [{ no: "4", label: "4. Eligible ITC", value: null, note: "Nothing in this period." }]);
});

test("GSTR-3: the same shape, so its CSV is meaningful", () => {
  const sheet = gstr3Sheet({ invoices: INVOICES, from: FROM, to: TO });
  const [only] = gstReturnSheets({ view: "gstr3", sheet, from: FROM, to: TO });
  const csv = reportCsv({ columns: only.columns, rows: only.rows, meta: only.meta });
  assert.ok(csv.includes("Table,Particulars,Amount,Note"));
  assert.ok(csv.includes("Net tax payable"));
});

test("an empty period returns empty tables, still openable", () => {
  const empty = gstr1Sheet({ invoices: [], from: "2030-01-01", to: "2030-01-31" });
  const wb = workbook(gstReturnSheets({ view: "gstr1", sheet: empty, from: "2030-01-01", to: "2030-01-31" }));
  assert.equal(wb.names.length, 8);
  assert.equal(headings(wb.sheet(1))[0], "GSTIN");
});

test("portal dates convert on the right calendar day", () => {
  assert.equal(portalToIso("03-04-2026"), "2026-04-03T00:00:00+05:30");
  assert.equal(portalToIso("not a date"), "not a date");
  assert.equal(displayDate("2026-04-03"), "03-04-2026");
  assert.equal(periodLine("", ""), "All dates");
  assert.equal(periodLine("2026-04-01", ""), "01-04-2026 to today");
});

/* ================================================ financial statements == */

console.log("\n--- the financial statements ---");

const ACCOUNTS = [
  { name: "Shah Traders", group: "Sundry Debtors", openingBal: 0 },
  { name: "Cash", group: "Cash In Hand", openingBal: 5000 },
  { name: "Capital", group: "Capital Account", openingBal: -5000 },
  { name: "Sales Account", group: "Sales Account", openingBal: 0 },
  { name: "Output CGST", group: "Duties And Taxes", openingBal: 0 },
  { name: "Rent", group: "Indirect Expenses", openingBal: 0 },
];
const D = "2026-05-10T06:00:00Z";
const LEDGER = [
  { customerName: "Shah Traders", date: D, debit: 1180, credit: 0 },
  { customerName: "Sales Account", date: D, debit: 0, credit: 1000 },
  { customerName: "Output CGST", date: D, debit: 0, credit: 180 },
  { customerName: "Rent", date: D, debit: 300, credit: 0 },
  { customerName: "Cash", date: D, debit: 0, credit: 300 },
];

const statementsData = () => {
  const positions = accountPositions({ accounts: ACCOUNTS, rows: LEDGER, from: "2026-04-01", to: "2026-10-12" });
  const trial = trialBalance(positions);
  const trading = tradingAccount({ positions, openingStock: 0, closingStock: 200 });
  const pl = profitAndLoss({ positions, gross: trading.gross });
  const accumulated = accumulatedProfit({ positions, closingStock: 200 });
  const sheet = balanceSheet({ positions, closingStock: 200, profit: accumulated });
  return { trial, trading, pl, sheet, warnings: ["Example warning about valuation."] };
};

test("the statement on screen leads; all four are in the workbook", () => {
  const data = statementsData();
  assert.deepEqual(
    financialSheets({ kind: "pl", data }).map((s) => s.name),
    ["Profit & Loss Account", "Trial Balance", "Trading Account", "Balance Sheet"]
  );
  assert.equal(financialSheets({ kind: "nonsense", data })[0].name, "Trial Balance");
  // Excel's sheet-name rules: "&" is fine, and the names survive.
  assert.deepEqual(workbook(financialSheets({ kind: "trial", data })).names.length, 4);
});

test("trial balance: debit and credit columns foot to the screen's totals", () => {
  const data = statementsData();
  const g = workbook(financialSheets({ kind: "trial", data })).sheet(0);
  assert.deepEqual(headings(g), ["Group", "Account", "Row", "Debit", "Credit"]);
  const body = bodyRows(g).slice(0, -1);
  const accounts = body.filter((r) => cell(r, "C").value === "Account");
  const groups = body.filter((r) => cell(r, "C").value === "Group");
  assert.equal(groups.length, data.trial.groups.length);
  const sumOf = (rows, col) => round2(rows.reduce((t, r) => t + (cell(r, col)?.value || 0), 0));
  // Groups alone foot to the totals (a collapsed group carries its net).
  assert.equal(sumOf(groups, "D"), data.trial.totals.debit);
  assert.equal(sumOf(groups, "E"), data.trial.totals.credit);
  assert.equal(cell(lastRow(g), "D").value, data.trial.totals.debit);
  assert.equal(cell(lastRow(g), "E").value, data.trial.totals.credit);
  // A credit balance is shown positive in the credit column, never negative.
  assert.ok(accounts.every((r) => (cell(r, "D")?.value ?? 0) >= 0 && (cell(r, "E")?.value ?? 0) >= 0));
});

test("trading, P&L and balance sheet: two sides, each footing to its total", () => {
  const data = statementsData();
  for (const [kind, key] of [["trading", "trading"], ["pl", "pl"], ["balance", "sheet"]]) {
    const g = workbook(financialSheets({ kind, data })).sheet(0);
    const body = bodyRows(g).slice(0, -1);
    const left = round2(body.reduce((t, r) => t + (cell(r, "C")?.value || 0), 0));
    const right = round2(body.reduce((t, r) => t + (cell(r, "F")?.value || 0), 0));
    const totals = lastRow(g);
    const s = data[key];
    assert.equal(cell(totals, "C").value, s.leftTotal ?? s.liabilitiesTotal, `${kind} left total`);
    assert.equal(cell(totals, "F").value, s.rightTotal ?? s.assetsTotal, `${kind} right total`);
    assert.equal(left, cell(totals, "C").value, `${kind}: the left column does not foot`);
    assert.equal(right, cell(totals, "F").value, `${kind}: the right column does not foot`);
  }
});

test("signs are the statement's own: a loss stays a loss", () => {
  const rows = horizontalRows([{ label: "Gross Loss b/d", amount: 50, carried: true }], [{ label: "P&L (loss)", amount: -75 }]);
  assert.equal(rows[0].leftLabel, "Gross Loss b/d (carried)");
  assert.equal(rows[0].rightAmount, -75);
  // The group the screen prints under an account travels too -- but not when
  // it merely repeats the name.
  const grouped = horizontalRows([{ label: "Rent", group: "Indirect Expenses", amount: 300 }], [{ label: "Sales Account", group: "Sales Account", amount: 1000 }]);
  assert.equal(grouped[0].leftGroup, "Indirect Expenses");
  assert.equal(grouped[0].rightGroup, "");
  const tr = trialRows({ groups: [{ group: "G", debit: 0, credit: 10, accounts: [{ name: "A", closing: -10 }] }] });
  assert.equal(tr[1].credit, 10);
  assert.equal(tr[1].debit, null);
});

test("warnings travel with the file", () => {
  const [sheet] = financialSheets({ kind: "trial", data: statementsData() });
  assert.ok(sheet.meta.some((m) => m.label === "Warning 1" && /valuation/.test(m.value)));
});

test("the figures the screen prints beside the accounts travel too", () => {
  const data = { ...statementsData(), stock: { closingOverridden: true }, profit: { accumulated: 1234.5 } };
  const meta = (kind) => Object.fromEntries(financialSheets({ kind, data })[0].meta.map((m) => [m.label, m.value]));
  assert.equal(meta("trading")["Closing stock basis"], "typed in");
  assert.equal(meta("pl")["Carried on the balance sheet"], "1234.50");
});

test("an empty book still exports", () => {
  const sheets = financialSheets({ kind: "balance", data: {} });
  const g = workbook(sheets).sheet(0);
  assert.deepEqual(headings(g), ["Liabilities", "Group", "Amount", "Assets", "Group", "Amount"]);
});

/* ======================================================== filenames ===== */

console.log("\n--- filenames ---");

test("filenames name the report, the period and the format", () => {
  assert.equal(
    reportFilename({ report: "Sales Book-month", from: FROM, to: TO, format: "xlsx" }),
    "sales-book-month-2026-04-01-to-2026-05-31.xlsx"
  );
  assert.equal(reportFilename({ report: "gstr3b", subject: "042026", from: FROM, to: TO, format: "csv" }), "gstr3b-042026-2026-04-01-to-2026-05-31.csv");
  assert.equal(reportFilename({ report: "balance-sheet", from: "", to: "2026-10-12", format: "xlsx" }), "balance-sheet-start-to-2026-10-12.xlsx");
});

/* ========================================================== wiring ====== */

console.log("\n--- the routes and pages use all of the above ---");

const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

for (const [route, builder] of [
  ["sales-report", "salesReportSheets"],
  ["gst-return", "gstReturnSheets"],
  ["financials", "financialSheets"],
]) {
  test(`${route}: exports from the same route, through reportResponse`, () => {
    const src = code(read(`app/api/${route}/route.js`));
    assert.match(src, /formatOf\(/);
    assert.match(src, /isReportFormat\(format\)/, "an unknown format is not refused");
    assert.match(src, new RegExp(`${builder}\\(`));
    assert.match(src, /reportResponse\(/);
    // Tenancy: still wrapped, and the firm is the session's, never the request's.
    assert.match(src, /export const GET = tenantRoute\(/);
    assert.match(src, /Company\.findById\(auth\.companyId\)/);
    assert.doesNotMatch(src, /searchParams\.get\("companyId"\)|params\.get\("companyId"\)/);
  });
}

test("gst-return refuses a CSV of GSTR-1 and any export of the e-return", () => {
  const src = code(read("app/api/gst-return/route.js"));
  assert.match(src, /format === "csv" && view === "gstr1"/);
  assert.match(src, /format !== "json" && view === "gstr1-ereturn"/);
});

test("financials validates the statement kind", () => {
  assert.match(code(read("app/api/financials/route.js")), /isStatementKind\(kind\)/);
});

for (const [page, route] of [
  ["sales-report", "sales-report"],
  ["gst-return", "gst-return"],
  ["financials", "financials"],
]) {
  test(`${page}: the Excel button asks the same route for format=xlsx`, () => {
    const src = read(`app/${page}/page.js`);
    assert.match(src, /Download Excel/);
    assert.match(src, /'xlsx'/);
    assert.match(src, new RegExp(`/api/${route}\\?`));
  });
}

console.log(`\n${passed} checks passed.\n`);
