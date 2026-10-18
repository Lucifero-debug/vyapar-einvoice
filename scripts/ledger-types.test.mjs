/**
 * The ledger's Type column: scripts/ledger-types.test.mjs
 *
 * Plain node, no framework -- `node scripts/ledger-types.test.mjs`.
 *
 * Three halves again, the same three that break. lib/ledgerTypes.mjs on its
 * own, which is pure. The two vocabularies it reads, because a document type
 * without a short code prints an empty cell and nothing else complains. Then
 * the wiring: a column is only as good as the field behind it, and the field
 * is written in one place and read in another.
 *
 * The sharpest test here is the last one. It posts a real invoice of each of
 * the four kinds and checks that the fallback, shown only the party row with
 * its stored type removed, names the document the posting actually wrote. If
 * anybody ever flips a sign in lib/balance.mjs, that is what catches it.
 */

import assert from "node:assert/strict";
import fs from "node:fs";

import {
  LEDGER_TYPE_CODES,
  PURCHASE_CONTRA,
  SALES_CONTRA,
  inferredDocType,
  ledgerRowType,
} from "../lib/ledgerTypes.mjs";
import { SERIES_DOC_TYPES, docTypeShort } from "../lib/series.mjs";
import { VOUCHER_KINDS, VOUCHER_KIND_CODES } from "../lib/voucherKinds.mjs";
import { buildInvoiceLedgerRows, invoicePostingDeltas } from "../lib/invoicePosting.mjs";

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

console.log("\n--- the two vocabularies ---");

test("every document type has a short code", () => {
  for (const doc of SERIES_DOC_TYPES) {
    assert.ok(doc.short, `${doc.code} has no short code`);
    assert.match(doc.short, /^[A-Z]{2,3}$/, `${doc.code}: "${doc.short}" is not two or three capitals`);
  }
});

test("where Sigfa gave an MKEY, the short code IS that MKEY", () => {
  // The whole point of the rule: the column prints Sigfa's own letters for
  // the five documents it named, and invents letters only for the rest.
  const withMkey = SERIES_DOC_TYPES.filter((doc) => doc.mkey);
  assert.ok(withMkey.length >= 5, "expected at least the five recorded MKEYs");
  for (const doc of withMkey) {
    assert.equal(doc.short, doc.mkey, `${doc.code}: short "${doc.short}" drifted from MKEY "${doc.mkey}"`);
  }
});

test("the six codes that were asked for are the six documents they name", () => {
  assert.equal(docTypeShort("SALE_INVOICE"), "SI");
  assert.equal(docTypeShort("PURCHASE_INVOICE"), "PI");
  assert.equal(docTypeShort("SALE_RETURN"), "SR");
  assert.equal(docTypeShort("PURCHASE_RETURN"), "PR");
  assert.equal(docTypeShort("SALE_CHALLAN"), "SC");
  assert.equal(docTypeShort("PURCHASE_CHALLAN"), "PC");
});

test("no two document types share a short code", () => {
  const shorts = SERIES_DOC_TYPES.map((doc) => doc.short);
  assert.equal(new Set(shorts).size, shorts.length, `duplicate short codes in ${shorts.join(", ")}`);
});

test("every voucher kind has a short code, and none collides with a document's", () => {
  const docShorts = new Set(SERIES_DOC_TYPES.map((doc) => doc.short));
  for (const kindCode of VOUCHER_KIND_CODES) {
    const short = VOUCHER_KINDS[kindCode].short;
    assert.ok(short, `${kindCode} has no short code`);
    assert.ok(!docShorts.has(short), `${kindCode}: "${short}" is also a document type's code`);
  }
});

test("an unknown document type prints nothing rather than inventing a code", () => {
  assert.equal(docTypeShort("NOT_A_DOCUMENT"), "");
  assert.equal(docTypeShort(""), "");
  assert.equal(docTypeShort(undefined), "");
});

console.log("\n--- reading one row ---");

test("a stored document type is used as it stands", () => {
  const t = ledgerRowType({ docType: "SALE_RETURN", account: SALES_CONTRA, credit: 100 });
  assert.equal(t.short, "SR");
  assert.equal(t.label, "Sales Return");
  assert.equal(t.inferred, false, "a stored type is not a reading");
});

test("a stored voucher kind names the voucher", () => {
  assert.deepEqual(
    ledgerRowType({ voucherKind: "RECEIPT", debit: 500 }),
    { short: "RC", label: "Receipt", inferred: false }
  );
  assert.equal(ledgerRowType({ voucherKind: "PAYMENT" }).short, "PY");
  assert.equal(ledgerRowType({ voucherKind: "JOURNAL" }).short, "JV");
  // 'CT', because 'CN' is the credit note -- which is what practically
  // everybody reading an Indian ledger expects those letters to mean.
  assert.equal(ledgerRowType({ voucherKind: "CONTRA" }).short, "CT");
  assert.equal(ledgerRowType({ voucherKind: "CREDIT_NOTE" }).short, "CN");
  assert.equal(ledgerRowType({ voucherKind: "DEBIT_NOTE" }).short, "DN");
  assert.equal(ledgerRowType({ voucherKind: "CREDIT_NOTE" }).label, "Credit Note");
});

test("the document type wins over a voucher kind on the same row", () => {
  // Nothing writes both. If something ever does, one answer has to be the
  // answer, and the document is the more specific of the two.
  const t = ledgerRowType({ docType: "PURCHASE_INVOICE", voucherKind: "PAYMENT" });
  assert.equal(t.short, "PI");
});

test("an unrecognised stored value falls through instead of being printed", () => {
  // A hand-edited row saying docType: "RUBBISH" must not reach the column.
  const t = ledgerRowType({ docType: "RUBBISH", account: SALES_CONTRA, debit: 10 });
  assert.equal(t.short, "SI", "should have fallen through to the reading");
  assert.equal(t.inferred, true);
  assert.equal(ledgerRowType({ docType: "RUBBISH", account: "Anything", debit: 10 }).short, "");
});

test("a row nothing can be read from prints an empty cell", () => {
  assert.deepEqual(ledgerRowType({}), { short: "", label: "", inferred: false });
  assert.deepEqual(ledgerRowType(null), { short: "", label: "", inferred: false });
  assert.deepEqual(ledgerRowType(undefined), { short: "", label: "", inferred: false });
  // An opening balance, as the page builds it.
  assert.equal(ledgerRowType({ account: "", debit: 0, credit: 0 }).short, "");
});

console.log("\n--- reading an old row off its figures ---");

test("the four party-row shapes", () => {
  assert.equal(inferredDocType({ account: SALES_CONTRA, debit: 100 }), "SALE_INVOICE");
  assert.equal(inferredDocType({ account: SALES_CONTRA, credit: 100 }), "SALE_RETURN");
  assert.equal(inferredDocType({ account: PURCHASE_CONTRA, credit: 100 }), "PURCHASE_INVOICE");
  assert.equal(inferredDocType({ account: PURCHASE_CONTRA, debit: 100 }), "PURCHASE_RETURN");
});

test("a shape it cannot read is left alone", () => {
  // Both columns, or neither: not an entry anybody meant, so not a guess.
  assert.equal(inferredDocType({ account: SALES_CONTRA, debit: 100, credit: 100 }), "");
  assert.equal(inferredDocType({ account: SALES_CONTRA, debit: 0, credit: 0 }), "");
  // A receipt leg or a GL row: its account says nothing about the document.
  assert.equal(inferredDocType({ account: "Cash", debit: 100 }), "");
  assert.equal(inferredDocType({ account: "CGST Output", credit: 9 }), "");
});

test("a reading is marked as a reading", () => {
  const t = ledgerRowType({ account: PURCHASE_CONTRA, credit: 100 });
  assert.equal(t.short, "PI");
  assert.equal(t.inferred, true, "the page prints '(read from the entry)' off this");
});

console.log("\n--- the wiring ---");

test("the posting stamps a document type on every row it writes", () => {
  const src = code("../lib/invoicePosting.mjs");
  assert.match(src, /docTypeForBill\(\{\s*type,\s*isReturn\s*\}\)/);
  assert.match(src, /rows\.map\(\(row\) => \(\{ \.\.\.row, docType \}\)\)/);
});

test("both billing routes pass the return flag, or every return reads as a sale", () => {
  for (const route of ["../app/api/save-invoice/route.js", "../app/api/sale-alter/route.js"]) {
    const src = code(route);
    assert.match(
      src,
      /buildInvoiceLedgerRows\(\{[\s\S]{0,200}?isReturn:/,
      `${route} does not pass isReturn to buildInvoiceLedgerRows`
    );
  }
});

test("the ledger row model declares docType, or Mongoose drops it silently", () => {
  const src = code("../models/ledgerModel.js");
  assert.match(src, /docType:\s*\{\s*type:\s*String/);
});

test("the two contra account names still match the ones the posting writes", () => {
  // lib/ledgerTypes.mjs matches these as literals. If they are renamed in
  // the posting, the fallback stops recognising old rows -- silently.
  const posting = read("../lib/invoicePosting.mjs");
  assert.ok(posting.includes(`"${SALES_CONTRA}"`), `posting no longer writes "${SALES_CONTRA}"`);
  assert.ok(posting.includes(`"${PURCHASE_CONTRA}"`), `posting no longer writes "${PURCHASE_CONTRA}"`);
});

test("the ledger page renders the column and still spans its footer", () => {
  const src = code("../app/ledger/page.js");
  assert.match(src, /<th[^>]*>TYPE<\/th>/, "no TYPE header");
  assert.match(src, /ledgerRowType\(e\)/, "rows are not typed");
  assert.match(src, /entry\.type\.short/, "the cell prints nothing");
  // Six columns now, so TOTAL has to reach across three of them.
  assert.match(src, /colSpan="3"/, "the footer still spans two columns");
});

test("the voucher register names every entry, not just the money vouchers", () => {
  const src = code("../app/voucher/page.js");
  assert.match(src, /rows\.map\(ledgerRowType\)\.find/, "the register is not using the shared reader");
  // It used to read voucherKind itself, which left every invoice blank.
  assert.doesNotMatch(
    src,
    /VOUCHER_KINDS\[/,
    "the register still reads voucherKind directly, so invoices go unnamed"
  );
  assert.match(src, /entry\.type\.label/, "the chip prints nothing");
  assert.match(src, /entry\.type\.inferred/, "a reading is not marked as one");
});

console.log("\n--- against a real posting ---");

/** One invoice's rows, exactly as a billing route would write them. */
const post = ({ type, isReturn, received = 0 }) => {
  const deltas = invoicePostingDeltas({ type, isReturn, finalAmount: 1000, received });
  return buildInvoiceLedgerRows({
    type,
    isReturn,
    customerName: "A A ENTERPRISES",
    cashAccountName: "Bank of Baroda",
    invoiceNo: 7,
    date: new Date("2026-10-18"),
    paymentType: received ? "Bank of Baroda" : "Credit",
    voucherId: "inv-7",
    deltas,
  });
};

const COMBOS = [
  { type: "Sale", isReturn: false, docType: "SALE_INVOICE", short: "SI" },
  { type: "Sale", isReturn: true, docType: "SALE_RETURN", short: "SR" },
  { type: "Purchase", isReturn: false, docType: "PURCHASE_INVOICE", short: "PI" },
  { type: "Purchase", isReturn: true, docType: "PURCHASE_RETURN", short: "PR" },
];

test("every row of every kind of bill carries its document type", () => {
  for (const combo of COMBOS) {
    // With a receipt, so the cash legs are in too -- those are the rows
    // somebody reading a bank ledger is looking at.
    const rows = post({ ...combo, received: 1000 });
    assert.equal(rows.length, 3, `${combo.docType}: expected the party row and both receipt legs`);
    for (const row of rows) {
      assert.equal(row.docType, combo.docType, `${combo.docType}: a row went out unstamped`);
      assert.equal(ledgerRowType(row).short, combo.short);
    }
  }
});

test("the fallback agrees with what the posting actually wrote", () => {
  // Strip the stored type off the party row and make the reading earn it.
  // This is the test that fails if a sign is ever flipped in balance.mjs.
  for (const combo of COMBOS) {
    const [party] = post(combo);
    const { docType, ...withoutType } = party;
    assert.equal(docType, combo.docType);
    assert.equal(
      inferredDocType(withoutType),
      combo.docType,
      `${combo.docType}: the reading disagrees with the posting (account ${party.account}, Dr ${party.debit}, Cr ${party.credit})`
    );
  }
});

test("a challan posts nothing, so SC and PC cannot appear in a ledger", () => {
  // Defined, reachable through the series master, and never written here.
  // If challans ever do post, this is the test that should be rewritten
  // rather than quietly deleted.
  assert.ok(!LEDGER_TYPE_CODES.includes("SC"));
  assert.ok(!LEDGER_TYPE_CODES.includes("PC"));
  const challanSave = read("../lib/challanSave.mjs");
  assert.ok(
    !/Ledger/.test(challanSave),
    "challanSave now touches the Ledger -- the Type column needs SC/PC adding to LEDGER_TYPE_CODES"
  );
});

console.log(`\n  ${passed} checks passed\n`);
