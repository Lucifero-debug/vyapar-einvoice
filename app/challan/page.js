'use client';
import React, { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import ChallanSearchParams from '@/components/ChallanSearchParams';
import { CHALLAN_KINDS, CHALLAN_TYPES, STATUS_LABELS, pendingQty } from '@/lib/challanStatus.mjs';
import { trim } from '@/lib/orderStatus.mjs';
import { readResponse } from '@/lib/apiResponse.mjs';

export const dynamic = 'force-dynamic';

/**
 * The challan register, and SIGFA's "Pending Challan Book".
 *
 * "Pending" is pending OR part billed -- every challan with a line still to
 * bill, as SIGFA's own pending query takes it. From here a challan is opened
 * to alter, printed, billed (on the sale or purchase screen) or deleted --
 * the last only while nothing on it has been billed.
 */

const fmt = (n) =>
  new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n) || 0);
const asDate = (v) => (v ? new Date(v).toLocaleDateString('en-IN') : '—');

const STATUS_FILTERS = [
  { key: 'pending', label: 'Pending' },
  { key: 'billed', label: 'Billed' },
  { key: '', label: 'All' },
];

function ChallanRegister() {
  const router = useRouter();
  const [type, setType] = useState('Sale');
  const [status, setStatus] = useState('pending');
  const [challans, setChallans] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [busy, setBusy] = useState(false);

  const readParams = useCallback((q) => {
    if (CHALLAN_TYPES.includes(q.type)) setType(q.type);
    if (q.status !== null && ['pending', 'billed', ''].includes(q.status)) setStatus(q.status);
  }, []);

  const load = useCallback(async () => {
    setError('');
    try {
      const qs = new URLSearchParams({ type });
      if (status) qs.set('status', status);
      const res = await fetch(`/api/challan?${qs.toString()}`);
      const { ok, body, message } = await readResponse(res);
      if (!ok) {
        setChallans([]);
        return setError(message);
      }
      setChallans(body.challans || []);
    } catch {
      setChallans([]);
      setError('Could not reach the server.');
    }
  }, [type, status]);

  useEffect(() => {
    load();
  }, [load]);

  const remove = async (c) => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/delete-challan?challanNo=${c.challanNo}&type=${encodeURIComponent(c.type)}`, {
        method: 'POST',
      });
      const { ok, body, message } = await readResponse(res);
      if (!ok) setError(message);
      else {
        setNotice(body.message || 'Deleted.');
        load();
      }
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
      setConfirmDelete(null);
    }
  };

  const kind = CHALLAN_KINDS[type];
  const billRoute = type === 'Sale' ? '/saleadd' : '/purchaseadd';

  return (
    <div className="mx-auto w-full max-w-6xl p-4 sm:p-6">
      <Suspense fallback={null}>
        <ChallanSearchParams onValue={readParams} />
      </Suspense>

      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title text-xl font-semibold">{kind.label}s</h1>
          <p className="page-subtitle">
            Goods sent or received ahead of the bill. Bill a pending challan from the{' '}
            {type === 'Sale' ? 'sale' : 'purchase'} screen with &ldquo;Pending challan [Alt+L]&rdquo;.
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => router.push(`/challanadd?type=${type}`)}>
          New {kind.label}
        </button>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {CHALLAN_TYPES.map((t) => (
          <button key={t} type="button" className={`btn btn-sm ${t === type ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setType(t)}>
            {CHALLAN_KINDS[t].label}
          </button>
        ))}
        <span className="mx-2 border-l border-border" />
        {STATUS_FILTERS.map((f) => (
          <button key={f.key || 'all'} type="button" className={`btn btn-sm ${f.key === status ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setStatus(f.key)}>
            {f.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive" role="alert">
          {error}
        </div>
      )}
      {notice && <div className="mb-4 rounded-lg border border-border bg-muted/50 px-4 py-3 text-sm">{notice}</div>}

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Challan No.</th>
              <th>Date</th>
              <th>{type === 'Sale' ? 'Customer' : 'Supplier'}</th>
              <th>Stock</th>
              <th className="num">Value</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {challans === null && (
              <tr>
                <td colSpan={7}>
                  <div className="empty-state">Loading…</div>
                </td>
              </tr>
            )}
            {challans?.length === 0 && (
              <tr>
                <td colSpan={7}>
                  <div className="empty-state">No {status === 'pending' ? 'pending ' : ''}{kind.label.toLowerCase()}s.</div>
                </td>
              </tr>
            )}
            {(challans || []).map((c) => {
              const key = `${c.type}-${c.challanNo}`;
              return (
                <React.Fragment key={key}>
                  <tr>
                    <td>
                      <button type="button" className="link" onClick={() => setExpanded(expanded === key ? null : key)}>
                        {c.challanNo}
                      </button>
                      {c.mriNo ? <div className="text-xs text-muted-foreground">M.R.I. {c.mriNo}</div> : null}
                    </td>
                    <td>{asDate(c.date)}</td>
                    <td>{c.customer?.name}</td>
                    <td>{c.stockEffect ? 'Moved' : 'Not moved'}</td>
                    <td className="num">{fmt(c.totalAmount)}</td>
                    <td>
                      <span className="chip">
                        {/* A purchase challan MRI that rejected every lot has nothing to bill. */}
                        {(c.items || []).length && (c.items || []).every((l) => !(Number(l.quantity) > 0))
                          ? 'Nothing accepted'
                          : STATUS_LABELS[c.status] || c.status}
                      </span>
                    </td>
                    <td>
                      <div className="flex flex-wrap justify-end gap-2">
                        {c.status !== 'billed' && (
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            onClick={() => router.push(`${billRoute}`)}
                            title="Open the bill screen; choose the party and press Pending challan [Alt+L]"
                          >
                            Bill
                          </button>
                        )}
                        <button type="button" className="btn btn-sm btn-secondary" onClick={() => router.push(`/challan/print?type=${c.type}&challanNo=${c.challanNo}`)}>
                          Print
                        </button>
                        <button type="button" className="btn btn-sm btn-secondary" onClick={() => router.push(`/challanadd?type=${c.type}&challanNo=${c.challanNo}`)}>
                          Alter
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          disabled={c.status !== 'pending'}
                          title={c.status !== 'pending' ? 'Already billed — delete those invoices first' : 'Delete this challan'}
                          onClick={() => setConfirmDelete(c)}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                  {expanded === key && (
                    <tr>
                      <td colSpan={7}>
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>Item</th>
                              <th className="num">Qty</th>
                              <th className="num">Billed</th>
                              <th className="num">Pending</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(c.items || []).map((l) => (
                              <tr key={String(l._id)}>
                                <td>{l.name}</td>
                                <td className="num">{trim(l.quantity)}</td>
                                <td className="num">{trim(l.billedQty || 0)}</td>
                                <td className="num font-medium">{trim(pendingQty(l))}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      {confirmDelete && (
        <div className="modal-overlay no-print" role="dialog" aria-modal="true">
          <div className="modal-card">
            <h2 className="modal-title mb-1">
              Delete {CHALLAN_KINDS[confirmDelete.type].label} {confirmDelete.challanNo}?
            </h2>
            <p className="field-hint mb-4">
              {confirmDelete.stockEffect
                ? 'Its stock movement is reversed as well.'
                : 'It moved no stock, so nothing else changes.'}
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn btn-secondary" onClick={() => setConfirmDelete(null)} disabled={busy}>
                Keep it
              </button>
              <button type="button" className="btn btn-danger" onClick={() => remove(confirmDelete)} disabled={busy}>
                {busy ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
      <ChallanRegister />
    </Suspense>
  );
}
