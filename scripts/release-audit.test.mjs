/**
 * Defects found by the production-readiness audit, each pinned.
 *
 *   1. an invoice billed to the cash account itself: edit and delete kept the
 *      cash leg (lib/invoicePosting.mjs withPartyCashLeg)
 *   2. a party could take a ledger head's name, and a head could be renamed
 *      (lib/invoiceGl.mjs headNameProblem)
 *   3. sign-in picked whichever account with the email MongoDB found first
 *   4. the tenant stamp kept a companyId naming another firm
 *   5. GSTR-1: the B2CL limit, credit notes filed twice, the e-return period,
 *      0% supplies in GSTR-3B 3.1(a)
 *   6. CSV: negative numbers exported as text; balances exported signed
 *   7. Electron gave the remote site Node.js
 *   8. parallel operations inside transactions
 *
 * Bare node: `node scripts/release-audit.test.mjs`.
 */

import assert from "node:assert/strict";
import fs from "node:fs";

import { round2 } from "../lib/balance.mjs";
import {
  balanceMovesFromRows,
  buildInvoiceLedgerRows,
  invoicePostingDeltas,
  withPartyCashLeg,
} from "../lib/invoicePosting.mjs";
import { GL_ACCOUNTS, glHeadOf, headNameProblem } from "../lib/invoiceGl.mjs";
import { stampDocs, stampedCompanyId } from "../lib/tenantScope.mjs";
import {
  B2CL_THRESHOLD,
  b2clLimit,
  b2csRows,
  cdnurRows,
  eReturnProblem,
  gstr3bSheet,
  tableFor,
} from "../lib/gstReturns.mjs";
import { csvCell, toCsv } from "../lib/csv.mjs";
import { STATEMENT_COLUMNS } from "../lib/statements.mjs";
import { CSV_COLUMNS } from "../lib/accountBooks.mjs";

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

/* ───────────────────── 1. the cash account as the party ────────────────── */

console.log("\n--- an invoice billed to the cash account itself ---");

/** What an invoice's rows do to each account, as the routes apply them. */
const rowsFor = ({ party, cash = "Cash", type = "Sale", isReturn = false, finalAmount, received }) => {
  const deltas = invoicePostingDeltas({ type, isReturn, finalAmount, received });
  const rows = buildInvoiceLedgerRows({
    type,
    customerName: party,
    cashAccountName: deltas.cashDelta !== 0 ? cash : undefined,
    invoiceNo: 1,
    date: new Date("2026-06-01"),
    paymentType: "Cash",
    voucherId: "v1",
    deltas,
    partyBalance: 0,
    cashBalance: 0,
  });
  return { deltas, rows };
};

/** Delete, as app/api/delete-invoice/route.js now reverses: net per account. */
const reversalOnDelete = ({ party, deltas, rows }) => {
  const moves = new Map();
  const add = (name, d) => moves.set(name, round2((moves.get(name) || 0) + d));
  add(party, -deltas.partyDelta);
  for (const [name, posted] of withPartyCashLeg(balanceMovesFromRows(rows), rows, party, deltas.cashDelta)) {
    add(name, -posted);
  }
  return moves;
};

test("deleting a bill raised to Cash takes the cash back out (paid, part-paid, unpaid)", () => {
  for (const received of [1180, 500, 0]) {
    const posted = rowsFor({ party: "Cash", finalAmount: 1180, received });
    const postedNet = balanceMovesFromRows(posted.rows).get("Cash") || 0;
    const reversal = reversalOnDelete({ party: "Cash", ...posted });
    assert.equal(round2(postedNet + (reversal.get("Cash") || 0)), 0, `received ${received}`);
  }
});

test("...for purchases and both kinds of return too", () => {
  for (const [type, isReturn] of [["Purchase", false], ["Sale", true], ["Purchase", true]]) {
    for (const received of [800, 300, 0]) {
      const posted = rowsFor({ party: "Cash", type, isReturn, finalAmount: 800, received });
      const postedNet = balanceMovesFromRows(posted.rows).get("Cash") || 0;
      const reversal = reversalOnDelete({ party: "Cash", ...posted });
      assert.equal(round2(postedNet + (reversal.get("Cash") || 0)), 0, `${type}${isReturn ? " return" : ""} ${received}`);
    }
  }
});

test("an ordinary party is unchanged: reversed by its derived delta only", () => {
  const posted = rowsFor({ party: "Ram", finalAmount: 1000, received: 400 });
  const reversal = reversalOnDelete({ party: "Ram", ...posted });
  assert.equal(reversal.get("Ram"), -600);
  assert.equal(reversal.get("Cash"), -400);
});

test("stale party rows from an older edit do not move an ordinary party", () => {
  // Rows posted at 1000; the invoice later edited to 1200 by the OLD
  // sale-alter, which moved the balance but never rewrote the rows.
  const stale = rowsFor({ party: "Ram", finalAmount: 1000, received: 0 });
  const now = invoicePostingDeltas({ type: "Sale", finalAmount: 1200, received: 0 });
  const reversal = reversalOnDelete({ party: "Ram", deltas: now, rows: stale.rows });
  assert.equal(reversal.get("Ram"), -1200, "the derived delta, not the stale rows");
});

test("a party with no rows (a lost posting) is left to the derived move alone", () => {
  const out = withPartyCashLeg(new Map([["Cash", 50]]), [], "Ram", 0);
  assert.deepEqual([...out], [["Cash", 50]]);
});

test("edit: the old Cash-party bill is fully reversed before the new one posts", () => {
  const before = rowsFor({ party: "Cash", finalAmount: 1000, received: 1000 });
  const after = rowsFor({ party: "Cash", finalAmount: 1500, received: 1500 });
  const moves = new Map();
  const add = (name, d) => moves.set(name, round2((moves.get(name) || 0) + d));
  add("Cash", -before.deltas.partyDelta);
  for (const [n, v] of withPartyCashLeg(balanceMovesFromRows(before.rows), before.rows, "Cash", before.deltas.cashDelta)) add(n, -v);
  add("Cash", after.deltas.partyDelta);
  for (const [n, v] of withPartyCashLeg(balanceMovesFromRows(after.rows), after.rows, "Cash", after.deltas.cashDelta)) add(n, v);
  const fromRows = round2((balanceMovesFromRows(after.rows).get("Cash") || 0) - (balanceMovesFromRows(before.rows).get("Cash") || 0));
  assert.equal(moves.get("Cash"), fromRows, "the balance moves exactly as the rows do");
  assert.equal(moves.get("Cash"), 500);
});

test("both routes use it", () => {
  const del = code(read("../app/api/delete-invoice/route.js"));
  assert.match(del, /withPartyCashLeg\(\s*balanceMovesFromRows\(rows\),\s*rows,\s*partyName,\s*deltas\.cashDelta/);
  assert.match(del, /customerName: 1, account: 1, debit: 1, credit: 1/);
  assert.doesNotMatch(del, /row\.customerName === partyName\) continue/);
  const alter = code(read("../app/api/sale-alter/route.js"));
  assert.match(alter, /withPartyCashLeg\(balanceMovesFromRows\(oldRows\), oldRows, previousName, before\.cashDelta\)/);
  assert.match(alter, /withPartyCashLeg\(balanceMovesFromRows\(rows\), rows, invoiceData\.customer\.name, after\.cashDelta\)/);
  assert.match(alter, /customerName: 1, account: 1, debit: 1, credit: 1/);
  assert.doesNotMatch(alter, /reverse\.delete\(previousName\)|apply\.delete\(/);
});

/* ───────────────────────── 2. ledger head names ────────────────────────── */

console.log("\n--- ledger head names ---");

test("a party may not take a head's name, in any case", () => {
  for (const head of GL_ACCOUNTS) {
    assert.ok(headNameProblem({ name: head.toUpperCase(), group: "Sundry Debtors" }), head);
  }
  assert.equal(glHeadOf("  output igst "), "Output IGST");
  assert.equal(headNameProblem({ name: "Ram Traders", group: "Sundry Debtors" }), null);
  // The head itself, in its own group, is fine (it is how a firm edits it).
  assert.equal(headNameProblem({ name: "Output IGST", group: "Duties And Taxes", previousName: "Output IGST", previousGroup: "Duties And Taxes" }), null);
});

test("a head cannot be renamed; a party wrongly holding a head's name can be", () => {
  assert.match(headNameProblem({ name: "Sales", group: "Sales Account", previousName: "Sales Account", previousGroup: "Sales Account" }), /split/);
  assert.equal(headNameProblem({ name: "Round off", group: "Indirect Expenses", previousName: "Round Off", previousGroup: "Indirect Expenses" }), null, "case only");
  assert.equal(headNameProblem({ name: "Acme", group: "Sundry Debtors", previousName: "Output IGST", previousGroup: "Sundry Debtors" }), null);
  // Party groups are judged by the chart of accounts: legacy spellings and a
  // firm's own customer groups ("Retail") are parties too.
  for (const group of ["customer", "supplier", "Retail", ""]) {
    assert.ok(headNameProblem({ name: "Output IGST", group }), `group "${group}"`);
    assert.equal(headNameProblem({ name: "Acme", group, previousName: "Output IGST", previousGroup: group }), null, `rename out of "${group}"`);
  }
});

test("customer-add and customer-alter check it", () => {
  assert.match(code(read("../app/api/customer-add/route.js")), /headNameProblem\(\{ name, group: customerData\.group \}\)/);
  assert.match(code(read("../app/api/customer-alter/route.js")), /headNameProblem\(\{[\s\S]{0,200}previousGroup: existing\.group/);
});

/* ───────────────────────────── 3. sign-in ──────────────────────────────── */

console.log("\n--- sign-in with an email held in more than one firm ---");

test("every account with the address is checked, and the password picks", () => {
  const src = code(read("../app/api/auth/login/route.js"));
  assert.match(src, /User\.find\(\{ email: address \}\)/);
  assert.doesNotMatch(src, /User\.findOne\(\{ email/);
  assert.match(src, /for \(const candidate of candidates\)/);
  assert.match(src, /usable\.length > 1/, "two working firms, same password: refuse rather than guess");
  // Only active accounts in active firms count, so a deactivated ex-staff
  // account elsewhere does not block the firm the person still works for.
  const usable = src.slice(src.indexOf("const usable = []"), src.indexOf("usable.length > 1"));
  assert.match(usable, /candidate\.active === false\) continue/);
  assert.match(usable, /firm\.active === false/);
  assert.match(src, /MAX_PASSWORD_LENGTH/);
  // A missing account still costs one hash.
  assert.match(src, /verifyPassword\(secretText, DUMMY_HASH\)/);
});

/* ─────────────────────────── 4. tenant stamp ───────────────────────────── */

console.log("\n--- the tenant stamp ---");

test("inside a request a document naming another firm is refused", () => {
  assert.throws(() => stampedCompanyId("firm-B", "firm-A"), /different firm/);
  assert.equal(stampedCompanyId(undefined, "firm-A"), "firm-A");
  assert.equal(stampedCompanyId("firm-A", "firm-A"), "firm-A");
  assert.throws(() => stampDocs([{ companyId: "firm-B" }], "firm-A"), /different firm/);
  const plugin = code(read("../lib/tenantPlugin.mjs"));
  assert.match(plugin, /this\.companyId = stampedCompanyId\(this\.companyId, firm\)/);
  assert.match(plugin, /if \(isUnscoped\(\)\) return;/, "migrations still set it freely");
});

/* ──────────────────────────────── 5. GST ───────────────────────────────── */

console.log("\n--- GST returns ---");

const unreg = (over = {}) => ({
  type: "Sale",
  return: false,
  date: "2026-06-15",
  customer: { name: "Walk-in" },
  taxType: "central",
  stateCode: "27",
  finalAmount: 177000,
  items: [{ hsn: "7308", gstRate: 18, quantity: 1, taxableAmount: 150000, gstAmount: 27000, total: 177000 }],
  ...over,
});

test("B2CL is above Rs 1 lakh from August 2024, Rs 2.5 lakh before", () => {
  assert.equal(B2CL_THRESHOLD, 100000);
  assert.equal(tableFor(unreg()), "B2CL");
  assert.equal(b2clLimit(unreg({ date: "2024-07-31" })), 250000);
  assert.equal(tableFor(unreg({ date: "2024-07-31" })), "B2CS");
});

test("a small unregistered credit note is netted in table 7 only, never table 10 too", () => {
  const sale = unreg({ taxType: "local", finalAmount: 590, items: [{ hsn: "1", gstRate: 18, quantity: 1, taxableAmount: 500, gstAmount: 90, total: 590 }] });
  const note = { ...sale, return: true, finalAmount: 118, items: [{ hsn: "1", gstRate: 18, quantity: 1, taxableAmount: 100, gstAmount: 18, total: 118 }] };
  assert.equal(tableFor(note), "B2CS");
  assert.equal(b2csRows([sale, note])[0].txval, 400);
  assert.equal(cdnurRows([note]).length, 0);
  const big = unreg({ return: true });
  assert.equal(tableFor(big), "CDNUR");
  assert.equal(cdnurRows([big])[0].typ, "B2CL", "the only type table 10 takes from this app");
});

test("the e-return is one whole calendar month", () => {
  const firm = { gstin: "07AAACA1111A1Z5" };
  assert.equal(eReturnProblem({ company: firm, from: "2026-06-01", to: "2026-06-30" }), null);
  assert.match(eReturnProblem({ company: firm, from: "2026-04-01", to: "2026-06-30" }), /month/);
  assert.match(code(read("../app/api/gst-return/route.js")), /eReturnProblem\(\{ company: company \|\| \{\}, from, to \}\)/);
});

test("GSTR-3B 3.1(a) leaves 0% supplies out, and says so", () => {
  const taxed = unreg({ taxType: "local", finalAmount: 118, items: [{ hsn: "1", gstRate: 18, quantity: 1, taxableAmount: 100, gstAmount: 18, total: 118 }] });
  const nil = unreg({ taxType: "local", finalAmount: 5000, items: [{ hsn: "2", gstRate: 0, quantity: 1, taxableAmount: 5000, gstAmount: 0, total: 5000 }] });
  const sheet = gstr3bSheet({ invoices: [taxed, nil], from: "2026-06-01", to: "2026-06-30" });
  const a = sheet.sections.find((s) => s.no === "3.1(a)").rows;
  assert.equal(a.find((r) => r.label === "Taxable value").value, 100);
  assert.ok(a.some((r) => /Left out: 0%/.test(r.label) && r.value === 5000));
});

/* ─────────────────────────────── 6. CSV ────────────────────────────────── */

console.log("\n--- exports ---");

test("a negative NUMBER is a number in the CSV; formulas are still defused", () => {
  assert.equal(csvCell(-120.5), "-120.5");
  assert.equal(csvCell("-120.5"), "-120.5");
  assert.equal(csvCell("=1+1"), "'=1+1");
  assert.equal(csvCell("-1+cmd"), "'-1+cmd");
  assert.equal(csvCell("\t=1"), "'\t=1");
  assert.equal(csvCell(Number.NaN), "");
});

test("a balance is exported as an amount with Dr/Cr, never -1500 Cr", () => {
  const row = { date: "2026-06-01", particulars: "x", debit: 0, credit: 1500, balance: -1500, mode: "Cr" };
  assert.match(toCsv(STATEMENT_COLUMNS, [row]), /,1500,Cr/);
  assert.match(toCsv(CSV_COLUMNS.entries, [row]), /,1500,Cr/);
});

/* ──────────────────────────── 7. Electron ──────────────────────────────── */

console.log("\n--- the desktop shell ---");

test("the remote site gets no Node.js", () => {
  const main = code(read("../main.js"));
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /contextIsolation: true/);
  assert.doesNotMatch(main, /nodeIntegration: true/);
});

/* ─────────────────────── 8. one op at a time in a tx ───────────────────── */

console.log("\n--- transactions ---");

test("no Promise.all over a transaction's session", () => {
  for (const file of [
    "../lib/runningBalances.mjs",
    "../lib/openBillsFor.mjs",
    "../app/api/customer-alter/route.js",
    "../app/api/clear-all-data/route.js",
  ]) {
    assert.doesNotMatch(code(read(file)), /Promise\.all\(/, file);
  }
});

/* ─────────────────── 9. found by the first Next 16 lint ────────────────── */

console.log("\n--- found by the first lint run on Next 16 ---");

test("the company page imports the logo it renders (it threw once a logo was set)", () => {
  const src = code(read("../app/company/page.js"));
  assert.match(src, /<CompanyLogo\b/);
  assert.match(src, /import \{[^}]*\bCompanyLogo\b[^}]*\} from '@\/components\/CompanyBrand'/);
});

test("the company page imports every prefs and logo helper it calls (the build failed on prefsFrom)", () => {
  const src = code(read("../app/company/page.js"));
  const imported = new Set(
    [...src.matchAll(/import\s*\{([^}]*)\}\s*from/g)].flatMap((m) =>
      m[1].split(",").map((n) => n.trim()).filter(Boolean)
    )
  );
  for (const name of [
    "prefsFrom", "prefProblems", "PREF_FIELDS", "PAPER_SIZES",
    "logoProblem", "logoSrc", "logoBytesOf", "LOGO_ACCEPT", "LOGO_FORMAT_WORDS", "MAX_LOGO_BYTES",
  ]) {
    assert.ok(new RegExp(`\\b${name}\\b`).test(src), `${name} is no longer used -- update this list`);
    assert.ok(imported.has(name), `${name} is used but not imported`);
  }
});

test("the desktop app opens the confirmed production domain, over https", () => {
  // The Vercel project connected to this repo (confirmed 12 Oct 2026).
  const main = code(read("../main.js"));
  assert.match(main, /const APP_URL = 'https:\/\/vyapar-einvoice-ph2z\.vercel\.app\/';/);
  assert.doesNotMatch(main, /vyapaar-ten|vyapaar-aspx/);
});

test("no ref is written or read during render in the keyboard and notice hooks", () => {
  for (const file of ["../components/billing/useBillingKeys.js", "../components/masters/MasterShortcuts.jsx"]) {
    const src = code(read(file));
    assert.match(src, /useLayoutEffect\(\(\) => \{\s*latest\.current = /, file);
  }
  const notice = code(read("../components/ui/notice.jsx"));
  assert.doesNotMatch(notice, /notify\.current/);
  assert.match(notice, /const notify = useMemo\(/);
});

test("set-state-in-effect is a warning, never switched off", () => {
  const cfg = code(read("../eslint.config.mjs"));
  assert.match(cfg, /"react-hooks\/set-state-in-effect": "warn"/);
  assert.doesNotMatch(cfg, /"react-hooks\/[a-z-]+": "off"/);
});

console.log(process.exitCode ? "\nSome checks failed.\n" : `\n${passed} checks passed.\n`);
