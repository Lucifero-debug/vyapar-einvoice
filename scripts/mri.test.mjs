/**
 * Purchase M.R.I. -- lib/mri.mjs, and how the bill, the challan, the routes
 * and the screens use it. Bare node: `node scripts/mri.test.mjs`.
 *
 * SIGFA's behaviour (read from SIGFA105.exe) that these pin:
 *   - an MRI is a purchase invoice or purchase challan, with its own series
 *   - Received / Accepted / Rejected; "Accepted Qty. Is More Than Received Qty."
 *   - only the accepted quantity is the purchase
 *   - Re-MRI against an earlier MRI ("Ag. MRI No."); "List Of Pending MRI"
 *     is every MRI with rejected material and no Re-MRI yet
 *   - Rejected Material Register, Party Wise Rejected Material
 */

import assert from "node:assert/strict";
import fs from "node:fs";

import {
  MRI_VIEWS,
  againstMriProblem,
  checkReceived,
  describeMri,
  hasRejection,
  isMriSide,
  mriRegister,
  mriTotals,
  parseMriHeader,
  partyWiseRejected,
  pendingMris,
  receivedOf,
  referencedReason,
  rejectedMaterial,
  rejectedQty,
  challanOf,
  excessQty,
  shortQty,
  rejectedValue,
} from "../lib/mri.mjs";
import { prepareInvoiceInput } from "../lib/invoiceInput.mjs";
import { prepareChallanInput } from "../lib/challanInput.mjs";
import { PAYLOAD_KEYS, buildInvoicePayload } from "../lib/billingMath.mjs";
import { invoiceStockLines } from "../lib/challanStatus.mjs";
import { permissionForPath } from "../lib/roles.mjs";

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

const NOW = Date.parse("2026-10-14T10:00:00Z");

const PURCHASE = {
  type: "Purchase",
  return: false,
  date: "2026-10-12",
  customer: { name: "Steel Traders" },
  paymentType: "Credit",
  received: 0,
  items: [{ name: "MS Angle", quantity: 80, receivedQty: 100, cost: 50, gstRate: 18 }],
  mri: { on: true, remark: "20 bent", againstMriNo: null },
  // Required on an M.R.I.: the supplier's bill it was received against.
  partyBillNo: "ST/4417",
  partyBillDate: "2026-10-11",
  // An M.R.I. needs its own number.
  invoiceNo: 108,
};

const CHALLAN = {
  type: "Purchase",
  date: "2026-10-12",
  customer: { name: "Steel Traders" },
  items: [{ name: "MS Angle", quantity: "80", receivedQty: "100", cost: "50", gstRate: 18 }],
  mri: { on: true, remark: "" },
  // Required on an M.R.I.: the supplier's challan it came with.
  partyChallanNo: "DC/88",
  partyChallanDate: "2026-10-11",
  // An M.R.I. needs its own number (the date is above).
  challanNo: 5,
};

const doc = (over) => ({
  source: "invoice",
  invoiceNo: 11,
  date: "2026-10-01",
  customer: { name: "Steel Traders" },
  mriNo: 1,
  items: [{ name: "MS Angle", quantity: 80, receivedQty: 100, cost: 50, discount: 10 }],
  ...over,
});

/* ───────────────────────────── one line ──────────────────────────────── */

console.log("\n--- received, accepted, rejected ---");

test("rejected is received less accepted, never negative", () => {
  assert.equal(rejectedQty({ quantity: 80, receivedQty: 100 }), 20);
  assert.equal(rejectedQty({ quantity: 80 }), 0, "no received figure: received what was accepted");
  assert.equal(rejectedQty({ quantity: 80, receivedQty: 80 }), 0);
  assert.equal(rejectedQty({ quantity: 0.3, receivedQty: 0.5 }), 0.2, "decimals do not drift");
  assert.equal(receivedOf({ quantity: 7 }), 7);
  assert.equal(receivedOf({ quantity: 7, receivedQty: "" }), 7);
});

test("the rejected value is at the line's net rate, before GST", () => {
  assert.equal(rejectedValue({ quantity: 80, receivedQty: 100, cost: 50, discount: 10 }), 900);
  assert.equal(rejectedValue({ quantity: 80, receivedQty: 80, cost: 50 }), 0);
});

test("SIGFA's words when more is accepted than received", () => {
  assert.match(checkReceived({ receivedQty: 50 }, 60, { mriOn: true }).error, /Accepted Qty\. Is More Than Received Qty\./);
  assert.equal(checkReceived({ receivedQty: 60 }, 60, { mriOn: true }).value, 60);
  assert.equal(checkReceived({}, 60, { mriOn: true }).value, 60, "blank: received what was accepted");
  assert.match(checkReceived({ receivedQty: -1 }, 0, { mriOn: true }).error, /not below zero/);
  assert.match(checkReceived({ receivedQty: "abc" }, 1, { mriOn: true }).error, /must be a number/);
  assert.match(checkReceived({ receivedQty: 0 }, 0, { mriOn: true }).error, /nothing was received/);
});

test("a received quantity on an ordinary bill is refused, not kept", () => {
  assert.match(checkReceived({ receivedQty: 5 }, 5, { mriOn: false }).error, /only kept on an M\.R\.I\./);
  assert.equal(checkReceived({}, 5, { mriOn: false }).value, undefined);
});

/* ──────────────────────────── the header ─────────────────────────────── */

console.log("\n--- the MRI block ---");

test("only a purchase bill or a purchase challan can be an MRI", () => {
  assert.equal(isMriSide({ type: "Purchase" }), true);
  assert.equal(isMriSide({ type: "Purchase", isReturn: true }), false);
  assert.equal(isMriSide({ type: "Sale" }), false);
  assert.match(parseMriHeader({ on: true }, { type: "Sale" }).error, /Only a purchase/);
  assert.match(parseMriHeader({ on: true }, { type: "Purchase", isReturn: true }).error, /Only a purchase/);
});

test("absent or off is simply not an MRI; the number is never taken from a request", () => {
  assert.deepEqual(parseMriHeader(undefined, { type: "Purchase" }).mri, { on: false, remark: "", againstMriNo: null });
  assert.equal(parseMriHeader({ on: false, remark: "x" }, { type: "Sale" }).mri.on, false, "off is fine on any screen");
  assert.match(parseMriHeader({ on: true, mriNo: 9 }, { type: "Purchase" }).error, /"mriNo" is not an M\.R\.I\. field/);
  assert.match(parseMriHeader({ on: "yes" }, { type: "Purchase" }).error, /on or off/);
  assert.match(parseMriHeader({ on: true, againstMriNo: 2.5 }, { type: "Purchase" }).error, /Ag\. MRI No\./);
  assert.match(parseMriHeader({ on: true, remark: "x".repeat(301) }, { type: "Purchase" }).error, /too long/);
  assert.deepEqual(parseMriHeader({ on: true, remark: " ok ", againstMriNo: "4" }, { type: "Purchase" }).mri, {
    on: true,
    remark: "ok",
    againstMriNo: 4,
  });
});

/* ──────────────────────────── the bill ───────────────────────────────── */

console.log("\n--- a purchase bill as an MRI ---");

test("the bill is priced, taxed and totalled on the ACCEPTED quantity", () => {
  const r = prepareInvoiceInput(PURCHASE, { now: NOW });
  assert.equal(r.ok, true, r.error);
  const line = r.invoice.items[0];
  assert.equal(line.quantity, 80);
  assert.equal(line.receivedQty, 100);
  assert.equal(line.taxableAmount, 4000, "80 x 50, not 100 x 50");
  assert.equal(r.invoice.mri.on, true);
  assert.equal(r.invoice.mri.remark, "20 bent");
});

test("a lot rejected outright is a line accepted at zero -- on an MRI only", () => {
  const all = { ...PURCHASE, items: [{ name: "Bolt", quantity: 0, receivedQty: 40, cost: 5 }, PURCHASE.items[0]] };
  const r = prepareInvoiceInput(all, { now: NOW });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.invoice.items[0].quantity, 0);
  assert.equal(r.invoice.items[0].total, 0);
  // The fully rejected line moves no stock; the accepted one does.
  assert.deepEqual(invoiceStockLines(r.invoice.items).map((l) => l.name), ["MS Angle"]);
  // Off an MRI, zero is still refused, received or not.
  const plain = { ...all, mri: undefined, items: [{ name: "Bolt", quantity: 0, cost: 5 }] };
  assert.match(prepareInvoiceInput(plain, { now: NOW }).error, /more than zero/);
});

test("a bill with nothing accepted is refused -- that delivery is a challan MRI", () => {
  const none = { ...PURCHASE, items: [{ name: "Bolt", quantity: 0, receivedQty: 40, cost: 5 }] };
  assert.match(prepareInvoiceInput(none, { now: NOW }).error, /Nothing was accepted/);
  const c = prepareChallanInput({ ...CHALLAN, items: [{ name: "Bolt", quantity: 0, receivedQty: 40, cost: 5 }] }, { now: NOW });
  assert.equal(c.items[0].quantity, 0);
});

test("refusals on the bill", () => {
  const bad = (over) => prepareInvoiceInput({ ...PURCHASE, ...over }, { now: NOW });
  assert.match(bad({ items: [{ name: "MS Angle", quantity: 120, receivedQty: 100, cost: 50 }] }).error, /Accepted Qty\. Is More Than Received Qty\./);
  assert.match(bad({ mri: undefined }).error, /only kept on an M\.R\.I\./, "received figure without an MRI");
  assert.match(bad({ type: "Sale" }).error, /Only a purchase/);
  assert.match(bad({ return: true }).error, /Only a purchase/);
});

test("the payload carries `mri`, and the purchase screen sends it", () => {
  assert.ok(PAYLOAD_KEYS.includes("mri"));
  const built = buildInvoicePayload({ items: [], mri: { on: true, remark: "", againstMriNo: null } }, { type: "Purchase", isReturn: false });
  assert.deepEqual(built.mri, { on: true, remark: "", againstMriNo: null });
  assert.equal(buildInvoicePayload({ items: [] }, { type: "Sale", isReturn: false }).mri, undefined);
  const screen = read("../components/billing/BillingScreen.jsx");
  assert.match(screen, /mri: takesMri \? mri : undefined/);
  // Switching the MRI off drops the received figures rather than sending them.
  assert.match(screen, /selectedItem\.map\(\(\{ receivedQty: _received, \.\.\.line \}\) => line\)/);
});

/* ──────────────────────────── the challan ────────────────────────────── */

console.log("\n--- a purchase challan as an MRI ---");

test("a purchase challan takes the same rules", () => {
  const c = prepareChallanInput(CHALLAN, { now: NOW });
  assert.equal(c.mri.on, true);
  assert.equal(c.items[0].quantity, 80);
  assert.equal(c.items[0].receivedQty, 100);
  assert.throws(
    () => prepareChallanInput({ ...CHALLAN, items: [{ name: "X", quantity: 5, receivedQty: 4, cost: 1 }] }, { now: NOW }),
    /Accepted Qty\. Is More Than Received Qty\./
  );
  assert.throws(() => prepareChallanInput({ ...CHALLAN, type: "Sale" }, { now: NOW }), /Only a purchase/);
  assert.throws(() => prepareChallanInput({ ...CHALLAN, mri: undefined }, { now: NOW }), /only kept on an M\.R\.I\./);
  const zero = prepareChallanInput({ ...CHALLAN, items: [{ name: "X", quantity: 0, receivedQty: 3, cost: 1 }] }, { now: NOW });
  assert.equal(zero.items[0].quantity, 0);
});

/* ───────────────────────────── Re-MRI ────────────────────────────────── */

console.log("\n--- Re-MRI and the pending list ---");

test("a Re-MRI must name a real MRI of the same supplier, with something rejected, not yet re-inspected", () => {
  const target = doc({});
  const ok = { againstMriNo: 1, target, party: "Steel Traders", self: null, claimedBy: null };
  assert.equal(againstMriProblem(ok), null);
  assert.equal(againstMriProblem({ ...ok, againstMriNo: null }), null, "no Ag. MRI No. is a fresh MRI");
  assert.match(againstMriProblem({ ...ok, target: null }), /was not found/);
  assert.match(againstMriProblem({ ...ok, self: 1 }), /against itself/);
  assert.match(againstMriProblem({ ...ok, party: "Someone Else" }), /is from Steel Traders, not Someone Else/);
  assert.equal(againstMriProblem({ ...ok, party: "steel traders" }), null, "case does not make a different party");
  assert.match(
    againstMriProblem({ ...ok, target: doc({ items: [{ name: "A", quantity: 5, receivedQty: 5 }] }) }),
    /rejected nothing/
  );
  assert.match(againstMriProblem({ ...ok, claimedBy: doc({ mriNo: 2, invoiceNo: 14 }) }), /already raised against M\.R\.I\. 1 \(M\.R\.I\. 2 -- Purchase bill 14\)/);
});

test("SIGFA's pending list: rejected material with no Re-MRI against it", () => {
  const docs = [
    doc({ mriNo: 1 }),
    doc({ mriNo: 2, invoiceNo: 12, items: [{ name: "Bolt", quantity: 10, receivedQty: 10 }] }),
    doc({ mriNo: 3, invoiceNo: 13, customer: { name: "Wire Co" } }),
    doc({ mriNo: 4, source: "challan", challanNo: 5, invoiceNo: undefined, againstMriNo: 3, items: [{ name: "MS Angle", quantity: 20, receivedQty: 20 }] }),
  ];
  assert.deepEqual(pendingMris(docs).map((r) => r.mriNo), [1]);
  const reg = mriRegister(docs);
  const by = Object.fromEntries(reg.map((r) => [r.mriNo, r]));
  assert.equal(by[1].status, "pending");
  assert.equal(by[2].status, "clear");
  assert.equal(by[3].status, "re-mri");
  assert.equal(by[3].reMriNo, 4);
  assert.equal(by[4].documentLabel, "Purchase challan");
  assert.equal(by[4].documentNo, 5);
  assert.equal(by[4].againstMriNo, 3);
  assert.deepEqual(reg.map((r) => r.mriNo), [4, 3, 2, 1], "newest first");
  assert.deepEqual(
    { received: by[1].received, accepted: by[1].accepted, rejected: by[1].rejected, value: by[1].rejectedValue },
    { received: 100, accepted: 80, rejected: 20, value: 900 }
  );
});

test("totals over a document, and the yes/no", () => {
  const items = [
    { name: "A", quantity: 8, receivedQty: 10, cost: 10 },
    { name: "B", quantity: 5, cost: 2 },
  ];
  assert.deepEqual(mriTotals(items), { received: 15, accepted: 13, rejected: 2, rejectedValue: 20 });
  assert.equal(hasRejection({ items }), true);
  assert.equal(hasRejection({ items: [items[1]] }), false);
});

test("the rejected material register, and party wise", () => {
  const docs = [
    doc({ mriNo: 1 }),
    doc({ mriNo: 5, invoiceNo: 20, items: [{ name: "MS Angle", quantity: 45, receivedQty: 50, cost: 50, discount: 10 }, { name: "Bolt", quantity: 9, receivedQty: 10, cost: 2 }] }),
    doc({ mriNo: 6, invoiceNo: 21, againstMriNo: 1, items: [{ name: "MS Angle", quantity: 20, receivedQty: 20, cost: 50 }] }),
  ];
  const rows = rejectedMaterial(docs);
  assert.deepEqual(rows.map((r) => [r.mriNo, r.item, r.rejected]), [
    [5, "Bolt", 1],
    [5, "MS Angle", 5],
    [1, "MS Angle", 20],
  ]);
  assert.equal(rows.find((r) => r.mriNo === 1).status, "re-mri");
  assert.equal(rows.find((r) => r.mriNo === 5).status, "pending");
  const party = partyWiseRejected(rows);
  const angle = party.find((r) => r.item === "MS Angle");
  assert.deepEqual(
    { mris: angle.mris, received: angle.received, rejected: angle.rejected, value: angle.value, pending: angle.pending },
    { mris: 2, received: 150, rejected: 25, value: 1125, pending: 1 }
  );
});

test("a Re-MRI blocks changing or deleting the MRI it points at, in words", () => {
  const reason = referencedReason(doc({ mriNo: 1 }), doc({ mriNo: 6, invoiceNo: 21 }));
  assert.match(reason, /used in Re-M\.R\.I\.: M\.R\.I\. 6 -- Purchase bill 21 is raised against M\.R\.I\. 1/);
  assert.equal(referencedReason(doc({}), null), null);
  assert.equal(describeMri({ source: "challan", challanNo: 4, mriNo: 2 }), "M.R.I. 2 -- Purchase challan 4");
});

/* ──────────────────────────── the wiring ─────────────────────────────── */

console.log("\n--- the routes, the models and the screens ---");

test("the bill and challan routes number the MRI and check Ag. MRI No. inside their transaction", () => {
  const save = code(read("../app/api/save-invoice/route.js"));
  assert.match(save, /await mriFields\(\{ session, mri: input\.mri, party: customer\.name, items: input\.items \}\)/);
  assert.match(save, /mriNo: mriData\.mriNo \|\| undefined/);
  const alter = code(read("../app/api/sale-alter/route.js"));
  assert.match(alter, /await mriFields\(\{\s*session,\s*mri: invoiceData\.mri,\s*previous: previousInvoice,\s*party: buyer\.name,\s*items: invoiceData\.items,?\s*\}\)/);
  assert.match(alter, /mriNo: mriData\.mriNo,/);
  const challanSave = code(read("../lib/challanSave.mjs"));
  assert.match(challanSave, /await mriFields\(\{ session, mri: input\.mri, previous, party: buyer\.name, items \}\)/);
  assert.match(code(read("../app/api/challan-alter/route.js")), /challanFields\(\{ session, input, items, previous \}\)/);
});

test("a Re-MRI locks the MRI it re-inspects, and that MRI keeps its rejection and supplier", () => {
  const src = code(read("../lib/mriSave.mjs"));
  assert.match(src, /Model\.updateOne\(\{ _id: target\._id \}, \{ \$inc: \{ mriLock: 1 \} \}, opts\(session\)\)/);
  assert.match(src, /if \(re && !hasRejection\(\{ items \}\)\)/);
  assert.match(src, /The supplier cannot change/);
  for (const file of ["../models/invoiceModel.js", "../models/challanModel.js"]) {
    const model = read(file);
    assert.match(model, /mriLock: \{ type: Number \}/, file);
    assert.match(
      model,
      /\{ companyId: 1, againstMriNo: 1 \},[\s\S]{0,80}\{ unique: true, partialFilterExpression: \{ againstMriNo: \{ \$type: "number" \} \} \}/,
      file
    );
  }
  // Every route hands over the lines, so the rejection check sees them.
  assert.match(code(read("../app/api/sale-alter/route.js")), /items: invoiceData\.items,\s*\}\)/);
  assert.match(code(read("../app/api/save-invoice/route.js")), /party: customer\.name, items: input\.items \}/);
  assert.match(code(read("../lib/challanSave.mjs")), /party: buyer\.name, items \}/);
});

test("an MRI with a Re-MRI against it cannot be deleted, as a bill or as a challan", () => {
  assert.match(code(read("../app/api/delete-invoice/route.js")), /await assertMriDeletable\(existing, session\)/);
  assert.match(code(read("../app/api/delete-invoice/route.js")), /mriNo: 1 \}/, "the lookup reads the MRI number");
  assert.match(code(read("../app/api/delete-challan/route.js")), /await assertMriDeletable\(existing, session\)/);
});

test("the series is one counter across bills and challans, reserved in the session", () => {
  const src = code(read("../lib/mriSave.mjs"));
  assert.match(src, /\{ name: MRI_COUNTER \},\s*\{ \$inc: \{ value: 1 \} \}/);
  assert.match(src, /Invoice\.findOne\(\{ mriNo: \{ \$type: "number" \} \}/);
  assert.match(src, /Challan\.findOne\(\{ mriNo: \{ \$type: "number" \} \}/);
  // Every query outside the read-only peek carries the session.
  const start = src.indexOf("export async function peekNextMriNo");
  const end = src.indexOf("export async function", start + 1);
  const transactional = src.slice(0, start) + src.slice(end);
  const calls = [...transactional.matchAll(/\.(findOne|updateOne|findOneAndUpdate)\(([\s\S]*?)\)(\.|;)/g)];
  assert.ok(calls.length >= 8, `found ${calls.length} queries`);
  for (const m of calls) assert.match(m[2], /opts\(session\)/, `a ${m[1]} without the session: ${m[2].slice(0, 80)}`);
});

test("both models declare the MRI fields, unique per firm where it is a number", () => {
  for (const file of ["../models/invoiceModel.js", "../models/challanModel.js"]) {
    const model = read(file);
    assert.match(model, /receivedQty:\s*\{\s*type:\s*Number\s*\}/, file);
    assert.match(model, /mriNo: \{ type: Number \}/, file);
    assert.match(model, /againstMriNo: \{ type: Number \}/, file);
    assert.match(
      model,
      /\{ companyId: 1, mriNo: 1 \},\s*\{ unique: true, partialFilterExpression: \{ mriNo: \{ \$type: "number" \} \} \}/,
      file
    );
  }
});

test("the registers are read-only, take the invoice permissions, and validate what they are given", () => {
  const api = code(read("../app/api/mri/route.js"));
  assert.match(api, /export const GET = tenantRoute\(handleGET\)/);
  assert.doesNotMatch(api, /\.(create|updateOne|updateMany|deleteMany|deleteOne|insertMany|bulkWrite|findOneAndUpdate)\(/);
  assert.match(api, /isMriView\(view\)/);
  assert.match(api, /That is not a date/);
  assert.equal(permissionForPath("/api/mri"), "invoice:read");
  assert.equal(permissionForPath("/mri"), "invoice:read");
  assert.equal(permissionForPath("/api/next-mri-no"), "invoice:write");
  assert.deepEqual(MRI_VIEWS, ["register", "pending", "rejected", "party"]);
});

test("Purchase M.R.I. sits in the Purchases section, after Purchase Challan", () => {
  const home = read("../app/page.js");
  const i = home.indexOf("{renderChallanRow({ type: 'Purchase', label: 'Purchase Challan' })}");
  const j = home.indexOf("{renderMriRow()}");
  assert.ok(i > 0 && j > i && j - i < 200, "the MRI row follows the purchase challan row");
  for (const href of ["/purchaseadd?mri=1", "/challanadd?type=Purchase&mri=1", "/mri?view=pending", "/mri?view=rejected"]) {
    assert.ok(home.includes(href), href);
  }
});

console.log("\n--- the third quantity: what the challan said ---");

test("short is what the challan promised and did not arrive", () => {
  // Two figures can only say what FAILED. Three say what never turned up as
  // well, and they are different arguments with a supplier: goods short on
  // the lorry are not goods sent back after inspection.
  assert.equal(shortQty({ challanQty: 100, receivedQty: 90, quantity: 80 }), 10);
  assert.equal(rejectedQty({ challanQty: 100, receivedQty: 90, quantity: 80 }), 10, "and 10 rejected");
  // All of it arrived.
  assert.equal(shortQty({ challanQty: 100, receivedQty: 100, quantity: 100 }), 0);
  assert.equal(shortQty({ challanQty: 0.5, receivedQty: 0.3, quantity: 0.3 }), 0.2, "decimals do not drift");
});

test("no challan figure claims nothing", () => {
  // A bill not drawn from a challan has no promise to fall short of. Reading
  // the absence as nought would make every ordinary purchase M.R.I. report
  // its whole receipt as short.
  assert.equal(challanOf({ quantity: 80 }), 0);
  assert.equal(challanOf({ challanQty: null, quantity: 80 }), 0);
  assert.equal(challanOf({ challanQty: "", quantity: 80 }), 0);
  assert.equal(shortQty({ receivedQty: 90, quantity: 80 }), 0);
  assert.equal(shortQty({ challanQty: 0, receivedQty: 90, quantity: 80 }), 0);
  assert.equal(excessQty({ receivedQty: 90, quantity: 80 }), 0);
});

test("more than the challan said is reported, not refused", () => {
  // It happens -- a replacement sent in the same lot. Capping the received
  // figure at the challan's would hide goods the firm is now holding.
  assert.equal(excessQty({ challanQty: 100, receivedQty: 110, quantity: 110 }), 10);
  assert.equal(shortQty({ challanQty: 100, receivedQty: 110, quantity: 110 }), 0, "not short as well");
  // And the received quantity is still accepted by the line check: the
  // challan is not a limit on what arrived.
  assert.deepEqual(
    checkReceived({ receivedQty: 110 }, 110, { mriOn: true }),
    { value: 110 }
  );
});

test("short and rejected are counted apart, not rolled together", () => {
  // 100 promised, 90 came, 80 passed. One line, two different problems.
  const line = { challanQty: 100, receivedQty: 90, quantity: 80 };
  assert.equal(shortQty(line), 10);
  assert.equal(rejectedQty(line), 10);
  assert.notEqual(shortQty(line) + rejectedQty(line), shortQty(line), "they are separate figures");
  // The bill is still priced on the accepted quantity, which is what the
  // module header says an M.R.I. must not change.
  assert.equal(line.quantity, 80);
});

test("a line drawn from a challan carries what that challan said", () => {
  // Without it the challan's own number is gone the moment the line is
  // merged: pickFromChallans overwrites `quantity` with what is being billed.
  const src = code(read("../lib/challanStatus.mjs"));
  assert.match(src, /challanQty: roundQty\(line\.quantity\)/);
});

test("it is kept only on a line that names a challan, and is declared", () => {
  // A figure standing alone would read as a shortfall against a promise
  // nobody made.
  const input = code(read("../lib/invoiceInput.mjs"));
  const at = input.indexOf("line.challanQty");
  assert.ok(at > 0, "the route drops the challan quantity");
  assert.ok(
    at > input.indexOf("if (anyChallan)"),
    "it is set outside the block that requires a challan reference"
  );
  // Mongoose strict mode drops what is not declared, and a dropped promise
  // is a receipt that silently loses what was sent.
  assert.match(read("../models/invoiceModel.js"), /challanQty:\{type:Number\}/);
});

test("the purchase challan takes it, because that is where their paper is", () => {
  // The receipt screen itself: the supplier's challan is in front of you, so
  // the figure is TYPED here, unlike on a bill drawn from a challan we have
  // already recorded, where it is copied.
  const screen = read("../app/challanadd/page.js");
  assert.match(screen, /<th className="num">Challan Qty<\/th>/);
  assert.match(screen, /<th className="num">Short<\/th>/, "short is not shown apart from rejected");
  assert.match(screen, /setDraft\(\{ \.\.\.draft, challanQty: e\.target\.value \}\)/);
  assert.match(screen, /editLine\(i, 'challanQty', e\.target\.value\)/);
  // A blank box is kept blank on the way out AND on the way back in.
  assert.match(screen, /challanQty: mriLine && promised !== null \? roundQty\(promised\) : ''/);
  assert.match(screen, /challanQty: l\.challanQty === undefined \|\| l\.challanQty === null \? '' : l\.challanQty/);
  // And the empty-table colspan counts the two new columns, or the message
  // sits under half the header.
  assert.match(screen, /colSpan=\{showMri \? 14 : 10\}/);
});

test("the challan route keeps it only on an M.R.I., and the model declares it", () => {
  // On an M.R.I. it is kept, and the short figure falls out of it.
  const onMri = prepareChallanInput(
    { ...CHALLAN, items: [{ name: "MS Angle", quantity: 80, receivedQty: 90, challanQty: 100, cost: 50 }] },
    { now: NOW }
  );
  assert.equal(onMri.items[0].challanQty, 100);
  assert.equal(shortQty(onMri.items[0]), 10, "10 never turned up");
  assert.equal(rejectedQty(onMri.items[0]), 10, "and 10 was turned away");

  // Off one it is refused rather than stored where nothing would read it.
  assert.throws(
    () =>
      prepareChallanInput(
        { ...CHALLAN, mri: undefined, items: [{ name: "MS Angle", quantity: 80, challanQty: 100, cost: 50 }] },
        { now: NOW }
      ),
    /only kept on an M\.R\.I\./
  );

  // Blank stays absent: no paper came with it, which is not a promise of
  // nothing. `shortQty` then claims nothing either.
  const bare = prepareChallanInput(CHALLAN, { now: NOW });
  assert.equal(bare.items[0].challanQty, undefined);
  assert.equal(shortQty(bare.items[0]), 0);

  // Mongoose strict mode drops what is not declared.
  assert.match(read("../models/challanModel.js"), /challanQty: \{ type: Number \}/);
});

test("the bill copies it from a recorded challan, and takes it typed on a keyed-in line", () => {
  // Copied from a challan we recorded, it is the SUPPLIER'S figure: a
  // receipt whose promise can be edited to match what arrived proves
  // nothing, so that line shows it and has no box.
  const screen = read("../components/billing/BillingScreen.jsx");
  assert.match(screen, /<th className='text-right'>Challan Qty<\/th>/);
  assert.match(screen, /\{items\.challanNo \? \([\s\S]{0,400}items\.challanQty \?\? '—'\s*\) : \(/);
  assert.match(screen, /shortQty\(items\) > 0/, "a short delivery is not flagged");
  // A line keyed in directly has the supplier's paper in hand, as on the
  // purchase challan screen: there it is typed.
  assert.match(screen, /onChange=\{\(e\) => handleChallanQtyChange\(index, e\.target\.value\)\}/);
  // Switching the M.R.I. off drops a typed one, which the route would refuse.
  assert.match(screen, /<MriPanel mri=\{mri\} onChange=\{changeMri\}/);
  // And the handler refuses to touch a copied one.
  assert.match(screen, /if \(idx !== index \|\| item\.challanNo\) return item;/);
});

test("the bill route keeps a typed challan quantity only on an M.R.I.", () => {
  // Keyed in directly, on an M.R.I.: kept, and short and rejected read apart.
  const typed = { ...PURCHASE, items: [{ ...PURCHASE.items[0], receivedQty: 90, challanQty: 100 }] };
  const r = prepareInvoiceInput(typed, { now: NOW });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.invoice.items[0].challanQty, 100);
  assert.equal(shortQty(r.invoice.items[0]), 10, "10 never turned up");
  assert.equal(rejectedQty(r.invoice.items[0]), 10, "and 10 was turned away");

  // Off an M.R.I. it is refused rather than stored where nothing reads it.
  const off = prepareInvoiceInput(
    { ...PURCHASE, mri: undefined, items: [{ name: "MS Angle", quantity: 80, challanQty: 100, cost: 50, gstRate: 18 }] },
    { now: NOW }
  );
  assert.match(off.error || "", /only kept on an M\.R\.I\./);

  // Blank stays absent: no paper is not a promise of nothing.
  const bare = prepareInvoiceInput(PURCHASE, { now: NOW });
  assert.equal(bare.invoice.items[0].challanQty, undefined);
  assert.equal(shortQty(bare.invoice.items[0]), 0);
});

console.log("\n--- an M.R.I. needs its own number and date ---");

test("a purchase bill M.R.I. needs its Invoice No, unless a series numbers it", () => {
  assert.equal(prepareInvoiceInput({ ...PURCHASE, invoiceNo: 112 }, { now: NOW }).ok, true);
  assert.match(prepareInvoiceInput({ ...PURCHASE, invoiceNo: "" }, { now: NOW }).error, /needs an Invoice No/);
  // A series gives the number itself.
  assert.equal(prepareInvoiceInput({ ...PURCHASE, invoiceNo: "", series: "MI" }, { now: NOW }).ok, true);
  // The date is required on every bill, as it always was.
  assert.ok(prepareInvoiceInput({ ...PURCHASE, invoiceNo: 112, date: "" }, { now: NOW }).error);
  // The supplier's bill number and date are NOT required.
  const r = prepareInvoiceInput({ ...PURCHASE, invoiceNo: 112, partyBillNo: "", partyBillDate: "" }, { now: NOW });
  assert.equal(r.ok, true, r.error);
  // Not an M.R.I.: a blank number is still given the next one.
  const plain = prepareInvoiceInput(
    { ...PURCHASE, mri: undefined, invoiceNo: "", items: [{ name: "MS Angle", quantity: 80, cost: 50, gstRate: 18 }] },
    { now: NOW }
  );
  assert.equal(plain.ok, true, plain.error);
});

test("a purchase challan M.R.I. needs its Challan No. and Challan Date", () => {
  assert.equal(prepareChallanInput({ ...CHALLAN, challanNo: 7 }, { now: NOW }).challanNo, 7);
  assert.throws(() => prepareChallanInput({ ...CHALLAN, challanNo: "" }, { now: NOW }), /needs a Challan No/);
  assert.throws(() => prepareChallanInput({ ...CHALLAN, challanNo: 7, date: "" }, { now: NOW }), /needs a Challan Date/);
  // The supplier's challan number and date are NOT required.
  assert.equal(prepareChallanInput({ ...CHALLAN, challanNo: 7, partyChallanNo: "", partyChallanDate: "" }, { now: NOW }).partyChallanNo, "");
  // Not an M.R.I.: blank number and date are filled in as before.
  const plain = prepareChallanInput(
    { ...CHALLAN, mri: undefined, challanNo: "", date: "", items: [{ name: "MS Angle", quantity: "80", cost: "50", gstRate: 18 }] },
    { now: NOW }
  );
  assert.equal(plain.challanNo, null);
});

test("the M.R.I. screens star the top number and date, not the supplier's", () => {
  const bill = read("../components/billing/BillingScreen.jsx");
  assert.match(bill, /Invoice No\{takesMri && mri\.on \? <span[^>]*text-destructive/);
  assert.match(bill, /'field-label mb-1'>Date\{takesMri && mri\.on \? <span[^>]*text-destructive/);
  assert.doesNotMatch(bill, /Supplier Bill (No|Date)'\}\s*\{takesMri/, "a supplier field is still starred");
  assert.match(bill, /if \(!chosenSeries && !String\(invoiceNo \?\? ''\)\.trim\(\)\)/);
  const challan = read("../app/challanadd/page.js");
  assert.match(challan, /Challan No\.\{showMri \? <span[^>]*text-destructive/);
  assert.match(challan, /Challan Date\{showMri \? <span[^>]*text-destructive/);
  assert.doesNotMatch(challan, /challan (No\.|date)\{showMri/, "a supplier field is still starred");
});

test("the supplier's bill date is stored, sent, reloaded and written on an edit", () => {
  assert.match(read("../models/invoiceModel.js"), /partyBillDate: \{ type: Date \}/);
  const math = read("../lib/billingMath.mjs");
  assert.match(math, /"partyBillDate",/);
  assert.match(math, /partyBillDate: form\.partyBillDate,/);
  assert.match(read("../app/api/save-invoice/route.js"), /partyBillDate: input\.partyBillDate,/);
  assert.match(read("../app/api/sale-alter/route.js"), /partyBillDate: invoiceData\.partyBillDate \?\? null,/);
  const screen = read("../components/billing/BillingScreen.jsx");
  assert.match(screen, /setPartyBillDate\(data\.partyBillDate \? formatDate\(data\.partyBillDate\) : ''\)/);
});

test("a whole register row opens its bill or challan, not only the Document link", () => {
  const page = read("../app/mri/page.js");
  assert.match(page, /<tr key=\{r\.mriNo\} \{\.\.\.rowOpener\(router, r\)\}>/, "the M.R.I. register row");
  assert.match(page, /<tr key=\{`\$\{r\.mriNo\}-\$\{r\.item\}-\$\{i\}`\} \{\.\.\.rowOpener\(router, r\)\}>/, "the rejected material row");
  // Reachable by keyboard, and the link inside does not open it twice.
  assert.match(page, /e\.key === 'Enter'/);
  assert.match(page, /tabIndex: 0/);
  assert.match(page, /e\.stopPropagation\(\);\s*router\.push\(docHref\(r\)\)/);
});

console.log(`\n  ${passed} checks passed\n`);
