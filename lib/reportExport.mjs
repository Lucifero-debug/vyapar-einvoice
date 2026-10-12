/**
 * The parts of an export that are not HTTP.
 *
 * Pure and dependency-free, like the rest of lib/*.mjs, so `node` can run
 * scripts/report-export.test.mjs directly -- which is the whole reason this
 * is separate from lib/reportHttp.js. That module imports NextResponse and
 * therefore cannot be loaded by a test under bare node; the format list, the
 * validation and the filename can, and they are the parts worth asserting on.
 *
 * lib/reportHttp.js re-exports every name here, so a route imports one module
 * and nothing has two homes.
 */

const text = (value) => String(value ?? "").trim();

export const REPORT_FORMATS = ["json", "csv", "xlsx"];

/**
 * Is this a format? An ABSENT one is, and means json.
 *
 * Deliberately permissive about blank and strict about everything else: the
 * screen's own request carries no `format` at all, while `format=pdf` is a
 * caller asking for something this app does not make and should be told so
 * rather than quietly handed JSON.
 */
export const isReportFormat = (format) => REPORT_FORMATS.includes(text(format) || "json");

/** The requested format, defaulting to json. */
export const formatOf = (searchParams) => text(searchParams?.get?.("format")) || "json";

/**
 * A filename a shop can find again: the report, the party, the period, the
 * extension. Nothing a filesystem or a mail client argues about.
 *
 *   customer-statement-acme-traders-2026-04-01-to-2026-06-30.xlsx
 *
 * The subject is slugged rather than quoted. "Acme Traders, Delhi (HO)" in a
 * Content-Disposition filename is a header a browser mangles, truncates at
 * the comma, or refuses outright depending on which browser it is.
 */
export const reportFilename = ({ report, subject, from, to, format = "csv" } = {}) => {
  const slug = (value) =>
    text(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "");

  const parts = [slug(report) || "report", slug(subject)].filter(Boolean);
  if (text(from) || text(to)) parts.push(`${text(from) || "start"}-to-${text(to) || "end"}`);
  return `${parts.join("-")}.${slug(format) || "csv"}`;
};

/**
 * The headers every report answer carries.
 *
 * A download is never a cached download: the figures changed the moment
 * somebody saved a bill, and a browser handing back last week's spreadsheet
 * from its cache is indistinguishable from a reporting bug.
 */
export const NO_STORE = Object.freeze({ "Cache-Control": "no-store, max-age=0" });

export const CSV_CONTENT_TYPE = "text/csv; charset=utf-8";

export const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** `attachment; filename="..."`, with the name already made safe above. */
export const contentDisposition = (filename) =>
  `attachment; filename="${text(filename).replace(/["\\]/g, "")}"`;
