'use client';

/**
 * Send this bill to the customer.
 *
 * A dialog rather than a bare button, for one reason: the address on a
 * party's master is a good DEFAULT and a bad rule. A shop emails a bill to
 * whoever asked for it — an accounts department, a purchase officer, the
 * customer's CA — and the master holds one address. So it is offered,
 * editable, with a Cc, and nothing is written back to the master.
 *
 * It replaces a `sendInvoice()` that was never rendered (so the feature was
 * unreachable) and that, finding no address on the bill, alerted "add one
 * under Customers, then try again" — a dead end in the middle of something
 * else.
 *
 * Every rule about who, what it says and what is wrong with the request lives
 * in `lib/invoiceEmail.mjs`, which the ROUTE checks too. This dialog's checks
 * are the quick answer; the route's are the rule.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  MAX_RECIPIENTS,
  attachmentName,
  defaultMessage,
  defaultSubject,
  parseAddresses,
  recipientFor,
  sendProblem,
  sentSummary,
} from '@/lib/invoiceEmail.mjs';

export default function EmailInvoiceDialog({
  invoice,
  company,
  // The party's master row, when the caller has it — the fallback address for
  // a bill raised before the snapshot carried an email.
  party = null,
  // Returns the base64 PDF (without the data: prefix), or null.
  makePdf,
  onClose,
  // Called with the route's reply after a successful send, so the page can
  // show the new "Emailed to…" line without refetching.
  onSent,
}) {
  const suggested = useMemo(() => recipientFor(invoice, party), [invoice, party]);

  const [to, setTo] = useState(suggested.to);
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState(() => defaultSubject(invoice, company));
  const [message, setMessage] = useState(() => defaultMessage(invoice, company));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(null);

  const firstField = useRef(null);
  useEffect(() => {
    firstField.current?.focus();
    // Select the whole address, so a different one can be typed straight over
    // it — the commonest thing to do here.
    firstField.current?.select?.();
  }, []);

  const history = sentSummary(invoice);
  const file = attachmentName(invoice);
  const recipients = parseAddresses(to);
  const copies = parseAddresses(cc);
  const count = recipients.valid.length + copies.valid.length;

  // The same function the route uses, minus the attachment — which does not
  // exist until Send is pressed, because rendering the PDF takes a moment and
  // doing it on every keystroke would make the dialog crawl.
  const problem = sendProblem({ to, cc, subject, pdfBase64: 'placeholder' });

  const send = async () => {
    setError('');
    setSending(true);
    try {
      const dataUrl = await makePdf?.();
      if (!dataUrl) {
        setError('The bill could not be turned into a PDF. Try Print instead.');
        return;
      }

      const res = await fetch('/api/send-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // The route loads the bill by this number and names the attachment
          // from it — see the note atop the route.
          invoiceNo: invoice?.invoiceNo,
          to,
          cc,
          subject,
          message,
          pdfBase64: String(dataUrl).split(',')[1],
        }),
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok || !body.success) {
        setError(body.error || 'The bill could not be sent.');
        return;
      }

      setSent(body);
      onSent?.(body);
    } catch (err) {
      setError('Could not reach the server.');
    } finally {
      setSending(false);
    }
  };

  // ── sent ────────────────────────────────────────────────────────────
  if (sent) {
    return (
      <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Bill sent">
        <div className="modal-card max-w-md">
          <div className="modal-title">Sent</div>
          <p className="text-sm">{sent.message}</p>
          {sent.logged === false ? (
            <p className="field-hint mt-2 text-destructive">
              The mail has gone, but it could not be recorded against the bill — so the
              &ldquo;emailed&rdquo; note below the invoice will not show it.
            </p>
          ) : null}
          <div className="mt-5 flex justify-end">
            <button type="button" className="btn btn-primary" onClick={() => onClose?.()}>
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── the form ────────────────────────────────────────────────────────
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Email this bill">
      <form
        className="modal-card max-w-lg"
        onSubmit={(event) => {
          event.preventDefault();
          if (!problem && !sending) send();
        }}
        // Escape closes, as it does everywhere else in the app.
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose?.();
          }
        }}
      >
        <div className="modal-title">Email this bill</div>

        {history ? <p className="field-hint mb-3">{history}</p> : null}

        <div className="field">
          <label className="field-label" htmlFor="email-to">
            To
          </label>
          <input
            id="email-to"
            ref={firstField}
            type="text"
            className="field-input mt-1.5"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="accounts@customer.in"
            autoComplete="off"
          />
          <p className="field-hint">
            {suggested.source === 'none'
              ? `No email address on file for ${invoice?.customer?.name || 'this customer'} — type one. It is not saved to their master.`
              : `From ${suggested.note}. Change it freely; it is not saved back to their master.`}
          </p>
        </div>

        <div className="field mt-3">
          <label className="field-label" htmlFor="email-cc">
            Cc <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <input
            id="email-cc"
            type="text"
            className="field-input mt-1.5"
            value={cc}
            onChange={(e) => setCc(e.target.value)}
            placeholder="Separate several with commas"
            autoComplete="off"
          />
        </div>

        <div className="field mt-3">
          <label className="field-label" htmlFor="email-subject">
            Subject
          </label>
          <input
            id="email-subject"
            type="text"
            className="field-input mt-1.5"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            maxLength={200}
          />
        </div>

        <div className="field mt-3">
          <label className="field-label" htmlFor="email-message">
            Message
          </label>
          <textarea
            id="email-message"
            className="field-input mt-1.5 min-h-[9rem]"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={4000}
          />
          <p className="field-hint">
            The bill goes as <span className="font-mono">{file}</span>. Clearing this sends the
            attachment with a one-line note.
          </p>
        </div>

        {problem ? (
          <p className="mt-3 text-sm text-destructive">{problem}</p>
        ) : count > 1 ? (
          <p className="field-hint mt-3">
            Going to {count} address{count === 1 ? '' : 'es'} (at most {MAX_RECIPIENTS}).
          </p>
        ) : null}

        {error ? (
          <p className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn btn-secondary" onClick={() => onClose?.()}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={Boolean(problem) || sending}>
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  );
}
