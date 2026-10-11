'use client';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  MONEY_EPSILON,
  adjustmentSummary,
  allocationProblems,
  billKey,
  billTypeFor,
  lineAmount,
} from '@/lib/billAdjust.mjs';

/**
 * Settling one voucher line against particular bills.
 *
 * Sigfa's "Against Bill". Opened from a line on the voucher form; it shows
 * that party's unpaid bills of the right kind, oldest first, and lets the
 * amount be spread across them.
 *
 * WHICH BILLS depends on which way the money is going, and the component does
 * not decide that -- `billTypeFor` does, from the line's own debit and credit.
 * Money coming back from a customer settles SALE invoices; money paid out
 * settles PURCHASE invoices. Offering the wrong set would let a receipt be
 * adjusted against a bill the firm owes.
 *
 * THE FIGURES ARE THE SERVER'S. The outstanding on each bill, and the FIFO
 * suggestion, both come from /api/open-bills, which uses the same module the
 * save then validates with. A picker that offered an allocation the save
 * refused would be worse than no picker at all.
 *
 * PART OF A RECEIPT MAY BE LEFT ON ACCOUNT, which is what Sigfa does and what
 * anybody expects from a round-figure payment. The remainder is shown rather
 * than demanded.
 */

const fmt = (n) =>
  new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    Number(n) || 0
  );

const asDate = (v) => (v ? new Date(v).toLocaleDateString('en-IN') : '—');

export default function BillAdjust({ open, line, voucherId, onClose, onApply }) {
  const [bills, setBills] = useState([]);
  const [amounts, setAmounts] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [empty, setEmpty] = useState(false);

  const type = billTypeFor(line);
  const amount = lineAmount(line);

  const load = useCallback(async () => {
    if (!open || !line?.name || !type) return;
    setLoading(true);
    setError('');
    try {
      const qs = new URLSearchParams({ party: line.name, type, amount: String(amount) });
      if (voucherId) qs.set('voucher', voucherId);
      const res = await fetch(`/api/open-bills?${qs.toString()}`);
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Could not load the bills.');
        setBills([]);
        return;
      }
      setBills(data.bills || []);
      setEmpty(Boolean(data.empty));

      // Anything already allocated on this line is shown as it stands, so
      // reopening the picker does not quietly discard what was chosen.
      const existing = {};
      for (const a of line.allocations || []) existing[billKey(a)] = String(a.amount);
      setAmounts(existing);
    } catch (err) {
      setError(err.message || 'Could not load the bills.');
      setBills([]);
    } finally {
      setLoading(false);
    }
  }, [open, line, type, amount, voucherId]);

  useEffect(() => {
    load();
  }, [load]);

  /** What is typed, as the rules module reads it. */
  const allocations = useMemo(
    () =>
      bills
        .map((bill) => ({
          invoiceNo: bill.invoiceNo,
          invoiceType: bill.invoiceType,
          invoiceDate: bill.date,
          amount: Number(amounts[billKey(bill)]) || 0,
        }))
        .filter((a) => a.amount > MONEY_EPSILON),
    [bills, amounts]
  );

  // Checked here as well as on the server, from the same module -- so the
  // screen says why before the save does, not instead of it.
  const problems = useMemo(
    () => allocationProblems({ line, allocations, bills }),
    [line, allocations, bills]
  );

  const summary = useMemo(
    () => adjustmentSummary(line, allocations, bills),
    [line, allocations, bills]
  );

  const fillFifo = () => {
    // Sigfa's "Adjustment on FIFO Basis" -- oldest bill first. The list
    // arrives in that order from the server, so this walks it as given.
    let left = amount;
    const next = {};
    for (const bill of bills) {
      if (left <= MONEY_EPSILON) break;
      const take = Math.min(left, bill.outstanding);
      if (take <= MONEY_EPSILON) continue;
      next[billKey(bill)] = String(Math.round(take * 100) / 100);
      left = Math.round((left - take) * 100) / 100;
    }
    setAmounts(next);
  };

  if (!open) return null;

  return (
    <div className="modal-overlay">
      <div className="modal-card max-w-3xl">
        <div className="modal-title">
          Adjust against bills — {line?.name}
          <span className="block text-sm font-normal text-muted-foreground">
            {type === 'Purchase' ? 'Paid to a supplier' : 'Received from a customer'}, {fmt(amount)}
          </span>
        </div>

        {!type && (
          <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm">
            Enter a debit or a credit on this line first — which bills are offered depends on
            which way the money is going.
          </div>
        )}

        {error && (
          <div className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {loading && <div className="empty-state">Loading…</div>}

        {/* Sigfa: "No Pending Bills Found". */}
        {!loading && type && empty && (
          <div className="empty-state">
            No pending bills for {line?.name}. The whole amount stays on account.
          </div>
        )}

        {!loading && bills.length > 0 && (
          <>
            <div className="table-wrap max-h-[45vh] overflow-y-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Date</th>
                    <th className="num">Age</th>
                    <th className="num">Bill</th>
                    <th className="num">Outstanding</th>
                    <th className="num">Adjust</th>
                  </tr>
                </thead>
                <tbody>
                  {bills.map((bill) => {
                    const key = billKey(bill);
                    return (
                      <tr key={key}>
                        <td className="font-medium">{bill.invoiceNo}</td>
                        <td>{asDate(bill.date)}</td>
                        <td className="num">{bill.ageDays} d</td>
                        <td className="num">{fmt(bill.balanceDue)}</td>
                        <td className="num">
                          {fmt(bill.outstanding)}
                          {bill.allocated > 0 && (
                            <span className="field-hint block">
                              {fmt(bill.allocated)} already adjusted
                            </span>
                          )}
                        </td>
                        <td className="num">
                          <input
                            type="number"
                            step="0.01"
                            min="0"
                            max={bill.outstanding}
                            className="field-input-sm text-right"
                            value={amounts[key] ?? ''}
                            onChange={(e) =>
                              setAmounts((prev) => ({ ...prev, [key]: e.target.value }))
                            }
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="stat-card">
                <div className="stat-label">On this line</div>
                <div className="stat-value">{fmt(summary.amount)}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Adjusted</div>
                <div className="stat-value">{fmt(summary.allocated)}</div>
                <div className="field-hint">
                  {summary.billsTouched} of {summary.bills} bills
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-label">On account</div>
                <div className="stat-value">{fmt(summary.onAccount)}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Total outstanding</div>
                <div className="stat-value">{fmt(summary.outstandingTotal)}</div>
              </div>
            </div>

            {problems.length > 0 && (
              <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                <ul className="list-inside list-disc space-y-1">
                  {problems.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              </div>
            )}

            {problems.length === 0 && summary.onAccount > MONEY_EPSILON && (
              <p className="field-hint mt-2">
                {fmt(summary.onAccount)} stays on account — that is allowed, and the party
                balance moves by the full amount either way.
              </p>
            )}
          </>
        )}

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={fillFifo}
            disabled={loading || bills.length === 0}
            title="Fill the oldest bills first"
          >
            Oldest first
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setAmounts({})}
            disabled={loading || bills.length === 0}
          >
            Clear
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => onClose?.()}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={problems.length > 0}
            onClick={() => {
              onApply?.(allocations);
              onClose?.();
            }}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
