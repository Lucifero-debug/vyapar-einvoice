'use client';
import React, { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { readResponse } from '@/lib/apiResponse.mjs';
import { trim } from '@/lib/orderStatus.mjs';
import { MRI_LABEL, MRI_STATUS_LABELS, MRI_VIEWS, MRI_VIEW_LABELS, isMriView } from '@/lib/mri.mjs';

export const dynamic = 'force-dynamic';

/**
 * Purchase M.R.I. registers -- SIGFA's MRI book, "List Of Pending MRI",
 * "Rejected Material Register" and "Party Wise Rejected Material", one
 * screen with four views. Every figure comes from /api/mri (lib/mri.mjs);
 * this page only lays it out and prints it.
 *
 *   /mri?view=pending&party=Acme
 */

const money = (n) =>
  new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n) || 0);
const asDate = (v) => (v ? new Date(v).toLocaleDateString('en-IN') : '—');

/** The query string, read in its own Suspense boundary. */
function MriParams({ onValue }) {
  const params = useSearchParams();
  useEffect(() => {
    onValue({ view: params.get('view'), party: params.get('party') || '' });
  }, [params, onValue]);
  return null;
}

function docHref(row) {
  return row.source === 'challan'
    ? `/challanadd?type=Purchase&challanNo=${row.documentNo}`
    : `/purchaseadd?value=${row.documentNo}`;
}

function MriRegister() {
  const router = useRouter();
  const [view, setView] = useState('register');
  const [party, setParty] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // The rows AND the query they answer: a table is only drawn from rows
  // fetched for the view now chosen, never the last view's.
  const [loaded, setLoaded] = useState({ key: '', rows: [], error: '' });

  const readParams = useCallback((q) => {
    if (isMriView(q.view)) setView(q.view);
    if (q.party) setParty(q.party);
  }, []);

  const key = useMemo(() => {
    const qs = new URLSearchParams({ view });
    if (party.trim()) qs.set('party', party.trim());
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    return qs.toString();
  }, [view, party, from, to]);

  useEffect(() => {
    let live = true;
    fetch(`/api/mri?${key}`)
      .then(readResponse)
      .then(({ ok, body, message }) => {
        if (!live) return;
        setLoaded(ok ? { key, rows: body.rows || [], error: '' } : { key, rows: [], error: message });
      })
      .catch(() => {
        if (live) setLoaded({ key, rows: [], error: 'Could not reach the server.' });
      });
    return () => {
      live = false;
    };
  }, [key]);

  const current = loaded.key === key;
  const rows = current ? loaded.rows : null;
  const error = current ? loaded.error : '';
  const list = rows || [];

  return (
    <div className="mx-auto w-full max-w-6xl p-4 sm:p-6">
      <Suspense fallback={null}>
        <MriParams onValue={readParams} />
      </Suspense>

      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title text-xl font-semibold">Purchase {MRI_LABEL} — {MRI_VIEW_LABELS[view]}</h1>
          <p className="page-subtitle">
            Goods received, accepted and rejected on purchase bills and purchase challans. Only the accepted quantity
            is billed and stocked.
          </p>
        </div>
        <div className="no-print flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary" onClick={() => router.push('/purchaseadd?mri=1')}>
            New {MRI_LABEL} on a bill
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => router.push('/challanadd?type=Purchase&mri=1')}>
            New {MRI_LABEL} on a challan
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => window.print()}>
            Print
          </button>
        </div>
      </div>

      <div className="no-print mb-4 flex flex-wrap items-end gap-2">
        {MRI_VIEWS.map((v) => (
          <button
            key={v}
            type="button"
            className={`btn btn-sm ${v === view ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setView(v)}
          >
            {MRI_VIEW_LABELS[v]}
          </button>
        ))}
        <span className="mx-2 border-l border-border" />
        <label className="flex items-center gap-2 text-sm">
          Supplier
          <input className="field-input field-input-sm w-44" value={party} onChange={(e) => setParty(e.target.value)} placeholder="All" />
        </label>
        <label className="flex items-center gap-2 text-sm">
          From
          <input type="date" className="field-input field-input-sm" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="flex items-center gap-2 text-sm">
          To
          <input type="date" className="field-input field-input-sm" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive" role="alert">
          {error}
        </div>
      )}

      <div className="table-wrap">
        {(view === 'register' || view === 'pending') && (
          <table className="data-table">
            <thead>
              <tr>
                <th>{MRI_LABEL} No.</th>
                <th>Date</th>
                <th>Document</th>
                <th>Supplier</th>
                <th className="num">Received</th>
                <th className="num">Accepted</th>
                <th className="num">Rejected</th>
                <th className="num">Rejected value</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <Empty rows={rows} cols={9} what={view === 'pending' ? 'pending MRIs' : 'MRIs'} />
              {list.map((r) => (
                <tr key={r.mriNo}>
                  <td className="font-medium">
                    {r.mriNo}
                    {r.againstMriNo ? <div className="text-xs text-muted-foreground">Re-MRI of {r.againstMriNo}</div> : null}
                  </td>
                  <td>{asDate(r.date)}</td>
                  <td>
                    <button type="button" className="link" onClick={() => router.push(docHref(r))}>
                      {r.documentLabel} {r.documentNo}
                    </button>
                    {r.partyBillNo ? <div className="text-xs text-muted-foreground">Supplier&apos;s No. {r.partyBillNo}</div> : null}
                  </td>
                  <td>{r.party}</td>
                  <td className="num">{trim(r.received)}</td>
                  <td className="num">{trim(r.accepted)}</td>
                  <td className="num font-medium">{r.rejected > 0 ? trim(r.rejected) : '—'}</td>
                  <td className="num">{r.rejected > 0 ? money(r.rejectedValue) : '—'}</td>
                  <td>
                    <span className="chip">{MRI_STATUS_LABELS[r.status] || r.status}</span>
                    {r.reMriNo ? <div className="text-xs text-muted-foreground">Re-MRI {r.reMriNo}</div> : null}
                    {r.remark ? <div className="text-xs text-muted-foreground">{r.remark}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {view === 'rejected' && (
          <table className="data-table">
            <thead>
              <tr>
                <th>{MRI_LABEL} No.</th>
                <th>Date</th>
                <th>Supplier</th>
                <th>Item</th>
                <th className="num">Received</th>
                <th className="num">Accepted</th>
                <th className="num">Rejected</th>
                <th className="num">Rate</th>
                <th className="num">Value</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              <Empty rows={rows} cols={10} what="rejected material" />
              {list.map((r, i) => (
                <tr key={`${r.mriNo}-${r.item}-${i}`}>
                  <td>{r.mriNo}</td>
                  <td>{asDate(r.date)}</td>
                  <td>{r.party}</td>
                  <td>{r.item}</td>
                  <td className="num">{trim(r.received)}</td>
                  <td className="num">{trim(r.accepted)}</td>
                  <td className="num font-medium">{trim(r.rejected)}</td>
                  <td className="num">{money(r.rate)}</td>
                  <td className="num">{money(r.value)}</td>
                  <td>
                    <span className="chip">{MRI_STATUS_LABELS[r.status] || r.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
            {list.length > 0 && (
              <tfoot>
                <tr>
                  <td colSpan={8}>Total rejected value</td>
                  <td className="num">{money(list.reduce((s, r) => s + Number(r.value || 0), 0))}</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        )}

        {view === 'party' && (
          <table className="data-table">
            <thead>
              <tr>
                <th>Supplier</th>
                <th>Item</th>
                <th className="num">MRIs</th>
                <th className="num">Received</th>
                <th className="num">Rejected</th>
                <th className="num">Rejected %</th>
                <th className="num">Value</th>
                <th className="num">Still pending</th>
              </tr>
            </thead>
            <tbody>
              <Empty rows={rows} cols={8} what="rejected material" />
              {list.map((r) => (
                <tr key={`${r.party}-${r.item}`}>
                  <td>{r.party}</td>
                  <td>{r.item}</td>
                  <td className="num">{r.mris}</td>
                  <td className="num">{trim(r.received)}</td>
                  <td className="num font-medium">{trim(r.rejected)}</td>
                  <td className="num">{r.received > 0 ? `${((r.rejected / r.received) * 100).toFixed(1)}%` : '—'}</td>
                  <td className="num">{money(r.value)}</td>
                  <td className="num">{r.pending || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Empty({ rows, cols, what }) {
  if (rows === null) {
    return (
      <tr>
        <td colSpan={cols}>
          <div className="empty-state">Loading…</div>
        </td>
      </tr>
    );
  }
  if (rows.length === 0) {
    return (
      <tr>
        <td colSpan={cols}>
          <div className="empty-state">No {what}.</div>
        </td>
      </tr>
    );
  }
  return null;
}

export default function Page() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
      <MriRegister />
    </Suspense>
  );
}
