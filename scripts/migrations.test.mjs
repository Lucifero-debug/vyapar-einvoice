/**
 * The three pending migrations: what they would change, and what stops them.
 *
 *   npm run sync:indexes            scripts/sync-indexes.mjs      lib/indexAudit.mjs
 *   backfill-stock-kind             scripts/backfill-stock-kind.mjs  lib/stockKindBackfill.mjs
 *   npm run backfill:gl-legs        scripts/backfill-gl-legs.mjs  lib/glBackfill.mjs
 *
 * No database here: the decisions are pure functions and are tested as such,
 * and the scripts are checked for the order of their steps -- a report run
 * that reaches a write, or a drop that comes before its replacement is
 * confirmed, fails this file. MIGRATIONS.md says what still has to be
 * checked against the real data before --apply.
 *
 * Bare node: `node scripts/migrations.test.mjs`.
 */

import assert from "node:assert/strict";
import fs from "node:fs";

import {
  buildOptions,
  duplicatePipeline,
  indexConflicts,
  missingTenantUniques,
  replacementFor,
  satisfies,
  staleUniques,
} from "../lib/indexAudit.mjs";
import { MISSING_KIND, isMissingKind, kindCollisions } from "../lib/stockKindBackfill.mjs";
import {
  headDrift,
  matchHeads,
  netMoves,
  netMovesByFirm,
  planBackfill,
  runningBalances,
} from "../lib/glBackfill.mjs";
import { GL_ACCOUNTS, SALES_ACCOUNT } from "../lib/invoiceGl.mjs";

let passed = 0;
const test = (name, fn) => {
  try {
    const result = fn();
    assert.equal(result, undefined, "this test body is async -- make it synchronous");
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    process.exitCode = 1;
    console.log(`  FAIL  ${name}\n        ${err.message.split("\n").join("\n        ")}`);
  }
};

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

/**
 * Just enough of MongoDB's aggregation to run `duplicatePipeline` over
 * fixtures: $match (equality and $type/$exists), $group with $sum/$push,
 * $sort, $limit, $project with $slice.
 */
const matches = (doc, filter) =>
  Object.entries(filter).every(([field, cond]) => {
    if (field === "$or") return cond.some((f) => matches(doc, f));
    const value = field.split(".").reduce((v, k) => (v == null ? undefined : v[k]), doc);
    if (cond && typeof cond === "object" && !Array.isArray(cond)) {
      if ("$type" in cond) return cond.$type === "string" ? typeof value === "string" : false;
      if ("$exists" in cond) return (value !== undefined) === cond.$exists;
      if ("$gt" in cond) return value > cond.$gt;
    }
    return value === cond;
  });
const runPipeline = (docs, pipeline) => {
  let out = docs;
  for (const stage of pipeline) {
    if (stage.$match) out = out.filter((d) => matches(d, stage.$match));
    else if (stage.$group) {
      const groups = new Map();
      for (const d of out) {
        const id = {};
        // As the server does it: a bare "$field" that is missing is LEFT OUT
        // of the group key; $ifNull turns missing into null; $toLower folds.
        const evaluate = (expr) => {
          if (typeof expr === "string") return expr.slice(1).split(".").reduce((x, p) => (x == null ? undefined : x[p]), d);
          if (expr.$ifNull) {
            const v = evaluate(expr.$ifNull[0]);
            return v === undefined || v === null ? expr.$ifNull[1] : v;
          }
          if (expr.$toLower) {
            const v = evaluate(expr.$toLower);
            return v === null || v === undefined ? "" : String(v).toLowerCase();
          }
          return undefined;
        };
        for (const [k, expr] of Object.entries(stage.$group._id)) {
          const v = evaluate(expr);
          if (v !== undefined) id[k] = v;
        }
        const key = JSON.stringify(id);
        if (!groups.has(key)) groups.set(key, { _id: id, n: 0, ids: [] });
        const g = groups.get(key);
        g.n += 1;
        g.ids.push(d._id);
      }
      out = [...groups.values()];
    } else if (stage.$sort) out = [...out].sort((a, b) => b.n - a.n);
    else if (stage.$limit) out = out.slice(0, stage.$limit);
    else if (stage.$project) out = out.map((g) => ({ _id: g._id, n: g.n, ids: g.ids.slice(0, 5) }));
  }
  return out;
};

/* ─────────────────────────────── indexes ───────────────────────────────── */

console.log("\n--- sync:indexes ---");

const PROD_DECLARED = [
  [{ companyId: 1 }, {}],
  [{ kind: 1 }, {}],
  [{ companyId: 1, kind: 1, docNo: 1 }, { unique: true }],
  [{ companyId: 1, date: -1, docNo: -1 }, {}],
];
const PROD_ACTUAL = [
  { name: "_id_", key: { _id: 1 } },
  { name: "companyId_1", key: { companyId: 1 } },
  { name: "companyId_1_docNo_1", key: { companyId: 1, docNo: 1 }, unique: true },
  { name: "docNo_1", key: { docNo: 1 }, unique: true },
];

test("both generations of stale unique index are found", () => {
  const stale = staleUniques(PROD_ACTUAL, PROD_DECLARED).map((i) => i.name);
  // The global one AND the per-firm one the kind made obsolete -- the old
  // audit only ever saw the first, so Goods Issue 5 and Production 5 still
  // could not coexist.
  assert.deepEqual(stale.sort(), ["companyId_1_docNo_1", "docNo_1"]);
});

test("_id_, non-unique indexes and declared uniques are never stale", () => {
  const actual = [...PROD_ACTUAL, { name: "companyId_1_kind_1_docNo_1", key: { companyId: 1, kind: 1, docNo: 1 }, unique: true }];
  const stale = staleUniques(actual, PROD_DECLARED).map((i) => i.name);
  assert.ok(!stale.includes("_id_"));
  assert.ok(!stale.includes("companyId_1"));
  assert.ok(!stale.includes("companyId_1_kind_1_docNo_1"));
});

test("a collection with no model is judged on the global rule alone", () => {
  const stale = staleUniques(PROD_ACTUAL, [], { hasModel: false }).map((i) => i.name);
  assert.deepEqual(stale, ["docNo_1"]);
});

test("a stale index has a replacement only once that replacement EXISTS", () => {
  const stale = PROD_ACTUAL[2];
  assert.equal(replacementFor(stale, PROD_DECLARED, PROD_ACTUAL), null, "declared but not built");
  const built = [...PROD_ACTUAL, { name: "x", key: { companyId: 1, kind: 1, docNo: 1 }, unique: true }];
  assert.deepEqual(replacementFor(stale, PROD_DECLARED, built).key, { companyId: 1, kind: 1, docNo: 1 });
});

test("a replacement must cover every field the stale index protected", () => {
  const stale = { name: "name_1_code_1", key: { name: 1, code: 1 }, unique: true };
  const declared = [[{ companyId: 1, name: 1 }, { unique: true }]];
  const actual = [{ key: { companyId: 1, name: 1 }, unique: true }];
  assert.equal(replacementFor(stale, declared, actual), null, "code would lose its protection");
});

test("orders and invoices: the declared per-firm keys are the replacements", () => {
  const orderDeclared = [[{ companyId: 1, type: 1, orderNo: 1 }, { unique: true }]];
  const orderStale = { name: "orderNo_1", key: { orderNo: 1 }, unique: true };
  assert.ok(replacementFor(orderStale, orderDeclared, [{ key: { companyId: 1, type: 1, orderNo: 1 }, unique: true }]));
  const invDeclared = [[{ companyId: 1, invoiceNo: 1 }, { unique: true }]];
  assert.ok(replacementFor({ key: { invoiceNo: 1 }, unique: true }, invDeclared, [{ key: { companyId: 1, invoiceNo: 1 }, unique: true }]));
});

test("duplicates are found per firm, in the index's own scope", () => {
  const docs = [
    { _id: "a", companyId: "F1", kind: "FR", docNo: 5 },
    { _id: "b", companyId: "F1", kind: "FR", docNo: 5 },
    { _id: "c", companyId: "F2", kind: "FR", docNo: 5 }, // another firm: fine
    { _id: "d", companyId: "F1", kind: "IS", docNo: 5 }, // another kind: fine
    { _id: "e", companyId: "F1", docNo: 7 }, // missing kind groups as null
    { _id: "f", companyId: "F1", kind: null, docNo: 7 },
  ];
  const groups = runPipeline(docs, duplicatePipeline({ companyId: 1, kind: 1, docNo: 1 }, { unique: true }));
  assert.deepEqual(
    groups.map((g) => `${g._id.companyId}|${g._id.kind}|${g._id.docNo}|${g.ids.sort().join(",")}`).sort(),
    ["F1|FR|5|a,b", "F1|null|7|e,f"]
  );
});

test("a partial index is only checked over the rows it covers", () => {
  // The IRN index ignores invoices never reported: many have no IRN.
  const docs = [
    { _id: 1, companyId: "F1" },
    { _id: 2, companyId: "F1" },
    { _id: 3, companyId: "F1", irn: "abc" },
    { _id: 4, companyId: "F1", irn: "abc" },
  ];
  const options = { unique: true, partialFilterExpression: { irn: { $type: "string" } } };
  const groups = runPipeline(docs, duplicatePipeline({ companyId: 1, irn: 1 }, options));
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].ids, [3, 4]);
  assert.deepEqual(buildOptions(options), options, "built with exactly the declared options");
});

test("the report run cannot build, drop or create anything", () => {
  const src = code(read("./sync-indexes.mjs"));
  // autoIndex/autoCreate off BEFORE any model is imported.
  const quiet = src.indexOf("quietMongoose(mongoose);");
  const firstModel = src.indexOf("await import(`../models/");
  assert.ok(quiet > 0 && quiet < firstModel, "a model is imported before autoIndex is off");
  assert.match(src, /connectMaintenance\(mongoose, process\.env\.MONGO_URI\)/);
  // Every change comes after the --apply gate.
  const gate = src.indexOf("if (!apply) {");
  for (const call of ["createIndex(", "dropIndex(", "writeBackup("]) {
    const at = src.indexOf(call);
    assert.ok(at > gate, `${call} is reachable without --apply`);
  }
});

test("duplicates block the run; there is no override", () => {
  const src = code(read("./sync-indexes.mjs"));
  assert.doesNotMatch(src, /--force/);
  const blocked = src.indexOf("if (duplicates.length || conflicts.length) {\n  console.log(\"BLOCKED");
  assert.ok(blocked > 0 && blocked < src.indexOf("if (!apply) {"));
  assert.doesNotMatch(src, /deleteMany|deleteOne|remove\(/, "nothing is deleted to make an index fit");
});

test("indexes are built first, and each drop re-confirms its replacement", () => {
  const src = code(read("./sync-indexes.mjs"));
  const build = src.indexOf(".createIndex(");
  const drop = src.indexOf(".dropIndex(");
  assert.ok(build > 0 && drop > build);
  const between = src.slice(build, drop);
  assert.match(between, /const now = await db\.collection\(s\.collection\)\.indexes\(\);/);
  assert.match(between, /if \(!replacementFor\(s\.index, s\.declared, now\)\)/);
  // A failed build stops before any drop.
  assert.match(between, /process\.exit\(1\)/);
});

test("the declared per-firm uniques the script will demand", () => {
  // What `missingTenantUniques` reports on an empty collection: these are the
  // keys an operator should see built.
  assert.deepEqual(missingTenantUniques(PROD_DECLARED, []), [{ companyId: 1, kind: 1, docNo: 1 }]);
});

test("a missing field and an explicit null are ONE key, as the index sees them", () => {
  const docs = [
    { _id: "x", companyId: "F1", docNo: 9 },
    { _id: "y", companyId: "F1", kind: null, docNo: 9 },
  ];
  const groups = runPipeline(docs, duplicatePipeline({ companyId: 1, kind: 1, docNo: 1 }, { unique: true }));
  assert.equal(groups.length, 1, "a bare $kind would have split them and reported ok");
  assert.deepEqual(groups[0].ids.sort(), ["x", "y"]);
});

test("a case-insensitive unique index is checked case-insensitively", () => {
  const docs = [
    { _id: 1, companyId: "F1", email: "Clerk@Shop.in" },
    { _id: 2, companyId: "F1", email: "clerk@shop.in" },
    { _id: 3, companyId: "F2", email: "clerk@shop.in" },
  ];
  const options = { unique: true, collation: { locale: "en", strength: 2 } };
  const groups = runPipeline(docs, duplicatePipeline({ companyId: 1, email: 1 }, options));
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].ids, [1, 2]);
});

test("an index counts as present only with the declared OPTIONS, not just the key", () => {
  const declared = [[{ companyId: 1, invoiceNo: 1 }, { unique: true }]];
  const nonUnique = { name: "companyId_1_invoiceNo_1", key: { companyId: 1, invoiceNo: 1 } };
  const globalOld = { name: "invoiceNo_1", key: { invoiceNo: 1 }, unique: true };
  // Same key, not unique: NOT the replacement -- dropping the global index
  // over it would leave no uniqueness at all.
  assert.equal(satisfies(nonUnique, ...declared[0]), false);
  assert.equal(replacementFor(globalOld, declared, [nonUnique]), null);
  assert.deepEqual(missingTenantUniques(declared, [nonUnique]), [{ companyId: 1, invoiceNo: 1 }]);
  assert.equal(indexConflicts(declared, [nonUnique]).length, 1, "and it is reported as a conflict");

  const irnDeclared = [[{ companyId: 1, irn: 1 }, { unique: true, partialFilterExpression: { irn: { $type: "string" } } }]];
  const sparseIrn = { name: "companyId_1_irn_1", key: { companyId: 1, irn: 1 }, unique: true, sparse: true };
  assert.equal(indexConflicts(irnDeclared, [sparseIrn]).length, 1, "sparse is not partial");
  const right = { ...sparseIrn, sparse: undefined, partialFilterExpression: { irn: { $type: "string" } } };
  assert.equal(indexConflicts(irnDeclared, [right]).length, 0);
  assert.equal(satisfies(right, ...irnDeclared[0]), true);
});

test("the users email index is audited too (unique per firm, case-insensitive)", () => {
  const src = code(read("./sync-indexes.mjs"));
  assert.match(src, /\["users", "userModel"\]/);
  assert.match(src, /\.\.\.TRANSACTION_COLLECTIONS, "users"\]/);
  assert.match(src, /allowDiskUse: true/);
});

/* ────────────────────────────── stock kind ─────────────────────────────── */

console.log("\n--- backfill-stock-kind ---");

test("only rows with no kind are eligible", () => {
  assert.equal(isMissingKind({ docNo: 1 }), true);
  assert.equal(isMissingKind({ docNo: 1, kind: null }), true);
  assert.equal(isMissingKind({ docNo: 1, kind: "" }), true);
  for (const kind of ["FR", "IS", "RS"]) assert.equal(isMissingKind({ kind }), false, kind);
  assert.deepEqual(MISSING_KIND, { $or: [{ kind: { $exists: false } }, { kind: null }, { kind: "" }] });
});

test("a number that would be held twice in one firm blocks the stamp", () => {
  const clashes = kindCollisions({
    unstamped: [
      { _id: "old5", companyId: "F1", docNo: 5 },
      { _id: "old6", companyId: "F1", docNo: 6 },
      { _id: "old7a", companyId: "F2", docNo: 7 },
      { _id: "old7b", companyId: "F2", docNo: 7 },
    ],
    stamped: [
      { _id: "new5", companyId: "F1", docNo: 5 },
      { _id: "other6", companyId: "F2", docNo: 6 }, // another firm: fine
    ],
  });
  assert.deepEqual(
    clashes.map((c) => `${c.companyId}:${c.docNo}:${c.ids.join("+")}`).sort(),
    ["F1:5:old5+new5", "F2:7:old7a+old7b"]
  );
  assert.deepEqual(kindCollisions({ unstamped: [{ _id: 1, companyId: "F", docNo: 1 }] }), []);
});

test("the stamp is by _id AND still-unstamped, backed up first, after the --apply gate", () => {
  const src = code(read("./backfill-stock-kind.mjs"));
  assert.match(src, /\{ _id: \{ \$in: targets\.map\(\(t\) => t\._id\) \}, \.\.\.MISSING_KIND \}/);
  const gate = src.indexOf("if (!apply) {");
  const backup = src.indexOf('writeBackup("stock-kind"');
  const write = src.indexOf(".updateMany(");
  assert.ok(gate > 0 && backup > gate && write > backup);
  assert.ok(src.indexOf("kindCollisions(") < gate, "the clash check runs in the report too");
  assert.doesNotMatch(src, /from "\.\.\/models\//, "no model, so no index is built by importing one");
  assert.match(src, /connectMaintenance\(/);
});

/* ─────────────────────────────── GL legs ───────────────────────────────── */

console.log("\n--- backfill:gl-legs ---");

const sale = (over = {}) => ({
  _id: over._id || "i1",
  companyId: over.companyId || "F1",
  invoiceNo: 1,
  type: "Sale",
  return: false,
  taxType: "local",
  customer: { name: "Acme" },
  finalAmount: 1180,
  received: 0,
  items: [{ name: "Bolt", quantity: 1, taxableAmount: 1000, gstRate: 18, gstAmount: 180, total: 1180 }],
  ...over,
});

test("head movements are kept apart per firm", () => {
  const { plan } = planBackfill({
    allInvoices: [sale({ _id: "a", companyId: "F1" }), sale({ _id: "b", companyId: "F2" })],
  });
  const byFirm = netMovesByFirm(plan);
  assert.equal(byFirm.get(`F1|${SALES_ACCOUNT}`).delta, -1000);
  assert.equal(byFirm.get(`F2|${SALES_ACCOUNT}`).delta, -1000);
  // The database-wide total, which the old script applied to ONE head:
  assert.equal(netMoves(plan).get(SALES_ACCOUNT), -2000);
});

test("an invoice with no firm is never posted", () => {
  const r = planBackfill({ allInvoices: [sale({ companyId: null })] });
  assert.equal(r.plan.length, 0);
  assert.equal(r.counts.noFirm, 1);
  assert.ok(r.skipped.some((s) => s.noFirm));
});

test("a rerun after writing plans nothing: no duplicate postings", () => {
  const invoices = [sale({ _id: "a" }), sale({ _id: "b", invoiceNo: 2 })];
  const first = planBackfill({ allInvoices: invoices });
  assert.equal(first.plan.length, 2);
  // What the first run wrote, as the second run would read it.
  const rowsByInvoice = new Map(first.plan.map((p) => [String(p._id), p.rows]));
  const second = planBackfill({ allInvoices: invoices, rowsByInvoice });
  assert.equal(second.plan.length, 0);
  assert.equal(second.counts.alreadyComplete, 2);
});

test("a run that stopped part-way resumes with only the rest", () => {
  const invoices = [sale({ _id: "a" }), sale({ _id: "b", invoiceNo: 2 })];
  const first = planBackfill({ allInvoices: invoices });
  const rowsByInvoice = new Map([[String(first.plan[0]._id), first.plan[0].rows]]);
  const resumed = planBackfill({ allInvoices: invoices, rowsByInvoice });
  assert.deepEqual(resumed.plan.map((p) => p._id), ["b"]);
});

test("each invoice's rows balance against its party, so the books stay square", () => {
  const { plan } = planBackfill({ allInvoices: [sale()] });
  const contra = plan[0].rows.reduce((s, r) => s + (r.debit || 0) - (r.credit || 0), 0);
  assert.equal(Math.round(contra * 100) / 100, -1180, "the party's +1180 Dr is matched by 1180 Cr");
});

test("an invoice posted under a head stored in other case counts as posted", () => {
  const inv = sale({ _id: "a" });
  const { plan } = planBackfill({ allInvoices: [inv] });
  // What the app wrote, under a firm whose heads are stored lower-case.
  const rows = plan[0].rows.map((r) => ({ ...r, customerName: r.customerName.toLowerCase() }));
  const again = planBackfill({ allInvoices: [inv], rowsByInvoice: new Map([["a", rows]]) });
  assert.equal(again.plan.length, 0);
  assert.equal(again.counts.alreadyComplete, 1);
  assert.ok(!again.skipped.some((x) => x.partial), "not PARTLY posted either");
});

test("heads are matched to the firm's stored name, case and all", () => {
  const { names, missing, clashes } = matchHeads(
    [{ name: "sales account" }, { name: "Round off" }],
    GL_ACCOUNTS
  );
  assert.equal(names.get(SALES_ACCOUNT), "sales account");
  assert.equal(names.get("Round Off"), "Round off");
  assert.ok(missing.length > 0);
  assert.deepEqual(clashes, []);
  const twice = matchHeads([{ name: "Sales Account" }, { name: "SALES ACCOUNT " }], GL_ACCOUNTS);
  assert.equal(twice.clashes.length, 1, "two heads in one firm for one account: stop");
});

test("drift and running balances follow lib/balance.mjs (signed, positive Dr)", () => {
  const rows = [
    { _id: "2", date: "2026-04-02", debit: 0, credit: 300 },
    { _id: "1", date: "2026-04-01", debit: 0, credit: 1000 },
    { _id: "3", date: "2026-04-02", debit: 50, credit: 0 },
  ];
  assert.equal(headDrift({ openingBal: 0, lastBal: -1250 }, rows), 0);
  assert.equal(headDrift({ openingBal: 0, lastBal: -1000 }, rows), 250);
  assert.deepEqual(runningBalances({ openingBal: 0 }, rows), [
    { _id: "1", balance: -1000 },
    { _id: "2", balance: -1300 },
    { _id: "3", balance: -1250 },
  ]);
});

test("the script writes per firm, one invoice per transaction, only after the gate", () => {
  const src = code(read("./backfill-gl-legs.mjs"));
  const gate = src.indexOf("if (!APPLY) {");
  for (const call of ["writeBackup(", ".insertOne(", ".insertMany(", ".updateOne(", ".bulkWrite("]) {
    const at = src.indexOf(call);
    assert.ok(at > gate, `${call} is reachable without --apply`);
  }
  assert.match(src, /if \(!tx\.ok\) \{/);
  assert.ok(src.indexOf("if (!tx.ok) {") < src.indexOf("writeBackup("), "refuses before backing up and writing");
  assert.match(src, /session\.withTransaction\(/);
  // Re-checked inside the transaction, so a second copy cannot post twice.
  const txStart = src.indexOf("session.withTransaction(");
  assert.ok(src.indexOf("postedHeads(now)", txStart) > txStart);
  assert.ok(src.indexOf("postedHeads(now)", txStart) < src.indexOf(".insertMany(", txStart));
  assert.match(src, /balancePipeline\(move\.delta\)/, "the head moves atomically, lastMode with it");
  assert.match(src, /\{ companyId: entry\.companyId, name: stored\(move\.account\) \}/);
  assert.match(src, /backfillRun: runId/, "rows can be found again for a rollback");
  assert.match(src, /quietMongoose\(mongoose\)/);
});

console.log(process.exitCode ? "\nSome checks failed.\n" : `\n${passed} checks passed.\n`);
