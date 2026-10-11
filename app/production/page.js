'use client';
import React, { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { LINE_KIND_LABELS } from '@/lib/bom.mjs';

/**
 * The production entry -- Sigfa's Production voucher (MKEY 'FR').
 *
 * Pick a formula, say how much was made, and the server explodes it: this page
 * never does the arithmetic. That is the point of /api/bom-explode existing
 * separately from /api/production-add -- the figures shown here and the figures
 * saved come from one implementation, so they cannot disagree.
 *
 * The lines ARE editable before saving, as Sigfa's are unless its "Lock Raw
 * Material Detail" option is set: a batch that actually used a bit more of
 * something should be recorded as it happened, not as the recipe says. Edited
 * quantities are kept; rates are not -- those always come from the item master
 * on the server, so a client cannot post its own costs.
 *
 * SHORT STOCK IS A WARNING, NOT A BLOCK. A shop booking production that
 * already happened on the floor, before the purchase bill for its raw material
 * has been entered, is doing something completely ordinary. Refusing would
 * mean refusing to record something physically true -- so the shortfall is
 * named and the decision is left to the person.
 */

const qty = (n) => String(parseFloat((Number(n) || 0).toFixed(3)));
const money = (n) =>
  new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    Number(n) || 0
  );
const asDate = (v) => (v ? new Date(v).toLocaleDateString('en-IN') : '—');

/** Today, as the IST calendar day -- the same rule lib/istDate.mjs applies. */
const todayIst = () => {
  const now = new Date();
  const ist = new Date(now.getTime() + (5 * 60 + 30) * 60 * 1000);
  return ist.toISOString().slice(0, 10);
};

function ProductionScreen() {
  const router = useRouter();
  const params = useSearchParams();

  const [boms, setBoms] = useState([]);
  const [register, setRegister] = useState([]);
  const [loadingRegister, setLoadingRegister] = useState(true);

  const [form, setForm] = useState({
    bomName: params.get('bom') || '',
    quantity: '',
    date: todayIst(),
    partyName: '',
    remarks: '',
    nested: true,
  });

  // The server's answer: lines, costing, shortfalls, warnings. Null until a
  // formula and a quantity have both been given.
  const [plan, setPlan] = useState(null);
  const [lines, setLines] = useState([]);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const loadBoms = useCallback(async () => {
    try {
      const res = await fetch('/api/bom?counts=0');
      const data = await res.json();
      if (data.success) setBoms((data.boms || []).filter((b) => !b.hold));
    } catch {
      /* the formula picker is a convenience; the name can be typed */
    }
  }, []);

  const loadRegister = useCallback(async () => {
    setLoadingRegister(true);
    try {
      const res = await fetch('/api/production');
      const data = await res.json();
      if (data.success) setRegister(data.productions || []);
    } catch {
      /* the register is secondary to the form above it */
    } finally {
      setLoadingRegister(false);
    }
  }, []);

  useEffect(() => {
    loadBoms();
    loadRegister();
  }, [loadBoms, loadRegister]);

  const explode = async () => {
    setError('');
    setPlan(null);
    setLines([]);

    const quantity = Number(form.quantity);
    if (!form.bomName.trim()) {
      setError('Pick a formula.');
      return;
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setError('Enter how much was produced.');
      return;
    }

    setBusy(true);
    try {
      const res = await fetch('/api/bom-explode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bomName: form.bomName, quantity, nested: form.nested }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Could not work out the materials.');
        return;
      }
      setPlan(data);
      setLines(data.lines.map((l) => ({ ...l, quantity: String(l.quantity) })));
    } catch (err) {
      setError(err.message || 'Could not work out the materials.');
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!plan) return;
    setError('');
    setSaving(true);
    try {
      const res = await fetch('/api/production-add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bomName: plan.bom.name,
          outputItem: plan.bom.outputItem,
          quantity: Number(form.quantity),
          date: form.date,
          partyName: form.partyName,
          remarks: form.remarks,
          nested: form.nested,
          // The lines as they stand on screen, edits included. Rates are
          // deliberately not sent -- the server reads them from the master.
          lines: lines.map((l) => ({
            itemName: l.itemName,
            kind: l.kind,
            quantity: Number(l.quantity),
            unit: l.unit,
            depth: l.depth,
            via: l.via,
            source: Array.isArray(l.paths) ? l.paths.join(' | ') : l.source,
          })),
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Could not save the entry.');
        return;
      }
      setPlan(null);
      setLines([]);
      setForm((f) => ({ ...f, quantity: '', remarks: '' }));
      await loadRegister();
    } catch (err) {
      setError(err.message || 'Could not save the entry.');
    } finally {
      setSaving(false);
    }
  };

  const deleteEntry = async (entry) => {
    setError('');
    const res = await fetch(`/api/delete-production?id=${encodeURIComponent(entry._id)}`, {
      method: 'POST',
    });
    const data = await res.json();
    if (data.success) await loadRegister();
    else setError(data.error || data.message || 'Could not delete the entry.');
  };

  const chosen = boms.find((b) => b.name === form.bomName);

  return (
    <div className="mx-auto w-full max-w-7xl p-4 sm:p-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title text-xl font-semibold">Production</h1>
          <p className="page-subtitle">
            Issues the materials and receives the finished item, in one entry.
          </p>
        </div>
        <button type="button" className="btn btn-secondary" onClick={() => router.push('/bom')}>
          Bills of Material
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="panel mb-4">
        <div className="panel-head">
          <div className="panel-title">New entry</div>
        </div>
        <div className="panel-body grid grid-cols-1 gap-4 sm:grid-cols-5">
          <div className="field sm:col-span-2">
            <label className="field-label mb-1.5 block">Formula</label>
            <select
              className="field-select"
              value={form.bomName}
              onChange={(e) => {
                setForm({ ...form, bomName: e.target.value });
                setPlan(null);
              }}
            >
              <option value="">Pick a formula…</option>
              {boms.map((b) => (
                <option key={b._id} value={b.name}>
                  {b.name} → {b.outputItem}
                </option>
              ))}
            </select>
            {chosen && (
              <p className="field-hint">
                Written for {qty(chosen.forQuantity)} {chosen.outputUnit}.
              </p>
            )}
          </div>

          <div className="field">
            <label className="field-label mb-1.5 block">Produced</label>
            <input
              className="field-input"
              type="number"
              min="0"
              step="0.001"
              value={form.quantity}
              onChange={(e) => {
                setForm({ ...form, quantity: e.target.value });
                setPlan(null);
              }}
            />
          </div>

          <div className="field">
            <label className="field-label mb-1.5 block">Date</label>
            <input
              className="field-input"
              type="date"
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
            />
          </div>

          <div className="field">
            <label className="field-label mb-1.5 block">Party (optional)</label>
            <input
              className="field-input"
              placeholder="Job work for…"
              value={form.partyName}
              onChange={(e) => setForm({ ...form, partyName: e.target.value })}
            />
          </div>

          <div className="field sm:col-span-4">
            <label className="field-label mb-1.5 block">Remarks</label>
            <input
              className="field-input"
              value={form.remarks}
              onChange={(e) => setForm({ ...form, remarks: e.target.value })}
            />
          </div>

          <div className="field">
            {/* Sigfa's "With Sub Formula". */}
            <label className="field-check mt-7">
              <input
                type="checkbox"
                checked={form.nested}
                onChange={(e) => {
                  setForm({ ...form, nested: e.target.checked });
                  setPlan(null);
                }}
              />
              <span>Break down sub-formulas</span>
            </label>
          </div>
        </div>
        <div className="panel-body flex justify-end border-t border-border">
          <button type="button" className="btn btn-primary" onClick={explode} disabled={busy}>
            {busy ? 'Working it out…' : 'Work out materials'}
          </button>
        </div>
      </div>

      {plan && (
        <>
          {plan.shortfalls.length > 0 && (
            <div className="mb-4 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm">
              <p className="mb-1 font-medium">Not enough stock for:</p>
              <ul className="list-inside list-disc">
                {plan.shortfalls.map((s) => (
                  <li key={s.itemName}>
                    {s.itemName} — need {qty(s.need)}, have {qty(s.have)} (short {qty(s.short)})
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-muted-foreground">
                This does not stop the entry. Stock booked after the fact is ordinary; the
                stock report will show the negative honestly.
              </p>
            </div>
          )}

          {plan.warnings.length > 0 && (
            <div className="mb-4 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm">
              {plan.warnings.map((w, i) => (
                <p key={i}>{w}</p>
              ))}
            </div>
          )}

          <div className="panel mb-4">
            <div className="panel-head">
              <div className="panel-title">
                {qty(form.quantity)} {plan.bom.outputUnit} of {plan.bom.outputItem} needs
              </div>
            </div>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Kind</th>
                    <th className="num">Quantity</th>
                    <th>Unit</th>
                    <th>From</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, i) => (
                    <tr key={`${line.itemName}-${line.kind}`}>
                      <td style={{ paddingLeft: `${0.75 + (line.depth || 0) * 1}rem` }}>
                        {line.itemName}
                      </td>
                      <td>{LINE_KIND_LABELS[line.kind] || line.kind}</td>
                      <td className="num">
                        <input
                          className="field-input-sm text-right"
                          type="number"
                          min="0"
                          step="0.001"
                          value={line.quantity}
                          onChange={(e) =>
                            setLines((rows) =>
                              rows.map((r, n) =>
                                n === i ? { ...r, quantity: e.target.value } : r
                              )
                            )
                          }
                        />
                      </td>
                      <td>{line.unit || '—'}</td>
                      <td className="text-muted-foreground">
                        {line.via}
                        {line.mergedFrom > 1 && ` (merged from ${line.mergedFrom})`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-4">
            <div className="stat-card">
              <div className="stat-label">Material</div>
              <div className="stat-value">₹ {money(plan.costing.materialValue)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Wastage</div>
              <div className="stat-value">₹ {money(plan.costing.wastageValue)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">By-products recovered</div>
              <div className="stat-value">− ₹ {money(plan.costing.byproductValue)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Cost per {plan.bom.outputUnit || 'unit'}</div>
              <div className="stat-value">₹ {money(plan.costing.costPerUnit)}</div>
            </div>
          </div>

          {plan.costing.missingCosts.length > 0 && (
            <div className="mb-4 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm">
              Costed on {plan.costing.costedLines} of {plan.costing.totalLines} lines. No cost
              in the item master for: {plan.costing.missingCosts.join(', ')}.
            </div>
          )}

          <div className="mb-8 flex justify-end gap-2">
            <button type="button" className="btn btn-secondary" onClick={() => setPlan(null)}>
              Start again
            </button>
            <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save production'}
            </button>
          </div>
        </>
      )}

      <h2 className="section-title mb-3">Register</h2>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>No</th>
              <th>Date</th>
              <th>Made</th>
              <th className="num">Quantity</th>
              <th>Formula</th>
              <th>Party</th>
              <th className="num">Lines</th>
              <th className="num">Cost</th>
              <th className="num">Per unit</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {loadingRegister ? (
              <tr>
                <td colSpan={10}>
                  <div className="empty-state">Loading…</div>
                </td>
              </tr>
            ) : register.length === 0 ? (
              <tr>
                <td colSpan={10}>
                  <div className="empty-state">No production entries yet.</div>
                </td>
              </tr>
            ) : (
              register.map((entry) => (
                <tr key={entry._id}>
                  <td className="font-medium">{entry.docNo}</td>
                  <td>{asDate(entry.date)}</td>
                  <td>{entry.outputItem}</td>
                  <td className="num">
                    {qty(entry.outputQuantity)} {entry.outputUnit}
                  </td>
                  <td>{entry.bomName || '—'}</td>
                  <td>{entry.partyName || '—'}</td>
                  <td className="num">{entry.lineCount}</td>
                  <td className="num">
                    ₹ {money(entry.netCost)}
                    {entry.missingCosts?.length > 0 && (
                      <span title={`No cost for: ${entry.missingCosts.join(', ')}`}> *</span>
                    )}
                  </td>
                  <td className="num">₹ {money(entry.costPerUnit)}</td>
                  <td>
                    <div className="flex justify-end">
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={() => deleteEntry(entry)}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="field-hint mt-2">
        Deleting an entry removes the stock it moved, in the same transaction. An asterisk
        beside a cost means some line had no price in the item master when it was saved.
      </p>
    </div>
  );
}

export default function ProductionPage() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={null}>
      <ProductionScreen />
    </Suspense>
  );
}
