/**
 * Fixture tests for the voucher ledger rebuild plan.
 *
 *   node scripts/rebuild-voucher-ledger.test.mjs
 */

import assert from "node:assert/strict";
import { planRebuild, diagnoseRow } from "./rebuild-voucher-ledger.mjs";

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  }
};

const VOUCHER = {
  _id: "voucher1",
  acName: "Cash",
  date: "2026-09-20",
  paymentType: "Receipt",
  narration: "Weekly collections",
  customers: [{ name: "Asha Traders", debit: 0, credit: 2000, narration: "" }],
};

/** The rows the current builder produces for VOUCHER. */
const goodRows = () => [
  {
    customerName: "Asha Traders",
    date: VOUCHER.date,
    account: "Cash",
    paymentType: "Receipt",
    debit: 0,
    credit: 2000,
    narration: "Against Cash",
    voucherId: "voucher1",
  },
  {
    customerName: "Cash",
    date: VOUCHER.date,
    account: "Receipt",
    paymentType: "Receipt",
    debit: 2000,
    credit: 0,
    narration: "Weekly collections",
    voucherId: "voucher1",
  },
];

/** The rows voucher-alter used to hand-roll. */
const legacyRows = () => [
  {
    account: "Asha Traders",
    type: "customer",
    date: VOUCHER.date,
    debit: 0,
    credit: 2000,
    narration: "Voucher update via Cash",
    voucherId: "voucher1",
  },
  {
    account: "Cash",
    type: "Receipt",
    date: VOUCHER.date,
    debit: 2000,
    credit: 0,
    narration: "Voucher update for Asha Traders",
    voucherId: "voucher1",
  },
];

console.log("\n--- invoice rows must never be touched ---");

test("a ledger row whose voucherId is an Invoice _id is out of scope", () => {
  const invoiceRow = {
    customerName: "Asha Traders",
    account: "Sales Account",
    debit: 5000,
    credit: 0,
    narration: "By Invoice No: 41",
    voucherId: "invoice_abc", // an Invoice _id, not a Voucher
  };
  const r = planRebuild({
    allVouchers: [VOUCHER],
    allLedgers: [...goodRows(), invoiceRow],
  });
  assert.equal(r.counts.untouchedRows, 1);
  assert.equal(r.counts.ownedRows, 2);
  // and it never appears in anything the plan would delete
  for (const p of r.plan) {
    assert.ok(!p.existing.some((row) => row.voucherId === "invoice_abc"));
  }
});

test("invoice rows are never deleted even when the voucher is rebuilt", () => {
  const invoiceRow = { customerName: "X", voucherId: "invoice_abc", debit: 1 };
  const r = planRebuild({
    allVouchers: [VOUCHER],
    allLedgers: [...legacyRows(), invoiceRow],
  });
  assert.equal(r.plan.length, 1, "the malformed voucher is in the plan");
  const doomed = r.plan.flatMap((p) => p.existing);
  assert.equal(doomed.length, 2, "only the voucher's own rows");
  assert.ok(!doomed.includes(invoiceRow));
});

test("rows with no voucherId at all are out of scope", () => {
  const r = planRebuild({
    allVouchers: [VOUCHER],
    allLedgers: [...goodRows(), { customerName: "Y", debit: 10 }],
  });
  assert.equal(r.counts.untouchedRows, 1);
  assert.equal(r.counts.orphanedRows, 0, "no voucherId is not an orphan");
});

test("a voucherId pointing at a deleted voucher is reported, not deleted", () => {
  const stray = { customerName: "Z", voucherId: "gone_forever", debit: 5 };
  const r = planRebuild({ allVouchers: [VOUCHER], allLedgers: [...goodRows(), stray] });
  assert.equal(r.counts.orphanedRows, 1);
  assert.ok(!r.plan.flatMap((p) => p.existing).includes(stray));
});

console.log("\n--- detecting the legacy shape ---");

test("missing customerName is flagged", () => {
  assert.ok(diagnoseRow(legacyRows()[0], VOUCHER).includes("no customerName"));
});

test("a stray `type` field is flagged", () => {
  assert.ok(
    diagnoseRow(legacyRows()[0], VOUCHER).includes("stray `type` field")
  );
});

test("a row booked against itself is flagged", () => {
  const row = { customerName: "Asha Traders", account: "Asha Traders" };
  assert.ok(diagnoseRow(row, VOUCHER).includes("booked against itself"));
});

test("a party row on the wrong side is flagged", () => {
  const row = { ...goodRows()[0], debit: 2000, credit: 0 };
  assert.ok(
    diagnoseRow(row, VOUCHER).includes("side does not match the voucher line")
  );
});

test("well-formed rows produce no complaints", () => {
  for (const row of goodRows()) {
    assert.deepEqual(diagnoseRow(row, VOUCHER), []);
  }
});

console.log("\n--- planning ---");

test("a voucher with correct rows is left out of the plan", () => {
  const r = planRebuild({ allVouchers: [VOUCHER], allLedgers: goodRows() });
  assert.equal(r.plan.length, 0);
});

test("a voucher with legacy rows is planned for rebuild", () => {
  const r = planRebuild({ allVouchers: [VOUCHER], allLedgers: legacyRows() });
  assert.equal(r.plan.length, 1);
  assert.equal(r.plan[0].existing.length, 2);
  assert.equal(r.plan[0].rebuilt.length, 2);
});

test("a voucher with no rows at all is planned", () => {
  const r = planRebuild({ allVouchers: [VOUCHER], allLedgers: [] });
  assert.equal(r.plan.length, 1);
  assert.ok(r.plan[0].problems.includes("no ledger rows at all"));
});

test("the duplicated main-account rows of a multi-party edit are caught", () => {
  // The old code wrote 2 rows per party; the builder writes parties + 1.
  const twoParty = {
    ...VOUCHER,
    customers: [
      { name: "A", debit: 0, credit: 100 },
      { name: "B", debit: 0, credit: 200 },
    ],
  };
  const r = planRebuild({
    allVouchers: [twoParty],
    allLedgers: Array.from({ length: 4 }, () => ({
      account: "A",
      type: "customer",
      voucherId: "voucher1",
      debit: 0,
      credit: 100,
    })),
  });
  assert.equal(r.plan.length, 1);
  assert.equal(r.plan[0].rebuilt.length, 3, "2 parties + 1 main row");
});

test("--all plans every voucher, even correct ones", () => {
  const r = planRebuild({
    allVouchers: [VOUCHER],
    allLedgers: goodRows(),
    rebuildAll: true,
  });
  assert.equal(r.plan.length, 1);
  assert.equal(r.plan[0].problems.length, 0);
});

console.log("\n--- rebuilt output ---");

test("rebuilt rows carry the voucher's id", () => {
  const r = planRebuild({ allVouchers: [VOUCHER], allLedgers: legacyRows() });
  for (const row of r.plan[0].rebuilt) {
    assert.equal(row.voucherId, "voucher1");
  }
});

test("rebuilt rows are the well-formed shape", () => {
  const r = planRebuild({ allVouchers: [VOUCHER], allLedgers: legacyRows() });
  for (const row of r.plan[0].rebuilt) {
    assert.deepEqual(diagnoseRow(row, VOUCHER), []);
  }
});

test("rebuilding is idempotent — a second pass finds nothing", () => {
  const first = planRebuild({ allVouchers: [VOUCHER], allLedgers: legacyRows() });
  const second = planRebuild({
    allVouchers: [VOUCHER],
    allLedgers: first.plan[0].rebuilt,
  });
  assert.equal(second.plan.length, 0);
});

test("vouchers with no stored narration are counted", () => {
  const r = planRebuild({
    allVouchers: [{ ...VOUCHER, narration: undefined }],
    allLedgers: legacyRows(),
  });
  assert.equal(r.narrationLost, 1);
  assert.equal(r.plan[0].rebuilt.at(-1).narration, "Main account entry");
});

console.log(
  process.exitCode
    ? "\nSome assertions failed.\n"
    : `\n${passed} assertions passed.\n`
);
