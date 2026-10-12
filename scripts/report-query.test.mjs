/**
 * Report filters in the URL: reading a shared link, writing the filters
 * back, and the pages that do both.
 *
 *   node scripts/report-query.test.mjs
 *
 * lib/reportQuery.mjs is the one place each report's filters are declared;
 * components/reports/ReportUrlSync.jsx reads them once and writes them back
 * with history.replaceState. These pin the rules a shared link depends on:
 * invalid values are dropped rather than trusted, defaults stay out of the
 * URL, dates are always written, presets stay presets, and the round trip is
 * exact.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  REPORT_QUERIES as Q,
  buildReportQuery,
  isIsoDate,
  isIsoMonth,
  parseReportQuery,
  sameQuery,
} from "../lib/reportQuery.mjs";
import { ALL_PRESETS, PRESET_LABELS, resolvePeriod } from "../lib/reportPeriods.mjs";

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

/** What a page's onRestore receives after a link is opened. */
const restore = (schema, qs) => parseReportQuery(schema, new URLSearchParams(qs)).values;
/** Open a link, apply it over the page's defaults, write it back. */
const roundTrip = (schema, defaults, qs) => buildReportQuery(schema, { ...defaults, ...restore(schema, qs) });

/* ============================================================ basics ==== */

console.log("\n--- dates and months ---");

test("a date is a real calendar day", () => {
  for (const ok of ["2026-04-01", "2024-02-29", "2026-12-31"]) assert.equal(isIsoDate(ok), true, ok);
  for (const bad of ["2026-02-31", "2025-02-29", "2026-13-01", "26-04-01", "2026-4-1", "01-04-2026", "", "2026-04-01T00:00", "<script>"]) {
    assert.equal(isIsoDate(bad), false, bad);
  }
});

test("a month is yyyy-mm", () => {
  assert.equal(isIsoMonth("2026-04"), true);
  for (const bad of ["2026-00", "2026-13", "2026-4", "April"]) assert.equal(isIsoMonth(bad), false, bad);
});

/* ============================================================ reading ==== */

console.log("\n--- reading a link ---");

test("valid values are returned; nothing is invented for absent ones", () => {
  const { values, invalid, present } = parseReportQuery(Q.salesReport, "side=Purchase&view=item&from=2026-04-01&to=2026-04-30");
  assert.deepEqual(values, { side: "Purchase", view: "item", from: "2026-04-01", to: "2026-04-30" });
  assert.deepEqual(invalid, []);
  assert.equal(present, true);
});

test("invalid values are dropped and named, so the page keeps its own default", () => {
  const { values, invalid } = parseReportQuery(
    Q.salesReport,
    "side=Gift&view=pdf&scope=all&grain=year&month=2026-13&from=2026-02-31&to=yesterday"
  );
  assert.deepEqual(values, {});
  assert.deepEqual(invalid.sort(), ["from", "grain", "month", "scope", "side", "to", "view"]);
});

test("values are compared exactly -- no case folding, no partial matches", () => {
  assert.deepEqual(restore(Q.salesReport, "side=sale&view=Book"), {});
  assert.deepEqual(restore(Q.gstReturn, "view=gstr3b"), { view: "gstr3b" });
  assert.deepEqual(restore(Q.gstReturn, "view=gstr3"), { view: "gstr3" });
  assert.deepEqual(restore(Q.gstReturn, "view=gstr"), {});
});

test("an empty URL names no filters", () => {
  for (const schema of Object.values(Q)) {
    const r = parseReportQuery(schema, "");
    assert.deepEqual(r.values, {});
    assert.equal(r.present, false);
  }
  assert.equal(parseReportQuery(Q.salesReport, null).present, false);
});

test("blank dates: allowed where the route reads them as open, refused where it needs them", () => {
  assert.deepEqual(restore(Q.salesReport, "from=&to="), { from: "", to: "" });
  assert.deepEqual(restore(Q.gstReturn, "from=&to="), {}, "GST needs both dates");
});

test("free text is capped, and stays text", () => {
  assert.deepEqual(restore(Q.orderReport, "customer=Shah%20%26%20Co"), { party: "Shah & Co" });
  assert.deepEqual(restore(Q.orderReport, `customer=${"x".repeat(500)}`), {});
  // A query operator is just a string here -- it is never a filter object.
  assert.deepEqual(restore(Q.orderReport, "customer[$ne]=x"), {});
});

test("booleans and stock figures", () => {
  assert.deepEqual(restore(Q.financials, "expand=1&closingStock=1250.50&openingStock=-3"), {
    expand: true,
    closingStock: "1250.50",
    openingStock: "-3",
  });
  assert.deepEqual(restore(Q.financials, "expand=maybe&closingStock=0x10&openingStock=12abc"), {});
  // A number box accepts an exponent and the route reads it with Number(),
  // so a link must carry it rather than silently drop the override.
  assert.deepEqual(restore(Q.financials, "closingStock=1e5"), { closingStock: "1e5" });
});

test("any reader shape: URLSearchParams, a string, a plain object", () => {
  const want = { view: "gstr3b" };
  assert.deepEqual(parseReportQuery(Q.gstReturn, new URLSearchParams("view=gstr3b")).values, want);
  assert.deepEqual(parseReportQuery(Q.gstReturn, "?view=gstr3b").values, want);
  assert.deepEqual(parseReportQuery(Q.gstReturn, { view: "gstr3b" }).values, want);
});

/* ============================================================ writing ==== */

console.log("\n--- writing the filters back ---");

const SALES_DEFAULTS = { side: "Sale", view: "book", scope: "both", grain: "month", month: "", from: "2026-10-01", to: "2026-10-31" };

test("defaults stay out of the URL; dates never do", () => {
  // A sales book at every default is just its period -- and the period IS
  // written, because "this month" means something else next month.
  assert.equal(buildReportQuery(Q.salesReport, SALES_DEFAULTS), "from=2026-10-01&to=2026-10-31");
});

test("a changed filter appears, in the schema's order", () => {
  assert.equal(
    buildReportQuery(Q.salesReport, { ...SALES_DEFAULTS, to: "2026-10-15", side: "Purchase", grain: "document" }),
    "side=Purchase&grain=document&from=2026-10-01&to=2026-10-15"
  );
});

test("clearing a filter -- setting it back -- removes it from the URL", () => {
  const changed = buildReportQuery(Q.orderReport, { type: "Purchase", view: "register", from: "2026-04-01", to: "2026-10-12", party: "Shah", item: "Bolt" });
  assert.match(changed, /type=Purchase/);
  assert.match(changed, /customer=Shah/);
  const cleared = buildReportQuery(Q.orderReport, { type: "Sale", view: "register", from: "2026-04-01", to: "2026-10-12", party: "", item: "" });
  assert.equal(cleared, "from=2026-04-01&to=2026-10-12");
});

test("a cleared date box is written as cleared, so the link reopens cleared", () => {
  const qs = buildReportQuery(Q.salesReport, { ...SALES_DEFAULTS, from: "" });
  assert.equal(qs, "from=&to=2026-10-31");
  assert.deepEqual(restore(Q.salesReport, qs), { from: "", to: "2026-10-31" });
});

test("an invalid value in state is never written", () => {
  assert.equal(buildReportQuery(Q.gstReturn, { view: "nonsense", from: "2026-02-31", to: "2026-03-31" }), "to=2026-03-31");
});

test("the order report keeps the link key it always read (`customer`)", () => {
  assert.match(buildReportQuery(Q.orderReport, { view: "register", from: "2026-04-01", to: "2026-04-30", party: "Shah" }), /customer=Shah/);
  assert.doesNotMatch(buildReportQuery(Q.orderReport, { party: "Shah" }), /party=/);
});

test("the order report's dates belong to the register only", () => {
  const pending = buildReportQuery(Q.orderReport, { type: "Sale", view: "party-pending", from: "2026-04-01", to: "2026-10-12", party: "", item: "" });
  assert.equal(pending, "view=party-pending");
});

/* ============================================================ presets ==== */

console.log("\n--- the thirteen presets ---");

test("all thirteen presets are still there, with their labels", () => {
  assert.equal(ALL_PRESETS.length, 13);
  for (const key of ALL_PRESETS) assert.ok(PRESET_LABELS[key], `${key} has no label`);
});

test("every preset round-trips as itself, not as frozen dates", () => {
  for (const preset of ALL_PRESETS.filter((p) => p !== "custom")) {
    const period = resolvePeriod({ preset, now: Date.parse("2026-10-12T06:30:00Z") });
    const qs = buildReportQuery(Q.statement, { side: "customer", account: "Shah", view: "detailed", preset, from: period.from, to: period.to });
    assert.doesNotMatch(qs, /from=|to=/, `${preset} froze its dates into the link`);
    const back = restore(Q.statement, qs);
    assert.equal(back.preset ?? "thisFy", preset);
  }
});

test("custom writes its dates, and they come back", () => {
  const qs = buildReportQuery(Q.accountBook, { kind: "bank", account: "HDFC", group: "", preset: "custom", from: "2026-04-01", to: "2026-06-30", daywise: true });
  assert.equal(qs, "kind=bank&account=HDFC&preset=custom&from=2026-04-01&to=2026-06-30&daywise=1");
  assert.deepEqual(restore(Q.accountBook, qs), {
    kind: "bank", account: "HDFC", preset: "custom", from: "2026-04-01", to: "2026-06-30", daywise: true,
  });
});

test("a preset resolves in IST: a link opened at 11:30 pm IST on 31 March is still March", () => {
  // 18:00 UTC on 31 March is 23:30 IST, still inside FY 2025-26.
  const period = resolvePeriod({ preset: "thisMonth", now: Date.parse("2026-03-31T18:00:00Z") });
  assert.equal(period.from, "2026-03-01");
  assert.equal(period.to, "2026-03-31");
  const fy = resolvePeriod({ preset: "thisFy", now: Date.parse("2026-03-31T18:00:00Z") });
  assert.equal(fy.from, "2025-04-01");
});

test("an unknown preset is dropped", () => {
  assert.deepEqual(restore(Q.statement, "preset=thisDecade"), {});
});

/* ========================================================= round trips === */

console.log("\n--- a shared link restores the same report ---");

test("every report: build -> parse -> build is the same string", () => {
  const cases = [
    [Q.salesReport, { side: "Purchase", view: "book", scope: "returns", grain: "date", month: "2026-04", from: "2026-04-01", to: "2026-04-30" }],
    [Q.gstReturn, { view: "gstr3b", from: "2026-09-01", to: "2026-09-30" }],
    [Q.financials, { kind: "balance", from: "2026-04-01", to: "2026-09-30", expand: true, closingStock: "1500", openingStock: "" }],
    [Q.orderReport, { type: "Purchase", view: "register", from: "2026-04-01", to: "2026-10-12", party: "Mehta & Sons", item: "Bolt 8mm" }],
    [Q.statement, { side: "supplier", account: "Bharat Steel", view: "monthly", preset: "prevQuarter", from: "", to: "" }],
    [Q.accountBook, { kind: "ledger", account: "", group: "Sundry Debtors", preset: "thisFy", from: "", to: "", daywise: false }],
  ];
  for (const [schema, values] of cases) {
    const once = buildReportQuery(schema, values);
    const twice = buildReportQuery(schema, restore(schema, once));
    assert.equal(twice, once);
  }
});

test("a page with defaults restores exactly what the sender saw", () => {
  const sent = buildReportQuery(Q.salesReport, { ...SALES_DEFAULTS, side: "Purchase", view: "party" });
  // The recipient's own default month differs; the link wins.
  const theirs = { ...SALES_DEFAULTS, from: "2026-11-01", to: "2026-11-30" };
  assert.equal(roundTrip(Q.salesReport, theirs, sent), sent);
});

test("a link with junk in it settles to a clean URL", () => {
  const settled = roundTrip(Q.gstReturn, { view: "gstr1", from: "2026-09-01", to: "2026-09-30" }, "view=gstrX&from=2026-08-01&utm_source=mail");
  assert.equal(settled, "from=2026-08-01&to=2026-09-30");
});

test("sameQuery ignores key order, and nothing else", () => {
  assert.equal(sameQuery("a=1&b=2", "?b=2&a=1"), true);
  assert.equal(sameQuery("a=1", "a=2"), false);
  assert.equal(sameQuery("", ""), true);
  assert.equal(sameQuery("a=1", ""), false);
});

/* ============================================================ wiring ==== */

console.log("\n--- the component and the pages ---");

const SYNC = read("components/reports/ReportUrlSync.jsx");
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

test("the URL is REPLACED, never pushed -- no history entry per filter", () => {
  const src = code(SYNC);
  assert.match(src, /window\.history\.replaceState\(/);
  assert.doesNotMatch(src, /pushState|router\.push|router\.replace/);
});

test("it reads the link once, and writes only after the first render", () => {
  const src = code(SYNC);
  assert.match(src, /started\.current\) return/);
  assert.match(src, /if \(!ready/);
  assert.match(src, /sameQuery\(current, query\)\) return/, "it rewrites a URL that already says the same thing");
  // The restore effect has no dependencies: a URL change after mount must
  // not re-apply the link over the user's own choices.
  assert.match(src, /setReady\(true\);[\s\S]*?\}, \[\]\);/);
});

for (const [page, schema] of [
  ["sales-report", "salesReport"],
  ["gst-return", "gstReturn"],
  ["financials", "financials"],
  ["order-report", "orderReport"],
  ["statement", "statement"],
  ["account-book", "accountBook"],
]) {
  test(`${page} keeps its filters in the URL`, () => {
    const src = read(`app/${page}/page.js`);
    assert.match(src, /import ReportUrlSync from '@\/components\/reports\/ReportUrlSync'/);
    assert.match(src, new RegExp(`schema=\\{REPORT_QUERIES\\.${schema}\\}`));
  });
}

for (const [page, schema] of [
  ["sales-report", "salesReport"],
  ["gst-return", "gstReturn"],
  ["financials", "financials"],
  ["order-report", "orderReport"],
]) {
  test(`${page} reads a link BEFORE its first fetch`, () => {
    // As the initial state, not in an effect: an effect would let the page
    // fetch its defaults first and race the link's own request.
    const src = read(`app/${page}/page.js`);
    assert.match(
      src,
      new RegExp(`useState\\(\\(\\) => parseReportQuery\\(REPORT_QUERIES\\.${schema}, searchParams\\)\\.values\\)`)
    );
    assert.match(src, /restore=\{false\}/, `${page} restores twice`);
    assert.doesNotMatch(src, /onRestore=/);
  });
}

test("the statement and account book keep their own readers", () => {
  // Not rebuilt: their link readers stay, and only the write-back is new.
  assert.match(read("app/statement/page.js"), /<StatementSearchParams onValues=\{applyLink\} \/>/);
  assert.match(read("app/statement/page.js"), /restore=\{false\}/);
  assert.match(read("app/account-book/page.js"), /<AccountBookSearchParams onValues=\{applyLink\} \/>/);
  assert.match(read("app/account-book/page.js"), /restore=\{false\}/);
  assert.match(read("components/AccountBookSearchParams.jsx"), /get\('preset'\)/);
});

test("the existing readers read once, even from an empty URL", () => {
  // Otherwise the page's own write-back would be picked up as a link.
  for (const reader of ["components/StatementSearchParams.jsx", "components/AccountBookSearchParams.jsx"]) {
    const src = code(read(reader));
    assert.match(src, /if \(done\.current\) return;\s*done\.current = true;/, reader);
  }
});

test("the account book holds a link's account and group until its book has loaded", () => {
  const src = code(read("app/account-book/page.js"));
  assert.doesNotMatch(src, /setTimeout\(\(\) => setAccount/, "the account is still applied on a timer");
  assert.match(src, /linked\.current = \{ kind: linkKind, account: values\.account/);
  assert.match(src, /if \(latestKind\.current !== nextKind\) return;/, "a stale tab's accounts can still fill the picker");
  assert.match(src, /setGroup\(link && link\.kind === kind && link\.group \? link\.group : ''\)/);
});

console.log(`\n${passed} checks passed.\n`);
