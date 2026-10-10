'use client'
import React, { useMemo, useState } from 'react'
import { Printer } from 'lucide-react';
import InvoiceDocument from '@/components/InvoiceDocument';
import { useSaleOptions } from '@/context/SaleOptionContext';

const today = () => new Date().toISOString().substring(0, 10);
const firstOfMonth = () => `${today().substring(0, 8)}01`;

const TYPE_OPTIONS = [
  { value: 'all', label: 'All invoices' },
  { value: 'sale', label: 'Sale' },
  { value: 'purchase', label: 'Purchase' },
  { value: 'salereturn', label: 'Sale Return' },
  { value: 'purchasereturn', label: 'Purchase Return' },
];

/** "Sale Return" rather than the raw { type, return } pair. */
const typeLabel = (inv) => `${inv.type || ''}${inv.return ? ' Return' : ''}`.trim() || '—';

const money = (n) => (Number(n) || 0).toFixed(2);

// Print invoices from a date range — the whole batch, or just the ones ticked.
const Page = () => {
  const { options } = useSaleOptions();
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(today());
  const [type, setType] = useState('all');
  const [invoices, setInvoices] = useState(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  // Ids ticked for printing. Everything loaded starts ticked, so the default
  // is the batch behaviour this page had before.
  const [picked, setPicked] = useState(() => new Set());

  // Any filter change invalidates what is on screen, so Print can't send a stale batch
  const changeFilter = (setter) => (e) => {
    setter(e.target.value);
    setInvoices(null);
    setPicked(new Set());
  };

  const loadInvoices = async () => {
    if (!from || !to) {
      alert('Please pick both dates');
      return;
    }
    if (from > to) {
      alert('The From date must be on or before the To date');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`/api/invoices-by-date?from=${from}&to=${to}&type=${type}`);
      const data = await res.json();
      if (!data.success) {
        alert(`Failed to load invoices: ${data.error}`);
        return;
      }
      setInvoices(data.invoices);
      setTotal(data.total);
      setPicked(new Set(data.invoices.map((inv) => inv._id)));
    } catch (err) {
      console.error('Error loading invoices:', err);
      alert('Error loading invoices');
    } finally {
      setLoading(false);
    }
  };

  const toggle = (id) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** Narrow the batch to one invoice without unticking the rest by hand. */
  const only = (id) => setPicked(new Set([id]));

  const selectAll = () => setPicked(new Set((invoices || []).map((inv) => inv._id)));
  const selectNone = () => setPicked(new Set());

  // What actually prints. Kept in the loaded order so the batch reads by date.
  const toPrint = useMemo(
    () => (invoices || []).filter((inv) => picked.has(inv._id)),
    [invoices, picked]
  );

  const grandTotal = toPrint.reduce((sum, inv) => sum + (Number(inv.finalAmount) || 0), 0);
  const allPicked = invoices && invoices.length > 0 && picked.size === invoices.length;

  return (
    <>
      <div className="no-print page-shell space-y-4">
        <header className="page-header mb-0">
          <div>
            <h1 className="page-title">Print Invoices</h1>
            <p className="page-subtitle">
              Load a date range, then print the whole batch or just the invoices you tick.
            </p>
          </div>
        </header>

        <div className="panel panel-body flex flex-wrap items-end gap-4">
          <div className="field w-44">
            <label className="field-label mb-1">From</label>
            <input type="date" className="field-input" value={from} onChange={changeFilter(setFrom)} />
          </div>
          <div className="field w-44">
            <label className="field-label mb-1">To</label>
            <input type="date" className="field-input" value={to} onChange={changeFilter(setTo)} />
          </div>
          <div className="field w-48">
            <label className="field-label mb-1">Type</label>
            <select className="field-select" value={type} onChange={changeFilter(setType)}>
              {TYPE_OPTIONS.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
          <button type="button" className="btn btn-secondary" onClick={loadInvoices} disabled={loading}>
            {loading ? 'Loading…' : 'Show Invoices'}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => window.print()}
            disabled={toPrint.length === 0}
          >
            <Printer className="h-4 w-4" />
            {toPrint.length === 0
              ? 'Print'
              : allPicked
                ? `Print All (${toPrint.length})`
                : `Print ${toPrint.length} selected`}
          </button>
        </div>

        {invoices && invoices.length === 0 && (
          <p className="text-sm text-muted-foreground">No invoices in this range.</p>
        )}

        {invoices && invoices.length > 0 && (
          <section className="panel">
            <div className="panel-head">
              <h2 className="panel-title">
                {invoices.length} in range · {toPrint.length} selected · ₹{money(grandTotal)}
              </h2>
              <div className="flex items-center gap-2">
                <button type="button" className="btn btn-ghost btn-sm" onClick={selectAll}>
                  Select all
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={selectNone}>
                  Clear
                </button>
              </div>
            </div>

            <div className="table-wrap border-0 shadow-none">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="w-10">
                      <input
                        type="checkbox"
                        className="field-check"
                        checked={allPicked}
                        onChange={() => (allPicked ? selectNone() : selectAll())}
                        aria-label="Select every invoice in the range"
                      />
                    </th>
                    <th className="w-24">INVOICE</th>
                    <th className="w-28">DATE</th>
                    <th>PARTY</th>
                    <th className="w-32">TYPE</th>
                    <th className="w-28 text-right">AMOUNT</th>
                    <th className="w-16" />
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => (
                    <tr key={inv._id} className={picked.has(inv._id) ? undefined : 'opacity-55'}>
                      <td>
                        <input
                          type="checkbox"
                          className="field-check"
                          checked={picked.has(inv._id)}
                          onChange={() => toggle(inv._id)}
                          aria-label={`Print invoice ${inv.invoiceNo}`}
                        />
                      </td>
                      <td className="num font-medium">{inv.invoiceNo}</td>
                      <td>{inv.date ? new Date(inv.date).toLocaleDateString('en-IN') : '—'}</td>
                      <td className="truncate">{inv.customer?.name || '—'}</td>
                      <td>{typeLabel(inv)}</td>
                      <td className="num">{money(inv.finalAmount)}</td>
                      <td className="text-center">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => only(inv._id)}
                          title="Print this invoice on its own"
                        >
                          Only
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {total > invoices.length && (
              <div className="panel-body pt-0">
                <p className="field-hint">
                  Showing the first {invoices.length} of {total}. Narrow the range to reach the rest.
                </p>
              </div>
            )}
          </section>
        )}
      </div>

      {toPrint.length > 0 && (
        <div className="px-3 sm:px-4">
          {toPrint.map((inv) => (
            <div key={inv._id} className="invoice-print-page">
              <InvoiceDocument invoice={inv} isRollStationary={options.rollStationary} />
            </div>
          ))}
        </div>
      )}
    </>
  );
};

export default Page;
