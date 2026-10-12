'use client';
export const dynamic = 'force-dynamic';

/**
 * Read a bill off a photograph -- a sale, a purchase, or a return of either.
 *
 * The kind is worked out from which side of the bill carries this firm's
 * GSTIN or name, or picked by the person (lib/invoiceImport.mjs
 * `resolveKind`), and can be changed after reading without reading the photo
 * again. The draft then opens on THAT kind's billing screen.
 *
 * WHAT THIS PAGE NO LONGER DOES
 * -----------------------------
 * It used to POST the extraction straight to `/api/save-invoice`, so a
 * misread quantity went into the party ledger, the stock ledger and the GL
 * legs with nobody having seen it -- and then navigated to the print view
 * with the whole items array in the query string. The note atop
 * lib/invoiceImport.mjs lists all six faults.
 *
 * Now: the bill is read, everything questionable is said plainly, and the
 * draft is handed to the ordinary purchase screen through sessionStorage. The
 * person checks it there and saves it through the same posting path as a bill
 * they typed. This page writes nothing.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatINR } from '@/lib/currency.mjs';
import {
  AUTO_KIND,
  IMPORT_DRAFT_KEY,
  IMPORT_KINDS,
  KIND_LABELS,
  MATCH_APPLIED,
  MATCH_SUGGESTED,
  importParcel,
  importScopeOf,
} from '@/lib/invoiceImport.mjs';

/** What the route accepts, and what the picker should therefore offer. */
const ACCEPT = 'image/png,image/jpeg,image/webp';

/**
 * The long edge a photo is scaled to before it is uploaded.
 *
 * A phone camera gives 3000-4000px and 4MB. Neither helps: the text on a
 * bill is legible well under 2000px, the upload is four times slower, and
 * the model is billed by image size. 1800 keeps the small print readable on
 * a full-page bill -- going much below it starts losing the rate column on
 * a dense twenty-line bill, which is the one column that must not be
 * guessed.
 */
const MAX_EDGE = 1800;

/**
 * Scale and re-encode in the browser.
 *
 * Also the reason the server's cap is a backstop rather than the limit a
 * person meets: by the time a 4MB photo reaches the route it is a few
 * hundred KB. Falls back to the original bytes if anything about the canvas
 * fails -- an unscaled upload that works beats a clever one that does not.
 */
const downscale = (file) =>
  new Promise((resolve) => {
    const done = (value) => resolve(value);
    try {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
          if (scale === 1) {
            URL.revokeObjectURL(url);
            done(null);
            return;
          }
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          URL.revokeObjectURL(url);
          // JPEG at 0.9: a bill is text on white, where the artefacts that
          // would matter are the ones around the digits, and 0.9 does not
          // produce them.
          canvas.toBlob((blob) => done(blob || null), 'image/jpeg', 0.9);
        } catch {
          URL.revokeObjectURL(url);
          done(null);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        done(null);
      };
      img.src = url;
    } catch {
      done(null);
    }
  });

const toBase64 = async (blob) => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // In chunks: String.fromCharCode(...bytes) on a megabyte blows the
  // argument limit in some browsers, which looks like a failing upload.
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
};

const SEVERITY = {
  blocking: { label: 'Needs you', className: 'border-destructive/40 bg-destructive/10 text-destructive' },
  check: { label: 'Worth a look', className: 'border-border bg-muted/50 text-foreground' },
};

/** The signed-in firm and user, as lib/invoiceImport.mjs `importScopeOf` reads them. Null if unknown. */
async function whoAmI() {
  try {
    const res = await fetch('/api/auth/me');
    return res.ok ? importScopeOf(await res.json()) : null;
  } catch {
    return null;
  }
}

export default function UploadInvoicePage() {
  const router = useRouter();

  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  // Who was signed in when the photo was read. The server matched the bill
  // against THAT firm's masters, so that is the firm the draft belongs to.
  const [readBy, setReadBy] = useState(null);
  // What the person says this bill is: "auto", or one of IMPORT_KINDS.
  const [kind, setKind] = useState(AUTO_KIND);
  const [redrafting, setRedrafting] = useState(false);
  const inputRef = useRef(null);

  const pick = (event) => {
    const chosen = event.target.files?.[0] || null;
    setFile(chosen);
    setResult(null);
    setReadBy(null);
    setError('');
    if (preview) URL.revokeObjectURL(preview);
    setPreview(chosen ? URL.createObjectURL(chosen) : '');
  };

  const read = useCallback(async () => {
    if (!file) return;
    setLoading(true);
    setError('');
    setResult(null);
    setReadBy(null);
    try {
      const scope = await whoAmI();
      const scaled = (await downscale(file)) || file;
      const res = await fetch('/api/invoice-extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: await toBase64(scaled), name: file.name, kind }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) {
        setError(body.error || 'The bill could not be read.');
        return;
      }
      setResult(body);
      setReadBy(scope);
    } catch (err) {
      setError('Could not reach the server.');
    } finally {
      setLoading(false);
    }
  }, [file, kind]);

  /**
   * The same reading, drafted as another kind -- no new photo, no new model
   * call. The route matches it against the masters again, because the party
   * is now on the other side of the bill.
   */
  const redraft = async (nextKind) => {
    if (!result?.draft?.read) return;
    // Matched again against the masters of whoever is signed in NOW, so it
    // must still be the firm and user the photo was read for.
    const scope = await whoAmI();
    if (!scope || !readBy || scope.companyId !== readBy.companyId || scope.user !== readBy.user) {
      setError('You are signed in as a different user or company from when this bill was read. Read the photo again.');
      return;
    }
    setKind(nextKind);
    setRedrafting(true);
    setError('');
    try {
      const res = await fetch('/api/invoice-extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extraction: result.draft.read, kind: nextKind }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) {
        setError(body.error || 'Could not change the type. Read the photo again.');
        return;
      }
      setResult(body);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setRedrafting(false);
    }
  };

  /**
   * Hand the draft to the billing screen for its kind.
   *
   * sessionStorage under one key, NOT the URL -- the old page put the whole
   * items array through encodeURIComponent into a query string, which is a
   * bill's worth of data in the address bar, the browser history and every
   * server log that records a URL.
   *
   * The parcel is TAGGED with the screen it is for and the firm and user who
   * read it (lib/invoiceImport.mjs `importParcel`), and the purchase screen
   * checks both before filling anything in. The key is one per browser tab,
   * and a tab can be signed in to another firm by the time it is opened.
   */
  const openInForm = async () => {
    // Not until the kind is known: the parcel names its screen.
    if (!result?.draft?.kind || !result.draft.route) {
      setError('Choose whether this is a sale, a purchase or a return first.');
      return;
    }
    // Still the same firm and user as when the photo was read? A tab can be
    // signed out and into another company in between.
    const scope = await whoAmI();
    if (
      !scope ||
      !readBy ||
      scope.companyId !== readBy.companyId ||
      scope.user !== readBy.user
    ) {
      setError(
        scope && readBy
          ? 'You are signed in as a different user or company from when this bill was read. Read the photo again.'
          : 'Could not confirm who is signed in. Sign in again, then read the photo again.'
      );
      return;
    }
    try {
      sessionStorage.setItem(
        IMPORT_DRAFT_KEY,
        JSON.stringify(
          importParcel(
            { draft: result.draft, warnings: result.warnings, newMasters: result.newMasters },
            scope
          )
        )
      );
    } catch {
      setError('This browser would not hold the draft. Type the bill in instead.');
      return;
    }
    router.push(`${result.draft.route}?import=1`);
  };

  const draft = result?.draft || null;
  const role = draft?.partyRole === 'customer' ? 'Customer' : 'Supplier';
  const partyRead = draft?.party?.read?.name ?? draft?.read?.supplierName ?? '';
  const blocking = useMemo(
    () => (result?.warnings || []).filter((w) => w.severity === 'blocking'),
    [result]
  );
  const checks = useMemo(
    () => (result?.warnings || []).filter((w) => w.severity === 'check'),
    [result]
  );

  return (
    <div className="page-shell max-w-3xl">
      <div className="page-header">
        <h1 className="page-title">Read a bill</h1>
        <p className="page-subtitle">
          Photograph a sale or purchase bill, a credit note or a debit note, and it will be read
          into a draft. Nothing is saved until you have checked it on the billing screen.
        </p>
      </div>

      <section className="panel">
        <div className="panel-body space-y-4">
          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-muted/40 px-6 py-8 text-center transition-colors hover:border-primary/50 hover:bg-accent/40">
            <span className="text-sm font-medium text-foreground">
              {file ? file.name : 'Choose a photo of the bill'}
            </span>
            <span className="text-xs text-muted-foreground">
              PNG, JPEG or WebP. A straight-on shot with the whole bill in frame reads best.
            </span>
            <input ref={inputRef} type="file" accept={ACCEPT} onChange={pick} className="sr-only" />
          </label>

          {preview ? (
            <img
              src={preview}
              alt="The bill you chose"
              className="mx-auto max-h-64 w-auto rounded-lg border border-border object-contain"
            />
          ) : null}

          <div>
            <label className="field-label" htmlFor="bill-kind">
              What kind of bill
            </label>
            <select
              id="bill-kind"
              className="field-select mt-1.5"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              disabled={loading}
            >
              <option value={AUTO_KIND}>Work it out from the bill</option>
              {IMPORT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </select>
            <p className="field-hint mt-1">
              Worked out from which side of the bill has your firm&apos;s GSTIN or name. You can
              change it after reading.
            </p>
          </div>

          <button
            type="button"
            onClick={read}
            disabled={!file || loading}
            className="btn btn-primary w-full"
          >
            {loading ? 'Reading the bill…' : 'Read it'}
          </button>

          {error ? (
            <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </section>

      {/* ── what was read ───────────────────────────────────────────── */}
      {draft ? (
        <section className="panel mt-5">
          <div className="panel-head">
            <div>
              <h2 className="panel-title">What it read</h2>
              <p className="field-hint mt-0.5">
                Every figure below is worked out from the rows, not taken from the bill&apos;s
                own totals. Those are only used to check the rows were read right.
              </p>
            </div>
          </div>
          <div className="panel-body space-y-5">
            {/* ── which kind of bill ─────────────────────────────── */}
            <div
              className={`rounded-lg border px-4 py-3 ${
                draft.kind ? 'border-border bg-muted/40' : 'border-destructive/40 bg-destructive/10'
              }`}
            >
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-sm">
                  {draft.kind ? (
                    <>
                      <span className="font-medium">{KIND_LABELS[draft.kind]}</span>
                      <span className="text-muted-foreground">
                        {draft.kindChosen !== AUTO_KIND
                          ? ' — as you chose'
                          : draft.kindDetectedBy === 'gstin'
                            ? ' — your GSTIN is on the bill'
                            : ' — your firm’s name is on the bill'}
                      </span>
                    </>
                  ) : (
                    <span className="font-medium text-destructive">
                      Is this a sale or a purchase? Your firm was not found on the bill.
                    </span>
                  )}
                </p>
                <div className="flex flex-wrap gap-2">
                  {IMPORT_KINDS.map((k) => (
                    <button
                      key={k}
                      type="button"
                      className={`btn btn-sm ${draft.kind === k ? 'btn-primary' : 'btn-secondary'}`}
                      disabled={redrafting || draft.kind === k}
                      onClick={() => redraft(k)}
                    >
                      {KIND_LABELS[k]}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="field-label">{role}</p>
                <p className="text-sm font-medium">
                  {draft.party.how === MATCH_APPLIED ? draft.party.name : partyRead || '(not read)'}
                </p>
                <p className="field-hint">
                  {draft.party.how === MATCH_APPLIED
                    ? `Matched by ${draft.party.by === 'gstin' ? 'GSTIN' : 'name'}.`
                    : draft.party.how === MATCH_SUGGESTED
                      ? 'Not an exact match — pick one on the next screen.'
                      : 'Not in your accounts yet.'}
                </p>
              </div>
              <div>
                <p className="field-label">
                  {draft.partySide === 'addressee' ? 'Bill no (your series)' : `${role} bill no`}
                </p>
                <p className="text-sm font-medium">
                  {(draft.partySide === 'addressee' ? draft.printedNo : draft.partyBillNo) ||
                    '(not read)'}
                </p>
                <p className="field-hint">
                  Your own invoice number is given by Vyapaar, not taken from the bill.
                </p>
              </div>
              <div>
                <p className="field-label">Date</p>
                <p className="text-sm font-medium">{draft.date || "(not read — today's date)"}</p>
              </div>
              <div>
                <p className="field-label">Tax</p>
                <p className="text-sm font-medium">
                  {draft.taxType === 'local'
                    ? 'CGST + SGST (same state)'
                    : draft.taxType === 'central'
                      ? 'IGST (different states)'
                      : `(follows the ${role.toLowerCase()}’s master)`}
                </p>
              </div>
            </div>

            <div className="table-wrap">
              <table className="data-table report-table min-w-[720px]">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>HSN</th>
                    <th className="num">Qty</th>
                    <th className="num">Rate</th>
                    <th className="num">GST</th>
                    <th className="num">Amount</th>
                    <th>Matched</th>
                  </tr>
                </thead>
                <tbody>
                  {draft.lines.map((line, index) => (
                    <tr key={`${line.name}-${index}`}>
                      <td>
                        {line.name}
                        {line.match.read.name && line.match.read.name !== line.name ? (
                          <span className="block text-xs text-muted-foreground">
                            read as &ldquo;{line.match.read.name}&rdquo;
                          </span>
                        ) : null}
                      </td>
                      <td>{line.hsn || '—'}</td>
                      <td className="num">{line.quantity || '—'}</td>
                      <td className="num">{line.cost ? formatINR(line.cost) : '—'}</td>
                      <td className="num">{line.gstRate ? `${line.gstRate}%` : '—'}</td>
                      <td className="num">{formatINR(line.total)}</td>
                      <td>
                        {line.match.charge ? (
                          <span className="chip">a charge</span>
                        ) : line.match.how === MATCH_APPLIED ? (
                          <span className="chip">in your master</span>
                        ) : line.match.how === MATCH_SUGGESTED ? (
                          <span className="chip">
                            maybe {line.match.suggestions[0]?.name}
                          </span>
                        ) : (
                          <span className="chip">new item</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={5}>
                      <span className="font-medium">From the rows</span>
                    </td>
                    <td className="num">{formatINR(draft.totals.total)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* The bill's own totals, beside ours. */}
            <div className="grid gap-3 sm:grid-cols-3">
              {['taxable', 'gst', 'total'].map((what) => {
                const check = draft.totals.checks[what];
                return (
                  <div key={what} className="stat-card">
                    <p className="stat-label">{what === 'gst' ? 'GST' : what}</p>
                    <p className="stat-value">{formatINR(draft.totals[what])}</p>
                    <p className="field-hint">
                      {check
                        ? check.agrees
                          ? 'agrees with the bill'
                          : `the bill prints ${formatINR(check.printed)}`
                        : 'the bill’s own figure was not read'}
                    </p>
                  </div>
                );
              })}
            </div>

            {/* ── what needs you ─────────────────────────────────── */}
            {blocking.length || checks.length ? (
              <div className="space-y-2">
                {[...blocking, ...checks].map((warning) => (
                  <p
                    key={`${warning.field}-${warning.message}`}
                    className={`rounded-lg border px-4 py-2.5 text-sm ${SEVERITY[warning.severity].className}`}
                  >
                    <span className="font-medium">{SEVERITY[warning.severity].label}:</span>{' '}
                    {warning.message}
                  </p>
                ))}
              </div>
            ) : (
              <p className="rounded-lg border border-border bg-muted/50 px-4 py-2.5 text-sm">
                Everything matched your masters and the figures agree with the bill. Still worth a
                glance before you save.
              </p>
            )}

            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
              <button
                type="button"
                className="btn btn-primary"
                onClick={openInForm}
                disabled={!draft.kind || redrafting}
              >
                {draft.kind
                  ? `Open in the ${KIND_LABELS[draft.kind].toLowerCase()} form`
                  : 'Choose the type first'}
              </button>
              <p className="field-hint">
                {blocking.length
                  ? `${blocking.length} thing${blocking.length === 1 ? '' : 's'} to settle there before you save — they are listed at the top of the form.`
                  : 'Check it over and save it there.'}
              </p>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
