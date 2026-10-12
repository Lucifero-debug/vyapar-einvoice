/**
 * A dependency-free .xlsx writer.
 *
 * Pure in the sense this project means it -- no Mongoose, no npm package,
 * runnable under bare `node`, so scripts/report-export.test.mjs exercises it
 * directly. It imports `node:zlib`, which is a Node builtin and not a
 * dependency; lib/password.mjs already imports `node:crypto` on the same
 * reasoning.
 *
 *
 * WHY NOT A LIBRARY
 * -----------------
 * The two candidates were both the wrong trade here. SheetJS's npm package
 * (`xlsx`) is deprecated on npm and is distributed from the vendor's own CDN;
 * ExcelJS is upwards of a megabyte in a serverless bundle, for a feature that
 * writes a table with four number formats. An .xlsx is a ZIP of XML, and the
 * part of the format a report needs -- a sheet, a header row, column widths,
 * a frozen pane and four number formats -- is small, stable since 2007, and
 * fully specified. Writing it means the export cannot break on a dependency
 * upgrade and adds nothing to what Vercel ships.
 *
 * What this deliberately does NOT do: formulas, charts, merged cells, images,
 * conditional formatting, styles beyond the ones listed below. A report that
 * needs any of those is a report that wants a template, not a writer.
 *
 *
 * NUMBERS ARE WRITTEN AS NUMBERS
 * ------------------------------
 * The whole reason to offer .xlsx beside .csv is that the figures arrive as
 * figures: a column of amounts the shop can total, sort and pivot. So a money
 * column is written as a bare `<v>1234.5</v>` with a DISPLAY format of
 * `#,##0.00`, never as the string "1,234.50" -- which is what every
 * hand-rolled export gets wrong and which turns the column into text the
 * moment it reaches Excel.
 *
 * Dates likewise: an Excel date is a serial day count, and ours are IST
 * calendar days throughout this app (lib/istDate.mjs), so the serial is
 * computed from the IST parts and not from the server's clock. A bill dated
 * the 1st must not export as the 31st because Vercel runs in UTC.
 */

import { deflateRawSync } from "node:zlib";
import { istParts } from "./istDate.mjs";

const text = (value) => String(value ?? "").trim();

/* ─────────────────────────────── the ZIP ────────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

export const crc32 = (bytes) => {
  let c = -1;
  for (let i = 0; i < bytes.length; i += 1) {
    c = (c >>> 8) ^ CRC_TABLE[(c ^ bytes[i]) & 0xff];
  }
  return (c ^ -1) >>> 0;
};

const utf8 = (s) => Buffer.from(String(s), "utf8");

/**
 * A ZIP archive, deflated.
 *
 * `entries` are `{ name, data }` with `data` a Buffer or Uint8Array. Written
 * with 32-bit sizes and no ZIP64, which caps one entry -- and so one sheet's
 * XML -- at 4GB. A report that large has other problems; the export route
 * refuses long before this.
 *
 * Every entry is stored with the DEFLATE method and a zeroed date/time field.
 * A fixed timestamp means the same report exports to byte-identical bytes,
 * which is what lets a test assert on them at all.
 */
export const zipBytes = (entries = []) => {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = utf8(entry.name);
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const deflated = deflateRawSync(raw, { level: 9 });
    const sum = crc32(raw);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);

    const head = Buffer.alloc(46 + name.length);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4); // made by
    head.writeUInt16LE(20, 6); // version needed
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(8, 10);
    head.writeUInt16LE(0, 12);
    head.writeUInt16LE(0, 14);
    head.writeUInt32LE(sum, 16);
    head.writeUInt32LE(deflated.length, 20);
    head.writeUInt32LE(raw.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt16LE(0, 30); // extra
    head.writeUInt16LE(0, 32); // comment
    head.writeUInt16LE(0, 34); // disk
    head.writeUInt16LE(0, 36); // internal attrs
    head.writeUInt32LE(0, 38); // external attrs
    head.writeUInt32LE(offset, 42);
    name.copy(head, 46);

    locals.push(local, deflated);
    central.push(head);
    offset += local.length + deflated.length;
  }

  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, dir, end]);
};

/* ────────────────────────────── the XML ─────────────────────────────── */

/**
 * XML text, escaped -- and stripped of the control characters XML 1.0 forbids
 * outright.
 *
 * The strip is not pedantry. A single stray 0x00 or 0x1f anywhere in a party
 * name makes the whole workbook unopenable, with Excel offering only to
 * "recover" it; and this app's masters are filled by hand and by a bulk
 * upload that has pasted from Word before now.
 */
export const xmlText = (value) =>
  String(value ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** A1, B1 ... Z1, AA1. */
export const cellRef = (col, row) => {
  let name = "";
  let n = col;
  while (n >= 0) {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  }
  return `${name}${row}`;
};

/**
 * An Excel date serial, from the IST calendar day.
 *
 * Day 1 is 1 January 1900, and Excel believes 1900 was a leap year, so for
 * every date after 28 February 1900 the serial is the count of days since
 * 1899-12-30. Every date this app will ever export is after 1900, so the
 * single epoch is correct and the leap-year branch nobody tests is not here.
 */
export const dateSerial = (value) => {
  const p = istParts(value);
  if (!p) return null;
  const days = Math.floor(Date.UTC(p.year, p.month - 1, p.day) / 86400000);
  // Date.UTC(1899, 11, 30) / 86400000 === -25569.
  return days + 25569;
};

/**
 * The style table.
 *
 * Fixed and small, because the set of things a report cell can be is fixed
 * and small. The `STYLE` map below is the only thing the sheet writer knows
 * about styling, so a new format is one entry here and one `type` on a
 * column -- not a styling engine.
 */
const NUM_FMTS = [
  { id: 164, code: "dd\\-mm\\-yyyy" },
  { id: 165, code: "#,##0.00" },
  { id: 166, code: "#,##0.###" },
  { id: 167, code: "#,##0" },
];

export const STYLE = {
  text: 0,
  head: 1,
  date: 2,
  money: 3,
  qty: 4,
  int: 5,
  boldText: 6,
  boldMoney: 7,
  boldQty: 8,
  boldInt: 9,
  title: 10,
};

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="${NUM_FMTS.length}">${NUM_FMTS.map(
  (f) => `<numFmt numFmtId="${f.id}" formatCode="${f.code}"/>`
).join("")}</numFmts>
<fonts count="3">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="13"/><name val="Calibri"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F9"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FF94A3B8"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="11">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="165" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="166" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="167" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
</styleSheet>`;

/** Which style a column's cells take, and its bold counterpart. */
const COLUMN_STYLE = {
  text: [STYLE.text, STYLE.boldText],
  date: [STYLE.date, STYLE.date],
  money: [STYLE.money, STYLE.boldMoney],
  qty: [STYLE.qty, STYLE.boldQty],
  int: [STYLE.int, STYLE.boldInt],
};

const NUMERIC = new Set(["money", "qty", "int"]);

/**
 * A sheet name Excel will accept.
 *
 * 31 characters, and none of []:*?/\ -- a workbook with an illegal sheet name
 * does not warn, it fails to open. Party names reach this function (a
 * statement is titled after its party), and "Shah & Co. (Delhi) / Unit 2" is
 * an ordinary one.
 */
export const sheetName = (value, fallback = "Sheet1") => {
  const cleaned = text(value).replace(/[[\]:*?/\\]/g, " ").replace(/\s+/g, " ").trim();
  const capped = cleaned.slice(0, 31).replace(/^'+|'+$/g, "").trim();
  return capped || fallback;
};

const cellXml = (ref, style, value, type) => {
  if (value === null || value === undefined || value === "") {
    // An empty cell is omitted rather than written blank. A written-but-empty
    // numeric cell is what makes Excel show 0 where the report means "no
    // figure" -- the same distinction lib/blankZeros.mjs exists to protect.
    return "";
  }
  if (type === "date") {
    const serial = dateSerial(value);
    if (serial === null) return `<c r="${ref}" s="${STYLE.text}" t="inlineStr"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`;
    return `<c r="${ref}" s="${style}"><v>${serial}</v></c>`;
  }
  if (NUMERIC.has(type)) {
    const n = Number(value);
    if (!Number.isFinite(n)) {
      // Not silently zeroed: a column that should hold a figure and holds
      // "n/a" says so, as text, rather than reading as nothing owed.
      return `<c r="${ref}" s="${STYLE.text}" t="inlineStr"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`;
    }
    return `<c r="${ref}" s="${style}"><v>${n}</v></c>`;
  }
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`;
};

/**
 * One worksheet's XML.
 *
 * Layout, top to bottom: an optional title row, the metadata block (one
 * label/value pair per row), a blank row, the column headings, the data rows,
 * and an optional totals row. The frozen pane is set to the heading row, so
 * scrolling a thousand-line ledger keeps the headings in view -- which is the
 * single thing that makes a long export usable.
 */
export const sheetXml = ({
  columns = [],
  rows = [],
  meta = [],
  title = "",
  totals = null,
  totalsLabel = "Total",
  freezeHeader = true,
} = {}) => {
  const lines = [];
  let r = 0;

  const row = (cells) => {
    r += 1;
    const body = cells.join("");
    lines.push(`<row r="${r}">${body}</row>`);
  };

  if (text(title)) row([cellXml(cellRef(0, r + 1), STYLE.title, text(title), "text")]);

  for (const m of meta || []) {
    // No value, no row -- see the same rule in lib/csv.mjs's csvMetaBlock.
    if (!text(m?.value)) continue;
    const at = r + 1;
    row([
      cellXml(cellRef(0, at), STYLE.boldText, text(m.label) ? `${text(m.label)}:` : "", "text"),
      cellXml(cellRef(1, at), STYLE.text, m.value, "text"),
    ]);
  }

  // A blank row between the block and the table, so a spreadsheet's
  // "first row is the header" guess lands on the headings once the block is
  // deleted -- and so the table reads as a table.
  if (r > 0) r += 1;

  const headerRow = r + 1;
  row(
    columns.map((c, i) => cellXml(cellRef(i, headerRow), STYLE.head, c.label ?? c.key, "text"))
  );

  for (const data of rows || []) {
    const at = r + 1;
    row(
      columns.map((c, i) => {
        const type = c.type || "text";
        const value = typeof c.value === "function" ? c.value(data) : data?.[c.key];
        return cellXml(cellRef(i, at), COLUMN_STYLE[type]?.[0] ?? STYLE.text, value, type);
      })
    );
  }

  if (totals) {
    const at = r + 1;
    row(
      columns.map((c, i) => {
        const type = c.type || "text";
        if (i === 0) return cellXml(cellRef(0, at), STYLE.boldText, totalsLabel, "text");
        // Only the columns the totals object actually carries. Calling a
        // derived column's `value()` on a totals row invents a figure --
        // a "Document" column reading "Invoice" under the word Total.
        //
        // Belt and braces: `cellXml` already omits an undefined value, so
        // removing this line produces byte-identical output and
        // mutate-export.mjs retires that mutant as equivalent. Kept because
        // it states the rule where a reader looks for it, and because a
        // future `cellXml` that printed something for undefined would
        // otherwise silently start inventing totals.
        if (!(c.key in (totals || {}))) return "";
        return cellXml(cellRef(i, at), COLUMN_STYLE[type]?.[1] ?? STYLE.boldText, totals[c.key], type);
      })
    );
  }

  const cols = columns.length
    ? `<cols>${columns
        .map(
          (c, i) =>
            `<col min="${i + 1}" max="${i + 1}" width="${
              Number(c.width) > 0 ? Number(c.width) : 14
            }" customWidth="1"/>`
        )
        .join("")}</cols>`
    : "";

  const pane =
    freezeHeader && columns.length
      ? `<pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/>`
      : "";

  const dimension = columns.length ? `<dimension ref="A1:${cellRef(columns.length - 1, Math.max(1, r))}"/>` : "";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${dimension}<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${cols}<sheetData>${lines.join(
    ""
  )}</sheetData></worksheet>`;
};

/**
 * A workbook, as bytes.
 *
 * `sheets` is an array of the spec `sheetXml` takes, each with a `name`. The
 * spec asks for summary and detail on separate worksheets for multi-section
 * reports, which is why this takes a list rather than one sheet.
 */
export const buildWorkbook = ({ sheets = [] } = {}) => {
  const used = new Set();
  const list = (sheets.length ? sheets : [{ name: "Sheet1", columns: [], rows: [] }]).map(
    (sheet, index) => {
      // Excel refuses a workbook with two sheets of the same name, and two
      // statements for parties whose names agree in their first 31 characters
      // is not a hypothetical.
      let name = sheetName(sheet.name, `Sheet${index + 1}`);
      let n = 2;
      while (used.has(name.toLowerCase())) {
        const suffix = ` (${n})`;
        name = `${name.slice(0, 31 - suffix.length)}${suffix}`;
        n += 1;
      }
      used.add(name.toLowerCase());
      return { ...sheet, name };
    }
  );

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${list
  .map(
    (_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  )
  .join("\n")}
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${list
    .map((s, i) => `<sheet name="${xmlText(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join("")}</sheets>
</workbook>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${list
  .map(
    (_, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
  )
  .join("\n")}
<Relationship Id="rId${list.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  return zipBytes([
    { name: "[Content_Types].xml", data: utf8(contentTypes) },
    { name: "_rels/.rels", data: utf8(rootRels) },
    { name: "xl/workbook.xml", data: utf8(workbook) },
    { name: "xl/_rels/workbook.xml.rels", data: utf8(workbookRels) },
    { name: "xl/styles.xml", data: utf8(STYLES_XML) },
    ...list.map((sheet, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: utf8(sheetXml(sheet)),
    })),
  ]);
};
