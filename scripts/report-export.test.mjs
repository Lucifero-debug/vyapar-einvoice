/**
 * Fixture tests for the CSV and .xlsx writers.
 *
 *   node scripts/report-export.test.mjs
 *
 * An export is the one output nobody proofreads. It is opened in a
 * spreadsheet months later, by somebody who was not there when it was taken,
 * and every way it can be wrong is quiet:
 *
 *   1. CSV INJECTION. A party name beginning "=", "+", "-" or "@" is a
 *      formula to Excel. "-Reliance Traders" is a plausible master entry and
 *      "=cmd|'/c calc'!A0" is the published DDE attack. One leading
 *      apostrophe fixes both, and nothing on screen shows whether it is there.
 *
 *   2. RFC 4180 QUOTING. "Acme Traders, Delhi" unquoted does not corrupt the
 *      file visibly -- it shifts that one row's later columns by one, so the
 *      sheet opens fine and an invoice's amount lands under "Balance Due".
 *
 *   3. NUMBERS AS TEXT. The only reason to offer .xlsx beside .csv is that
 *      the figures arrive as figures. A money column written as "1,234.50"
 *      cannot be totalled, sorted or pivoted, and every hand-rolled export
 *      gets this wrong.
 *
 *   4. DATES. An Excel date is a serial day count from 1899-12-30, and ours
 *      are IST calendar days. A bill dated the 1st must not export as the
 *      31st because Vercel runs in UTC.
 *
 * The workbook is checked by UNZIPPING IT and reading the XML, not by
 * trusting that the bytes are a zip. A corrupt archive and a correct one are
 * the same length to an eye, and "it downloaded" is not evidence that Excel
 * will open it.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { crc32 as zlibCrc32, inflateRawSync } from "node:zlib";
import { CSV_BOM, csvCell, csvMetaBlock, csvRow, reportCsv, toCsv } from "../lib/csv.mjs";
import {
  STYLE,
  buildWorkbook,
  cellRef,
  crc32,
  dateSerial,
  sheetName,
  sheetXml,
  xmlText,
  zipBytes,
} from "../lib/xlsx.mjs";
import { reportFilename, isReportFormat, REPORT_FORMATS } from "../lib/reportExport.mjs";

let passed = 0;
const test = (name, fn) => {
  try {
    const result = fn();
    assert.equal(result, undefined, "this test body is async -- make it synchronous");
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  }
};

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

/**
 * A minimal ZIP reader, for the assertions below.
 *
 * Walks the central directory from the end-of-central-directory record, the
 * way a real reader does -- so it checks the directory the writer built
 * rather than guessing where entries start.
 *
 * THE CRC IS CHECKED WITH NODE'S OWN zlib.crc32, not with the writer's. This
 * matters: verifying the archive with the same `crc32` the writer used makes
 * the check self-consistent, so a wrong CRC TABLE passes -- which is exactly
 * what a mutant proved. An independent oracle is the only kind worth having.
 *
 * Both headers are read and compared, because a reader may use either: Excel
 * reads the central directory, a strict one reads the local header, and a
 * writer that fills one correctly and the other wrongly produces an archive
 * that opens in some tools and not others.
 */
const unzip = (buf) => {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0, "no end-of-central-directory record");
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);

  const files = {};
  for (let i = 0; i < count; i += 1) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50, "bad central directory header");
    const sum = buf.readUInt32LE(at + 16);
    const compressed = buf.readUInt32LE(at + 20);
    const raw = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const offset = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString("utf8");

    assert.equal(buf.readUInt32LE(offset), 0x04034b50, `bad local header for ${name}`);
    // The local header must agree with the central directory, field for
    // field. A mismatch is what makes an archive open in one tool and not
    // another.
    assert.equal(buf.readUInt32LE(offset + 14), sum, `${name}: local CRC disagrees`);
    assert.equal(buf.readUInt32LE(offset + 18), compressed, `${name}: local compressed size disagrees`);
    assert.equal(buf.readUInt32LE(offset + 22), raw, `${name}: local uncompressed size disagrees`);

    const localNameLen = buf.readUInt16LE(offset + 26);
    const localExtraLen = buf.readUInt16LE(offset + 28);
    const start = offset + 30 + localNameLen + localExtraLen;
    const data = inflateRawSync(buf.subarray(start, start + compressed));

    assert.equal(data.length, raw, `${name}: declared size does not match`);
    // Node's own CRC, not the writer's -- see the note above.
    assert.equal(sum, zlibCrc32(data), `${name}: CRC does not match its contents`);

    files[name] = data.toString("utf8");
    at += 46 + nameLen + extraLen + commentLen;
  }

  // The end record's own two fields must describe the walk that just
  // happened: the directory's byte length, and where it started.
  const dirStart = buf.readUInt32LE(eocd + 16);
  assert.equal(buf.readUInt32LE(eocd + 12), at - dirStart, "the declared directory size is wrong");
  assert.equal(buf.readUInt16LE(eocd + 8), count, "the two entry counts disagree");

  return files;
};

console.log("\n--- CSV: injection ---");

test("a cell that starts like a formula is disarmed", () => {
  for (const value of ["=1+1", "+1", "-Reliance Traders", "@SUM(A1)", "=cmd|'/c calc'!A0"]) {
    const out = csvCell(value);
    assert.ok(out.startsWith("'") || out.startsWith('"\''), `${value} -> ${out}`);
  }
});

test("a value needing both treatments gets both, apostrophe inside the quotes", () => {
  // A party name with a comma AND a leading minus. The apostrophe must end up
  // where the spreadsheet will see it -- inside the quoted field.
  assert.equal(csvCell("-Acme, Delhi"), "\"'-Acme, Delhi\"");
});

test("an ordinary value is left alone", () => {
  assert.equal(csvCell("Acme Traders"), "Acme Traders");
  assert.equal(csvCell(1234.5), "1234.5");
  assert.equal(csvCell(0), "0");
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
});

console.log("\n--- CSV: RFC 4180 ---");

test("commas, quotes, newlines and edge whitespace are quoted", () => {
  assert.equal(csvCell("Acme, Delhi"), '"Acme, Delhi"');
  assert.equal(csvCell('He said "no"'), '"He said ""no"""');
  assert.equal(csvCell("line one\nline two"), '"line one\nline two"');
  assert.equal(csvCell("line one\r\nline two"), '"line one\r\nline two"');
  assert.equal(csvCell(" padded"), '" padded"');
  assert.equal(csvCell("padded "), '"padded "');
});

test("a row with a comma in it still has the right number of fields", () => {
  const columns = [
    { key: "party", label: "Party" },
    { key: "amount", label: "Amount" },
  ];
  const csv = toCsv(columns, [{ party: "Acme Traders, Delhi", amount: 1180 }]);
  const [, line] = csv.split("\r\n");
  // Naively split on commas this is THREE fields; properly quoted it is a
  // quoted field and a number.
  assert.equal(line, '"Acme Traders, Delhi",1180');
  assert.equal(line.split(",").length, 3, "the raw string does contain two commas");
});

test("a derived column is computed, in toCsv as well as in reportCsv", () => {
  // toCsv is what the order reports, the sales book and the GST returns
  // download through. A `value()` ignored there is a column of blanks in
  // three reports at once.
  const csv = toCsv(
    [
      { key: "a", label: "A" },
      { key: "kind", label: "Document", value: (r) => (r.isReturn ? "Return" : "Invoice") },
    ],
    [{ a: 1, isReturn: true }]
  );
  assert.equal(csv, "A,Document\r\n1,Return");
});

test("rows end with CRLF, which is what Excel expects", () => {
  const csv = toCsv([{ key: "a", label: "A" }], [{ a: 1 }, { a: 2 }]);
  assert.equal(csv, "A\r\n1\r\n2");
});

console.log("\n--- CSV: the report sheet ---");

test("the BOM is there, so Excel on Windows reads it as UTF-8", () => {
  const csv = reportCsv({ columns: [{ key: "a", label: "A" }], rows: [{ a: "₹ ो" }] });
  assert.ok(csv.startsWith(CSV_BOM));
  assert.equal(csv.charCodeAt(0), 0xfeff);
  // And it can be turned off, for a file something other than a spreadsheet
  // will parse.
  assert.equal(reportCsv({ columns: [], rows: [], bom: false }).charCodeAt(0) === 0xfeff, false);
});

test("the metadata block sits above a blank line, then the headings", () => {
  const csv = reportCsv({
    columns: [{ key: "a", label: "A" }],
    rows: [{ a: 1 }],
    meta: [
      { label: "Firm", value: "Acme Traders" },
      { label: "Period", value: "01-04-2026 to 30-06-2026" },
    ],
  });
  const lines = csv.replace(CSV_BOM, "").split("\r\n");
  assert.deepEqual(lines, [
    "Firm:,Acme Traders",
    "Period:,01-04-2026 to 30-06-2026",
    "",
    "A",
    "1",
  ]);
});

test("a blank metadata line is dropped rather than printed empty", () => {
  // A firm with no GSTIN must not export a line reading "GSTIN:,".
  assert.deepEqual(csvMetaBlock([{ label: "GSTIN", value: "" }, { label: "", value: "" }]), []);
});

test("the totals row is labelled and fills only the columns it has", () => {
  const csv = reportCsv({
    columns: [
      { key: "date", label: "Date" },
      { key: "kind", label: "Document", value: () => "Invoice" },
      { key: "debit", label: "Debit" },
    ],
    rows: [{ date: "2026-04-01", debit: 100 }],
    totals: { debit: 100 },
  });
  const lines = csv.replace(CSV_BOM, "").split("\r\n");
  assert.equal(lines.length, 3);
  // The BODY row DOES compute the derived column...
  assert.equal(lines[1], "2026-04-01,Invoice,100");
  // ...and the totals row does NOT. "Total,Invoice,100" would be a figure
  // invented for a column that has none.
  assert.equal(lines[2], "Total,,100");
});

test("a metadata value that looks like a formula is disarmed too", () => {
  const csv = reportCsv({ columns: [{ key: "a", label: "A" }], rows: [], meta: [{ label: "Firm", value: "=HYPERLINK(1)" }] });
  assert.match(csv, /Firm:,'=HYPERLINK\(1\)/);
});

console.log("\n--- the ZIP container ---");

test("a written archive reads back, entry for entry, CRC and all", () => {
  const bytes = zipBytes([
    { name: "a.txt", data: Buffer.from("hello") },
    { name: "dir/b.txt", data: Buffer.from("x".repeat(5000)) },
  ]);
  const files = unzip(bytes);
  assert.deepEqual(Object.keys(files), ["a.txt", "dir/b.txt"]);
  assert.equal(files["a.txt"], "hello");
  assert.equal(files["dir/b.txt"].length, 5000);
});

test("the same report exports to the same bytes", () => {
  // The date/time field is zeroed on purpose, so a test can assert on bytes
  // at all -- and so two downloads of an unchanged report are identical.
  const one = buildWorkbook({ sheets: [{ name: "S", columns: [{ key: "a", label: "A" }], rows: [{ a: 1 }] }] });
  const two = buildWorkbook({ sheets: [{ name: "S", columns: [{ key: "a", label: "A" }], rows: [{ a: 1 }] }] });
  assert.ok(one.equals(two));
});

console.log("\n--- the workbook ---");

const SHEET = {
  name: "Entries",
  title: "Customer Statement -- Acme Traders",
  meta: [{ label: "Firm", value: "Acme Traders, Delhi" }],
  columns: [
    { key: "date", label: "Date", type: "date", width: 12 },
    { key: "particulars", label: "Particulars", type: "text", width: 26 },
    { key: "qty", label: "Qty", type: "qty" },
    { key: "count", label: "Bills", type: "int" },
    { key: "debit", label: "Debit", type: "money" },
    { key: "credit", label: "Credit", type: "money" },
  ],
  rows: [
    { date: "2026-04-05", particulars: "Sales Invoice 12", qty: 2.5, count: 1, debit: 11800, credit: "" },
    { date: "2026-04-09", particulars: "=cmd|'/c calc'!A0", qty: "", count: 1, debit: "", credit: 5000 },
  ],
  totals: { debit: 11800, credit: 5000 },
  totalsLabel: "Period total",
};

test("it has every part Excel requires, and nothing else", () => {
  const files = unzip(buildWorkbook({ sheets: [SHEET] }));
  assert.deepEqual(Object.keys(files).sort(), [
    "[Content_Types].xml",
    "_rels/.rels",
    "xl/_rels/workbook.xml.rels",
    "xl/styles.xml",
    "xl/workbook.xml",
    "xl/worksheets/sheet1.xml",
  ]);
  // The relationship each part is reached through must actually point at it.
  assert.match(files["_rels/.rels"], /Target="xl\/workbook\.xml"/);
  assert.match(files["xl/_rels/workbook.xml.rels"], /Target="worksheets\/sheet1\.xml"/);
  assert.match(files["xl/_rels/workbook.xml.rels"], /Target="styles\.xml"/);
  // EVERY part must be declared, not just the ones a test happens to name:
  // an undeclared part makes Excel refuse the file outright.
  for (const part of Object.keys(files)) {
    if (part.endsWith(".rels") || part === "[Content_Types].xml") continue;
    assert.match(
      files["[Content_Types].xml"],
      new RegExp(`PartName="/${part.replace(/[.[\]]/g, "\\$&")}"`),
      `${part} is not declared in [Content_Types].xml`
    );
  }
});

test("money and quantities are NUMBERS with a display format, not strings", () => {
  const xml = unzip(buildWorkbook({ sheets: [SHEET] }))["xl/worksheets/sheet1.xml"];
  // A numeric cell is <v>11800</v> with no t="inlineStr". If this is ever
  // written as text, the column cannot be totalled in the spreadsheet and
  // the whole point of offering .xlsx is gone.
  assert.match(xml, new RegExp(`<c r="E5" s="${STYLE.money}"><v>11800</v></c>`));
  assert.match(xml, new RegExp(`<c r="C5" s="${STYLE.qty}"><v>2.5</v></c>`));
  assert.match(xml, new RegExp(`<c r="D5" s="${STYLE.int}"><v>1</v></c>`));
  assert.equal(/<c r="E5"[^>]*t="inlineStr"/.test(xml), false);
  // And the formats those styles point at are the ones declared.
  const styles = unzip(buildWorkbook({ sheets: [SHEET] }))["xl/styles.xml"];
  assert.match(styles, /numFmtId="165" formatCode="#,##0\.00"/);
  assert.match(styles, /numFmtId="166" formatCode="#,##0\.###"/);
  assert.match(styles, /numFmtId="164" formatCode="dd\\-mm\\-yyyy"/);
});

test("a date is the right serial, taken from the IST day", () => {
  // 1899-12-30 is serial 0, so 5 April 2026 is 46117. Checked against two
  // anchors as well, because an off-by-one here is a year of dates each a
  // day out and nothing looks wrong on the sheet.
  assert.equal(dateSerial("2026-04-05"), 46117);
  assert.equal(dateSerial("1900-01-01"), 2);
  assert.equal(dateSerial("2000-01-01"), 36526);
  // 19:00 UTC on 11 October is 00:30 IST on the 12th. The serial must be the
  // 12th, or a bill entered late at night exports a day early.
  assert.equal(dateSerial("2026-10-11T19:00:00Z"), dateSerial("2026-10-12"));
  assert.equal(dateSerial("2026-10-11T12:00:00Z"), dateSerial("2026-10-11"));
  assert.equal(dateSerial("not a date"), null);
});

test("an unparseable date falls back to text rather than to serial zero", () => {
  const xml = sheetXml({
    columns: [{ key: "d", label: "D", type: "date" }],
    rows: [{ d: "whenever" }],
  });
  // Serial 0 is 30 December 1899, which would print as a real date and read
  // as one. Text reads as what it is.
  assert.match(xml, /t="inlineStr"><is><t xml:space="preserve">whenever/);
  assert.equal(/<v>0<\/v>/.test(xml), false);
});

test("a figure column holding a word keeps the word instead of becoming zero", () => {
  const xml = sheetXml({
    columns: [{ key: "n", label: "N", type: "money" }],
    rows: [{ n: "not in master" }],
  });
  // Zeroing it would read as nothing owed, which is a different statement.
  assert.match(xml, /t="inlineStr"><is><t xml:space="preserve">not in master/);
});

test("an empty cell is omitted, so a blank is not a nought", () => {
  const xml = unzip(buildWorkbook({ sheets: [SHEET] }))["xl/worksheets/sheet1.xml"];
  // Row 5's Credit is "" and row 6's Debit is "". Neither must exist.
  assert.equal(/<c r="F5"/.test(xml), false, "a blank credit was written");
  assert.equal(/<c r="E6"/.test(xml), false, "a blank debit was written");
  // The same decision lib/blankZeros.mjs exists to protect.
  assert.match(xml, /<c r="F6"/);
});

test("AND A ZERO IS NOT A BLANK", () => {
  // The other half of the same rule, and the easier one to get wrong: a
  // falsy test treats 0 as absent, so a settled account's closing balance
  // vanishes from the sheet instead of reading 0.00.
  const xml = sheetXml({
    columns: [{ key: "n", label: "N", type: "money" }],
    rows: [{ n: 0 }],
  });
  assert.match(xml, new RegExp(`<c r="A2" s="${STYLE.money}"><v>0</v></c>`));
});

test("a blank metadata row is left out of the workbook too", () => {
  // Not only out of the CSV. A firm with no GSTIN must not get a row
  // reading "GSTIN:" with nothing beside it.
  const xml = sheetXml({
    columns: [{ key: "a", label: "A" }],
    rows: [{ a: 1 }],
    meta: [
      { label: "Firm", value: "Acme" },
      { label: "GSTIN", value: "" },
    ],
  });
  assert.equal(/GSTIN/.test(xml), false, "a valueless metadata row was written");
  assert.match(xml, /Firm:/);
  // One metadata row, so the headings are row 3 (block, blank, headings).
  assert.match(xml, new RegExp(`<c r="A3" s="${STYLE.head}"`));
});

test("the header row is bold, bordered and FROZEN", () => {
  const xml = unzip(buildWorkbook({ sheets: [SHEET] }))["xl/worksheets/sheet1.xml"];
  // Title on row 1, one metadata row, a blank, so the headings are row 4.
  assert.match(xml, new RegExp(`<c r="A4" s="${STYLE.head}"`));
  assert.match(xml, /<pane ySplit="4" topLeftCell="A5"[^>]*state="frozen"\/>/);
  const styles = unzip(buildWorkbook({ sheets: [SHEET] }))["xl/styles.xml"];
  // Style 1 is the header: bold font, a fill and a bottom border.
  assert.match(styles, /<xf numFmtId="0" fontId="1" fillId="2" borderId="1"/);
});

test("column widths are carried, and a column without one gets a default", () => {
  const xml = unzip(buildWorkbook({ sheets: [SHEET] }))["xl/worksheets/sheet1.xml"];
  assert.match(xml, /<col min="1" max="1" width="12" customWidth="1"\/>/);
  assert.match(xml, /<col min="2" max="2" width="26" customWidth="1"\/>/);
  assert.match(xml, /<col min="3" max="3" width="14" customWidth="1"\/>/);
});

test("the totals row is bold and fills only the columns it has", () => {
  const xml = unzip(buildWorkbook({ sheets: [SHEET] }))["xl/worksheets/sheet1.xml"];
  assert.match(xml, new RegExp(`<c r="A7" s="${STYLE.boldText}"[^>]*>.*?Period total`));
  assert.match(xml, new RegExp(`<c r="E7" s="${STYLE.boldMoney}"><v>11800</v></c>`));
  // Particulars has no total, so it is left out rather than being given one.
  assert.equal(/<c r="B7"/.test(xml), false);
});

test("a formula-looking string is an inline string, which a spreadsheet does not evaluate", () => {
  const xml = unzip(buildWorkbook({ sheets: [SHEET] }))["xl/worksheets/sheet1.xml"];
  // In SpreadsheetML a formula is an <f> element; a t="inlineStr" cell is
  // text whatever it starts with. So .xlsx needs no apostrophe, and adding
  // one would corrupt a legitimate party name. Checked rather than assumed.
  assert.match(
    xml,
    /<c r="B6"[^>]*t="inlineStr"><is><t xml:space="preserve">=cmd\|'\/c calc'!A0<\/t>/
  );
  assert.equal(/<f>/.test(xml), false, "something wrote a formula element");
});

test("XML is escaped, and the control characters that break a workbook are stripped", () => {
  assert.equal(xmlText('Shah & Co. <"A">'), "Shah &amp; Co. &lt;&quot;A&quot;&gt;");
  // A single 0x00 anywhere makes the whole workbook unopenable, with Excel
  // offering only to "recover" it -- and this app's masters are filled by
  // hand and by a bulk upload that has pasted from Word.
  assert.equal(xmlText("Acme\u0000 Traders\u001f"), "Acme Traders");
  // A tab, newline and carriage return are legal and kept.
  assert.equal(xmlText("a\tb\nc"), "a\tb\nc");
});

test("A1 notation holds past column Z", () => {
  assert.equal(cellRef(0, 1), "A1");
  assert.equal(cellRef(25, 3), "Z3");
  assert.equal(cellRef(26, 1), "AA1");
  assert.equal(cellRef(51, 1), "AZ1");
  assert.equal(cellRef(52, 1), "BA1");
});

console.log("\n--- sheet names ---");

test("a party name is made safe rather than making the file unopenable", () => {
  // []:*?/\ are illegal in a sheet name, and a workbook with an illegal one
  // does not warn -- it fails to open. "Shah & Co. (Delhi) / Unit 2" is an
  // ordinary party name.
  assert.equal(sheetName("Shah & Co. [Delhi] / Unit 2"), "Shah & Co. Delhi Unit 2");
  assert.equal(sheetName("A".repeat(40)).length, 31);
  assert.equal(sheetName(""), "Sheet1");
  assert.equal(sheetName("   "), "Sheet1");
  assert.equal(sheetName("'quoted'"), "quoted");
});

test("two sheets cannot end up with the same name", () => {
  // Excel refuses a workbook with duplicate sheet names, and two parties
  // agreeing in their first 31 characters is not hypothetical.
  const long = `${"Shri Balaji Trading Company Priv".slice(0, 31)}`;
  const files = unzip(
    buildWorkbook({
      sheets: [
        { name: `${long} Ltd`, columns: [{ key: "a", label: "A" }], rows: [] },
        { name: `${long} LLP`, columns: [{ key: "a", label: "A" }], rows: [] },
      ],
    })
  );
  const names = [...files["xl/workbook.xml"].matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(names.length, 2);
  assert.notEqual(names[0], names[1]);
  assert.ok(names.every((n) => n.length <= 31));
});

test("several sheets each get their own part and relationship", () => {
  const files = unzip(
    buildWorkbook({
      sheets: [
        { name: "Month summary", columns: [{ key: "a", label: "A" }], rows: [{ a: 1 }] },
        { name: "Entries", columns: [{ key: "b", label: "B" }], rows: [{ b: 2 }] },
      ],
    })
  );
  assert.ok(files["xl/worksheets/sheet1.xml"]);
  assert.ok(files["xl/worksheets/sheet2.xml"]);
  assert.match(files["xl/worksheets/sheet1.xml"], />A</);
  assert.match(files["xl/worksheets/sheet2.xml"], />B</);
  assert.match(files["xl/_rels/workbook.xml.rels"], /rId2".*worksheets\/sheet2\.xml/);
});

test("an empty report still produces a workbook that opens", () => {
  const files = unzip(buildWorkbook({}));
  assert.ok(files["xl/worksheets/sheet1.xml"]);
  assert.match(files["xl/workbook.xml"], /name="Sheet1"/);
});

console.log("\n--- filenames and formats ---");

test("a filename says what it is, for whom and when", () => {
  assert.equal(
    reportFilename({
      report: "customer-statement",
      subject: "Acme Traders, Delhi (HO)",
      from: "2026-04-01",
      to: "2026-06-30",
      format: "xlsx",
    }),
    "customer-statement-acme-traders-delhi-ho-2026-04-01-to-2026-06-30.xlsx"
  );
  // Nothing a filesystem argues about survives.
  assert.equal(/[^a-z0-9.\-]/.test(reportFilename({ report: "x", subject: 'a/b\\c:"d*' })), false);
  assert.equal(reportFilename({}), "report.csv");
});

test("only the three formats are formats", () => {
  assert.deepEqual(REPORT_FORMATS, ["json", "csv", "xlsx"]);
  assert.equal(isReportFormat("json"), true);
  assert.equal(isReportFormat("xlsx"), true);
  assert.equal(isReportFormat("pdf"), false);
  // An absent format means json, which is what the screen asks for.
  assert.equal(isReportFormat(""), true);
});

console.log("\n--- wiring ---");

test("there is one CSV writer, and the old home re-exports it", () => {
  const orders = read("../lib/orderReports.mjs");
  assert.match(orders, /export \{ csvCell, toCsv \} from "\.\/csv\.mjs";/);
  // The copy is gone, so the escaping rules exist once.
  assert.equal(/export const csvCell = \(/.test(orders), false);
  assert.equal(/export const toCsv = \(/.test(orders), false);
});

test("every report module reaches the same writer", () => {
  // Through lib/csv.mjs or through the re-export; what matters is that none
  // of them has its own.
  for (const file of ["../lib/accountBooks.mjs", "../lib/salesReports.mjs", "../lib/gstReturns.mjs"]) {
    const src = read(file);
    assert.equal(/const csvCell = \(value\) => \{/.test(src), false, `${file} has its own csvCell`);
  }
});

test("the export route helper builds both formats from ONE column list", () => {
  const http = read("../lib/reportHttp.js");
  // The CSV takes sheets[0] and the workbook takes them all, both off the
  // same `sheets` argument -- so a column cannot be called two things.
  assert.match(http, /const sheet = sheets\[0\]/);
  assert.match(http, /buildWorkbook\(\{ sheets \}\)/);
  assert.match(http, /columns: sheet\.columns/);
});

test("the xlsx writer adds no dependency", () => {
  const src = read("../lib/xlsx.mjs");
  const imports = [...src.matchAll(/^import .*? from "([^"]+)";$/gm)].map((m) => m[1]);
  for (const name of imports) {
    assert.ok(
      name.startsWith("node:") || name.startsWith("./"),
      `lib/xlsx.mjs imports "${name}", which is a dependency`
    );
  }
  const pkg = JSON.parse(read("../package.json"));
  for (const name of ["xlsx", "exceljs", "write-excel-file", "node-xlsx"]) {
    assert.equal(name in pkg.dependencies, false, `${name} was added as a dependency`);
  }
});

console.log(`\n  ${passed} checks passed\n`);
