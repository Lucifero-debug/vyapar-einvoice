/**
 * The six vouchers: Receipt, Payment, Journal, Contra, Credit Note and
 * Debit Note.
 *
 *   node scripts/voucher-kinds.test.mjs
 *
 * Run with bare node -- lib/voucherKinds.mjs imports only balance.mjs, and
 * lib/voucherLedger.mjs only those two.
 *
 *
 * WHAT THIS SUITE IS GUARDING
 * ---------------------------
 * Three things, and they are the three that cost money if they break.
 *
 * ONE: a direction, once named, is enforced. Cash-or-bank said which account
 * the money went through and never which way it went -- that was decided only
 * by the column an operator typed into, and nothing objected to a receipt
 * entered as a payment. The entry posts cleanly either way and reads as
 * correct afterwards, while the party's balance, the cash book and the trial
 * balance all moved backwards.
 *
 * TWO: a journal has no cash leg, and every path that touches one knows it.
 * The posting builder appends an aggregate row for `acName`; a journal has no
 * acName, so an unguarded builder appends a row for `undefined`. That is not
 * cosmetic: `delete-voucher` and `voucher-alter` reverse by walking the same
 * deltas, so the reversal would chase an account called undefined and leave
 * the lines it really moved un-reversed. The balance would be wrong and
 * nothing would say so.
 *
 * THREE: an entry saved before any of this keeps posting exactly as it did.
 * None of them carries a `kind`, nothing backfills one, and `kindOf` reads an
 * absent one off the figures -- so the rows and deltas for an old voucher
 * must come out byte for byte as the old builder made them.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  VOUCHER_KINDS,
  VOUCHER_KIND_CODES,
  inferredFrom,
  inferredKind,
  isVoucherKind,
  kindOf,
  lineProblem,
  lineTotals,
  voucherProblems,
  voucherTitle,
} from "../lib/voucherKinds.mjs";
import {
  buildVoucherBalanceDeltas,
  buildVoucherLedgerRows,
  journalContra,
} from "../lib/voucherLedger.mjs";

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

const DATE = "2026-10-15";

/** A receipt of 5,000 from one party into the cash account. */
const receipt = (over = {}) => ({
  kind: "RECEIPT",
  acName: "Cash A/c",
  paymentType: "Cash",
  date: DATE,
  narration: "",
  customers: [{ name: "Acme Traders", debit: 0, credit: 5000 }],
  voucherId: "v1",
  ...over,
});

/** Depreciation: Dr the expense, Cr the asset. No money moves. */
const journal = (over = {}) => ({
  kind: "JOURNAL",
  date: DATE,
  narration: "Depreciation for the year",
  customers: [
    { name: "Depreciation", debit: 12000, credit: 0 },
    { name: "Plant & Machinery", debit: 0, credit: 12000 },
  ],
  voucherId: "j1",
  ...over,
});

console.log("\n--- the six kinds ---");

test("there are six, in the order a menu should offer them", () => {
  assert.deepEqual(VOUCHER_KIND_CODES, [
    "RECEIPT",
    "PAYMENT",
    "JOURNAL",
    "CONTRA",
    "CREDIT_NOTE",
    "DEBIT_NOTE",
  ]);
  for (const code of VOUCHER_KIND_CODES) {
    assert.equal(VOUCHER_KINDS[code].code, code, `${code} disagrees with its key`);
    assert.ok(VOUCHER_KINDS[code].label, `${code} has no label`);
  }
});

test("a note has an account but no cash or bank leg", () => {
  // The distinction the two flags exist for. A note books against a head
  // like Discount Allowed; nothing is paid, so there is no instrument.
  for (const code of ["CREDIT_NOTE", "DEBIT_NOTE"]) {
    const spec = VOUCHER_KINDS[code];
    assert.equal(spec.needsAccount, true, `${code} has nothing to post against`);
    assert.equal(spec.needsPaymentType, false, `${code} is asking for cash or bank`);
    assert.equal(spec.mustBalance, false, `${code} should be absorbed by its account`);
    assert.equal(spec.ownAccounts, false, `${code} names a party, not our own accounts`);
  }
  // And the three that DO move money still want both.
  for (const code of ["RECEIPT", "PAYMENT", "CONTRA"]) {
    assert.equal(VOUCHER_KINDS[code].needsPaymentType, true, `${code} lost its instrument`);
  }
  // A journal has neither.
  assert.equal(VOUCHER_KINDS.JOURNAL.needsAccount, false);
  assert.equal(VOUCHER_KINDS.JOURNAL.needsPaymentType, false);
});

test("a note takes a figure in either column", () => {
  // The notes were locked to one side when they were added, exactly as a
  // receipt is. That was wrong, and holding it open is what this test is
  // for: a note moves no money, so its direction is not a fact about the
  // kind the way a receipt's is, and an adjustment with both sides -- part
  // discount and part rate difference, or a balance moved between two
  // parties -- is an ordinary entry rather than a mistake.
  assert.equal(VOUCHER_KINDS.CREDIT_NOTE.side, null);
  assert.equal(VOUCHER_KINDS.DEBIT_NOTE.side, null);

  // Not merely the flag: neither column is refused by the validator the
  // routes themselves call.
  for (const kind of ["CREDIT_NOTE", "DEBIT_NOTE"]) {
    assert.equal(lineProblem({ name: "A", credit: 100 }, kind), null, `${kind} refused a credit`);
    assert.equal(lineProblem({ name: "A", debit: 100 }, kind), null, `${kind} refused a debit`);

    for (const line of [{ name: "A", credit: 100 }, { name: "A", debit: 100 }]) {
      assert.deepEqual(
        voucherProblems({ kind, acName: "Discount Allowed", customers: [line] }),
        [],
        `${kind} refused a whole voucher on one of the two sides`
      );
    }
  }

  // One figure per LINE is still the rule. Both columns of a single line is
  // a half-corrected mistake; a two-sided adjustment is two lines.
  assert.match(
    lineProblem({ name: "A", debit: 100, credit: 100 }, "CREDIT_NOTE") || "",
    /one column, not both/
  );
});

// What a two-sided note POSTS is pinned next door, in
// scripts/voucher-ledger.test.mjs, where the row builder's fixtures live.

test("a note is refused a cash or bank account", () => {
  const problems = voucherProblems({
    kind: "CREDIT_NOTE",
    acName: "Discount Allowed",
    paymentType: "Cash",
    customers: [{ name: "A", credit: 100 }],
  });
  assert.match(problems.join(" "), /not paid by cash or bank/);
});

test("a note still needs the account it books against", () => {
  const problems = voucherProblems({
    kind: "DEBIT_NOTE",
    acName: "",
    customers: [{ name: "A", debit: 100 }],
  });
  assert.match(problems.join(" "), /needs an account/);
});

test("a clean note has nothing wrong with it", () => {
  assert.deepEqual(
    voucherProblems({
      kind: "CREDIT_NOTE",
      acName: "Discount Allowed",
      paymentType: "",
      customers: [{ name: "A A ENTERPRISES", credit: 500 }],
    }),
    []
  );
  assert.deepEqual(
    voucherProblems({
      kind: "DEBIT_NOTE",
      acName: "Rejected Material",
      paymentType: "",
      customers: [{ name: "SUPPLIER LTD", debit: 500 }],
    }),
    []
  );
});

/*
  "a note put on the wrong side is caught" stood here and asserted that a
  debit on a credit note was refused. There is no wrong side on a note any
  more, so the test is gone rather than loosened -- "a note takes a figure in
  either column" above is its replacement and asserts the opposite.

  The side rule itself is untouched and still pinned, on the kinds whose
  direction is a fact: see the receipt and payment cases below.
*/

test("anything else is refused, not defaulted", () => {
  assert.equal(isVoucherKind("RECEIPT"), true);
  assert.equal(isVoucherKind("receipt"), false, "the stored value is upper case");
  assert.equal(isVoucherKind("CASH"), false, "the old cash/bank split is not a kind");
  assert.equal(isVoucherKind(""), false);
  assert.equal(isVoucherKind(undefined), false);
  // And a kind that got past the guard is not quietly treated as a receipt.
  assert.deepEqual(voucherProblems({ kind: "CASH", customers: [] }), [
    '"CASH" is not a voucher kind.',
  ]);
});

test("only the journal has no account, and only it must balance", () => {
  assert.equal(VOUCHER_KINDS.RECEIPT.needsAccount, true);
  assert.equal(VOUCHER_KINDS.PAYMENT.needsAccount, true);
  assert.equal(VOUCHER_KINDS.CONTRA.needsAccount, true);
  assert.equal(VOUCHER_KINDS.JOURNAL.needsAccount, false);

  assert.equal(VOUCHER_KINDS.JOURNAL.mustBalance, true);
  for (const code of ["RECEIPT", "PAYMENT", "CONTRA"]) {
    assert.equal(VOUCHER_KINDS[code].mustBalance, false, `${code} balances via its account`);
  }
});

test("money in is a credit to the party, money out a debit", () => {
  // The whole reason the direction is named: this was previously decided by
  // which column somebody typed into.
  assert.equal(VOUCHER_KINDS.RECEIPT.side, "credit");
  assert.equal(VOUCHER_KINDS.PAYMENT.side, "debit");
  // A contra credits the account the money LEFT, so it posts as a receipt
  // does -- only what the line may name differs.
  assert.equal(VOUCHER_KINDS.CONTRA.side, "credit");
  assert.equal(VOUCHER_KINDS.CONTRA.ownAccounts, true);
  // A journal is free to use either column, line by line.
  assert.equal(VOUCHER_KINDS.JOURNAL.side, null);
});

test("each form is headed by its kind", () => {
  assert.equal(voucherTitle("RECEIPT"), "Receipt Voucher");
  assert.equal(voucherTitle("JOURNAL"), "Journal Voucher");
  assert.equal(voucherTitle("CONTRA"), "Contra Voucher");
  assert.equal(voucherTitle("nonsense"), "Voucher", "never a heading built from a bad kind");
});

console.log("\n--- a receipt and a payment post opposite ways ---");

test("a receipt credits the party and debits the cash account", () => {
  const rows = buildVoucherLedgerRows(receipt());
  assert.equal(rows.length, 2, "one party line plus the account");

  const party = rows[0];
  assert.equal(party.customerName, "Acme Traders");
  assert.equal(party.credit, 5000);
  assert.equal(party.debit, 0);
  assert.equal(party.account, "Cash A/c", "the contra is the account it went into");

  const account = rows[1];
  assert.equal(account.customerName, "Cash A/c");
  assert.equal(account.debit, 5000, "the cash account receives it");
  assert.equal(account.credit, 0);
  assert.equal(account.account, "Cash");
});

test("a payment debits the party and credits the cash account", () => {
  const rows = buildVoucherLedgerRows(
    receipt({
      kind: "PAYMENT",
      customers: [{ name: "Acme Traders", debit: 5000, credit: 0 }],
    })
  );
  assert.equal(rows[0].debit, 5000);
  assert.equal(rows[1].customerName, "Cash A/c");
  assert.equal(rows[1].credit, 5000, "the cash account pays it out");
});

test("either way the voucher nets to zero", () => {
  // The invariant the whole posting rests on: debits equal credits across
  // every row, so no voucher can move the trial balance out of balance.
  for (const voucher of [
    receipt(),
    receipt({ kind: "PAYMENT", customers: [{ name: "Acme Traders", debit: 5000, credit: 0 }] }),
    journal(),
  ]) {
    const rows = buildVoucherLedgerRows(voucher);
    const { debit, credit } = rows.reduce(
      (t, r) => ({ debit: t.debit + r.debit, credit: t.credit + r.credit }),
      { debit: 0, credit: 0 }
    );
    assert.equal(debit, credit, `${voucher.kind} does not balance`);
    // And the balance deltas net to zero for the same reason.
    const total = buildVoucherBalanceDeltas(voucher).reduce((t, d) => t + d.delta, 0);
    assert.equal(total, 0, `${voucher.kind} deltas do not net to zero`);
  }
});

test("a receipt refuses a figure in the debit column", () => {
  const problems = voucherProblems(
    receipt({ customers: [{ name: "Acme Traders", debit: 5000, credit: 0 }] })
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /goes in Credit/);
  assert.match(problems[0], /Acme Traders/, "the line is named");
});

test("a payment refuses a figure in the credit column", () => {
  const problems = voucherProblems(
    receipt({ kind: "PAYMENT", customers: [{ name: "Acme Traders", debit: 0, credit: 5000 }] })
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /goes in Debit/);
});

test("a line needs a name and exactly one figure", () => {
  assert.match(lineProblem({ name: "", credit: 100 }, "RECEIPT"), /needs an account/);
  assert.match(lineProblem({ name: "A", debit: 0, credit: 0 }, "RECEIPT"), /enter an amount/);
  assert.match(
    lineProblem({ name: "A", debit: 100, credit: 100 }, "JOURNAL"),
    /one column, not both/
  );
  assert.match(lineProblem({ name: "A", credit: -100 }, "RECEIPT"), /cannot be negative/);
  assert.equal(lineProblem({ name: "A", debit: 0, credit: 100 }, "RECEIPT"), null);
});

test("a voucher cannot pay itself", () => {
  const problems = voucherProblems(
    receipt({ customers: [{ name: "Cash A/c", debit: 0, credit: 5000 }] })
  );
  assert.ok(problems.some((p) => /is the voucher's own account/.test(p)));
});

console.log("\n--- a journal has no cash leg ---");

test("a journal posts its lines and nothing else", () => {
  const rows = buildVoucherLedgerRows(journal());
  assert.equal(rows.length, 2, "no aggregate row -- there is no account to aggregate");
  assert.deepEqual(rows.map((r) => r.customerName), ["Depreciation", "Plant & Machinery"]);
  // Nothing named undefined, which is what an unguarded builder appends.
  assert.ok(
    rows.every((r) => r.customerName && r.customerName !== "undefined"),
    "a row for an account nobody has"
  );
});

test("a journal's deltas carry no account either", () => {
  // THE CHECK THAT MATTERS FOR DELETE. delete-voucher and voucher-alter
  // reverse by walking these: an extra delta for an absent acName would send
  // the reversal after an account called undefined and leave the real lines
  // standing.
  const deltas = buildVoucherBalanceDeltas(journal());
  assert.equal(deltas.length, 2);
  assert.deepEqual(deltas.map((d) => d.name), ["Depreciation", "Plant & Machinery"]);
  assert.deepEqual(deltas.map((d) => d.delta), [12000, -12000]);
  assert.ok(deltas.every((d) => d.name !== undefined));
});

test("two lines name each other in the ledger, more name the journal", () => {
  // What makes a journal readable in an account's own ledger: "Depreciation"
  // against "Plant & Machinery" rather than a blank contra column.
  const two = buildVoucherLedgerRows(journal());
  assert.equal(two[0].account, "Plant & Machinery");
  assert.equal(two[1].account, "Depreciation");

  const three = buildVoucherLedgerRows(
    journal({
      customers: [
        { name: "Depreciation", debit: 12000, credit: 0 },
        { name: "Plant & Machinery", debit: 0, credit: 8000 },
        { name: "Furniture", debit: 0, credit: 4000 },
      ],
    })
  );
  // No single other side, so saying so beats naming one of three.
  assert.deepEqual(three.map((r) => r.account), ["Journal", "Journal", "Journal"]);
  assert.equal(journalContra([{ name: "A" }, { name: "B" }], 0), "B");
  assert.equal(journalContra([{ name: "A" }], 0), "Journal");
});

test("a journal must balance, and the message says by how much", () => {
  const problems = voucherProblems(
    journal({
      customers: [
        { name: "Depreciation", debit: 12000, credit: 0 },
        { name: "Plant & Machinery", debit: 0, credit: 11000 },
      ],
    })
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /must balance/);
  // "does not balance" with no figure is the least useful error a ledger can
  // give you.
  assert.match(problems[0], /12000\.00/);
  assert.match(problems[0], /11000\.00/);
  assert.match(problems[0], /out by 1000\.00/);
});

test("a journal needs two sides", () => {
  const problems = voucherProblems(
    journal({ customers: [{ name: "Depreciation", debit: 12000, credit: 0 }] })
  );
  assert.ok(problems.some((p) => /at least two lines/.test(p)));
});

test("a journal carrying a cash account is refused", () => {
  // Not merely unnecessary: it would post a cash leg for an adjustment that
  // never touched cash, and the cash book would show money that never moved.
  const problems = voucherProblems(journal({ acName: "Cash A/c", paymentType: "Cash" }));
  assert.ok(problems.some((p) => /no cash or bank account/.test(p)));
  assert.ok(problems.some((p) => /not paid by cash or bank/.test(p)));
});

test("a balanced journal is accepted", () => {
  assert.deepEqual(voucherProblems(journal()), []);
});

console.log("\n--- a contra moves money between our own accounts ---");

test("a contra credits where it left and debits where it landed", () => {
  const rows = buildVoucherLedgerRows({
    kind: "CONTRA",
    acName: "HDFC Bank",
    paymentType: "Bank",
    date: DATE,
    customers: [{ name: "Cash A/c", debit: 0, credit: 20000 }],
    voucherId: "c1",
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].customerName, "Cash A/c");
  assert.equal(rows[0].credit, 20000, "the cash it left");
  assert.equal(rows[1].customerName, "HDFC Bank");
  assert.equal(rows[1].debit, 20000, "the bank it landed in");
});

test("a contra has one line, and not its own account", () => {
  const two = voucherProblems({
    kind: "CONTRA",
    acName: "HDFC Bank",
    paymentType: "Bank",
    customers: [
      { name: "Cash A/c", debit: 0, credit: 10000 },
      { name: "Petty Cash", debit: 0, credit: 10000 },
    ],
  });
  assert.ok(two.some((p) => /has one line/.test(p)));

  const itself = voucherProblems({
    kind: "CONTRA",
    acName: "HDFC Bank",
    paymentType: "Bank",
    customers: [{ name: "HDFC Bank", debit: 0, credit: 10000 }],
  });
  assert.ok(itself.some((p) => /own account/.test(p)));
});

console.log("\n--- an entry saved before any of this ---");

test("an absent kind is read off the figures", () => {
  // Every such entry has a cash or bank leg and party lines, so the side the
  // lines sit on IS the direction the money went.
  assert.equal(inferredKind({ customers: [{ credit: 500 }] }).code, "RECEIPT");
  assert.equal(inferredKind({ customers: [{ debit: 500 }] }).code, "PAYMENT");
  // kindOf prefers a stored kind and falls back to the reading.
  assert.equal(kindOf({ kind: "JOURNAL", customers: [{ credit: 1 }] }).code, "JOURNAL");
  assert.equal(kindOf({ customers: [{ debit: 500 }] }).code, "PAYMENT");
  // And a caller can tell a reading from a stored value, to mark it.
  assert.equal(inferredFrom({ customers: [{ debit: 500 }] }), true);
  assert.equal(inferredFrom({ kind: "RECEIPT", customers: [] }), false);
  assert.equal(inferredFrom({ kind: "CASH" }), true, "a bad stored kind is not a kind");
});

test("an old voucher posts exactly as it always did", () => {
  // THE BACKWARDS-COMPATIBILITY CHECK. No kind, so kindOf reads a receipt or
  // a payment -- both of which carry an account -- and the rows must come out
  // with the aggregate row they always had.
  const old = {
    acName: "Cash A/c",
    paymentType: "Cash",
    date: DATE,
    narration: "",
    customers: [
      { name: "Acme Traders", debit: 0, credit: 3000 },
      { name: "Bharat Steel", debit: 0, credit: 2000 },
    ],
    voucherId: "old1",
  };
  const rows = buildVoucherLedgerRows(old);
  assert.equal(rows.length, 3, "two lines and the account");
  assert.equal(rows[2].customerName, "Cash A/c");
  assert.equal(rows[2].debit, 5000);
  assert.equal(rows[2].narration, "Main account entry");
  assert.equal(rows[0].account, "Cash A/c", "the old contra, not a journal contra");
  assert.equal(rows[0].paymentType, "Cash");

  const deltas = buildVoucherBalanceDeltas(old);
  assert.equal(deltas.length, 3);
  assert.deepEqual(deltas[2], { name: "Cash A/c", delta: 5000 });
});

test("the totals helper counts both columns", () => {
  assert.deepEqual(lineTotals([{ debit: 10, credit: 0 }, { debit: 0, credit: 2 }]), {
    debit: 10,
    credit: 2,
  });
  // Rounded line by line, so a column of thirds does not drift away from the
  // figure the journal is checked to balance against.
  assert.deepEqual(lineTotals([{ debit: 0.1 }, { debit: 0.2 }]), { debit: 0.3, credit: 0 });
  assert.deepEqual(
    lineTotals([{ credit: 33.33 }, { credit: 33.33 }, { credit: 33.34 }]),
    { debit: 0, credit: 100 }
  );
  assert.deepEqual(lineTotals([]), { debit: 0, credit: 0 });
  assert.deepEqual(lineTotals(), { debit: 0, credit: 0 });
  // A string from a number box is coerced, not concatenated.
  assert.deepEqual(lineTotals([{ debit: "10" }, { debit: "5" }]), { debit: 15, credit: 0 });
  // round2 is half-up on the SCALED value, so a figure sitting exactly on
  // half a paisa goes down: 1.005 * 100 is 100.4999... in binary floating
  // point. Pinned because it is the kind of thing somebody later "fixes"
  // into a different rounding and moves every journal by a paisa.
  assert.deepEqual(lineTotals([{ debit: 1.005 }]), { debit: 1, credit: 0 });
});

console.log("\n--- the wiring ---");

test("one validator, called by both write paths", () => {
  // The screen's copy is a courtesy; these two are the rule. A second
  // implementation is how they come to disagree about what a journal is.
  for (const route of ["../app/api/voucher-add/route.js", "../app/api/voucher-alter/route.js"]) {
    const src = read(route);
    assert.ok(/voucherProblems\(\{ kind, acName, paymentType, customers \}\)/.test(src), route);
    assert.ok(/from ['"]@\/lib\/voucherKinds\.mjs['"]/.test(src), route);
  }
  // And the old four-field presence check is gone from add.
  assert.doesNotMatch(
    read("../app/api/voucher-add/route.js"),
    /Missing required fields/,
    "the check that let a receipt through as a payment"
  );
});

test("the kind reaches the posting from every path that writes", () => {
  for (const route of ["../app/api/voucher-add/route.js", "../app/api/voucher-alter/route.js"]) {
    const src = read(route);
    assert.ok(/buildVoucherLedgerRows\(\{\s*kind,/.test(src), `${route} posts without a kind`);
    // `posted` rather than `customers`: an `Expense With GST` journal derives
    // its own lines (lib/journalTypes.mjs) and `posted` is whichever set is
    // actually being written -- the derived legs, or the form's lines for
    // every other voucher. Both must reach the balances, or an expense moves
    // the ledger and leaves the party's balance behind.
    assert.ok(
      /buildVoucherBalanceDeltas\(\{\s*kind,\s*acName,\s*customers: posted,?\s*\}\)/.test(src),
      route
    );
  }
});

test("a reversal uses the STORED kind, not the incoming one", () => {
  // A delete has no incoming kind at all, and an edit's incoming kind
  // describes what the voucher is about to become -- not what has to be
  // undone. Reversing a journal as though it had a cash leg leaves its lines
  // standing and the balances wrong.
  const alter = read("../app/api/voucher-alter/route.js");
  assert.ok(/kind: existingVoucher\.kind/.test(alter), "the edit reverses with the wrong kind");
  const remove = read("../app/api/delete-voucher/route.js");
  assert.ok(/kind: voucher\.kind/.test(remove), "the delete reverses without a kind");
});

test("a blank account never reaches the balance recompute", () => {
  // A journal has no acName, and the recompute lists would carry an empty
  // name straight into a lookup for an account nobody has.
  for (const route of ["../app/api/voucher-add/route.js", "../app/api/voucher-alter/route.js"]) {
    const src = read(route);
    const at = src.indexOf("recomputeLedgerBalances(");
    assert.ok(at > 0, `${route} does not recompute`);
    assert.match(src.slice(at, at + 400), /\.filter\(Boolean\)/, route);
  }
});

test("the model keeps the kind optional and the account conditional", () => {
  const src = read("../models/voucherModel.js");
  // Optional, because every entry saved before this has none and nothing
  // backfills one. A default would stamp a guess on the next save.
  assert.ok(/kind: \{/.test(src));
  assert.ok(/enum: VOUCHER_KIND_CODES/.test(src), "the enum must come from the module");
  assert.doesNotMatch(src, /kind: \{[^}]*default:/s, "a default would invent a kind");
  // acName is required for the three kinds that move money, absent for a
  // journal -- so it cannot be a bare `required: true` any more.
  assert.ok(/return this\.kind !== "JOURNAL"/.test(src));
});

test("the form offers them all, and enforces the direction", () => {
  const src = read("../app/voucheradd/page.js");
  // The list comes from the module, so the screen cannot offer a kind the
  // routes would refuse.
  assert.ok(/VOUCHER_KIND_CODES\.map/.test(src), "the kinds are not read from the module");
  assert.ok(/voucherTitle\(kind\)/.test(src), "the heading is not built from the kind");
  // The direction is the kind's: the column the kind forbids is disabled
  // rather than left open for somebody to type a receipt into as a payment.
  //
  // Matched loosely, because the condition has since grown another term --
  // an Expense With GST journal fills both columns itself, so its cells are
  // disabled too. Pinning the whole expression made this test fail the day
  // that landed, for a reason that had nothing to do with the direction.
  assert.ok(/disabled=\{[^}]*spec\.side === "credit"\}/.test(src));
  assert.ok(/disabled=\{[^}]*spec\.side === "debit"\}/.test(src));
  // Cash-or-bank is settable on the form. It used to come only from the URL,
  // so opening /voucheradd without one left it blank -- which the new
  // validation refuses, with nothing on screen to fix it with.
  assert.ok(/setInstrument\(/.test(src));
  // A journal's panel is gone rather than merely ignored, and what is sent
  // is blank for it.
  assert.ok(/\{spec\.needsAccount && \(/.test(src));
  assert.ok(/const acName = spec\.needsAccount \? form\.acName : ""/.test(src));
  // The INSTRUMENT follows the narrower flag, not that one. A credit note
  // has an account but no cash or bank leg, so sending one would have the
  // route refuse it -- and the Cash/Bank toggle has to go with it, or the
  // form shows a choice that does nothing.
  assert.ok(/const paymentType = spec\.needsPaymentType \? instrument : ""/.test(src));
  assert.ok(/\{spec\.needsPaymentType && \(/.test(src), "the instrument toggle is not gated");
  // And the kind reaches the server.
  assert.ok(/body: JSON\.stringify\(\{\s*kind,/.test(src), "the kind is not sent");
});

test("the form checks the same rules before it posts", () => {
  const src = read("../app/voucheradd/page.js");
  assert.ok(/voucherProblems\(\{ kind, acName, paymentType, customers: lines \}\)/.test(src));
  // Its own copy of a rule would be a second answer to "what is a journal".
  assert.doesNotMatch(src, /must balance/i, "the screen is wording its own rule");
});

test("changing the kind moves the figures rather than stranding them", () => {
  // Receipt to Payment is the same amounts the other way, so a figure in the
  // column the new kind forbids is carried across. Left where it was, the
  // save would refuse a voucher that looks right on screen.
  const src = read("../app/voucheradd/page.js");
  assert.ok(/const changeKind = \(next\)/.test(src));
  assert.ok(/to\.side === "debit" \? String\(amount/.test(src));
  // The adjustments DO go: the direction decides which bills are eligible.
  assert.ok(/allocations: \[\]/.test(src));
  // And an account is kept only while the new kind draws one from the same
  // place: a journal has no leg at all, and switching a receipt to a credit
  // note would otherwise leave "Cash" as the head the note books against.
  assert.ok(
    /acName: to\.needsAccount && to\.needsPaymentType === from\.needsPaymentType \? prev\.acName : ""/.test(src),
    "an account survives a switch between kinds that choose it differently"
  );
  assert.ok(/const from = spec;/.test(src), "the kind being left is not read");
});

test("the voucher's date can be set, on every kind", () => {
  const src = read("../app/voucheradd/page.js");

  // It was always held in `form.date` and always sent -- there was simply
  // no control for it, so every entry was dated the day it was typed and
  // nothing could be backdated.
  assert.ok(/id="voucher-date"/.test(src), "there is no date field");
  assert.ok(/type="date"[\s\S]{0,120}name="date"/.test(src), "it is not a date input");
  assert.ok(/value=\{form\.date\}/.test(src), "the field is not bound to the form");
  assert.ok(/date: form\.date/.test(src), "the chosen date is not sent");

  // Today IN INDIA. A host in UTC would date an evening voucher yesterday
  // -- lib/istDate.mjs exists for that.
  assert.ok(/date: todayIst\(\)/.test(src), "the default is not read in IST");

  // Not gated by the kind: a journal has no account panel, so a date field
  // tucked inside one would be missing from the entry that most often
  // needs backdating.
  const at = src.indexOf('id="voucher-date"');
  const around = src.slice(Math.max(0, at - 400), at + 200);
  assert.doesNotMatch(around, /spec\./, "the date field is hidden for some kinds");

  // And a voucher opened for editing shows its own date, not today's.
  assert.ok(/date:\s*\n?\s*voucher\.date\?\.slice\(0, 10\)/.test(src), "a loaded date is not kept");
});

test("a note picks its head from everything except the till", () => {
  const src = read("../app/voucheradd/page.js");
  // Offering cash or bank there would let a credit note take money out of
  // the drawer, which is a payment wearing a note's name.
  assert.ok(/customersNotInGroups\(customers, \["cash", "bank"\]\)/.test(src));
  assert.ok(/const accountChoices = spec\.needsPaymentType/.test(src));
});

test("a loaded voucher keeps its own kind", () => {
  const src = read("../app/voucheradd/page.js");
  // Stored, or read off the figures for an entry saved before the kinds.
  assert.ok(/setKind\(kindOf\(voucher\)\.code\)/.test(src));
  // A ?kind= in the URL must not re-post an existing voucher as something
  // else, so the deep link applies only to a new one.
  const at = src.indexOf("if (voucherParams.value) return;");
  assert.ok(at > 0, "the URL kind is applied even to a loaded voucher");
});

test("the day book can say which kind wrote a row", () => {
  // It reads ledger ROWS and never opens the voucher, so the kind is copied
  // onto the row -- and has to be declared, or strict mode drops it.
  assert.ok(/voucherKind: \{/.test(read("../models/ledgerModel.js")));
  assert.ok(/voucherKind: spec\.code/.test(read("../lib/voucherLedger.mjs")));

  // The register used to read VOUCHER_KINDS itself, which named the four
  // money vouchers and left every invoice blank. It now goes through
  // lib/ledgerTypes.mjs, which reads the same `voucherKind` first and falls
  // back to the invoice's `docType` -- so a receipt is still named a
  // Receipt, and a sales invoice is named too. The invoice half of that is
  // tested in scripts/ledger-types.test.mjs; what matters here is that the
  // kind written above still reaches the page.
  const page = read("../app/voucher/page.js");
  assert.ok(/ledgerRowType/.test(page), "the day book no longer names the kind at all");
  assert.ok(/entry\.type\.label/.test(page), "the kind is read but never shown");

  // Still never a guessed kind presented as a stored one: a reading is
  // marked as a reading.
  assert.doesNotMatch(page, /voucherKind.*\?\?\s*'RECEIPT'/, "a guessed kind in the day book");
  assert.ok(/entry\.type\.inferred/.test(page), "a reading is not marked as one");
});

test("all four are reachable from the dashboard, and counted once", () => {
  const src = read("../app/page.js");
  assert.ok(/kind=JOURNAL/.test(src), "a journal cannot be started");
  assert.ok(/kind=CONTRA/.test(src), "a contra cannot be started");
  // A contra carries a cash or bank paymentType like a receipt does, so the
  // instrument lists have to exclude it or every one is counted twice.
  assert.ok(/codeOf\(v\) !== 'CONTRA'/.test(src), "contras are double-counted");
  // And both are editable and deletable, or they are write-only.
  assert.ok(/case 'Journal':\s*\n\s*case 'Contra':/.test(src));
});

test("the modules stay pure", () => {
  for (const file of ["../lib/voucherKinds.mjs", "../lib/voucherLedger.mjs"]) {
    const src = read(file);
    assert.doesNotMatch(src, /from\s+["']react["']/, file);
    assert.doesNotMatch(src, /from\s+["']mongoose["']/, file);
    assert.doesNotMatch(src, /from\s+["'][^"']*models\//, file);
  }
});

test("the Sigfa claim is a quotation, and the rest is marked as ours", () => {
  // Every other Sigfa statement in this project is read out of the binary.
  // The only thing known about its money vouchers is the CA/BA line already
  // recorded in stockVoucher; the four names here are a design decision, and
  // the module has to say so rather than let a later reader take them for a
  // finding.
  const src = read("../lib/voucherKinds.mjs");
  assert.ok(/'CA' Cash and 'BA' Bank/.test(src), "the one quotation is not carried");
  assert.ok(/NOT SIGFA'S/.test(src), "the invented names are not marked as ours");
});

test("the dashboard lists and opens a journal or contra by name and id, not as a bill", () => {
  // They used to fall through to the bill branch, which names and opens by
  // `invoiceNo` -- a field no voucher has -- so the Alter list showed a
  // blank row that opened nothing (found on an Expense With GST journal).
  const src = read("../app/page.js");
  const named = src.slice(src.indexOf("const isNamed"), src.indexOf("const billLabel"));
  for (const section of ["Bank", "Cash", "Journal", "Contra"]) {
    assert.match(named, new RegExp(`sectionName === '${section}'`), `${section} is not a named section`);
  }
});

console.log(`\n  ${passed} checks passed\n`);
