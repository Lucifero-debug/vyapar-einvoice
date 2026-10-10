/**
 * Fixture tests for the e-invoice edit lock.
 *
 *   node scripts/einvoice-lock.test.mjs
 *
 * This is the module that stands between a user and silently editing an
 * invoice the government already holds a signed copy of. Two kinds of mistake
 * matter here and they fail in opposite directions:
 *
 *   1. Freezing too little -- a reported invoice that stays editable. The books
 *      and the IRP's copy then disagree, and nobody finds out until a buyer
 *      claims credit against the version we no longer have.
 *
 *   2. Freezing too much -- an invoice with no IRN, or one properly cancelled,
 *      that refuses to be corrected. That one is merely infuriating, but it is
 *      the one a nervous "block everything" edit introduces.
 *
 * The 24-hour window is tested to the minute and across month, leap-day and
 * year boundaries, because the arithmetic that gets this wrong is exactly the
 * arithmetic that looks right in October.
 */

// Deliberately NOT a timezone anywhere near India: the deadline shown to the
// user must be IST whatever the server's clock is set to, and this is what
// catches a rewrite that formats in local time.
process.env.TZ = "America/Los_Angeles";

import assert from "node:assert/strict";
import {
  CANCEL_WINDOW_MS,
  LOCKED_STATUS,
  cancelDeadline,
  cancelWindowOpen,
  deleteBlockedReason,
  editBlockedReason,
  formatIst,
  hasIrn,
  isCancelled,
} from "../lib/einvoiceLock.mjs";

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

const IRN = "a".repeat(64);

/** An invoice as Mongoose hands it back, with whatever e-invoice state. */
const invoice = (over = {}) => ({
  invoiceNo: 5,
  type: "sale",
  finalAmount: 1180,
  ...over,
});

const reported = (over = {}) =>
  invoice({
    irn: IRN,
    ackNo: "112010000000123",
    ackDt: new Date(Date.UTC(2026, 9, 8, 10, 12)), // 8 Oct 2026, 3:42 pm IST
    einvoiceStatus: "generated",
    ...over,
  });

console.log("\n--- a reported invoice freezes ---");

test("an invoice with an IRN cannot be edited", () => {
  const reason = editBlockedReason(reported(), Date.UTC(2026, 9, 8, 11, 0));
  assert.ok(reason, "a reported invoice must be blocked");
  assert.match(reason, /cannot be edited/);
});

test("the reason names the invoice and the IRN to quote", () => {
  const reason = editBlockedReason(reported(), Date.UTC(2026, 9, 8, 11, 0));
  assert.match(reason, /Invoice 5/);
  assert.ok(reason.includes(IRN), "the IRN itself has to be in the message");
});

test("it stays frozen whatever the status says, as long as an IRN exists", () => {
  // `generated` is the normal case; the others are rows left behind by a
  // half-finished call. An IRN exists, so the IRP has it, so it freezes.
  for (const einvoiceStatus of ["generated", "failed", "none", undefined]) {
    assert.ok(
      editBlockedReason(reported({ einvoiceStatus }), Date.UTC(2026, 9, 8, 11, 0)),
      `status ${String(einvoiceStatus)} must still freeze the row`
    );
  }
});

test("deleting is blocked too, and says so in its own words", () => {
  const reason = deleteBlockedReason(reported(), Date.UTC(2026, 9, 8, 11, 0));
  assert.match(reason, /cannot be deleted/);
  assert.doesNotMatch(reason, /cannot be edited/);
});

test("an invoice with no number still produces a sentence", () => {
  const reason = editBlockedReason(
    reported({ invoiceNo: undefined }),
    Date.UTC(2026, 9, 8, 11, 0)
  );
  assert.match(reason, /^This invoice has been reported/);
  assert.doesNotMatch(reason, /undefined/);
});

console.log("\n--- everything else stays editable ---");

test("an invoice that was never reported is not blocked", () => {
  assert.equal(editBlockedReason(invoice()), null);
  assert.equal(deleteBlockedReason(invoice()), null);
});

test("an empty or blank IRN is no IRN", () => {
  for (const irn of ["", "   ", null, undefined]) {
    assert.equal(editBlockedReason(invoice({ irn })), null, `irn ${JSON.stringify(irn)}`);
    assert.equal(hasIrn(invoice({ irn })), false);
  }
});

test("a cancelled e-invoice is editable again", () => {
  const row = reported({
    einvoiceStatus: "cancelled",
    einvoiceCancelledAt: new Date(Date.UTC(2026, 9, 8, 11, 0)),
  });
  assert.equal(editBlockedReason(row, Date.UTC(2026, 9, 9, 0, 0)), null);
  assert.equal(deleteBlockedReason(row, Date.UTC(2026, 9, 9, 0, 0)), null);
});

test("the status is matched whatever case it is stored in", () => {
  assert.equal(isCancelled(reported({ einvoiceStatus: "CANCELLED" })), true);
  assert.equal(isCancelled(reported({ einvoiceStatus: "Cancelled" })), true);
  assert.equal(isCancelled(reported()), false);
});

test("a cancellation timestamp alone does NOT unfreeze the row", () => {
  // A cancel that wrote its timestamp and then failed before writing the
  // status is a cancel that may never have reached the IRP. Staying frozen is
  // the safe side of that doubt.
  const halfDone = reported({
    einvoiceCancelledAt: new Date(Date.UTC(2026, 9, 8, 11, 0)),
  });
  assert.ok(editBlockedReason(halfDone, Date.UTC(2026, 9, 8, 12, 0)));
});

test("nothing throws on the shapes a route can actually be handed", () => {
  for (const row of [null, undefined, {}, { irn: 5 }, { irn: {} }]) {
    assert.equal(editBlockedReason(row), null);
    assert.equal(cancelWindowOpen(row), false);
    assert.equal(cancelDeadline(row), null);
  }
});

console.log("\n--- the 24-hour window, to the minute ---");

// 31 Jan 2026, 11:30 pm IST -> the window shuts on 1 Feb, 11:30 pm IST.
const MONTH_END_ACK = Date.UTC(2026, 0, 31, 18, 0);

test("the window is exactly twenty-four hours long", () => {
  assert.equal(CANCEL_WINDOW_MS, 86400000);
  assert.equal(
    cancelDeadline(reported({ ackDt: new Date(MONTH_END_ACK) })),
    MONTH_END_ACK + CANCEL_WINDOW_MS
  );
});

test("it is open a minute before the deadline and shut at it", () => {
  const row = reported({ ackDt: new Date(MONTH_END_ACK) });
  const deadline = MONTH_END_ACK + CANCEL_WINDOW_MS;
  assert.equal(cancelWindowOpen(row, deadline - 60_000), true, "one minute left");
  assert.equal(cancelWindowOpen(row, deadline - 1), true, "one millisecond left");
  assert.equal(cancelWindowOpen(row, deadline), false, "the 24-hour mark is over");
  assert.equal(cancelWindowOpen(row, deadline + 1), false, "past it");
});

test("it is open at the moment of acknowledgement", () => {
  const row = reported({ ackDt: new Date(MONTH_END_ACK) });
  assert.equal(cancelWindowOpen(row, MONTH_END_ACK), true);
});

test("the deadline lands on the next calendar day across a month end", () => {
  const row = reported({ ackDt: new Date(MONTH_END_ACK) });
  assert.equal(formatIst(cancelDeadline(row)), "1 Feb 2026, 11:30 pm IST");
});

test("and across a leap day, a non-leap February and a year end", () => {
  const cases = [
    [Date.UTC(2024, 1, 28, 18, 0), "29 Feb 2024, 11:30 pm IST"],
    [Date.UTC(2026, 1, 28, 18, 0), "1 Mar 2026, 11:30 pm IST"],
    [Date.UTC(2025, 11, 31, 18, 0), "1 Jan 2026, 11:30 pm IST"],
  ];
  for (const [ack, expected] of cases) {
    const row = reported({ ackDt: new Date(ack) });
    assert.equal(formatIst(cancelDeadline(row)), expected);
    assert.equal(cancelWindowOpen(row, ack + CANCEL_WINDOW_MS - 1), true);
    assert.equal(cancelWindowOpen(row, ack + CANCEL_WINDOW_MS), false);
  }
});

test("the message switches from 'cancel by' to 'window closed'", () => {
  const row = reported();
  const deadline = cancelDeadline(row);
  const open = editBlockedReason(row, deadline - 1);
  assert.match(open, /Cancel the e-invoice before 9 Oct 2026, 3:42 pm IST/);
  const shut = editBlockedReason(row, deadline);
  assert.match(shut, /window closed on 9 Oct 2026, 3:42 pm IST/);
  assert.match(shut, /credit note/);
});

test("with no acknowledgement date it refuses to invent a deadline", () => {
  for (const ackDt of [undefined, null, "", "not a date"]) {
    const row = reported({ ackDt });
    assert.equal(cancelDeadline(row), null);
    assert.equal(cancelWindowOpen(row), false);
    const reason = editBlockedReason(row);
    assert.match(reason, /within 24 hours of reporting it/);
    assert.doesNotMatch(reason, /Invalid Date|NaN|null/);
  }
});

test("an unreported invoice has no cancellation window, date or not", () => {
  // An ordinary invoice can carry a date in `ackDt` only by accident, but if
  // one does there is still nothing at the IRP to cancel, so there is no
  // window -- and no "cancel by" line to put in front of a user.
  const row = invoice({ ackDt: new Date(Date.UTC(2026, 9, 8, 10, 12)) });
  assert.equal(cancelDeadline(row), null);
  assert.equal(cancelWindowOpen(row, Date.UTC(2026, 9, 8, 11, 0)), false);
});

test("a cancelled invoice has no window left to be open", () => {
  const row = reported({ einvoiceStatus: "cancelled" });
  assert.equal(cancelWindowOpen(row, cancelDeadline(row) - 1), false);
});

test("ackDt is accepted as a Date, an ISO string or epoch milliseconds", () => {
  const ms = Date.UTC(2026, 9, 8, 10, 12);
  const asDate = cancelDeadline(reported({ ackDt: new Date(ms) }));
  assert.equal(cancelDeadline(reported({ ackDt: new Date(ms).toISOString() })), asDate);
  assert.equal(cancelDeadline(reported({ ackDt: ms })), asDate);
});

test("`now` may be a Date as well as a number", () => {
  const row = reported();
  const deadline = cancelDeadline(row);
  assert.equal(cancelWindowOpen(row, new Date(deadline - 1)), true);
  assert.equal(cancelWindowOpen(row, new Date(deadline)), false);
});

console.log("\n--- the deadline is written in IST ---");

test("the time is India's, not the server's", () => {
  // The process is on US Pacific time (set at the top of this file). 10:12 UTC
  // is 3:42 pm in Delhi and 3:12 am in California; the user is in Delhi.
  assert.equal(formatIst(Date.UTC(2026, 9, 8, 10, 12)), "8 Oct 2026, 3:42 pm IST");
});

test("midnight and noon are 12, not 0", () => {
  assert.equal(formatIst(Date.UTC(2026, 9, 7, 18, 30)), "8 Oct 2026, 12:00 am IST");
  assert.equal(formatIst(Date.UTC(2026, 9, 8, 6, 30)), "8 Oct 2026, 12:00 pm IST");
});

test("the half-hour offset is applied, not a whole hour", () => {
  // The bug this catches is +5:00 or +6:00 instead of +5:30.
  assert.equal(formatIst(Date.UTC(2026, 9, 8, 18, 45)), "9 Oct 2026, 12:15 am IST");
});

test("an unusable date formats as nothing rather than 'Invalid Date'", () => {
  for (const value of [null, undefined, "", "tomorrow", new Date("nope"), NaN]) {
    assert.equal(formatIst(value), null, JSON.stringify(String(value)));
  }
});

console.log("\n--- the routes' side of the contract ---");

test("the blocked status is 409, not 400 or 500", () => {
  // 409 Conflict: the request is well formed, the row's state refuses it.
  assert.equal(LOCKED_STATUS, 409);
});

console.log(`\n${passed} checks passed.\n`);
