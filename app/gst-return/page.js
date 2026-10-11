'use client';
import React, { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useCompany } from '@/context/CompanyContext';
import { companyAddress } from '@/lib/company.mjs';
import { GST_RETURNS } from '@/lib/gstReturns.mjs';

export const dynamic = 'force-dynamic';

/**
 * Sigfa's GST returns.
 *
 * FOUR RETURNS, ONE SCREEN, and the titles are Sigfa's own, brackets and all:
 *
 *     GSTR-1 [ E-Return ]
 *     GSTR-1 [ Outward Supply - Sale ]
 *     GSTR-3 [ Inward And Outward ]
 *     GSTR-3B [ Inward And Outward ]
 *
 * The first downloads the portal's JSON; the other three show numbered
 * tables. The numbering is the point -- a return is filed table by table and
 * checked against the portal the same way.
 *
 * NOTHING IS COMPUTED HERE. Every figure comes from lib/gstReturns.mjs, by
 * way of the route. A table that cannot be built says which field it would
 * need, rather than showing a zero that reads as "nothing to file".
 *
 * PRINTING follows the other registers: `doc-sheet`, the firm's letterhead,
 * `no-print` on every control.
 */

const money = (n) =>
  new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    Number(n) || 0
  );

const qty = (n) => String(parseFloat((Number(n) || 0).toFixed(3)));

/** The first and last day of the previous month — the period you file for. */
const lastMonth = () => {
  const now = new Date();
  const ist = new Date(now.getTime() + (5 * 60 + 30) * 60 * 1000);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  const pad = (n) => String(n).padStart(2, '0');
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0));
  const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return { from: iso(start), to: iso(end) };
};

/** A row of a GSTR-1 table, whichever table it is. */
function TableRows({ tag, rows }) {
  if (tag === 'B2B' || tag === 'CDNR') {
    return (
      <table className="data-table">
        <thead>
          <tr>
            <th>GSTIN</th>
            <th>Party</th>
            <th className="num">{tag === 'CDNR' ? 'Note No' : 'Invoice No'}</th>
            <th>Date</th>
            <th>POS</th>
            <th className="num">Rate</th>
            <th className="num">Taxable</th>
            <th className="num">IGST</th>
            <th className="num">CGST</th>
            <th className="num">SGST</th>
            <th className="num">Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.flatMap((block) =>
            (tag === 'CDNR' ? block.nt : block.inv).flatMap((doc) =>
              doc.itms.map((item, i) => (
                <tr key={`${block.ctin}-${doc.inum || doc.nt_num}-${item.num}`}>
                  <td className="text-xs">{i === 0 ? block.ctin : ''}</td>
                  <td>{i === 0 ? block.party || '—' : ''}</td>
                  <td className="num">{i === 0 ? doc.inum || doc.nt_num : ''}</td>
                  <td>{i === 0 ? doc.idt || doc.nt_dt : ''}</td>
                  <td>{i === 0 ? doc.pos || '—' : ''}</td>
                  <td className="num">{item.itm_det.rt}%</td>
                  <td className="num">{money(item.itm_det.txval)}</td>
                  <td className="num">{money(item.itm_det.iamt)}</td>
                  <td className="num">{money(item.itm_det.camt)}</td>
                  <td className="num">{money(item.itm_det.samt)}</td>
                  <td className="num">{i === 0 ? money(doc.val) : ''}</td>
                </tr>
              ))
            )
          )}
        </tbody>
      </table>
    );
  }

  if (tag === 'B2CL') {
    return (
      <table className="data-table">
        <thead>
          <tr>
            <th>POS</th>
            <th className="num">Invoice No</th>
            <th>Date</th>
            <th className="num">Rate</th>
            <th className="num">Taxable</th>
            <th className="num">IGST</th>
            <th className="num">Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.flatMap((block) =>
            block.inv.flatMap((doc) =>
              doc.itms.map((item, i) => (
                <tr key={`${block.pos}-${doc.inum}-${item.num}`}>
                  <td>{i === 0 ? block.pos : ''}</td>
                  <td className="num">{i === 0 ? doc.inum : ''}</td>
                  <td>{i === 0 ? doc.idt : ''}</td>
                  <td className="num">{item.itm_det.rt}%</td>
                  <td className="num">{money(item.itm_det.txval)}</td>
                  <td className="num">{money(item.itm_det.iamt)}</td>
                  <td className="num">{i === 0 ? money(doc.val) : ''}</td>
                </tr>
              ))
            )
          )}
        </tbody>
      </table>
    );
  }

  if (tag === 'B2CS') {
    return (
      <table className="data-table">
        <thead>
          <tr>
            <th>Supply</th>
            <th>POS</th>
            <th className="num">Rate</th>
            <th className="num">Taxable</th>
            <th className="num">IGST</th>
            <th className="num">CGST</th>
            <th className="num">SGST</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.sply_ty}-${r.pos}-${r.rt}`}>
              <td>{r.sply_ty}</td>
              <td>{r.pos || '—'}</td>
              <td className="num">{r.rt}%</td>
              <td className="num">{money(r.txval)}</td>
              <td className="num">{money(r.iamt)}</td>
              <td className="num">{money(r.camt)}</td>
              <td className="num">{money(r.samt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  if (tag === 'CDNUR') {
    return (
      <table className="data-table">
        <thead>
          <tr>
            <th>Type</th>
            <th className="num">Note No</th>
            <th>Date</th>
            <th>POS</th>
            <th className="num">Rate</th>
            <th className="num">Taxable</th>
            <th className="num">Tax</th>
            <th className="num">Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.flatMap((doc) =>
            doc.itms.map((item, i) => (
              <tr key={`${doc.nt_num}-${item.num}`}>
                <td>{i === 0 ? doc.typ : ''}</td>
                <td className="num">{i === 0 ? doc.nt_num : ''}</td>
                <td>{i === 0 ? doc.nt_dt : ''}</td>
                <td>{i === 0 ? doc.pos || '—' : ''}</td>
                <td className="num">{item.itm_det.rt}%</td>
                <td className="num">{money(item.itm_det.txval)}</td>
                <td className="num">
                  {money(item.itm_det.iamt + item.itm_det.camt + item.itm_det.samt)}
                </td>
                <td className="num">{i === 0 ? money(doc.val) : ''}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    );
  }

  if (tag === 'HSN') {
    return (
      <table className="data-table">
        <thead>
          <tr>
            <th className="num">#</th>
            <th>HSN</th>
            <th>Description</th>
            <th>UQC</th>
            <th className="num">Rate</th>
            <th className="num">Quantity</th>
            <th className="num">Taxable</th>
            <th className="num">IGST</th>
            <th className="num">CGST</th>
            <th className="num">SGST</th>
            <th className="num">Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.hsn_sc}-${r.rt}`}>
              <td className="num">{r.num}</td>
              <td>{r.hsn_sc || '—'}</td>
              <td>{r.desc || '—'}</td>
              <td>{r.uqc || '—'}</td>
              <td className="num">{r.rt}%</td>
              <td className="num">{qty(r.qty)}</td>
              <td className="num">{money(r.txval)}</td>
              <td className="num">{money(r.iamt)}</td>
              <td className="num">{money(r.camt)}</td>
              <td className="num">{money(r.samt)}</td>
              <td className="num">{money(r.val)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  if (tag === 'DOCS') {
    return (
      <table className="data-table">
        <thead>
          <tr>
            <th>Nature of document</th>
            <th className="num">From</th>
            <th className="num">To</th>
            <th className="num">Total</th>
            <th className="num">Cancelled</th>
            <th className="num">Net issued</th>
          </tr>
        </thead>
        <tbody>
          {rows.flatMap((det) =>
            det.docs.map((d) => (
              <tr key={`${det.doc_num}-${d.num}`}>
                <td>{det.doc_typ}</td>
                <td className="num">{d.from}</td>
                <td className="num">{d.to}</td>
                <td className="num">{d.totnum}</td>
                <td className="num">{d.cancel}</td>
                <td className="num">{d.net_issue}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    );
  }

  // GSTR-3 and GSTR-3B: label and figure.
  return (
    <table className="data-table">
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <td>{r.label}</td>
            <td className="num font-medium">
              {r.value === null ? r.note || '—' : money(r.value)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function GstReturns() {
  const { company } = useCompany();
  const period = useMemo(lastMonth, []);

  const [view, setView] = useState('gstr1');
  const [from, setFrom] = useState(period.from);
  const [to, setTo] = useState(period.to);

  const [sheet, setSheet] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const qs = new URLSearchParams({ view, from, to });
      const res = await fetch(`/api/gst-return?${qs.toString()}`);
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Could not build the return.');
        setSheet(null);
        return;
      }
      setSheet(data);
    } catch (err) {
      setError(err.message || 'Could not build the return.');
    } finally {
      setBusy(false);
    }
  }, [view, from, to]);

  useEffect(() => {
    load();
  }, [load]);

  const chosen = GST_RETURNS.find((r) => r.key === view);
  const isEReturn = view === 'gstr1-ereturn';

  const download = () => {
    if (!sheet?.json) return;
    const blob = new Blob([JSON.stringify(sheet.json, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = sheet.filename || 'gstr1.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="page-shell-wide doc-sheet">
      <div className="doc-head">
        <p className="doc-org">{company?.name || ''}</p>
        <p className="doc-meta">{company ? companyAddress(company) : ''}</p>
        <p className="doc-kind">{(chosen?.title || 'GST RETURN').toUpperCase()}</p>
        <p className="doc-meta mt-1">
          {company?.gstin ? `GSTIN ${company.gstin} · ` : ''}
          Tax period {sheet?.period || '—'}
        </p>
      </div>

      {/* ── controls ─────────────────────────────────────────────── */}
      <div className="no-print mb-5 rounded-xl border border-border bg-card p-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {GST_RETURNS.map((r) => (
            <button
              key={r.key}
              type="button"
              className={`btn btn-sm ${view === r.key ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setView(r.key)}
              title={r.blurb}
            >
              {r.title}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <div>
            <label className="field-label" htmlFor="gr-from">From</label>
            <input
              id="gr-from"
              type="date"
              className="field-input mt-1.5"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="gr-to">To</label>
            <input
              id="gr-to"
              type="date"
              className="field-input mt-1.5"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <div className="flex items-end gap-2 sm:col-span-2">
            {isEReturn ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={download}
                disabled={!sheet?.json}
              >
                Download JSON
              </button>
            ) : (
              <button type="button" className="btn btn-secondary" onClick={() => window.print()}>
                Print
              </button>
            )}
          </div>
        </div>
        <p className="field-hint mt-3">{chosen?.blurb}</p>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {busy && <div className="empty-state">Working it out…</div>}

      {/* ── the e-return ────────────────────────────────────────── */}
      {!busy && isEReturn && sheet?.json && (
        <>
          <div className="panel mb-4">
            <div className="panel-head">
              <h2 className="panel-title">{sheet.filename}</h2>
            </div>
            <div className="panel-body">
              <p className="field-hint mb-3">
                This is the file the portal and its offline utility both take. A table with
                nothing in it is left out of the file on purpose — the utility reports an empty
                section as an error rather than as nothing to file.
              </p>
              <div className="flex flex-wrap gap-2">
                {Object.keys(sheet.json).map((key) => (
                  <span key={key} className="chip">
                    {key}
                  </span>
                ))}
              </div>
            </div>
          </div>

          {sheet.gaps?.length > 0 && (
            <div className="panel mb-4">
              <div className="panel-head">
                <h2 className="panel-title">Not in this file, and why</h2>
              </div>
              <div className="panel-body">
                <ul className="space-y-2 text-sm">
                  {sheet.gaps.map((gap) => (
                    <li key={gap.no}>
                      <span className="font-medium">{gap.title}</span>
                      <br />
                      <span className="text-muted-foreground">Needs {gap.needs}.</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          <div className="table-wrap">
            <pre className="overflow-x-auto p-4 text-xs leading-relaxed">
              {JSON.stringify(sheet.json, null, 2)}
            </pre>
          </div>
        </>
      )}

      {/* ── the readable returns, table by numbered table ───────── */}
      {!busy &&
        !isEReturn &&
        sheet?.sections?.map((section) => (
          <div className="panel mb-4" key={section.no}>
            <div className="panel-head">
              <h2 className="panel-title">{section.title}</h2>
              {section.code && <span className="chip">{section.code}</span>}
            </div>
            <div className="panel-body">
              {!section.filled ? (
                <div className="empty-state">
                  Nothing can be filed here yet. It needs {section.needs}.
                </div>
              ) : section.rows.length === 0 ? (
                <div className="empty-state">Nothing in this period.</div>
              ) : (
                <div className="table-wrap">
                  <TableRows tag={section.tag} rows={section.rows} />
                </div>
              )}
            </div>
          </div>
        ))}

      {!busy && !isEReturn && sheet?.totals && (
        <div className="panel">
          <div className="panel-head">
            <h2 className="panel-title">Outward totals, as filed</h2>
          </div>
          <div className="panel-body grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="stat-card">
              <p className="stat-label">Taxable value</p>
              <p className="stat-value">{money(sheet.totals.taxable)}</p>
            </div>
            <div className="stat-card">
              <p className="stat-label">IGST</p>
              <p className="stat-value">{money(sheet.totals.iamt)}</p>
            </div>
            <div className="stat-card">
              <p className="stat-label">CGST + SGST</p>
              <p className="stat-value">{money(sheet.totals.camt + sheet.totals.samt)}</p>
            </div>
            <div className="stat-card">
              <p className="stat-label">Invoice value</p>
              <p className="stat-value">{money(sheet.totals.value)}</p>
            </div>
          </div>
        </div>
      )}

      <p className="field-hint mt-4">
        Credit notes are included and subtracted everywhere, which is what a summary of outward
        supplies means. Table 7 is net of them, as its own heading says, and table 10 lists them —
        that is the portal asking for the same documents two ways, not a figure counted twice.
      </p>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
      <GstReturns />
    </Suspense>
  );
}
