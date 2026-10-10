/**
 * When a saved invoice may no longer be changed.
 *
 * Once an invoice has been reported to the IRP, the government holds a signed
 * copy of it. Editing or deleting our row after that point does not change
 * theirs -- it just makes the two disagree, quietly, with no way to tell which
 * one the buyer will claim credit against. So the row freezes.
 *
 * The only ways out are the two the law gives you:
 *
 *   - cancel the e-invoice, which is allowed for 24 hours after the IRP
 *     acknowledged it and not a minute longer, or
 *   - leave it alone and raise a credit note.
 *
 * Pure on purpose -- nothing here reads the database or the network, and its
 * one import is another pure module -- so `middleware.js` at the edge, a
 * `'use client'` page and a bare `node` test can all use it. See
 * PROJECT_CONTEXT.md section 6.
 */

/** The IRP's cancellation window. Fixed by the rules, not by us. */
export const CANCEL_WINDOW_MS = 24 * 60 * 60 * 1000;

/** What the routes return when a frozen invoice is edited or deleted. */
export const LOCKED_STATUS = 409;

/* ------------------------------------------------------------------ dates -- */

// Every date here is read in IST, by one implementation, in lib/istDate.mjs:
// a deadline shown in the server's own timezone would be five and a half
// hours wrong for the only people who use this.
import { formatIst as formatIstDate, toEpoch } from "./istDate.mjs";

/** Re-exported so a page showing a deadline uses the same wording. */
export const formatIst = formatIstDate;

/* ------------------------------------------------------------------- state -- */

/** Has this invoice been reported to the IRP? */
export const hasIrn = (invoice) =>
  typeof invoice?.irn === "string" && invoice.irn.trim() !== "";

/**
 * Has the e-invoice been cancelled at the IRP?
 *
 * The stored status only, never `einvoiceCancelledAt` as a fallback. A row
 * that has a cancellation timestamp but no cancelled status is a cancel attempt
 * that did not finish, and unfreezing an invoice the IRP still holds is the one
 * mistake this module exists to prevent.
 */
export const isCancelled = (invoice) =>
  String(invoice?.einvoiceStatus || "").toLowerCase() === "cancelled";

/** The instant the cancellation window shuts, or null when there is none. */
export const cancelDeadline = (invoice) => {
  const ack = toEpoch(invoice?.ackDt);
  if (!hasIrn(invoice) || ack === null) return null;
  return ack + CANCEL_WINDOW_MS;
};

/**
 * Is the 24-hour cancellation window still open?
 *
 * False once it has shut, and false for an invoice with nothing to cancel --
 * one never reported, one already cancelled, or one whose acknowledgement date
 * is missing, because a window we cannot date is not a window we may assume.
 */
export const cancelWindowOpen = (invoice, now = Date.now()) => {
  if (isCancelled(invoice)) return false;
  const deadline = cancelDeadline(invoice);
  if (deadline === null) return false;
  // Strictly before: "within 24 hours" is over at the 24-hour mark itself.
  return (toEpoch(now) ?? Date.now()) < deadline;
};

/* ------------------------------------------------------------------ reason -- */

const blockedReason = (invoice, verb, now) => {
  if (!hasIrn(invoice)) return null;
  // A cancelled e-invoice is one the IRP no longer holds against this number,
  // so the row is ours to correct again.
  if (isCancelled(invoice)) return null;

  const label =
    invoice.invoiceNo === null || invoice.invoiceNo === undefined
      ? "This invoice"
      : `Invoice ${invoice.invoiceNo}`;
  const head = `${label} has been reported to the IRP (IRN ${invoice.irn.trim()}). It cannot be ${verb}.`;

  const deadline = cancelDeadline(invoice);
  if (deadline === null) {
    // Reported, but we did not keep the acknowledgement date, so we cannot say
    // how long is left. Do not guess it for them.
    return `${head} Cancel the e-invoice within 24 hours of reporting it, or raise a credit note.`;
  }
  if (cancelWindowOpen(invoice, now)) {
    return `${head} Cancel the e-invoice before ${formatIst(deadline)}, or raise a credit note.`;
  }
  return `${head} The 24-hour cancellation window closed on ${formatIst(deadline)}. Raise a credit note instead.`;
};

/**
 * Why this invoice may not be edited, or null when it may.
 *
 * The string is written to be shown to the user as it stands: it names the
 * invoice, the IRN to quote, and the one thing they can still do about it.
 */
export const editBlockedReason = (invoice, now = Date.now()) =>
  blockedReason(invoice, "edited", now);

/** Why this invoice may not be deleted, or null when it may. */
export const deleteBlockedReason = (invoice, now = Date.now()) =>
  blockedReason(invoice, "deleted", now);
