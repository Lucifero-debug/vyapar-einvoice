'use client'

/**
 * Why a saved invoice is frozen, shown where the user is about to try to
 * change it.
 *
 * Once an invoice has been reported to the IRP, `sale-alter` and
 * `delete-invoice` refuse it with a 409. This is the same message, in front of
 * the Save button instead of behind it: the point is that nobody retypes a
 * whole bill before being told it was never going to be accepted.
 *
 * The sentence comes from `editBlockedReason()` in lib/einvoiceLock.mjs, so
 * the screen and the server can never word the rule differently. It carries
 * the IRN, which is the thing worth quoting to a CA or to the portal, hence
 * `break-words` -- an IRN is 64 characters and will not fit on a phone.
 */
export default function EinvoiceLockNotice({ reason, className = '' }) {
  if (!reason) return null

  return (
    <div
      role="alert"
      className={`mb-3 break-words rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-sm leading-snug text-foreground ${className}`.trim()}
    >
      <span className="font-semibold">E-invoice locked.</span> {reason}
    </div>
  )
}
