/**
 * Error handling, user feedback and logging.
 *
 *   - lib/apiResponse.mjs: one way to read an API answer, and words for it
 *   - lib/serverError.mjs: a 500 shows a reference, the exception goes to the log
 *   - lib/downloadFile.mjs: report downloads that fail say so on the screen
 *   - the login page only redirects within the site
 *   - no browser alert(), no debugging console.log, no leftover diagnostics
 *   - next.config.mjs and the lint script match the installed Next.js 16
 *
 * Bare node: `node scripts/error-handling.test.mjs`.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  NETWORK_ERROR,
  errorMessage,
  readResponse,
  safeNextPath,
  statusMessage,
} from "../lib/apiResponse.mjs";
import { hideInternalError, internalErrorBody, validationMessage } from "../lib/serverError.mjs";
import { istToday } from "../lib/istDate.mjs";
import { filenameFrom } from "../lib/downloadFile.mjs";

let passed = 0;
const pending = [];
const test = (name, fn) => {
  pending.push(
    (async () => {
      try {
        await fn();
        passed += 1;
        console.log(`  ok    ${name}`);
      } catch (err) {
        process.exitCode = 1;
        console.log(`  FAIL  ${name}\n        ${err.message.split("\n").join("\n        ")}`);
      }
    })()
  );
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

/** Every source file a browser or a route runs, under these folders. */
const sources = (dirs) => {
  const out = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (/\.(js|jsx|mjs)$/.test(entry.name)) out.push(child);
    }
  };
  for (const d of dirs) if (exists(d)) walk(d);
  return out;
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/* ───────────────────────────── reading answers ─────────────────────────── */

console.log("\n--- reading an API answer ---");

test("ok means 2xx and not success:false", async () => {
  assert.equal((await readResponse(json({ success: true }))).ok, true);
  // delete-cust answers a success with { message } and no `success` at all.
  assert.equal((await readResponse(json({ message: "Customer deleted" }))).ok, true);
  const refused = await readResponse(json({ success: false, error: "Name taken." }));
  assert.equal(refused.ok, false);
  assert.equal(refused.message, "Name taken.");
});

test("the route's words are used whether it calls them error or message", async () => {
  // The auth gate sends `message`; most routes send `error`.
  const gate = await readResponse(json({ success: false, message: "Please sign in." }, 401));
  assert.equal(gate.message, "Please sign in.");
  const route = await readResponse(json({ error: "Invoice not found." }, 404));
  assert.equal(route.message, "Invoice not found.");
});

test("a body that is not JSON is not a crash, and not 'could not reach the server'", async () => {
  const res = new Response("<html>Internal Server Error</html>", { status: 500 });
  const r = await readResponse(res);
  assert.equal(r.ok, false);
  assert.deepEqual(r.body, {});
  assert.match(r.message, /server ran into a problem/);
  assert.notEqual(r.message, NETWORK_ERROR);
});

test("a raw exception is never shown as the message", () => {
  for (const internal of [
    'E11000 duplicate key error collection: test.items index: companyId_1_name_1 dup key: { name: "Bolt" }',
    "Cast to ObjectId failed for value \"x\" (type string) at path \"_id\"",
    "TypeError: Cannot read properties of undefined (reading 'map')\n    at handler (/app/route.js:12:5)",
    "MongoServerError: connection refused",
    "x".repeat(500),
  ]) {
    assert.equal(errorMessage({ error: internal }, 500), statusMessage(500), internal.slice(0, 40));
  }
});

test("every status has words a person can act on", () => {
  assert.match(statusMessage(401), /sign in/i);
  assert.match(statusMessage(403), /permission/i);
  assert.match(statusMessage(409), /reload/i);
  assert.match(statusMessage(503), /server/i);
  assert.match(errorMessage({}, 0), /went wrong/i);
});

/* ───────────────────────────── 500s ────────────────────────────────────── */

console.log("\n--- a 500 shows a reference, the log keeps the exception ---");

const REQ = { method: "POST", url: "https://app.example/api/save-invoice" };

test("a 500 carrying an exception is replaced, and the exception is logged", async () => {
  const logged = [];
  const out = await hideInternalError(
    json({ success: false, error: "E11000 duplicate key ... dup key: { gstin: \"07AAA\" }" }, 500),
    REQ,
    { log: (...args) => logged.push(args.join(" ")), ref: "abc12345" }
  );
  assert.equal(out.status, 500);
  const body = await out.json();
  assert.equal(body.success, false);
  assert.equal(body.ref, "abc12345");
  assert.match(body.error, /ref abc12345/);
  assert.doesNotMatch(JSON.stringify(body), /E11000|gstin|07AAA/);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /\[api abc12345\] POST \/api\/save-invoice -> 500/);
  assert.match(logged[0], /E11000/);
});

test("anything that is not a 500 passes through untouched", async () => {
  for (const status of [200, 400, 401, 403, 404, 409, 502, 503]) {
    const res = json({ error: "said on purpose" }, status);
    assert.equal(await hideInternalError(res, REQ, { log: () => {} }), res, String(status));
  }
  assert.equal(await hideInternalError(undefined, REQ), undefined);
});

test("a schema refusal sent as a 500 becomes a 400 naming the fields", async () => {
  const out = await hideInternalError(
    json({ error: "Item validation failed: hsn: Path `hsn` is required., name: Path `name` is required." }, 500),
    REQ,
    { log: () => { throw new Error("a user's typo is not logged as a crash"); } }
  );
  assert.equal(out.status, 400);
  assert.equal((await out.json()).error, "Check these fields: hsn is required; name is required.");
  assert.equal(validationMessage("Customer validation failed: openBal: Cast to Number failed for value \"abc\" (type string) at path \"openBal\""), "Check these fields: openBal is not a valid value.");
  assert.equal(validationMessage("E11000 duplicate key"), null);
  assert.equal(validationMessage(undefined), null);
});

test("a 500 that is not JSON is still replaced", async () => {
  const out = await hideInternalError(new Response("boom", { status: 500 }), REQ, { log: () => {} });
  assert.match((await out.json()).error, /server ran into a problem/);
});

test("references differ, and are short", () => {
  const a = internalErrorBody().ref;
  const b = internalErrorBody().ref;
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{8}$/);
});

test("every tenant route is behind the sanitiser, and the auth routes hide theirs too", () => {
  assert.match(code(read("lib/tenantRoute.mjs")), /return await hideInternalError\(res, req\)/);
  for (const route of ["login", "register", "me"]) {
    const src = code(read(`app/api/auth/${route}/route.js`));
    assert.doesNotMatch(src, /message: error\.message \}, \{ status: 500 \}/, route);
    assert.match(src, /internalErrorBody\(\)/, route);
  }
});

/* ───────────────────────────── redirects ───────────────────────────────── */

console.log("\n--- sign-in only ever returns to this site ---");

test("safeNextPath keeps a local path and refuses everything else", () => {
  assert.equal(safeNextPath("/sales-report?from=2026-04-01"), "/sales-report?from=2026-04-01");
  assert.equal(safeNextPath(""), "/");
  assert.equal(safeNextPath(null), "/");
  for (const evil of [
    "https://evil.example/login",
    "//evil.example",
    "/\\evil.example",
    "javascript:alert(1)",
    "/\t/evil.example",
    "evil.example",
  ]) {
    assert.equal(safeNextPath(evil), "/", evil);
  }
});

test("the login page goes through it", () => {
  const src = code(read("app/login/page.js"));
  assert.match(src, /safeNextPath\(params\.get\('next'\)\)/);
  assert.doesNotMatch(src, /params\.get\('next'\) \|\| '\/'/);
});

/* ───────────────────────────── downloads ───────────────────────────────── */

console.log("\n--- report downloads ---");

test("the file name comes off Content-Disposition, never as a path", () => {
  assert.equal(filenameFrom('attachment; filename="Sales Book.xlsx"'), "Sales Book.xlsx");
  assert.equal(filenameFrom("attachment; filename*=UTF-8''GSTR%E2%80%943B.csv"), "GSTR—3B.csv");
  assert.equal(filenameFrom('attachment; filename="../../etc/passwd"'), "passwd");
  assert.equal(filenameFrom("", "report"), "report");
});

test("no report screen navigates the whole app to a download URL any more", () => {
  for (const page of ["account-book", "gst-return", "financials", "stock-report", "statement", "sales-report"]) {
    const src = code(read(`app/${page}/page.js`));
    assert.doesNotMatch(src, /window\.location\.href = `\/api\//, page);
    assert.match(src, /exporter\.download\(`\/api\//, page);
    assert.match(src, /<Notice notice=\{exporter\.notice\}/, page);
  }
});

/* ───────────────────────── alerts and console ──────────────────────────── */

console.log("\n--- no alert(), no debugging logs ---");

const CLIENT = sources(["app", "components", "context"]).filter((f) => !f.startsWith(path.join("app", "api")));

test("no browser alert() anywhere a person sees", () => {
  const offenders = CLIENT.filter((f) => /(^|[^.\w])alert\(|window\.alert\(/.test(code(read(f))));
  assert.deepEqual(offenders, []);
});

test("no debugging console.log in the app, the routes or lib", () => {
  const allowed = new Set([
    path.join("lib", "mongodb.js"), // one line per cold start, no data
    path.join("lib", "secretBox.mjs"), // inside an error message: the command to generate a key
  ]);
  const offenders = sources(["app", "components", "context", "lib"])
    .filter((f) => !allowed.has(f))
    .filter((f) => /console\.log\(/.test(code(read(f))));
  assert.deepEqual(offenders, []);
});

test("the temporary tenant diagnostics are gone", () => {
  const ctx = code(read("lib/tenantContext.mjs"));
  assert.doesNotMatch(ctx, /console\.log/);
  assert.doesNotMatch(read("lib/tenantRoute.mjs"), /TEMPORARY DIAGNOSTIC/);
  assert.doesNotMatch(read("lib/tenantContext.mjs"), /TEMPORARY DIAGNOSTIC/);
});

test("saving shows progress and cannot be fired twice", () => {
  const billing = code(read("components/billing/BillingScreen.jsx"));
  assert.match(billing, /if \(saving\) return;/);
  assert.match(billing, /disabled=\{Boolean\(einvoiceLock\) \|\| saving\}/);
  assert.match(billing, /finally \{\s*setSaving\(false\);/);
  const voucher = code(read("app/voucheradd/page.js"));
  assert.match(voucher, /if \(saving\) return;/);
  assert.match(voucher, /disabled=\{saving\}/);
});

test("a failed save reports the server's reason, not 'undefined'", () => {
  const billing = code(read("components/billing/BillingScreen.jsx"));
  assert.doesNotMatch(billing, /'Failed to save invoice: ' \+ result\.error/);
  assert.match(billing, /readResponse\(response\)/);
});

test("istToday is the Indian date, which runs 5h30 ahead of UTC", () => {
  assert.equal(istToday(Date.parse("2026-10-11T18:29:59Z")), "2026-10-11");
  assert.equal(istToday(Date.parse("2026-10-11T18:30:00Z")), "2026-10-12", "00:00 IST");
  assert.equal(istToday(Date.parse("2026-03-31T19:00:00Z")), "2026-04-01", "a new financial year");
});

test("new documents start on today's Indian date, not UTC's", () => {
  const offenders = [
    "components/billing/BillingScreen.jsx",
    "app/voucheradd/page.js",
    "app/orderadd/page.js",
    "app/invoice-range/page.js",
    "components/PriceListMaster.jsx",
    "app/order-report/page.js",
    "app/financials/page.js",
  ].filter((f) => /new Date\(\)\.toISOString\(\)\.(slice|substring)\(0, 10\)/.test(code(read(f))));
  assert.deepEqual(offenders, []);
});

test("a new voucher is dated today in India, not today in UTC", () => {
  const src = code(read("app/voucheradd/page.js"));
  assert.doesNotMatch(src, /new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/);
  assert.match(src, /date: todayIst\(\)/);
});

test("sign-out failure is shown rather than swallowed", () => {
  const src = code(read("components/UserMenu.jsx"));
  assert.doesNotMatch(src, /fetch\('\/api\/auth\/logout', \{ method: 'POST' \}\)\.catch\(\(\) => \{\}\)/);
  assert.match(src, /setSignOutError\(/);
});

/* ───────────────────────── Next.js 16 config ───────────────────────────── */

console.log("\n--- Next.js 16 configuration ---");

test("next.config.mjs has no `eslint` key (removed in Next.js 16)", () => {
  const cfg = code(read("next.config.mjs"));
  assert.doesNotMatch(cfg, /\beslint\s*:/);
  assert.match(cfg, /reactStrictMode: true/);
});

test("linting runs ESLint directly, since `next lint` no longer exists", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.scripts.lint, "eslint .");
  const eslintConfig = read("eslint.config.mjs");
  assert.match(eslintConfig, /"\.next\/\*\*"/, "the build output must not be linted");
  // eslint-config-next 16 is flat config, imported and spread directly.
  assert.match(eslintConfig, /import nextVitals from "eslint-config-next\/core-web-vitals"/, "the Next.js rules still apply");
  assert.match(eslintConfig, /\.\.\.nextVitals/, "the Next.js rules still apply");
  assert.match(pkg.devDependencies["eslint-config-next"], /^\^?16\./, "the rules match the Next.js major");
});

test("the auth gate is untouched: still middleware.js, same checks", () => {
  // Next.js 16 deprecates the name (warns, still runs it). Not renamed here:
  // see the note in PROJECT_CONTEXT.md §6.32.
  assert.ok(exists("middleware.js"));
  assert.ok(!exists("proxy.js"), "both files present is a build error in Next.js 16");
  const gate = code(read("middleware.js"));
  for (const must of [/verifySession\(/, /isPublicPath\(pathname\)/, /canAccessPath\(claims\.role, pathname\)/, /status: 401/, /status: 403/, /export const config = \{/]) {
    assert.match(gate, must);
  }
});

await Promise.all(pending);
console.log(process.exitCode ? "\nSome checks failed.\n" : `\n${passed} checks passed.\n`);
