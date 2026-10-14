'use client';
import React, { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { LINE_KINDS, LINE_KIND_LABELS, bomCost, bomProblems } from '@/lib/bom.mjs';
import ItemSearch from '@/components/billing/ItemSearch';

/**
 * The formula form -- Sigfa's FrmBOM, under Masters > Misc > Bill of Material.
 *
 * Three things on this screen are worth explaining, because each is a
 * deliberate departure from how Sigfa's own screen behaves:
 *
 *   1. THE HEADER IS A HEADER. Sigfa's FMAST repeats the output item, its unit
 *      and FORQTY on every row, so a half-finished edit can leave rows that
 *      disagree about what the formula makes. Here they are typed once.
 *
 *   2. NO RATE COLUMN. Sigfa has FRATE on each line. The costing below reads
 *      each component's cost from the item master instead, live, and names the
 *      ones with no price rather than counting them as free. A rate typed onto
 *      a formula is a rate nobody refreshes.
 *
 *   3. THE PROBLEMS ARE SHOWN BEFORE SAVING, from the same module the server
 *      validates with (lib/bom.mjs). Not instead of the server check -- the
 *      server runs it again, and also checks things only it can see, like a
 *      duplicate name or a loop across formulas.
 */

const qty = (n) => String(parseFloat((Number(n) || 0).toFixed(3)));
const money = (n) =>
  new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    Number(n) || 0
  );

const blankLine = () => ({ itemName: '', kind: 'material', quantity: '', note: '' });

function BomForm() {
  const router = useRouter();
  const params = useSearchParams();
  const editingId = params.get('id');

  const [items, setItems] = useState([]);
  const [form, setForm] = useState({
    name: '',
    outputItem: '',
    forQuantity: '1',
    remarks: '',
    hold: false,
  });
  const [lines, setLines] = useState([blankLine()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [exploded, setExploded] = useState(null);

  // The item master, for the pickers and for the costing. One fetch; the
  // costing below is then arithmetic rather than a round trip per keystroke.
  useEffect(() => {
    (async () => {
      try {
        // get-item, not item: /api/item is a POST that looks ONE item up.
        // Every other form here reads the master from this endpoint.
        const res = await fetch('/api/get-item');
        const data = await res.json();
        setItems(Array.isArray(data.item) ? data.item : []);
      } catch {
        setError('Could not load the item master.');
      }
    })();
  }, []);

  const loadExisting = useCallback(async () => {
    if (!editingId) return;
    try {
      const res = await fetch(`/api/get-bom?id=${encodeURIComponent(editingId)}&expand=1`);
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Could not load that formula.');
        return;
      }
      const bom = data.bom;
      setForm({
        name: bom.name || '',
        outputItem: bom.outputItem || '',
        forQuantity: String(bom.forQuantity ?? '1'),
        remarks: bom.remarks || '',
        hold: Boolean(bom.hold),
      });
      setLines(
        (bom.lines || []).length
          ? bom.lines.map((l) => ({
              itemName: l.itemName || '',
              kind: l.kind || 'material',
              quantity: String(l.quantity ?? ''),
              note: l.note || '',
            }))
          : [blankLine()]
      );
      setExploded(data.exploded || null);
    } catch (err) {
      setError(err.message || 'Could not load that formula.');
    }
  }, [editingId]);

  useEffect(() => {
    loadExisting();
  }, [loadExisting]);

  const costOf = useMemo(() => {
    const map = new Map(
      items.map((i) => [String(i.name || '').trim().toLowerCase(), Number(i.cost) || 0])
    );
    return (name) => map.get(String(name || '').trim().toLowerCase()) || 0;
  }, [items]);

  const unitOf = useMemo(() => {
    const map = new Map(
      items.map((i) => [String(i.name || '').trim().toLowerCase(), String(i.unit || '')])
    );
    return (name) => map.get(String(name || '').trim().toLowerCase()) || '';
  }, [items]);

  const candidate = useMemo(
    () => ({
      name: form.name,
      outputItem: form.outputItem,
      forQuantity: Number(form.forQuantity),
      lines: lines
        .filter((l) => String(l.itemName || '').trim())
        .map((l) => ({ ...l, quantity: Number(l.quantity) })),
    }),
    [form, lines]
  );

  const problems = useMemo(() => bomProblems(candidate), [candidate]);

  const costing = useMemo(
    () =>
      bomCost({
        lines: candidate.lines,
        outputQuantity: candidate.forQuantity,
        costOf,
      }),
    [candidate, costOf]
  );

  const setLine = (i, patch) =>
    setLines((rows) => rows.map((row, n) => (n === i ? { ...row, ...patch } : row)));

  const addLine = () => setLines((rows) => [...rows, blankLine()]);

  const dropLine = (i) =>
    setLines((rows) => (rows.length === 1 ? [blankLine()] : rows.filter((_, n) => n !== i)));

  const save = async () => {
    setError('');
    setNotice('');
    if (problems.length) {
      setError(problems[0]);
      return;
    }
    setSaving(true);
    try {
      const endpoint = editingId ? '/api/bom-alter' : '/api/bom-add';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: editingId || undefined,
          name: form.name,
          outputItem: form.outputItem,
          forQuantity: Number(form.forQuantity),
          remarks: form.remarks,
          hold: form.hold,
          lines: candidate.lines,
        }),
      });
      const data = await res.json();
      if (data.success) router.push('/bom');
      else setError(data.error || data.message || 'Could not save the formula.');
    } catch (err) {
      setError(err.message || 'Could not save the formula.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-5xl p-4 sm:p-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title text-xl font-semibold">
            {editingId ? 'Edit formula' : 'New formula'}
          </h1>
          <p className="page-subtitle">
            What one item is made of. Enter the lines for a whole batch — the production
            entry scales them.
          </p>
        </div>
        <button type="button" className="btn btn-secondary" onClick={() => router.push('/bom')}>
          Back to formulas
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-4 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm">
          {notice}
        </div>
      )}

      <div className="panel mb-4">
        <div className="panel-head">
          <div className="panel-title">The formula</div>
        </div>
        <div className="panel-body grid grid-cols-1 gap-4 sm:grid-cols-4">
          <div className="field sm:col-span-2">
            <label className="field-label mb-1.5 block">Formula name</label>
            <input
              className="field-input"
              placeholder="e.g. Bracket 50x50"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <p className="field-hint">Must be unique. Two formulas cannot share a name.</p>
          </div>

          <div className="field">
            {/* The formula's output. A labelled field rather than a cell, so
                the field shape -- but with no hint, since F2 belongs to the
                billing screen. */}
            <ItemSearch
              items={items}
              label="Makes"
              placeholder="Item produced"
              value={form.outputItem}
              onQueryChange={(text) => setForm({ ...form, outputItem: text })}
              onPick={(item) => setForm({ ...form, outputItem: item.name })}
              priceOf={(item) => Number(item.cost) || 0}
              hint=""
              emptyHint=""
            />
          </div>

          <div className="field">
            <label className="field-label mb-1.5 block">
              For quantity {form.outputItem && unitOf(form.outputItem)}
            </label>
            <input
              className="field-input"
              type="number"
              min="0"
              step="0.001"
              value={form.forQuantity}
              onChange={(e) => setForm({ ...form, forQuantity: e.target.value })}
            />
            <p className="field-hint">The output the lines below produce.</p>
          </div>

          <div className="field sm:col-span-3">
            <label className="field-label mb-1.5 block">Remarks</label>
            <input
              className="field-input"
              value={form.remarks}
              onChange={(e) => setForm({ ...form, remarks: e.target.value })}
            />
          </div>

          <div className="field">
            <label className="mt-7 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="field-check"
                checked={form.hold}
                onChange={(e) => setForm({ ...form, hold: e.target.checked })}
              />
              <span>On hold</span>
            </label>
            <p className="field-hint">Kept out of the production picker.</p>
          </div>
        </div>
      </div>

      <div className="panel mb-4">
        <div className="panel-head flex items-center justify-between">
          <div className="panel-title">Lines</div>
          <button type="button" className="btn btn-sm btn-secondary" onClick={addLine}>
            Add line
          </button>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Kind</th>
                <th className="num">Quantity</th>
                <th>Unit</th>
                <th className="num">Rate (master)</th>
                <th className="num">Value</th>
                <th>Note</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((line, i) => {
                const rate = costOf(line.itemName);
                const value = (Number(line.quantity) || 0) * rate;
                return (
                  <tr key={i}>
                    <td>
                      {/* Was an `<input list>` over a `<datalist>`, which
                          took any text at all -- a component misspelt here
                          costs a formula that explodes to nothing. The
                          cell variant portals its list, because this grid
                          sits in an overflow container that would clip it. */}
                      <ItemSearch
                        variant="cell"
                        items={items}
                        label="Component"
                        placeholder="Component"
                        value={line.itemName}
                        onQueryChange={(text) => setLine(i, { itemName: text })}
                        onPick={(item) => setLine(i, { itemName: item.name })}
                        priceOf={(item) => Number(item.cost) || 0}
                        stockOf={(item) => Number(item.lastQuantity)}
                        inputClassName="field-input-sm w-full"
                        emptyHint=""
                      />
                    </td>
                    <td>
                      <select
                        className="field-select"
                        value={line.kind}
                        onChange={(e) => setLine(i, { kind: e.target.value })}
                      >
                        {LINE_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {LINE_KIND_LABELS[k]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="num">
                      <input
                        className="field-input-sm text-right"
                        type="number"
                        min="0"
                        step="0.001"
                        value={line.quantity}
                        onChange={(e) => setLine(i, { quantity: e.target.value })}
                      />
                    </td>
                    <td>{unitOf(line.itemName) || '—'}</td>
                    <td className="num">{rate ? money(rate) : <span title="No cost in the item master">—</span>}</td>
                    <td className="num">{rate ? money(value) : '—'}</td>
                    <td>
                      <input
                        className="field-input-sm"
                        value={line.note}
                        onChange={(e) => setLine(i, { note: e.target.value })}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => dropLine(i)}
                        aria-label="Remove line"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-4">
        <div className="stat-card">
          <div className="stat-label">Material</div>
          <div className="stat-value">₹ {money(costing.materialValue)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Wastage</div>
          <div className="stat-value">₹ {money(costing.wastageValue)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">By-products recovered</div>
          <div className="stat-value">− ₹ {money(costing.byproductValue)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            Cost per {form.outputItem ? unitOf(form.outputItem) || 'unit' : 'unit'}
          </div>
          <div className="stat-value">₹ {money(costing.costPerUnit)}</div>
        </div>
      </div>

      {/* The honest part. A cost computed over four of seven lines is not a
          cost, and saying so is the whole reason bomCost returns this. */}
      {costing.missingCosts.length > 0 && (
        <div className="mb-4 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm">
          Costed on {costing.costedLines} of {costing.totalLines} lines. No cost in the item
          master for: {costing.missingCosts.join(', ')}.
        </div>
      )}

      {problems.length > 0 && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <ul className="list-inside list-disc space-y-1">
            {problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Sigfa's "With Sub Formula", shown read-only: what this formula really
          consumes once every component that has a formula of its own has been
          broken down. */}
      {exploded && exploded.lines?.length > 0 && (
        <div className="panel mb-4">
          <div className="panel-head">
            <div className="panel-title">Broken down to raw materials</div>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Kind</th>
                  <th className="num">Quantity</th>
                  <th>Via</th>
                </tr>
              </thead>
              <tbody>
                {exploded.lines.map((l, i) => (
                  <tr key={i}>
                    <td style={{ paddingLeft: `${0.75 + (l.depth || 0) * 1}rem` }}>{l.itemName}</td>
                    <td>{LINE_KIND_LABELS[l.kind] || l.kind}</td>
                    <td className="num">
                      {qty(l.quantity)} {l.unit}
                    </td>
                    <td className="text-muted-foreground">{l.via}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {exploded.warnings?.length > 0 && (
            <div className="panel-body text-sm text-muted-foreground">
              {exploded.warnings.map((w, i) => (
                <p key={i}>{w}</p>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button type="button" className="btn btn-secondary" onClick={() => router.push('/bom')}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={save}
          disabled={saving || problems.length > 0}
        >
          {saving ? 'Saving…' : editingId ? 'Update formula' : 'Save formula'}
        </button>
      </div>
    </div>
  );
}

export default function BomAddPage() {
  // useSearchParams needs a Suspense boundary in the App Router, the same way
  // every other page here wraps it (components/OrderSearchParams.jsx).
  return (
    <Suspense fallback={null}>
      <BomForm />
    </Suspense>
  );
}
