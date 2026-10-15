/**
 * The four money vouchers: Receipt, Payment, Journal and Contra.
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

console.log("\n--- the four kinds ---");

test("there are four, in the order a menu should offer them", () => {
  assert.deepEqual(VOUCHER_KIND_CODES, ["RECEIPT", "PAYMENT", "JOURNAL", "CONTRA"]);
  for (const code of VOUCHER_KIND_CODES) {
    assert.equal(VOUCHER_KINDS[code].code, code, `${code} disagrees with its key`);
    assert.ok(VOUCHER_KINDS[code].label, `${code} has no label`);
  }
});

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

test("the form offers the four, and enforces the direction", () => {
  const src = read("../app/voucheradd/page.js");
  // The list comes from the module, so the screen cannot offer a kind the
  // routes would refuse.
  assert.ok(/VOUCHER_KIND_CODES\.map/.test(src), "the kinds are not read from the module");
  assert.ok(/voucherTitle\(kind\)/.test(src), "the heading is not built from the kind");
  // The direction is the kind's: the column the kind forbids is disabled
  // rather than left open for somebody to type a receipt into as a payment.
  assert.ok(/disabled=\{spec\.side === "credit"\}/.test(src));
  assert.ok(/disabled=\{spec\.side === "debit"\}/.test(src));
  // Cash-or-bank is settable on the form. It used to come only from the URL,
  // so opening /voucheradd without one left it blank -- which the new
  // validation refuses, with nothing on screen to fix it with.
  assert.ok(/setInstrument\(/.test(src));
  // A journal's panel is gone rather than merely ignored, and what is sent
  // is blank for it.
  assert.ok(/\{spec\.needsAccount && \(/.test(src));
  assert.ok(/const acName = spec\.needsAccount \? form\.acName : ""/.test(src));
  assert.ok(/const paymentType = spec\.needsAccount \? instrument : ""/.test(src));
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
  // And a journal cannot keep a cash account it no longer has a leg for.
  assert.ok(/acName: to\.needsAccount \? prev\.acName : ""/.test(src));
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
  const page = read("../app/voucher/page.js");
  assert.ok(/VOUCHER_KINDS\[rows\[0\]\.voucherKind\]\?\.label \|\| ''/.test(page));
  // An invoice's rows have no voucher behind them, so a day book says
  // nothing there rather than guessing a kind.
  assert.doesNotMatch(page, /voucherKind.*\?\?\s*'RECEIPT'/, "a guessed kind in the day book");
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

console.log(`\n  ${passed} checks passed\n`);
