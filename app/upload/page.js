'use client';
export const dynamic = 'force-dynamic';

/**
 * Read a purchase bill off a photograph.
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
import { IMPORT_DRAFT_KEY, MATCH_APPLIED, MATCH_SUGGESTED } from '@/lib/invoiceImport.mjs';

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

export default function UploadInvoicePage() {
  const router = useRouter();

  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const inputRef = useRef(null);

  const pick = (event) => {
    const chosen = event.target.files?.[0] || null;
    setFile(chosen);
    setResult(null);
    setError('');
    if (preview) URL.revokeObjectURL(preview);
    setPreview(chosen ? URL.createObjectURL(chosen) : '');
  };

  const read = useCallback(async () => {
    if (!file) return;
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const scaled = (await downscale(file)) || file;
      const res = await fetch('/api/invoice-extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: await toBase64(scaled), name: file.name }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) {
        setError(body.error || 'The bill could not be read.');
        return;
      }
      setResult(body);
    } catch (err) {
      setError('Could not reach the server.');
    } finally {
      setLoading(false);
    }
  }, [file]);

  /**
   * Hand the draft to the purchase screen.
   *
   * sessionStorage under one key, NOT the URL -- the old page put the whole
   * items array through encodeURIComponent into a query string, which is a
   * bill's worth of data in the address bar, the browser history and every
   * server log that records a URL.
   */
  const openInForm = () => {
    try {
      sessionStorage.setItem(
        IMPORT_DRAFT_KEY,
        JSON.stringify({ draft: result.draft, warnings: result.warnings, newMasters: result.newMasters })
      );
    } catch {
      setError('This browser would not hold the draft. Type the bill in instead.');
      return;
    }
    router.push('/purchaseadd?import=1');
  };

  const draft = result?.draft || null;
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
        <h1 className="page-title">Read a purchase bill</h1>
        <p className="page-subtitle">
          Photograph a supplier&apos;s bill and it will be read into a draft. Nothing is saved
          until you have checked it on the purchase screen.
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
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="field-label">Supplier</p>
                <p className="text-sm font-medium">
                  {draft.party.how === MATCH_APPLIED
                    ? draft.party.name
                    : draft.read.supplierName || '(not read)'}
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
                <p className="field-label">Supplier bill no</p>
                <p className="text-sm font-medium">{draft.partyBillNo || '(not read)'}</p>
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
                      : '(follows the supplier’s master)'}
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
              <button type="button" className="btn btn-primary" onClick={openInForm}>
                Open in the purchase form
              </button>
              <p className="field-hint">
                {blocking.length
                  ? `${blocking.length} thing${blocking.length === 1 ? '' : 's'} to settle there — the form will not save until you do.`
                  : 'Check it over and save it there.'}
              </p>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
