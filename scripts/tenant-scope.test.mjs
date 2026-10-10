/**
 * Fixture tests for tenant scoping.
 *
 *   node scripts/tenant-scope.test.mjs
 *
 * This is the only thing standing between one customer's books and another's,
 * so the cases are mostly about what must NOT happen: a query running without
 * a firm in context, an aggregation comparing a string to an ObjectId and
 * matching nothing, a bulkWrite slipping past because its filters live on the
 * operations rather than the query.
 *
 * The decisions all live in lib/tenantScope.mjs and lib/tenantContext.mjs,
 * neither of which imports Mongoose, so this runs under bare node.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FILTERED_HOOKS,
  UNFILTERABLE,
  BULK_OPS,
  stampDocs,
  scopeBulkOps,
  aggregateMatch,
} from "../lib/tenantScope.mjs";
import {
  runInTenant,
  currentTenant,
  requireTenant,
  runAcrossAllTenants,
  isUnscoped,
  TenantMissingError,
} from "../lib/tenantContext.mjs";

let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  }
};

const FIRM_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const FIRM_B = "bbbbbbbbbbbbbbbbbbbbbbbb";

console.log("\n--- no firm in context means no query ---");

await test("outside a request there is no tenant", () => {
  assert.equal(currentTenant(), null);
});

await test("requireTenant throws rather than returning nothing", () => {
  // The whole safety property. If this ever returned null or undefined, every
  // query in the app would quietly widen to all firms.
  assert.throws(() => requireTenant(), TenantMissingError);
  assert.throws(() => requireTenant("A Customer query"), /A Customer query/);
  assert.throws(() => requireTenant(), /tenantRoute/);
});

await test("a route that forgets to scope gets a loud error, not wrong data", () => {
  let caught = null;
  try { requireTenant("An Invoice query"); } catch (err) { caught = err; }
  assert.ok(caught instanceof TenantMissingError);
  assert.equal(caught.status, 500);
});

console.log("\n--- the context holds, and does not leak ---");

await test("inside runInTenant the firm is known", async () => {
  await runInTenant(FIRM_A, async () => {
    assert.equal(currentTenant(), FIRM_A);
    assert.equal(requireTenant(), FIRM_A);
  });
});

await test("the firm survives awaits and nested calls", async () => {
  // Every query in a route is behind at least one await; if the context did
  // not survive them this would scope the first query and nothing after it.
  await runInTenant(FIRM_A, async () => {
    await new Promise((r) => setTimeout(r, 1));
    assert.equal(currentTenant(), FIRM_A);
    const nested = async () => {
      await Promise.resolve();
      return currentTenant();
    };
    assert.equal(await nested(), FIRM_A);
  });
});

await test("two firms in flight at once do not see each other", async () => {
  // Two requests overlapping is the normal case on a shared instance, and the
  // failure here would be the worst possible one.
  const seen = [];
  await Promise.all([
    runInTenant(FIRM_A, async () => {
      await new Promise((r) => setTimeout(r, 5));
      seen.push(["A", currentTenant()]);
    }),
    runInTenant(FIRM_B, async () => {
      await new Promise((r) => setTimeout(r, 1));
      seen.push(["B", currentTenant()]);
    }),
  ]);
  assert.deepEqual(seen.sort(), [["A", FIRM_A], ["B", FIRM_B]]);
});

await test("the context does not outlive the request", async () => {
  await runInTenant(FIRM_A, async () => currentTenant());
  assert.equal(currentTenant(), null);
  assert.throws(() => requireTenant(), TenantMissingError);
});

await test("a firm cannot be established as blank", () => {
  for (const bad of ["", null, undefined, 0]) {
    assert.throws(() => runInTenant(bad, () => {}), TenantMissingError, `blank: ${bad}`);
  }
});

console.log("\n--- the escape hatch is deliberate and narrow ---");

await test("runAcrossAllTenants is the only way to go unscoped", async () => {
  assert.equal(isUnscoped(), false);
  await runAcrossAllTenants(async () => {
    assert.equal(isUnscoped(), true);
    assert.equal(currentTenant(), null);
  });
  assert.equal(isUnscoped(), false);
});

await test("a normal request is never unscoped", async () => {
  await runInTenant(FIRM_A, async () => assert.equal(isUnscoped(), false));
});

console.log("\n--- every query shape that carries a filter is hooked ---");

await test("the hook list covers the shapes the app actually uses", () => {
  // Taken from the survey of all 135 call sites in app/api and lib.
  for (const used of [
    "find", "findOne", "findOneAndUpdate", "findOneAndDelete",
    "updateOne", "updateMany", "deleteOne", "deleteMany",
    "countDocuments", "distinct",
  ]) {
    assert.ok(FILTERED_HOOKS.includes(used), `${used} must be hooked`);
  }
});

await test("findById is not listed, because Mongoose rewrites it", () => {
  // It becomes findOne({_id}) before middleware runs. Listing it would throw
  // at schema compile time; relying on findOne is what actually scopes it.
  for (const name of ["findById", "findByIdAndUpdate", "findByIdAndDelete"]) {
    assert.ok(!FILTERED_HOOKS.includes(name), `${name} must not be listed`);
  }
});

await test("estimatedDocumentCount is named as unfilterable", () => {
  // It reads collection metadata, so it cannot be scoped at all and must never
  // be used on a tenant collection.
  assert.ok(UNFILTERABLE.includes("estimatedDocumentCount"));
  assert.ok(!FILTERED_HOOKS.includes("estimatedDocumentCount"));
});

await test("nothing is listed twice", () => {
  assert.equal(new Set(FILTERED_HOOKS).size, FILTERED_HOOKS.length);
});

console.log("\n--- creates are stamped ---");

await test("every inserted document gets the firm", () => {
  const docs = [{ name: "A" }, { name: "B" }];
  stampDocs(docs, FIRM_A);
  assert.deepEqual(docs.map((d) => d.companyId), [FIRM_A, FIRM_A]);
});

await test("a document that already names a firm is left alone", () => {
  // The migration sets companyId explicitly; it must not be overwritten.
  const docs = [{ name: "A", companyId: FIRM_B }, { name: "B" }];
  stampDocs(docs, FIRM_A);
  assert.deepEqual(docs.map((d) => d.companyId), [FIRM_B, FIRM_A]);
});

await test("stamping with no firm throws rather than writing an orphan", () => {
  assert.throws(() => stampDocs([{ name: "A" }], ""), /company id/);
  assert.throws(() => stampDocs([{ name: "A" }], null), /company id/);
});

await test("an empty or missing batch does not throw", () => {
  assert.deepEqual(stampDocs([], FIRM_A), []);
  assert.equal(stampDocs(undefined, FIRM_A), undefined);
});

console.log("\n--- bulkWrite carries its filters per operation ---");

await test("every operation kind is scoped", () => {
  const ops = [
    { updateOne: { filter: { _id: 1 }, update: { $set: { x: 1 } } } },
    { updateMany: { filter: { name: "A" }, update: { $set: { x: 1 } } } },
    { deleteOne: { filter: { _id: 2 } } },
    { deleteMany: { filter: {} } },
    { replaceOne: { filter: { _id: 3 }, replacement: {} } },
  ];
  scopeBulkOps(ops, FIRM_A);
  for (const op of ops) {
    const body = Object.values(op)[0];
    assert.equal(body.filter.companyId, FIRM_A, JSON.stringify(op));
  }
  // The original filter survives alongside it.
  assert.equal(ops[0].updateOne.filter._id, 1);
  assert.equal(ops[1].updateMany.filter.name, "A");
});

await test("an insertOne in a bulkWrite is stamped, not filtered", () => {
  const ops = [{ insertOne: { document: { name: "A" } } }];
  scopeBulkOps(ops, FIRM_A);
  assert.equal(ops[0].insertOne.document.companyId, FIRM_A);
  assert.equal(ops[0].insertOne.filter, undefined);
});

await test("an operation naming another firm is overridden, not trusted", () => {
  // Scoping is applied last on purpose: nothing in the operation may widen it.
  const ops = [{ updateMany: { filter: { companyId: FIRM_B }, update: {} } }];
  scopeBulkOps(ops, FIRM_A);
  assert.equal(ops[0].updateMany.filter.companyId, FIRM_A);
});

await test("a bulkWrite with no firm throws", () => {
  assert.throws(() => scopeBulkOps([{ deleteMany: { filter: {} } }], ""), /company id/);
});

await test("the operation list matches what MongoDB accepts", () => {
  for (const kind of ["insertOne", "updateOne", "updateMany", "deleteOne", "deleteMany", "replaceOne"]) {
    assert.ok(BULK_OPS.includes(kind), `${kind} must be scoped`);
  }
});

console.log("\n--- aggregations compare the stored type ---");

await test("the match stage casts the id", () => {
  // The stored value is an ObjectId. A plain string matches nothing, which
  // would show as an empty stock report rather than as an error.
  const cast = (v) => ({ __objectId: v });
  const stage = aggregateMatch(FIRM_A, cast);
  assert.deepEqual(stage, { $match: { companyId: { __objectId: FIRM_A } } });
});

await test("an aggregation with no firm or no caster throws", () => {
  assert.throws(() => aggregateMatch("", () => {}), /company id/);
  assert.throws(() => aggregateMatch(FIRM_A, null), /caster/);
  assert.throws(() => aggregateMatch(FIRM_A, undefined), /caster/);
});

console.log("\n--- every route is actually wrapped ---");

// A static sweep of the real route files. The scoping rules above are only
// worth anything if every route establishes a tenant, and the way that breaks
// is somebody adding a route next month and not wrapping it.
const ROUTES = (() => {
  // fileURLToPath, NOT .pathname. On Windows `.pathname` is
  // "/C:/Vs%20Code/..." -- a leading slash and percent-encoded spaces -- which
  // readdirSync resolves against the drive and fails on as "C:\\C:\\Vs%20Code".
  const dir = fileURLToPath(new URL("../app/api/", import.meta.url));
  const walk = (d) =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]
    );
  return walk(dir).filter((f) => f.endsWith("route.js"));
})();

const AUTH_ROUTES = ROUTES.filter((f) => f.includes(`${path.sep}auth${path.sep}`));
const TENANT_ROUTES = ROUTES.filter((f) => !f.includes(`${path.sep}auth${path.sep}`));
// Reported with forward slashes whatever the platform uses, because the paths
// above are built with path.join: on Windows they come back separated by
// backslashes, and looking for "app/api/" in one of those finds nothing.
const posix = (f) => f.split(path.sep).join("/");
const rel = (f) => {
  const p = posix(f);
  const at = p.indexOf("app/api/");
  return at === -1 ? p : p.slice(at);
};

await test("there are routes to check at all", () => {
  // Guards against the sweep silently finding nothing and passing.
  assert.ok(TENANT_ROUTES.length >= 40, `only found ${TENANT_ROUTES.length} routes`);
});

await test("the sweep reads real paths on this platform", () => {
  // This whole section walks the filesystem, which is the one part of the test
  // suite that behaves differently on Windows. Both halves of that have bitten
  // it: a file: URL's `.pathname` is not a Windows path, and a path joined
  // with backslashes does not contain "app/api/".
  for (const f of ROUTES.slice(0, 5)) {
    assert.ok(path.isAbsolute(f), `${f} is not an absolute path`);
    assert.ok(fs.existsSync(f), `${f} does not exist`);
    assert.doesNotMatch(f, /%20|%2F/, `${f} is still percent-encoded`);
    assert.match(rel(f), /^app\/api\//, `rel() gave "${rel(f)}"`);
  }
});

await test("no route exports a handler that skips the wrapper", () => {
  // `export async function GET` is the unwrapped shape. Every tenant route
  // must go through tenantRoute() instead.
  const bare = TENANT_ROUTES.filter((f) =>
    /^export\s+async\s+function\s+(GET|POST|PUT|DELETE|PATCH)\b/m.test(fs.readFileSync(f, "utf8"))
  );
  assert.deepEqual(bare.map(rel), [], "these routes are not wrapped");
});

await test("every route exports its handlers through tenantRoute", () => {
  const unwrapped = [];
  for (const f of TENANT_ROUTES) {
    const src = fs.readFileSync(f, "utf8");
    const methods = [...src.matchAll(/^export\s+const\s+(GET|POST|PUT|DELETE|PATCH)\s*=\s*([A-Za-z_$][\w$]*)/gm)];
    if (!methods.length) { unwrapped.push(`${rel(f)} (no handler exported)`); continue; }
    for (const [, method, wrapper] of methods) {
      if (wrapper !== "tenantRoute") unwrapped.push(`${rel(f)} ${method} via ${wrapper}`);
    }
  }
  assert.deepEqual(unwrapped, []);
});

await test("every route imports the wrapper it uses", () => {
  const missing = TENANT_ROUTES.filter(
    (f) => !fs.readFileSync(f, "utf8").includes("@/lib/tenantRoute.mjs")
  );
  assert.deepEqual(missing.map(rel), []);
});

await test("the auth routes are deliberately not wrapped", () => {
  // Signing in happens before anybody belongs to a firm, so these cannot be
  // scoped -- and that exemption should stay small and visible.
  assert.ok(AUTH_ROUTES.length > 0, "expected to find the auth routes");
  assert.ok(AUTH_ROUTES.length <= 5, `${AUTH_ROUTES.length} unscoped routes is too many`);
  for (const f of AUTH_ROUTES) {
    assert.ok(rel(f).startsWith("app/api/auth/"), `${rel(f)} is outside app/api/auth`);
  }
});

await test("no tenant model is used without the plugin", () => {
  const dir = fileURLToPath(new URL("../models/", import.meta.url));
  const EXEMPT = ["companyModel.js", "userModel.js", "totalSales.js"];
  const offenders = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".js"))) {
    if (EXEMPT.includes(f)) continue;
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    // The CALL, not the import: a file can import the plugin and never apply
    // it, which is exactly the half-done edit worth catching.
    if (!/\.plugin\(\s*tenantPlugin\s*\)/.test(src)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], "these models are not tenant-scoped");
});

console.log(`\n  ${passed} checks passed\n`);
