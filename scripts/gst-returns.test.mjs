/**
 * Sigfa's GST returns: scripts/gst-returns.test.mjs
 *
 * Plain node, no framework -- `node scripts/gst-returns.test.mjs`.
 *
 * WHAT THIS SUITE IS GUARDING. A GST return is the one report in this app
 * that a stranger audits. Three things matter more than the rest, and most of
 * what follows aims at them:
 *
 *   1. ONE TABLE PER DOCUMENT. Every sales document belongs in exactly one of
 *      B2B / B2CL / B2CS / CDNR / CDNUR. A bill claimed by two tables is
 *      filed twice; a bill claimed by none is not filed at all.
 *
 *   2. THE TAX ADDS BACK. CGST + SGST has to come to the tax the invoice
 *      charged, to the paisa, at every level of grouping.
 *
 *   3. AN EMPTY TABLE IS NOT A ZERO. The four tables this app cannot build
 *      must say so rather than report nothing to file.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  B2CL_THRESHOLD,
  GSTR1_SECTIONS,
  GSTR3B_SECTIONS,
  GSTR3_SECTIONS,
  GST_RETURNS,
  RETURN_KEYS,
  b2bBlocks,
  b2clBlocks,
  b2csRows,
  cdnrBlocks,
  cdnurRows,
  docIssueRows,
  documentsIn,
  eReturnGaps,
  eReturnProblem,
  groupTotals,
  gstr1Json,
  gstr1Sheet,
  gstr3Sheet,
  gstr3bSheet,
  hsnRows,
  isCreditNote,
  isInterState,
  isRegistered,
  isReturnKey,
  jsonFilename,
  outwardTotals,
  portalDate,
  rateGroups,
  returnTitle,
  tableFor,
  taxPeriod,
  taxSplit,
} from "../lib/gstReturns.mjs";
import { splitGst } from "../lib/gst.mjs";
import { canAccessPath, permissionForPath } from "../lib/roles.mjs";

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

/** Comments explain what these files avoid, and greps match the prose. */
const code = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

const line = (over = {}) => ({
  name: "Plate",
  hsn: "7308",
  uqc: "KGS",
  quantity: 10,
  gstRate: 18,
  taxableAmount: 1000,
  gstAmount: 180,
  total: 1180,
  ...over,
});

/** A registered, intra-State sale: the ordinary B2B bill. */
const invoice = (over = {}) => ({
  invoiceNo: 1,
  type: "Sale",
  return: false,
  date: "2026-06-15",
  customer: { name: "Acme Traders", gstin: "07AAACA1111A1Z5" },
  stateOfSupply: "Delhi",
  stateCode: "07",
  taxType: "local",
  gst: 180,
  totalAmount: 1180,
  finalAmount: 1180,
  items: [line()],
  ...over,
});

/** Unregistered, inter-State, over the limit: table 5. */
const BIG_B2CL = invoice({
  invoiceNo: 2,
  customer: { name: "Walk-in" },
  taxType: "central",
  stateCode: "27",
  gst: 45762.71,
  totalAmount: 300000,
  finalAmount: 300000,
  items: [line({ taxableAmount: 254237.29, gstAmount: 45762.71, total: 300000 })],
});

/** Unregistered, small: table 7. */
const SMALL_B2CS = invoice({
  invoiceNo: 3,
  customer: { name: "Small Shop" },
  gst: 90,
  totalAmount: 590,
  finalAmount: 590,
  items: [line({ quantity: 5, taxableAmount: 500, gstAmount: 90, total: 590 })],
});

/** A credit note to a registered buyer: table 9. */
const CDNR_NOTE = invoice({
  invoiceNo: 4,
  return: true,
  gst: 36,
  totalAmount: 236,
  finalAmount: 236,
  items: [line({ quantity: 2, taxableAmount: 200, gstAmount: 36, total: 236 })],
});

/** A credit note to an unregistered buyer: table 10, and net off table 7. */
const CDNUR_NOTE = invoice({
  invoiceNo: 5,
  return: true,
  customer: { name: "Small Shop" },
  gst: 18,
  totalAmount: 118,
  finalAmount: 118,
  items: [line({ quantity: 1, taxableAmount: 100, gstAmount: 18, total: 118 })],
});

/** Registered AND inter-State: in 3.1(a) but NOT in 3B's 3.2 subset. */
const REGISTERED_INTERSTATE = invoice({
  invoiceNo: 6,
  customer: { name: "Mumbai Metals", gstin: "27AAACM2222B1Z4" },
  taxType: "central",
  stateCode: "27",
});

/** Unregistered, inter-State, under the limit: table 7 as INTER. */
const SMALL_INTERSTATE = invoice({
  invoiceNo: 7,
  customer: { name: "Pune Shop" },
  taxType: "central",
  stateCode: "27",
  gst: 36,
  totalAmount: 236,
  finalAmount: 236,
  items: [line({ quantity: 2, gstRate: 18, taxableAmount: 200, gstAmount: 36, total: 236 })],
});

/** Unregistered, intra-State, a SECOND rate: table 7 grouped by rate. */
const SMALL_OTHER_RATE = invoice({
  invoiceNo: 8,
  customer: { name: "Small Shop" },
  gst: 15,
  totalAmount: 315,
  finalAmount: 315,
  items: [line({ name: "Book", hsn: "4901", gstRate: 5, quantity: 3, taxableAmount: 300, gstAmount: 15, total: 315 })],
});

const ALL = [invoice(), BIG_B2CL, SMALL_B2CS, CDNR_NOTE, CDNUR_NOTE];
const PERIOD = { from: "2026-06-01", to: "2026-06-30" };

console.log("\n--- the four returns Sigfa has ---");

test("named as Sigfa names them, brackets and all", () => {
  assert.deepEqual(
    GST_RETURNS.map((r) => r.title),
    [
      "GSTR-1 [ E-Return ]",
      "GSTR-1 [ Outward Supply - Sale ]",
      "GSTR-3 [ Inward And Outward ]",
      "GSTR-3B [ Inward And Outward ]",
    ]
  );
  assert.deepEqual(RETURN_KEYS, ["gstr1-ereturn", "gstr1", "gstr3", "gstr3b"]);
  assert.equal(isReturnKey("gstr1"), true);
  assert.equal(isReturnKey("gstr2"), false, "not one of the four asked for");
  assert.equal(isReturnKey(""), false);
  assert.equal(returnTitle("gstr3b"), "GSTR-3B [ Inward And Outward ]");
});

test("GSTR-1 carries Sigfa's ten tables, in its numbering and its words", () => {
  assert.deepEqual(GSTR1_SECTIONS.map((s) => s.no), ["4","5","6","7","8","9","10","11","12","13"]);
  assert.deepEqual(
    GSTR1_SECTIONS.map((s) => s.tag),
    ["B2B","B2CL","EXP","B2CS","EXEMP","CDNR","CDNUR","AT","HSN","DOCS"]
  );
  // Sigfa's own report codes, so the figures can be checked against it.
  assert.equal(GSTR1_SECTIONS[0].code, "GSTR_1_04");
  assert.equal(GSTR1_SECTIONS[9].code, "GSTR_Documents");
  // And its captions verbatim, threshold and all.
  assert.equal(
    GSTR1_SECTIONS[1].title,
    "5. Inter-State Sale To Un-Reg. Persons Inv.Value Above Rs 2.5 Lakh (B2CL)"
  );
  assert.match(GSTR1_SECTIONS[3].title, /Net Of Debit And Credit Notes/);
});

test("GSTR-3 carries Sigfa's five, and 3B the portal's rows", () => {
  assert.deepEqual(GSTR3_SECTIONS.map((s) => s.code),
    ["GSTR_3_03", "GSTR_3_04", "GSTR_3_05", "GSTR_3_06", "GSTR_3_08"]);
  // 3B's tables are the portal's, because Sigfa's menu names the return and
  // not its rows -- and 3B is filed against exactly these.
  assert.deepEqual(GSTR3B_SECTIONS.map((s) => s.no),
    ["3.1(a)", "3.1(b)", "3.1(c)", "3.1(d)", "3.1(e)", "3.2", "4", "5"]);
});

test("the four tables that cannot be built say which field they need", () => {
  const blocked = GSTR1_SECTIONS.filter((s) => !s.filled);
  assert.deepEqual(blocked.map((s) => s.tag), ["EXP", "EXEMP", "AT"]);
  for (const section of blocked) {
    assert.ok(section.needs, `${section.tag} does not say what it needs`);
  }
  // And GSTR-3's reverse-charge table is the fourth.
  const rcm = GSTR3_SECTIONS.find((s) => s.code === "GSTR_3_05");
  assert.equal(rcm.filled, false);
  assert.match(rcm.needs, /reverse-charge/);
  // A 0% line must NOT be filed as exempt: nil-rated, exempted and non-GST
  // are three different tables, and a zero rate does not say which.
  const exempt = GSTR1_SECTIONS.find((s) => s.tag === "EXEMP");
  assert.match(exempt.needs, /any of the three/);
});

console.log("\n--- one table per document, and only one ---");

test("every sales document lands in exactly one table", () => {
  assert.equal(tableFor(invoice()), "B2B");
  assert.equal(tableFor(BIG_B2CL), "B2CL");
  assert.equal(tableFor(SMALL_B2CS), "B2CS");
  assert.equal(tableFor(CDNR_NOTE), "CDNR");
  assert.equal(tableFor(CDNUR_NOTE), "CDNUR");
  // Nothing falls through: whatever the invoice, a table is named.
  for (const inv of [{}, { customer: {} }, { return: true }, { taxType: "central" }]) {
    assert.ok(tableFor(inv), JSON.stringify(inv));
  }
});

test("registration decides B2B, and a GSTIN is what registration means", () => {
  assert.equal(isRegistered(invoice()), true);
  assert.equal(isRegistered(SMALL_B2CS), false);
  assert.equal(isRegistered(invoice({ customer: { name: "X", gstin: "" } })), false);
  assert.equal(isRegistered(invoice({ customer: { name: "X", gstin: "  " } })), false);
});

test("the inter-State test reads the stored taxType, not the states", () => {
  // It is decided when the bill is raised and stored. A return that worked it
  // out again could disagree with the invoice the client already sent.
  assert.equal(isInterState(BIG_B2CL), true);
  assert.equal(isInterState(invoice()), false);
  // Even where the state codes would say otherwise.
  assert.equal(isInterState(invoice({ taxType: "local", stateCode: "27" })), false);
  const src = code(read("../lib/gstReturns.mjs"));
  assert.doesNotMatch(src, /placeOfSupply\(/, "the return must not re-derive the supply type");
});

test("table 5 is above the limit, not at it", () => {
  assert.equal(B2CL_THRESHOLD, 250000, "Sigfa's own caption says 2.5 lakh");
  const at = { ...BIG_B2CL, finalAmount: 250000 };
  const over = { ...BIG_B2CL, finalAmount: 250000.01 };
  assert.equal(tableFor(at), "B2CS", "exactly at the limit is not above it");
  assert.equal(tableFor(over), "B2CL");
  // And an intra-State bill of any size is never B2CL.
  assert.equal(tableFor({ ...BIG_B2CL, taxType: "local" }), "B2CS");
});

test("a credit note is filed as one whatever its value", () => {
  assert.equal(isCreditNote(CDNR_NOTE), true);
  assert.equal(isCreditNote(invoice()), false);
  // A huge inter-State credit note to a registered buyer is still CDNR.
  assert.equal(tableFor({ ...CDNR_NOTE, finalAmount: 900000, taxType: "central" }), "CDNR");
  assert.equal(
    tableFor({ ...CDNUR_NOTE, finalAmount: 900000, taxType: "central" }),
    "CDNUR"
  );
});

console.log("\n--- the tax has to add back ---");

test("an inter-State supply is all IGST, an intra-State one is halved", () => {
  assert.deepEqual(taxSplit(180, true), { iamt: 180, camt: 0, samt: 0, csamt: 0 });
  assert.deepEqual(taxSplit(180, false), { iamt: 0, camt: 90, samt: 90, csamt: 0 });
  // Cess is nothing because there is no cess field -- a truthful zero.
  assert.equal(taxSplit(180, false).csamt, 0);
});

test("the odd paisa is carried once, by the app's own splitter", () => {
  // 18% of 1234.57 is 222.2226, stored as 222.22 -- an even number of paise.
  // 45762.71 is not: halved it is 22881.355.
  const split = taxSplit(45762.71, false);
  assert.equal(
    round(split.camt + split.samt),
    45762.71,
    "CGST + SGST must come to the tax charged, to the paisa"
  );
  // And it is lib/gst.mjs doing it, not a second copy of the rule.
  assert.deepEqual(
    { camt: split.camt, samt: split.samt },
    { camt: splitGst(45762.71).cgst, samt: splitGst(45762.71).sgst }
  );
  const src = code(read("../lib/gstReturns.mjs"));
  assert.ok(src.includes("splitGst"), "it must reuse the app's splitter");
  assert.doesNotMatch(src, /\/ 2\)\.toFixed/, "that is the bug splitGst exists to avoid");
});

function round(n) {
  return Math.round(n * 100) / 100;
}

test("a bill is filed one rate at a time", () => {
  const twoRates = invoice({
    items: [
      line({ gstRate: 18, taxableAmount: 1000, gstAmount: 180, total: 1180 }),
      line({ name: "Book", gstRate: 5, taxableAmount: 400, gstAmount: 20, total: 420 }),
    ],
  });
  const groups = rateGroups(twoRates);
  assert.equal(groups.length, 2);
  // Lowest rate first, and numbered from one as the portal wants.
  assert.deepEqual(groups.map((g) => g.itm_det.rt), [5, 18]);
  assert.deepEqual(groups.map((g) => g.num), [1, 2]);
  assert.equal(groups[0].itm_det.txval, 400);
  assert.equal(groups[1].itm_det.txval, 1000);
});

test("two lines at one rate are one entry, split once", () => {
  // Split per line, the odd paisa would be carried per line and CGST + SGST
  // would drift from the tax charged.
  const sameRate = invoice({
    items: [
      line({ taxableAmount: 100.05, gstAmount: 18.01, total: 118.06 }),
      line({ taxableAmount: 200.05, gstAmount: 36.01, total: 236.06 }),
    ],
  });
  const groups = rateGroups(sameRate);
  assert.equal(groups.length, 1, "one rate, one entry");
  const d = groups[0].itm_det;
  assert.equal(d.txval, 300.1);
  assert.equal(round(d.camt + d.samt), 54.02, "the two lines' tax, exactly");
});

test("the tax is the tax that was stored, not the tax the rate implies", () => {
  // `recalcItem` in lib/billingMath.mjs does not round, and a bill can be
  // altered after it was raised -- so the stored tax and the arithmetic on
  // the rate can differ by paise. The bill the client sent is the truth, and
  // a return that recomputed it would disagree with the bill.
  const drifted = invoice({
    items: [line({ taxableAmount: 1000, gstRate: 18, gstAmount: 179.99, total: 1179.99 })],
  });
  const d = rateGroups(drifted)[0].itm_det;
  assert.equal(d.rt, 18);
  assert.equal(d.txval, 1000);
  assert.equal(
    round(d.camt + d.samt),
    179.99,
    "the stored 179.99, not the 180.00 the rate would give"
  );
});

test("a rate group's totals foot to the group", () => {
  const groups = rateGroups(invoice());
  const t = groupTotals(groups);
  assert.equal(t.txval, 1000);
  assert.equal(round(t.camt + t.samt), 180);
  assert.equal(t.iamt, 0);
  assert.deepEqual(groupTotals([]), { txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 });
});

console.log("\n--- the tables themselves ---");

test("table 4 groups by buyer GSTIN, not by invoice", () => {
  const docs = documentsIn({ invoices: [invoice(), invoice({ invoiceNo: 9 }), SMALL_B2CS], ...PERIOD });
  const blocks = b2bBlocks(docs);
  assert.equal(blocks.length, 1, "one buyer, two bills");
  assert.equal(blocks[0].ctin, "07AAACA1111A1Z5");
  assert.deepEqual(blocks[0].inv.map((i) => i.inum), ["1", "9"]);
  // The portal's own field spellings and values.
  assert.equal(blocks[0].inv[0].rchrg, "N");
  assert.equal(blocks[0].inv[0].inv_typ, "R");
  assert.equal(blocks[0].inv[0].pos, "07");
  assert.equal(blocks[0].inv[0].val, 1180);
});

test("a GSTIN is filed upper case, however it was typed", () => {
  const lower = invoice({ customer: { name: "Acme", gstin: "07aaaca1111a1z5" } });
  assert.equal(b2bBlocks([lower])[0].ctin, "07AAACA1111A1Z5");
});

test("the place of supply is two digits, however it was stored", () => {
  // Delhi is "07", not 7. Codes were stored as numbers at one point, which
  // dropped the leading zero -- and a one-digit place of supply is rejected.
  assert.equal(b2bBlocks([invoice({ stateCode: 7 })])[0].inv[0].pos, "07");
  assert.equal(b2bBlocks([invoice({ stateCode: "7" })])[0].inv[0].pos, "07");
  assert.equal(b2bBlocks([invoice({ stateCode: "" })])[0].inv[0].pos, "");
});

test("table 5 groups by place of supply", () => {
  const other = { ...BIG_B2CL, invoiceNo: 6, stateCode: "09" };
  const blocks = b2clBlocks([BIG_B2CL, other]);
  assert.deepEqual(blocks.map((b) => b.pos), ["09", "27"]);
  assert.equal(blocks[1].inv[0].val, 300000);
});

test("table 7 is one row per place, supply type and rate", () => {
  const docs = documentsIn({ invoices: [SMALL_B2CS, { ...SMALL_B2CS, invoiceNo: 7 }], ...PERIOD });
  const rows = b2csRows(docs);
  assert.equal(rows.length, 1, "two bills, one row");
  assert.equal(rows[0].sply_ty, "INTRA");
  assert.equal(rows[0].typ, "OE");
  assert.equal(rows[0].txval, 1000, "500 twice");
  assert.equal(round(rows[0].camt + rows[0].samt), 180);
});

test("table 7 separates the rates, the places and the supply types", () => {
  const rows = b2csRows(
    documentsIn({ invoices: [SMALL_B2CS, SMALL_OTHER_RATE, SMALL_INTERSTATE], ...PERIOD })
  );
  // Three rows: two intra-State rates at 07, and one inter-State row at 27.
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => [r.sply_ty, r.pos, r.rt]), [
    ["INTER", "27", 18],
    ["INTRA", "07", 5],
    ["INTRA", "07", 18],
  ]);
  // The inter-State row is IGST; the intra-State ones are halved.
  const inter = rows[0];
  assert.equal(inter.iamt, 36);
  assert.equal(inter.camt, 0);
  assert.equal(rows[2].iamt, 0);
  assert.equal(round(rows[2].camt + rows[2].samt), 90);
  // And the taxable values stay with their own rates.
  assert.equal(rows[1].txval, 300, "the 5% row");
  assert.equal(rows[2].txval, 500, "the 18% row");
});

test("table 7 separates two places of the same supply type", () => {
  // The place is part of the key in its own right. Two inter-State rows at
  // one rate differ only by where the goods went, and the portal files the
  // tax state by state -- collapsed into one row it would be filed against
  // whichever state happened to come first.
  const karnataka = { ...SMALL_INTERSTATE, invoiceNo: 9, stateCode: "29" };
  const rows = b2csRows(documentsIn({ invoices: [SMALL_INTERSTATE, karnataka], ...PERIOD }));
  assert.equal(rows.length, 2, "two states, two rows");
  assert.deepEqual(rows.map((r) => r.pos), ["27", "29"]);
  assert.deepEqual(rows.map((r) => r.txval), [200, 200]);
  assert.deepEqual(rows.map((r) => r.iamt), [36, 36]);
});

test("table 7 is net of credit notes, which is what its heading says", () => {
  const rows = b2csRows(documentsIn({ invoices: [SMALL_B2CS, CDNUR_NOTE], ...PERIOD }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].txval, 400, "500 less the 100 credited");
  assert.equal(round(rows[0].camt + rows[0].samt), 72, "90 less 18");
  // The same note is itemised in table 10. That is the portal asking for the
  // same document two ways, not one document counted twice.
  assert.equal(cdnurRows(documentsIn({ invoices: [CDNUR_NOTE], ...PERIOD })).length, 1);
});

test("a B2CL-sized credit note nets nothing off table 7", () => {
  // It never belonged to table 7, so subtracting it there would make the
  // table negative against sales it does not cover.
  const big = { ...CDNUR_NOTE, invoiceNo: 8, taxType: "central", stateCode: "27", finalAmount: 400000 };
  const rows = b2csRows(documentsIn({ invoices: [SMALL_B2CS, big], ...PERIOD }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].txval, 500, "untouched");
  // And it is still listed in table 10, typed as B2CL.
  const ten = cdnurRows(documentsIn({ invoices: [big], ...PERIOD }));
  assert.equal(ten[0].typ, "B2CL");
  assert.equal(cdnurRows(documentsIn({ invoices: [CDNUR_NOTE], ...PERIOD }))[0].typ, "B2CS");
});

test("tables 9 and 10 file credit notes, not invoices", () => {
  const docs = documentsIn({ invoices: ALL, ...PERIOD });
  const nine = cdnrBlocks(docs);
  assert.equal(nine.length, 1);
  assert.equal(nine[0].nt.length, 1);
  assert.equal(nine[0].nt[0].ntty, "C", "a credit note, not a debit note");
  assert.equal(nine[0].nt[0].p_gst, "N", "raised under GST, not before it");
  assert.equal(nine[0].nt[0].nt_num, "4");
  const ten = cdnurRows(docs);
  assert.equal(ten.length, 1);
  assert.equal(ten[0].nt_num, "5");
});

test("table 12 is per HSN AND per rate, off the lines", () => {
  // This app's own hsnTotals keeps only the first line's rate for a group, a
  // defect recorded in lib/billingMath.mjs. Reading it would file the wrong
  // rate; the lines are read instead.
  const mixed = invoice({
    items: [
      line({ gstRate: 5, taxableAmount: 100, gstAmount: 5, total: 105 }),
      line({ gstRate: 18, taxableAmount: 200, gstAmount: 36, total: 236 }),
    ],
    hsnTotals: [{ hsn: "7308", gstRate: 5, amount: 41, total: 341 }],
  });
  const rows = hsnRows([mixed]);
  assert.equal(rows.length, 2, "one HSN, two rates, two rows");
  assert.deepEqual(rows.map((r) => r.rt), [5, 18]);
  assert.deepEqual(rows.map((r) => r.num), [1, 2]);
  const src = code(read("../lib/gstReturns.mjs"));
  assert.doesNotMatch(src, /invoice\.hsnTotals|hsnTotals\b\s*\|\|/, "it must not read hsnTotals");
});

test("table 12 runs by HSN and carries the GST unit code", () => {
  const rows = hsnRows(
    documentsIn({ invoices: [invoice(), SMALL_OTHER_RATE], ...PERIOD })
  );
  // "4901" before "7308", whichever order the bills were raised in.
  assert.deepEqual(rows.map((r) => r.hsn_sc), ["4901", "7308"]);
  assert.deepEqual(rows.map((r) => r.num), [1, 2]);
  // UQC is the GST code and `unit` is whatever was typed into the master.
  // The code is preferred: it is the one the portal accepts.
  const both = hsnRows([invoice({ items: [line({ uqc: "KGS", unit: "Kilogram" })] })]);
  assert.equal(both[0].uqc, "KGS");
  const typedOnly = hsnRows([invoice({ items: [line({ uqc: "", unit: "Kilogram" })] })]);
  assert.equal(typedOnly[0].uqc, "Kilogram", "better than nothing when no code was stamped");
});

test("table 12 subtracts a credit note's quantity and value", () => {
  const rows = hsnRows(documentsIn({ invoices: [invoice(), CDNR_NOTE], ...PERIOD }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].qty, 8, "10 out, 2 back");
  assert.equal(rows[0].txval, 800);
  assert.equal(rows[0].val, 944);
  assert.equal(rows[0].uqc, "KGS", "the GST code, not the typed unit");
});

test("table 13 reports invoices and credit notes as separate series", () => {
  const rows = docIssueRows(documentsIn({ invoices: ALL, ...PERIOD }));
  assert.deepEqual(rows.map((r) => r.doc_num), [1, 5], "nature 1 and nature 5");
  assert.deepEqual(rows[0].docs[0], {
    num: 1, from: "1", to: "3", totnum: 3, cancel: 0, net_issue: 3,
  });
  assert.deepEqual(rows[1].docs[0], {
    num: 1, from: "4", to: "5", totnum: 2, cancel: 0, net_issue: 2,
  });
  // A series with nothing in it is left out rather than reported as a range
  // from nowhere to nowhere.
  assert.deepEqual(docIssueRows([invoice()]).map((r) => r.doc_num), [1]);
  assert.deepEqual(docIssueRows([]), []);

  // The TOTAL is how many were issued, not how wide the range is. A firm
  // that skipped a number has a narrower total than its range, and reporting
  // the range would claim documents that were never raised.
  const gapped = docIssueRows([invoice({ invoiceNo: 1 }), invoice({ invoiceNo: 2 }), invoice({ invoiceNo: 9 })]);
  assert.equal(gapped[0].docs[0].from, "1");
  assert.equal(gapped[0].docs[0].to, "9");
  assert.equal(gapped[0].docs[0].totnum, 3, "three issued, not nine");
  assert.equal(gapped[0].docs[0].net_issue, 3);
});

console.log("\n--- the period ---");

test("a return covers IST calendar days, not the server's", () => {
  // 19:00 UTC on 30 June is already 1 July in IST. Filed in the wrong period
  // this is a late return, not a rounding error.
  const late = invoice({ invoiceNo: 7, date: "2026-06-30T19:00:00Z" });
  assert.deepEqual(
    documentsIn({ invoices: [late], from: "2026-07-01", to: "2026-07-31" }).map((i) => i.invoiceNo),
    [7]
  );
  assert.deepEqual(documentsIn({ invoices: [late], ...PERIOD }), []);
});

test("the period is inclusive at both ends, and nothing outside it", () => {
  const invoices = [
    invoice({ invoiceNo: 1, date: "2026-05-31" }),
    invoice({ invoiceNo: 2, date: "2026-06-01" }),
    invoice({ invoiceNo: 3, date: "2026-06-30" }),
    invoice({ invoiceNo: 4, date: "2026-07-01" }),
  ];
  assert.deepEqual(documentsIn({ invoices, ...PERIOD }).map((i) => i.invoiceNo), [2, 3]);
});

test("only the asked-for side, and nothing dateless", () => {
  const invoices = [invoice(), invoice({ invoiceNo: 2, type: "Purchase" }), invoice({ invoiceNo: 3, date: null }), null];
  assert.deepEqual(documentsIn({ invoices, side: "Sale", ...PERIOD }).map((i) => i.invoiceNo), [1]);
  assert.deepEqual(documentsIn({ invoices, side: "Purchase", ...PERIOD }).map((i) => i.invoiceNo), [2]);
});

test("the tax period and the dates are in the portal's formats", () => {
  assert.equal(taxPeriod("2026-06-01"), "062026", "mmyyyy, month padded");
  assert.equal(taxPeriod("2026-11-01"), "112026");
  assert.equal(taxPeriod(""), "", "no date, no period");
  assert.equal(portalDate("2026-06-05"), "05-06-2026", "dd-mm-yyyy, both padded");
  assert.equal(portalDate("2026-12-31"), "31-12-2026");
  assert.equal(portalDate(null), "");
});

console.log("\n--- the sheets, and that they agree with each other ---");

test("the GSTR-1 sheet shows every table, filled or not", () => {
  const sheet = gstr1Sheet({ invoices: ALL, ...PERIOD });
  assert.equal(sheet.period, "062026");
  assert.equal(sheet.documents, 5);
  assert.equal(sheet.sections.length, 10, "all ten, none hidden");
  const byTag = Object.fromEntries(sheet.sections.map((s) => [s.tag, s]));
  assert.equal(byTag.B2B.rows.length, 1);
  assert.equal(byTag.B2CL.rows.length, 1);
  assert.equal(byTag.B2CS.rows.length, 1);
  assert.equal(byTag.CDNR.rows.length, 1);
  assert.equal(byTag.CDNUR.rows.length, 1);
  assert.equal(byTag.HSN.rows.length, 1);
  // The three that cannot be built carry no rows AND a reason.
  for (const tag of ["EXP", "EXEMP", "AT"]) {
    assert.equal(byTag[tag].filled, false, tag);
    assert.deepEqual(byTag[tag].rows, [], tag);
    assert.ok(byTag[tag].needs, tag);
  }
});

test("the outward totals net the credit notes off", () => {
  const t = outwardTotals(documentsIn({ invoices: ALL, ...PERIOD }));
  // 1000 + 254237.29 + 500 - 200 - 100
  assert.equal(t.taxable, 255437.29);
  assert.equal(t.iamt, 45762.71, "only the inter-State bill");
  assert.equal(round(t.camt + t.samt), round(180 + 90 - 36 - 18));
  assert.equal(t.tax, round(45762.71 + 180 + 90 - 36 - 18));
  // The invoice VALUE is what the parties were charged, which is not the
  // taxable value and not the taxable value plus tax either -- a bill can
  // carry freight.
  assert.equal(t.value, round(1180 + 300000 + 590 - 236 - 118));
  assert.notEqual(t.value, t.taxable);
  assert.deepEqual(outwardTotals([]), {
    taxable: 0, value: 0, iamt: 0, camt: 0, samt: 0, csamt: 0, tax: 0,
  });
});

test("GSTR-3's liability is the tax GSTR-1 foots on", () => {
  // The whole reason these four live in one module: if the outward tax on
  // GSTR-1 is not the liability on GSTR-3, one of the two is wrong.
  const one = gstr1Sheet({ invoices: ALL, ...PERIOD });
  const three = gstr3Sheet({ invoices: ALL, ...PERIOD });
  const liability = three.sections
    .find((s) => s.code === "GSTR_3_08")
    .rows.find((r) => r.label === "Tax on outward supplies").value;
  assert.equal(liability, one.totals.tax);
  // And table 4's taxable value is the same taxable value.
  const outward = three.sections.find((s) => s.code === "GSTR_3_04");
  assert.equal(outward.rows.find((r) => r.label === "Taxable value").value, one.totals.taxable);
});

test("GSTR-3 takes its input credit off the purchase side", () => {
  const purchase = invoice({
    invoiceNo: 20,
    type: "Purchase",
    gst: 360,
    totalAmount: 2360,
    finalAmount: 2360,
    items: [line({ taxableAmount: 2000, gstAmount: 360, total: 2360 })],
  });
  const three = gstr3Sheet({ invoices: [invoice(), purchase], ...PERIOD });
  const itc = three.sections.find((s) => s.code === "GSTR_3_06");
  assert.equal(itc.rows.find((r) => r.label === "Taxable value of inward supplies").value, 2000);
  const due = three.sections.find((s) => s.code === "GSTR_3_08");
  assert.equal(due.rows.find((r) => r.label === "Tax on outward supplies").value, 180);
  assert.equal(due.rows.find((r) => r.label === "Less: input tax credit").value, 360);
  assert.equal(
    due.rows.find((r) => r.label === "Net tax payable").value,
    -180,
    "more credit than liability reads as a negative, not as nothing"
  );
});

test("a purchase never counts as an outward supply", () => {
  const purchase = invoice({ invoiceNo: 21, type: "Purchase" });
  const one = gstr1Sheet({ invoices: [purchase], ...PERIOD });
  assert.equal(one.documents, 0);
  assert.equal(one.totals.taxable, 0);
});

test("GSTR-3B's 3.1(a) is the outward tax, and 3.2 a subset of it", () => {
  const sheet = gstr3bSheet({ invoices: ALL, ...PERIOD });
  const by = Object.fromEntries(sheet.sections.map((s) => [s.no, s]));
  const one = gstr1Sheet({ invoices: ALL, ...PERIOD });
  assert.equal(by["3.1(a)"].rows.find((r) => r.label === "Taxable value").value, one.totals.taxable);
  assert.equal(by["3.1(a)"].rows.find((r) => r.label === "Integrated tax").value, one.totals.iamt);
  // 3.2 is part of 3.1(a), never an addition to it.
  const subset = by["3.2"].rows.find((r) => r.label === "Taxable value").value;
  assert.ok(subset <= one.totals.taxable, "3.2 cannot exceed 3.1(a)");
  assert.equal(subset, 254237.29, "the one inter-State unregistered bill");

  // A REGISTERED inter-State bill belongs in 3.1(a) and not in 3.2, which is
  // about unregistered persons. Checked with one in the period, or the
  // registration test could be dropped and nothing would notice.
  const withRegistered = gstr3bSheet({ invoices: [...ALL, REGISTERED_INTERSTATE], ...PERIOD });
  const by2 = Object.fromEntries(withRegistered.sections.map((s) => [s.no, s]));
  assert.equal(
    by2["3.2"].rows.find((r) => r.label === "Taxable value").value,
    254237.29,
    "unchanged by a registered inter-State bill"
  );
  assert.equal(
    by2["3.1(a)"].rows.find((r) => r.label === "Taxable value").value,
    round(255437.29 + 1000),
    "but 3.1(a) does include it"
  );
  // And the four rows it cannot fill say so.
  for (const no of ["3.1(b)", "3.1(c)", "3.1(d)", "3.1(e)", "5"]) {
    assert.equal(by[no].filled, false, no);
    assert.ok(by[no].needs, no);
  }
});

test("GSTR-3B's table 4 is the input credit, off the purchase side", () => {
  const purchase = invoice({
    invoiceNo: 20,
    type: "Purchase",
    taxType: "central",
    stateCode: "27",
    gst: 360,
    totalAmount: 2360,
    finalAmount: 2360,
    items: [line({ taxableAmount: 2000, gstAmount: 360, total: 2360 })],
  });
  const sheet = gstr3bSheet({ invoices: [invoice(), purchase], ...PERIOD });
  const four = sheet.sections.find((s) => s.no === "4");
  assert.equal(four.rows.find((r) => r.label === "ITC available — Integrated tax").value, 360);
  assert.equal(four.rows.find((r) => r.label === "ITC available — Central tax").value, 0);
  assert.equal(four.rows.find((r) => r.label === "Net ITC available").value, 360);
  // And the sale's own tax has not leaked into the credit.
  const outward = sheet.sections.find((s) => s.no === "3.1(a)");
  assert.equal(outward.rows.find((r) => r.label === "Central tax").value, 90);
});

test("an empty period builds every return without breaking", () => {
  for (const sheet of [
    gstr1Sheet({ invoices: [], ...PERIOD }),
    gstr3Sheet({ invoices: [], ...PERIOD }),
    gstr3bSheet({ invoices: [], ...PERIOD }),
  ]) {
    assert.equal(sheet.documents, 0);
    assert.ok(sheet.sections.length > 0);
  }
  assert.deepEqual(gstr1Sheet({}).sections.length, 10);
});

console.log("\n--- the e-return ---");

test("the JSON carries the portal's own keys", () => {
  // The firm's own GSTIN typed in lower case, because it is stored as typed.
  const json = gstr1Json({ company: { gstin: "07aaaca1111a1z5" }, invoices: ALL, ...PERIOD });
  assert.equal(json.gstin, "07AAACA1111A1Z5", "the portal rejects lower case");
  assert.equal(json.fp, "062026");
  assert.deepEqual(
    Object.keys(json),
    ["gstin", "fp", "b2b", "b2cl", "b2cs", "cdnr", "cdnur", "hsn", "doc_issue"]
  );
  // The nested shapes the utility validates against.
  assert.ok(Array.isArray(json.hsn.data), "hsn is an object around its data");
  assert.ok(Array.isArray(json.doc_issue.doc_det));
  assert.ok(Array.isArray(json.b2b[0].inv[0].itms));
  assert.ok("itm_det" in json.b2b[0].inv[0].itms[0]);
});

test("an empty table is left out, not sent empty", () => {
  // The utility reports an empty section as an error rather than as nothing
  // to file, so the key must be absent.
  const json = gstr1Json({ company: { gstin: "07AAACA1111A1Z5" }, invoices: [invoice()], ...PERIOD });
  assert.deepEqual(Object.keys(json), ["gstin", "fp", "b2b", "hsn", "doc_issue"]);
  assert.equal("b2cl" in json, false);
  assert.equal("cdnr" in json, false);
  // And a period with nothing in it is a header and no tables.
  assert.deepEqual(
    Object.keys(gstr1Json({ company: { gstin: "07AAACA1111A1Z5" }, invoices: [], ...PERIOD })),
    ["gstin", "fp"]
  );
});

test("the party name is kept off the file but kept on the sheet", () => {
  // The portal has no field for it and an unknown key fails validation; the
  // screen needs it to be readable.
  const json = gstr1Json({ company: { gstin: "07AAACA1111A1Z5" }, invoices: ALL, ...PERIOD });
  assert.equal("party" in json.b2b[0], false);
  assert.equal("party" in json.cdnr[0], false);
  assert.equal("doc_typ" in json.doc_issue.doc_det[0], false);
  assert.equal(b2bBlocks(documentsIn({ invoices: ALL, ...PERIOD }))[0].party, "Acme Traders");
});

test("the firm's GSTIN is required, and said so before uploading", () => {
  assert.match(eReturnProblem({ company: {}, from: "2026-06-01" }), /GSTIN/);
  assert.match(eReturnProblem({ company: { gstin: "07AAACA1111A1Z5" } }), /period/);
  assert.equal(eReturnProblem({ company: { gstin: "07AAACA1111A1Z5" }, from: "2026-06-01" }), null);
});

test("the file names itself after the firm and the period", () => {
  assert.equal(
    jsonFilename({ gstin: "07aaaca1111a1z5" }, "2026-06-01"),
    "GSTR1-07AAACA1111A1Z5-062026.json"
  );
  assert.match(jsonFilename({}, ""), /NOGSTIN-period/);
});

test("what the file leaves out is listed with it", () => {
  const gaps = eReturnGaps();
  assert.deepEqual(gaps.map((g) => g.tag), ["EXP", "EXEMP", "AT"]);
  for (const gap of gaps) assert.ok(gap.needs && gap.title);
});

console.log("\n--- the wiring ---");

test("one route serves all four, and refuses anything else", () => {
  const src = read("../app/api/gst-return/route.js");
  assert.ok(src.includes("isReturnKey"), "the view is not checked");
  assert.ok(/export const GET = tenantRoute\(/.test(src));
  assert.doesNotMatch(src, /^export\s+async\s+function\s+GET\b/m, "it must be wrapped");
  // A return without a period is refused rather than built over all time.
  assert.ok(/!from \|\| !to/.test(src));
});

test("the route computes nothing itself", () => {
  const src = code(read("../app/api/gst-return/route.js"));
  for (const fn of ["gstr1Sheet", "gstr3Sheet", "gstr3bSheet", "gstr1Json", "eReturnProblem"]) {
    assert.ok(src.includes(fn), `${fn} is not used`);
  }
  assert.doesNotMatch(src, /reduce\(/, "the route is doing its own totalling");
});

test("the route widens the date filter before the IST comparison", () => {
  const src = read("../app/api/gst-return/route.js");
  assert.ok(/setUTCDate\(end\.getUTCDate\(\) \+ 2\)/.test(src));
});

test("the route fetches the lines, because every table needs the rate", () => {
  const src = code(read("../app/api/gst-return/route.js"));
  assert.ok(/items: 1/.test(src), "without the lines there are no rate groups");
  // And only the GSTIN off the company, not the whole profile.
  assert.ok(/select\("gstin name"\)/.test(src));
});

test("GSTR-1 asks the database for sales only", () => {
  const src = code(read("../app/api/gst-return/route.js"));
  assert.ok(/outwardOnly \? \{ type: "Sale" \}/.test(src));
  assert.ok(/\$in: \["Sale", "Purchase"\]/.test(src), "3 and 3B need both sides");
});

test("the returns are owner and accountant, not biller", () => {
  // A GST return is the firm's filing position, not one bill.
  for (const path of ["/gst-return", "/api/gst-return"]) {
    assert.equal(permissionForPath(path), "report:read", path);
    assert.equal(canAccessPath("owner", path), true, path);
    assert.equal(canAccessPath("accountant", path), true, path);
    assert.equal(canAccessPath("biller", path), false, path);
  }
});

test("the page computes nothing and reaches the dashboard", () => {
  const page = read("../app/gst-return/page.js");
  assert.ok(/from '@\/lib\/gstReturns\.mjs'/.test(page));
  assert.doesNotMatch(code(page), /\.reduce\(/, "the page is doing its own totalling");
  assert.ok(/GST_RETURNS/.test(page), "the four come from the module");
  assert.ok(/'\/gst-return'/.test(read("../app/page.js")), "no tile on the dashboard");
});

test("the page says why a table is empty, and prints like the registers", () => {
  const page = read("../app/gst-return/page.js");
  assert.ok(/It needs \{section\.needs\}/.test(page), "an empty table must say why");
  assert.ok(/doc-sheet/.test(page) && /doc-head/.test(page) && /doc-kind/.test(page));
  assert.ok(/no-print/.test(page), "the controls must not print");
  // And the thing a reader could otherwise get wrong.
  assert.ok(/not a figure counted twice/i.test(page));
});

test("the module stays pure", () => {
  const src = read("../lib/gstReturns.mjs");
  assert.doesNotMatch(src, /from\s+["']react["']/);
  assert.doesNotMatch(src, /from\s+["']mongoose["']/);
  assert.doesNotMatch(src, /from\s+["'][^"']*models\//);
});

console.log(`\n  ${passed} checks passed\n`);
