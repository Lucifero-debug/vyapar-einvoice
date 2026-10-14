'use client';
import React, { useEffect, useState } from 'react';
import { CHALLAN_KINDS, pickFromChallans, pickKey } from '@/lib/challanStatus.mjs';
import { trim as trimQty } from '@/lib/orderStatus.mjs';

/**
 * "Pending Challan" on the sale and purchase screens -- SIGFA's picker of
 * unbilled challan lines (lib/challanStatus.mjs).
 *
 * Lists the party's pending challans with every unbilled line and a "Bill
 * now" quantity, pre-filled with what is pending. Ticking a challan fills
 * its lines; the clerk can lower any quantity to bill part of it. The rule
 * module does the checking, so this screen computes nothing about billing.
 */
export default function ChallanPicker({ type, partyName, items, recalc, onClose, onPick }) {
  const [challans, setChallans] = useState(null);
  const [picks, setPicks] = useState({});
  const [error, setError] = useState('');
  const label = CHALLAN_KINDS[type]?.label || 'Challan';

  useEffect(() => {
    let live = true;
    const qs = new URLSearchParams({ type });
    if (partyName) qs.set('customer', partyName);
    fetch(`/api/challan-pending?${qs.toString()}`)
      .then((r) => r.json())
      .then((d) => {
        if (!live) return;
        if (!d.success) throw new Error(d.error || 'Could not load pending challans.');
        setChallans(d.challans || []);
      })
      .catch((e) => {
        if (!live) return;
        setChallans([]);
        setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [type, partyName]);

  const setChallanAll = (challan, on) =>
    setPicks((p) => {
      const next = { ...p };
      for (const line of challan.lines) next[pickKey(challan, line)] = on ? line.quantity : '';
      return next;
    });

  const isTicked = (challan) => challan.lines.some((line) => Number(picks[pickKey(challan, line)]) > 0);

  const apply = () => {
    setError('');
    const { lines, problems, used } = pickFromChallans({ challans: challans || [], picks, items, recalc });
    if (problems.length) return setError(problems.join(' '));
    if (!lines.length) return setError('Tick a challan, or set a quantity on at least one line.');
    onPick({ lines, used });
  };

  return (
    <div className="modal-overlay no-print" role="dialog" aria-modal="true" aria-label={`Pending ${label}`}>
      <div className="modal-card max-w-4xl">
        <h2 className="modal-title mb-1">Pending {label}</h2>
        <p className="field-hint mb-4">
          Tick a challan to bill all of it, or lower a quantity to bill part. What is left stays pending
          on the challan.
        </p>

        {error && (
          <div className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {challans === null ? (
          <div className="empty-state">Loading pending challans…</div>
        ) : challans.length === 0 ? (
          <div className="empty-state">
            No pending {label.toLowerCase()}s{partyName ? ` for ${partyName}` : ''}.
          </div>
        ) : (
          <>
            <div className="mb-3 flex gap-2">
              <button type="button" className="btn btn-sm btn-secondary" onClick={() => challans.forEach((c) => setChallanAll(c, true))}>
                Select all challans
              </button>
              <button type="button" className="btn btn-sm btn-secondary" onClick={() => setPicks({})}>
                De-select all
              </button>
            </div>
            <div className="max-h-[55vh] space-y-4 overflow-y-auto">
              {challans.map((challan) => (
                <div key={`${challan.type}-${challan.challanNo}`} className="rounded-lg border border-border">
                  <label className="flex cursor-pointer flex-wrap items-center gap-3 border-b border-border px-3 py-2">
                    <input
                      type="checkbox"
                      checked={isTicked(challan)}
                      onChange={(e) => setChallanAll(challan, e.target.checked)}
                    />
                    <span className="font-medium">
                      {label} {challan.challanNo}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {challan.date ? new Date(challan.date).toLocaleDateString('en-IN') : ''} · {challan.customer?.name}
                    </span>
                    <span className="chip">{challan.stockEffect ? 'stock already moved' : 'no stock effect'}</span>
                  </label>
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Item</th>
                          <th className="num">Pending</th>
                          <th className="num">Rate</th>
                          <th className="num">GST %</th>
                          <th className="num">Bill now</th>
                        </tr>
                      </thead>
                      <tbody>
                        {challan.lines.map((line) => {
                          const k = pickKey(challan, line);
                          return (
                            <tr key={k}>
                              <td>{line.name}</td>
                              <td className="num">{trimQty(line.quantity)}</td>
                              <td className="num">{line.cost}</td>
                              <td className="num">{line.gstRate}</td>
                              <td className="num">
                                <input
                                  type="number"
                                  step="0.001"
                                  min="0"
                                  max={line.quantity}
                                  className="field-input field-input-sm num w-24"
                                  value={picks[k] ?? ''}
                                  placeholder="0"
                                  onChange={(e) => setPicks((p) => ({ ...p, [k]: e.target.value }))}
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={apply} disabled={!challans?.length}>
            Add to bill
          </button>
        </div>
      </div>
    </div>
  );
}
