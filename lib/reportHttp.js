/**
 * Turning a built report into a JSON, CSV or XLSX response.
 *
 * NOT a lib/*.mjs: it imports NextResponse, so it cannot run under bare node
 * and does not pretend to. The arithmetic and the bytes are built by the pure
 * modules (lib/csv.mjs, lib/xlsx.mjs); what is here is the three content
 * types, the filename and the no-store headers.
 *
 *
 * THE EXPORT IS THE SAME ROUTE AS THE REPORT, ON PURPOSE
 * -----------------------------------------------------
 * The spec's rule is that a user who cannot see a report must not be able to
 * download it by calling the export endpoint directly. The surest way to
 * guarantee that is to have no separate export endpoint at all: every report
 * route takes `format=json|csv|xlsx` and answers in that shape, so the
 * permission, the tenant scope, the filters and the figures are literally the
 * same code path. A second route would be a second place for the permission
 * table to fall out of step -- and the one place it fell out of step would be
 * the one that hands over a spreadsheet of the whole book.
 *
 * It also settles the spec's "exports must match the visible report": they
 * are built from the same object. The only difference the format makes is
 * that a paginated screen slices `rows` for display while the export is
 * handed the unsliced array.
 */

import { NextResponse } from "next/server";
import { reportCsv } from "./csv.mjs";
import { buildWorkbook } from "./xlsx.mjs";
// The format list, the validation, the filename and the headers are pure, so
// they live in a module bare `node` can load and a test can assert on. See
// the header there.
import {
  CSV_CONTENT_TYPE,
  NO_STORE as noStore,
  XLSX_CONTENT_TYPE,
  contentDisposition,
  formatOf,
  isReportFormat,
  reportFilename,
} from "./reportExport.mjs";

const text = (value) => String(value ?? "").trim();

// Re-exported so a route imports one module rather than two.
export { formatOf, isReportFormat, reportFilename };
export { REPORT_FORMATS } from "./reportExport.mjs";

/**
 * One report, in the format asked for.
 *
 * `json`  - `payload`, as it is.
 * `csv`   - the FIRST sheet only, with its metadata block, BOM and totals.
 *           CSV is one table; a multi-section report downloads as .xlsx.
 * `xlsx`  - every sheet, each with its own columns, widths and frozen header.
 *
 * `sheets` is the shape lib/xlsx.mjs takes: `{ name, title, meta, columns,
 * rows, totals, totalsLabel }`. The same array drives both file formats, so
 * the CSV and the workbook cannot disagree about what a column is called --
 * the mistake lib/salesReports.mjs's CSV_COLUMNS comment was written about.
 */
export function reportResponse({
  format = "json",
  payload = null,
  sheets = [],
  filename = {},
} = {}) {
  const kind = text(format) || "json";

  if (kind === "json") {
    return NextResponse.json(payload ?? { success: true }, { headers: noStore });
  }

  if (!Array.isArray(sheets) || !sheets.length) {
    return NextResponse.json(
      { success: false, error: "There is nothing in this report to export." },
      { status: 400, headers: noStore }
    );
  }

  if (kind === "csv") {
    const sheet = sheets[0];
    const body = reportCsv({
      columns: sheet.columns || [],
      rows: sheet.rows || [],
      meta: [...(sheet.title ? [{ label: "", value: sheet.title }] : []), ...(sheet.meta || [])],
      totals: sheet.totals || null,
      totalsLabel: sheet.totalsLabel || "Total",
    });
    const name = reportFilename({ ...filename, format: "csv" });
    return new NextResponse(body, {
      headers: {
        ...noStore,
        // charset=utf-8 AND the BOM reportCsv writes. Excel on Windows needs
        // the BOM; everything else needs the charset; neither is enough alone.
        "Content-Type": CSV_CONTENT_TYPE,
        "Content-Disposition": contentDisposition(name),
      },
    });
  }

  if (kind === "xlsx") {
    const bytes = buildWorkbook({ sheets });
    const name = reportFilename({ ...filename, format: "xlsx" });
    return new NextResponse(bytes, {
      headers: {
        ...noStore,
        "Content-Type": XLSX_CONTENT_TYPE,
        "Content-Disposition": contentDisposition(name),
        "Content-Length": String(bytes.length),
      },
    });
  }

  return NextResponse.json(
    { success: false, error: `"${kind}" is not a format. Use json, csv or xlsx.` },
    { status: 400, headers: noStore }
  );
}
