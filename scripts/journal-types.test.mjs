/**
 * The Journal's Type field, and Expense With GST.
 *
 *   node scripts/journal-types.test.mjs
 *
 * The thing being held up here is the TAX. An expense's legs have to land on
 * the right Input heads, split only when the place of supply says so, and
 * never split by a default — a wrong split still foots, so the trial balance
 * gives no sign of it and only the return does, months later.
 */

import assert from "node:assert/strict";
import fs from "node:fs";

import {
  EXPENSE_DEFAULTS,
  EXPENSE_FIELDS,
  JOURNAL_TYPES,
  JOURNAL_TYPE_CODES,
  expenseLegs,
  expenseProblems,
  expenseTax,
  expenseTaxType,
  expenseTotal,
  isExpenseJournal,
  journalTypeOf,
  legsBalance,
  normalizeExpense,
} from "../lib/journalTypes.mjs";
import { TAX_ACCOUNTS } from "../lib/invoiceGl.mjs";

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
const code = (p) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const accounts = {
  inputCgst: TAX_ACCOUNTS.inputCgst,
  inputSgst: TAX_ACCOUNTS.inputSgst,
  inputIgst: TAX_ACCOUNTS.inputIgst,
};

/** A whole, valid expense: 1,000 of telephone at 18%, from a local supplier. */
const expense = (over = {}) => ({
  party: "Airtel",
  expenseAccount: "Telephone Expenses",
  taxable: 1000,
  gstRate: 18,
  supplierGstin: "07AAACA1234A1Z5",
  billNo: "B/4417",
  billDate: "2026-01-15",
  sac: "998413",
  narration: "January line rental",
  ...over,
});

console.log("\n--- the Type field ---");

test("a journal is either the general one or an expense with GST", () => {
  assert.deepEqual(JOURNAL_TYPE_CODES, ["GENERAL", "EXPENSE_GST"]);
  // Quoted from Sigfa's Type box, so it must not drift into a paraphrase.
  assert.equal(JOURNAL_TYPES.EXPENSE_GST.label, "Expense With GST");
});

test("a voucher with no type reads as the general journal", () => {
  // The same reading voucherKinds does for an absent kind. Stamping one would
  // turn a reading into a stored fact the next time an old voucher is saved.
  assert.equal(journalTypeOf(undefined).code, "GENERAL");
  assert.equal(journalTypeOf("").code, "GENERAL");
  assert.equal(journalTypeOf(null).code, "GENERAL");
  assert.equal(journalTypeOf("nonsense").code, "GENERAL");
  assert.equal(journalTypeOf("expense_gst").code, "EXPENSE_GST", "case-insensitive");
  assert.ok(isExpenseJournal("EXPENSE_GST"));
  assert.ok(!isExpenseJournal("GENERAL"));
});

test("only the expense type is held to one entry per voucher", () => {
  // Sigfa's own line, under the grid: "Only One Entry Per Voucher".
  assert.equal(JOURNAL_TYPES.EXPENSE_GST.oneEntry, true);
  assert.equal(JOURNAL_TYPES.GENERAL.oneEntry, false, "a general journal is still free");
});

console.log("\n--- the expense itself ---");

test("every field comes back, whatever was sent", () => {
  assert.deepEqual(Object.keys(normalizeExpense({})).sort(), EXPENSE_FIELDS.slice().sort());
  assert.deepEqual(normalizeExpense({}), EXPENSE_DEFAULTS);
});

test("the GSTIN is upper-cased and the bill date stays a plain string", () => {
  const out = normalizeExpense(expense({ supplierGstin: "07aaaca1234a1z5" }));
  assert.equal(out.supplierGstin, "07AAACA1234A1Z5");
  // Not a Date: parsed as UTC midnight it would slip a day west of
  // Greenwich, and this is what the return claims the credit against.
  assert.equal(out.billDate, "2026-01-15");
  assert.equal(typeof out.billDate, "string");
});

console.log("\n--- the tax, and the split that must not be guessed ---");

test("a local expense splits into CGST and SGST", () => {
  const tax = expenseTax({ taxable: 1000, gstRate: 18, taxType: "local" });
  assert.deepEqual(tax, { cgst: 90, sgst: 90, igst: 0, total: 180 });
});

test("an inter-state expense is all IGST", () => {
  const tax = expenseTax({ taxable: 1000, gstRate: 18, taxType: "central" });
  assert.deepEqual(tax, { cgst: 0, sgst: 0, igst: 180, total: 180 });
});

test("an odd paisa reconciles to the tax exactly", () => {
  // The whole reason splitGst exists: (total / 2) printed twice is a paisa
  // out half the time, and then the voucher does not foot.
  const tax = expenseTax({ taxable: 1000.05, gstRate: 18, taxType: "local" });
  assert.equal(tax.total, 180.01);
  assert.equal(Number((tax.cgst + tax.sgst).toFixed(2)), 180.01);
});

test("an unknown place of supply splits NOTHING", () => {
  // Not a half-and-half guess, and not IGST either. `taxTypeFor` answers null
  // when nobody has said, and a `|| "local"` here would be a tax decision
  // made by a default -- which lib/gst.mjs names as the thing not to do.
  const tax = expenseTax({ taxable: 1000, gstRate: 18, taxType: null });
  assert.deepEqual(tax, { cgst: 0, sgst: 0, igst: 0, total: 0 });
});

test("the place of supply comes from the two state codes, or from neither", () => {
  assert.equal(expenseTaxType("07", "07"), "local");
  assert.equal(expenseTaxType("07", "29"), "central");
  assert.equal(expenseTaxType("07", ""), null, "the supplier's state is not known");
  assert.equal(expenseTaxType("", "07"), null, "our own state is not known");
});

test("the supplier is owed the expense plus its tax", () => {
  assert.equal(expenseTotal({ taxable: 1000, gstRate: 18, taxType: "local" }), 1180);
  assert.equal(expenseTotal({ taxable: 1000, gstRate: 0, taxType: "local" }), 1000);
});

console.log("\n--- the three legs ---");

test("a local expense debits its head and both input halves, and credits the party", () => {
  const legs = expenseLegs(expense(), { taxType: "local", accounts });
  assert.deepEqual(
    legs.map((l) => [l.name, l.debit, l.credit]),
    [
      ["Telephone Expenses", 1000, 0],
      ["Input CGST", 90, 0],
      ["Input SGST", 90, 0],
      ["Airtel", 0, 1180],
    ]
  );
});

test("an inter-state expense debits Input IGST instead, never alongside", () => {
  const legs = expenseLegs(expense(), { taxType: "central", accounts });
  const names = legs.map((l) => l.name);
  assert.deepEqual(names, ["Telephone Expenses", "Input IGST", "Airtel"]);
  assert.ok(!names.includes("Input CGST"), "both splits would double the credit claimed");
  assert.ok(!names.includes("Input SGST"));
});

test("a nil-rated expense writes two lines, not four with zeros in them", () => {
  // A zero row in a party's ledger is a row somebody has to read and discount.
  const legs = expenseLegs(expense({ gstRate: 0 }), { taxType: "local", accounts });
  assert.deepEqual(
    legs.map((l) => [l.name, l.debit, l.credit]),
    [
      ["Telephone Expenses", 1000, 0],
      ["Airtel", 0, 1000],
    ]
  );
});

test("the legs balance, whichever way the tax went", () => {
  // A journal has no account absorbing the opposite of its lines, so its own
  // lines are the only thing that can balance it.
  for (const taxType of ["local", "central"]) {
    assert.ok(legsBalance(expenseLegs(expense(), { taxType, accounts })), taxType);
  }
  assert.ok(legsBalance(expenseLegs(expense({ gstRate: 0 }), { taxType: "local", accounts })));
  assert.ok(legsBalance(expenseLegs(expense({ taxable: 1000.05 }), { taxType: "local", accounts })));
  // And a set that does not balance is reported, rather than assumed.
  assert.ok(!legsBalance([{ debit: 10, credit: 0 }]));
});

test("the input heads are named by lib/invoiceGl.mjs, not spelled again here", () => {
  // Every head is joined BY NAME. A second spelling of "Input CGST" is a
  // second account, and the credit claimed would be split across the two.
  assert.doesNotMatch(code("../lib/journalTypes.mjs"), /Input CGST|Input SGST|Input IGST/);
});

console.log("\n--- what the screen refuses ---");

test("an expense needs a supplier, a head and an amount", () => {
  const problems = expenseProblems({}, { taxType: "local" });
  assert.match(problems.join(" | "), /supplier this expense is owed to/);
  assert.match(problems.join(" | "), /expense account to debit/);
  assert.match(problems.join(" | "), /amount, before tax/);
});

test("an unknown place of supply is refused, and says what to fix", () => {
  const problems = expenseProblems(expense(), { taxType: null });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /place of supply is not known/);
  assert.match(problems[0], /Set the state on this party and on your own firm/);
});

test("a nil-rated expense needs no place of supply and no bill", () => {
  // There is no credit to claim, so asking for the paperwork behind one would
  // refuse a perfectly good entry.
  const problems = expenseProblems(
    expense({ gstRate: 0, supplierGstin: "", billNo: "", billDate: "" }),
    { taxType: null }
  );
  assert.deepEqual(problems, []);
});

test("a credit cannot be claimed without the supplier's document", () => {
  // This is the liability. A claim with nothing behind it is the one the
  // officer disallows, so it is refused here rather than filed.
  for (const [field, pattern] of [
    ["supplierGstin", /GSTIN/],
    ["billNo", /bill number/],
    ["billDate", /bill date/],
  ]) {
    const problems = expenseProblems(expense({ [field]: "" }), { taxType: "local" });
    assert.match(problems.join(" | "), pattern, field);
  }
});

test("a whole, valid expense is not refused", () => {
  assert.deepEqual(expenseProblems(expense(), { taxType: "local" }), []);
  assert.deepEqual(expenseProblems(expense(), { taxType: "central" }), []);
});

test("a rate outside 0 to 100 is refused", () => {
  assert.match(expenseProblems(expense({ gstRate: -5 }), { taxType: "local" }).join(" "), /between 0 and 100/);
  assert.match(expenseProblems(expense({ gstRate: 180 }), { taxType: "local" }).join(" "), /between 0 and 100/);
});

console.log("\n--- the module says what it was built from ---");

test("it quotes the screen and marks what it is not quoting", () => {
  const src = read("../lib/journalTypes.mjs");
  assert.match(src, /Expense With GST/);
  assert.match(src, /Only One Entry Per Vouche/);
  assert.match(src, /Account Name \| Debit \| Credit \| Type \| Number/);
  // The grid's own Type and Number columns are empty in the screenshot, and
  // the module has to say it is not guessing at them.
  assert.match(src, /EMPTY in the\n \* screenshot|are not guessed at here/);
});

test("the two rules it reuses are imported, not rewritten", () => {
  const src = code("../lib/journalTypes.mjs");
  assert.match(src, /from "\.\/gst\.mjs"/);
  assert.match(src, /splitGst/);
  assert.match(src, /taxTypeFor/);
  // No arithmetic of its own for the halves, which is how the two would drift.
  assert.doesNotMatch(src, /\/ 2/);
});

console.log("\n--- the voucher stores what was claimed ---");

test("the type and the expense are declared, or strict mode drops them", () => {
  const model = read("../models/voucherModel.js");
  assert.match(model, /journalType: \{/);
  assert.match(model, /expense: \{/);
  for (const field of [...EXPENSE_FIELDS, "taxType", "cgst", "sgst", "igst", "total"]) {
    assert.match(model, new RegExp(`${field}:`), `${field} is not declared`);
  }
  // No default on the type: an absent one READS as the general journal, and
  // a default would stamp that reading onto an old voucher on its next save.
  const block = model.slice(model.indexOf("journalType: {"), model.indexOf("expense: {"));
  assert.doesNotMatch(block, /default:/);
});

test("the split is frozen, not recomputed when the voucher is read back", () => {
  // The figures were claimed against the supplier's state as it stood. Had
  // they been derived at read time, correcting that party's state next year
  // would re-decide the place of supply of a credit already filed.
  const model = read("../models/voucherModel.js");
  assert.match(model, /taxType: \{ type: String/);
  assert.match(model, /WHY THE TAX IS STORED AND NOT RECOMPUTED/);
});

test("both write paths derive the lines rather than trusting the form", () => {
  // The legs are the whole point: a form free to post its own would be free
  // to put the tax on the wrong head, and a trial balance that still foots
  // gives no sign of it.
  for (const route of [
    "../app/api/voucher-add/route.js",
    "../app/api/voucher-alter/route.js",
  ]) {
    const src = code(route);
    assert.match(src, /resolveExpenseVoucher\(/, `${route} trusts the posted lines`);
    assert.match(src, /const posted = resolvedExpense \? resolvedExpense\.lines : customers/, route);
    // Inside the transaction, so a refusal takes back the Input heads it
    // may have created on the way.
    assert.match(src, /session,/, route);
  }
});

test("an edit that stops being an expense clears the claim", () => {
  // Mongoose drops an undefined from an update, so the voucher would keep
  // the claim of a journal it no longer is.
  const alter = code("../app/api/voucher-alter/route.js");
  assert.match(alter, /expense: resolvedExpense \? resolvedExpense\.expense : null/);
});

console.log("\n--- and the return claims it ---");

test("GSTR-3 and GSTR-3B take the vouchers as well as the invoices", () => {
  const src = code("../lib/gstReturns.mjs");
  assert.match(src, /export const expenseItc = /);
  assert.match(src, /gstr3Sheet = \(\{ invoices = \[\], vouchers = \[\]/);
  assert.match(src, /gstr3bSheet = \(\{ invoices = \[\], vouchers = \[\]/);
  // Added to the purchases, not instead of them.
  assert.match(src, /addTotals\(inwardTotals\(purchases\), expense/);
});

test("the return reads the stored figures, never a fresh split", () => {
  const src = code("../lib/gstReturns.mjs");
  const block = src.slice(src.indexOf("export const expenseItc"), src.indexOf("const addTotals"));
  assert.match(block, /expense\.igst/);
  assert.match(block, /expense\.cgst/);
  assert.match(block, /expense\.sgst/);
  // No rate arithmetic in here at all: re-deriving would re-decide a credit.
  assert.doesNotMatch(block, /gstRate|taxTypeFor|splitGst/);
});

test("only the two returns with an ITC table pay for the query", () => {
  // GSTR-1 is outward supply only, so loading expenses for it would be a
  // query per view that nothing reads.
  const route = code("../app/api/gst-return/route.js");
  assert.match(route, /view === "gstr3" \|\| view === "gstr3b"/);
  assert.match(route, /journalType: "EXPENSE_GST"/);
  assert.match(route, /gstr3bSheet\(\{ invoices, vouchers, from, to \}\)/);
});

console.log("\n--- an expense can be reopened and saved ---");

test("the hidden lines grid cannot block an expense's save", () => {
  const src = code("../app/voucheradd/page.js");
  // Reopening an expense loads its legs (Input CGST 45.90) into the hidden
  // grid. A hidden control that fails validation stops the submit silently,
  // so for an expense the grid is disabled and not required.
  assert.match(src, /name="name"[\s\S]{0,300}required=\{!isExpense\}[\s\S]{0,40}disabled=\{isExpense\}/);
  assert.match(src, /name="debit"[\s\S]{0,400}disabled=\{isExpense \|\| spec\.side === "credit"\}/);
  assert.match(src, /name="credit"[\s\S]{0,400}disabled=\{isExpense \|\| spec\.side === "debit"\}/);
});

test("a journal line takes paise", () => {
  const src = code("../app/voucheradd/page.js");
  // The default step of 1 refuses 45.90, on any journal, not just an expense.
  assert.match(src, /name="debit"[\s\S]{0,300}step="0\.01"/);
  assert.match(src, /name="credit"[\s\S]{0,300}step="0\.01"/);
});

console.log("\n--- the supplier's GSTIN comes from their master ---");

test("the server takes the GSTIN off the party master when the form sent none", () => {
  const src = code("../lib/expenseVoucher.mjs");
  assert.match(src, /\{ name: 1, state: 1, stateCode: 1, gstIn: 1 \}/, "the master's GSTIN is not read");
  assert.match(
    src,
    /if \(!draft\.supplierGstin && supplier\?\.gstIn\) \{\s*draft = normalizeExpense\(\{ \.\.\.draft, supplierGstin: supplier\.gstIn \}\);/
  );
  // Before the check that refuses a missing one, or the fallback is too late.
  assert.ok(src.indexOf("supplier?.gstIn") < src.indexOf("expenseProblems(draft"));
});

test("the screen fills it on picking the supplier, and sends it", () => {
  const src = code("../app/voucheradd/page.js");
  assert.match(src, /customers\.find\(\(c\) => c\.name === name\)\?\.gstIn/);
  assert.match(src, /supplierGstin: masterGstin\(e\.target\.value\) \|\| expense\.supplierGstin/);
  assert.match(src, /expenseProblems\(expenseToSend\(\), \{ taxType: stated \}\)/);
  assert.match(src, /\{ expense: expenseToSend\(\) \}/);
});

console.log(`\n  ${passed} checks passed\n`);
