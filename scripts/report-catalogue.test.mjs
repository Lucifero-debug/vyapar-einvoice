/**
 * Fixture tests for the Reports hub's catalogue.
 *
 *   node scripts/report-catalogue.test.mjs
 *
 * A hub is a page of links, and a page of links fails in two ways nobody
 * notices until a customer does:
 *
 *   1. A DEAD TILE. A path with a typo, or a path to a page that was renamed,
 *      opens a 404 from a screen that looks authoritative. Every `path` here
 *      is therefore checked against the filesystem -- the page must exist.
 *
 *   2. A TILE THE ROLE CANNOT OPEN, shown as though it could. The hub reads
 *      its permissions from lib/roles.mjs rather than carrying its own copy,
 *      and this asserts that every report's path is actually IN that table --
 *      an unlisted page falls through to "any session will do", which for a
 *      report means a biller reaching the trial balance.
 *
 * The gaps are checked too: a category that says a report does not exist yet
 * must not be saying so about a page that has since been built.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  CATEGORY_KEYS,
  REPORTS,
  REPORT_CATEGORIES,
  REPORT_GAPS,
  reportHref,
  reportHub,
  reportsIn,
} from "../lib/reportCatalogue.mjs";
import { ROLES, canAccessPath, permissionForPath } from "../lib/roles.mjs";
import { REPORT_QUERIES } from "../lib/reportQuery.mjs";

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

const exists = (p) => fs.existsSync(new URL(p, import.meta.url));

console.log("\n--- the catalogue ---");

test("every report names a category that exists", () => {
  for (const report of REPORTS) {
    assert.ok(CATEGORY_KEYS.includes(report.category), `${report.key}: ${report.category}`);
  }
  // And every category has something in it -- a tile or an honest gap.
  for (const category of REPORT_CATEGORIES) {
    const has = reportsIn(category.key).length || (REPORT_GAPS[category.key] || []).length;
    assert.ok(has, `${category.key} is an empty category`);
  }
});

test("keys are unique, so React cannot drop a tile", () => {
  const keys = REPORTS.map((r) => r.key);
  assert.equal(new Set(keys).size, keys.length);
});

test("EVERY TILE OPENS A PAGE THAT EXISTS", () => {
  for (const report of REPORTS) {
    assert.ok(report.path.startsWith("/"), `${report.key}: ${report.path}`);
    const page = `../app${report.path}/page.js`;
    assert.ok(exists(page), `${report.key} points at ${report.path}, which has no page.js`);
  }
});

test("every tile is in the permission table, not falling through to any session", () => {
  for (const report of REPORTS) {
    const permission = permissionForPath(report.path);
    assert.ok(
      permission,
      `${report.path} is not in lib/roles.mjs, so any signed-in user reaches it`
    );
  }
});

test("a report's API route is behind the same permission as its page", () => {
  // Otherwise a role kept out of the page downloads the same figures from the
  // route -- and these routes serve the exports too (lib/reportHttp.js).
  const pairs = [
    ["/statement", "/api/statement"],
    ["/account-book", "/api/account-book"],
    ["/sales-report", "/api/sales-report"],
    ["/gst-return", "/api/gst-return"],
    ["/financials", "/api/financials"],
  ];
  for (const [page, route] of pairs) {
    assert.equal(
      permissionForPath(page),
      permissionForPath(route),
      `${page} and ${route} are behind different permissions`
    );
  }
});

test("a gap does not describe a report that has since been built", () => {
  for (const [category, lines] of Object.entries(REPORT_GAPS)) {
    assert.ok(CATEGORY_KEYS.includes(category), `gap for unknown category ${category}`);
    for (const line of lines) {
      assert.ok(line.length > 20, "a gap should say what is missing");
      // A gap naming a path that now exists is a stale apology.
      const paths = line.match(/\/[a-z-]+/g) || [];
      for (const path of paths) {
        assert.equal(exists(`../app${path}/page.js`), false, `the gap still mentions ${path}, which exists`);
      }
    }
  }
});

console.log("\n--- the links ---");

test("a preselecting query becomes a query string", () => {
  assert.equal(reportHref({ path: "/statement", query: { side: "supplier" } }), "/statement?side=supplier");
  assert.equal(reportHref({ path: "/account-book", query: { kind: "cash" } }), "/account-book?kind=cash");
  // No query, no question mark.
  assert.equal(reportHref({ path: "/sales-report" }), "/sales-report");
  assert.equal(reportHref({ path: "/sales-report", query: { kind: "" } }), "/sales-report");
  // A report with no path gets no link at all, rather than a link to "" --
  // which renders as an anchor to the current page and reads as a tile that
  // does nothing when clicked.
  assert.equal(reportHref({}), "");
  assert.equal(reportHref({ query: { side: "customer" } }), "");
  assert.equal(reportHref({ path: "", query: { side: "customer" } }), "");
});

test("every preselecting query is one the target page actually reads", () => {
  // A ?side= on a page that ignores it is a tile that silently opens the
  // wrong side -- worse than no tile, because it looks like it worked.
  const readers = {
    "/statement": "../components/StatementSearchParams.jsx",
    "/account-book": "../components/AccountBookSearchParams.jsx",
    "/stock-report": "../components/StockReportSearchParams.jsx",
  };
  // Pages that read their filters through components/reports/ReportUrlSync.jsx
  // declare them as a schema in lib/reportQuery.mjs instead of a reader of
  // their own; a key is read when the schema names it.
  const schemas = {
    "/sales-report": REPORT_QUERIES.salesReport,
    "/gst-return": REPORT_QUERIES.gstReturn,
    "/financials": REPORT_QUERIES.financials,
    "/order-report": REPORT_QUERIES.orderReport,
  };
  for (const report of REPORTS) {
    const keys = Object.keys(report.query || {});
    if (!keys.length) continue;
    if (schemas[report.path]) {
      const page = fs.readFileSync(new URL(`../app${report.path}/page.js`, import.meta.url), "utf8");
      assert.match(page, /<ReportUrlSync/, `${report.path} does not render ReportUrlSync`);
      for (const key of keys) {
        const field = schemas[report.path][key];
        assert.ok(field, `${report.path}'s schema does not read ?${key}`);
        if (field.type === "enum") {
          assert.ok(field.values.includes(report.query[key]), `?${key}=${report.query[key]} is not a value ${report.path} accepts`);
        }
      }
      continue;
    }
    const reader = readers[report.path];
    assert.ok(reader, `${report.path} is given a query but has no params reader`);
    const src = fs.readFileSync(new URL(reader, import.meta.url), "utf8");
    for (const key of keys) {
      assert.match(src, new RegExp(`get\\('${key}'\\)`), `${reader} does not read ?${key}`);
    }
  }
});

console.log("\n--- the hub ---");

test("it groups the reports and carries each category's gaps", () => {
  const hub = reportHub();
  assert.deepEqual(
    hub.map((c) => c.key),
    REPORT_CATEGORIES.filter(
      (c) => reportsIn(c.key).length || (REPORT_GAPS[c.key] || []).length
    ).map((c) => c.key)
  );
  const money = hub.find((c) => c.key === "money");
  assert.ok(money.gaps.length);
  assert.equal(hub.flatMap((c) => c.reports).length, REPORTS.length);
});

test("a report the role cannot open is flagged, not dropped", () => {
  // A biller who cannot reach the ledger should learn the firm HAS a
  // statement and that it is not theirs to run -- hiding it only makes them
  // ask the owner whether one exists.
  const hub = reportHub({ allowed: (path) => canAccessPath("biller", path) });
  const statements = hub.find((c) => c.key === "statements");
  assert.equal(statements.reports.length, 2);
  assert.ok(statements.reports.every((r) => r.locked));

  const owner = reportHub({ allowed: (path) => canAccessPath("owner", path) });
  assert.ok(owner.flatMap((c) => c.reports).every((r) => !r.locked));
});

test("the lock matches the roles table for every role and every report", () => {
  for (const role of ROLES) {
    const hub = reportHub({ allowed: (path) => canAccessPath(role, path) });
    for (const report of hub.flatMap((c) => c.reports)) {
      assert.equal(
        report.locked,
        !canAccessPath(role, report.path),
        `${role} / ${report.key}`
      );
    }
  }
});

test("with no predicate nothing is locked, so a hub never greys everything", () => {
  // The page passes no predicate until the role has loaded; a flicker from
  // open to locked reads as a bug, and the edge middleware enforces the real
  // rule either way.
  assert.ok(reportHub().flatMap((c) => c.reports).every((r) => !r.locked));
});

console.log("\n--- wiring ---");

test("the hub page is a loop over the catalogue, not a list of tiles", () => {
  const page = fs.readFileSync(new URL("../app/reports/page.js", import.meta.url), "utf8");
  assert.match(page, /reportHub\(\{/);
  assert.match(page, /from '@\/lib\/reportCatalogue\.mjs'/);
  assert.match(page, /canAccessPath/);
});

test("the home screen points at the hub", () => {
  const home = fs.readFileSync(new URL("../app/page.js", import.meta.url), "utf8");
  assert.match(home, /router\.push\('\/reports'\)/);
  assert.match(home, /router\.push\('\/statement'\)/);
});

console.log(`\n  ${passed} checks passed\n`);
