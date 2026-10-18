'use client';
import React, { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { LINE_KIND_LABELS } from '@/lib/bom.mjs';
import ItemSearch from '@/components/billing/ItemSearch';
import MasterShortcuts from '@/components/masters/MasterShortcuts';
import {
  defaultSeries,
  docTypeForStockKind,
  normalizeSeriesCode,
  seriesOptions,
} from '@/lib/series.mjs';
import {
  DEFAULT_KIND,
  SLIP_COLUMNS,
  isStockKind,
  kindOf,
  reversalOf,
  seriesUsed,
  slipAmount,
  slipDayName,
  slipTitle,
  slipTotal,
  stockKind,
} from '@/lib/stockVoucher.mjs';

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
  // The item master, for the goods vouchers' own item search. Fetched only
  // when this screen is one of them -- a production entry picks its items by
  // exploding a formula and has no use for it.
  const [items, setItems] = useState([]);
  // The parties, for the slip's Party box. Sigfa's is a lookup into CUSMAST;
  // this offers the same names while still accepting a one-off typed in.
  const [customers, setCustomers] = useState([]);
  const [register, setRegister] = useState([]);
  const [loadingRegister, setLoadingRegister] = useState(true);
  // The series master -- Sigfa's SubKey. Until it existed the Series box was
  // free text with a datalist built from the slips already written; that list
  // is still offered alongside this, so a firm's existing labels stay
  // pickable. See lib/series.mjs.
  const [seriesMaster, setSeriesMaster] = useState([]);

  // WHICH OF THE THREE this screen is. Sigfa keeps Production, Goods Issued
  // and Goods Received in one table under three MKEYs, and this is one screen
  // under three URLs for the same reason: the stock-writing, the alter and
  // the delete are identical, and a second copy of them is where a direction
  // gets inverted unnoticed.
  const askedKind = params.get('kind');
  const kind = isStockKind(askedKind) ? kindOf(askedKind) : DEFAULT_KIND;
  const config = stockKind(kind);

  const [form, setForm] = useState({
    bomName: params.get('bom') || '',
    quantity: '',
    date: todayIst(),
    partyName: '',
    remarks: '',
    nested: true,
    // Sigfa's slip header. Series is its SubKey; Store is recorded only --
    // this app holds stock in one place. See models/productionModel.js.
    series: '',
    store: '',
  });

  // The server's answer: lines, costing, shortfalls, warnings. Null until a
  // formula and a quantity have both been given.
  const [plan, setPlan] = useState(null);
  const [lines, setLines] = useState([]);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // The entry being changed, or null for a new one. An alter rewrites the
  // stock the entry moved, so it is not a different screen -- it is this one,
  // loaded with what was recorded.
  const [editing, setEditing] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [notice, setNotice] = useState('');

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
      const res = await fetch(`/api/production?kind=${encodeURIComponent(kind)}`);
      const data = await res.json();
      if (data.success) setRegister(data.productions || []);
    } catch {
      /* the register is secondary to the form above it */
    } finally {
      setLoadingRegister(false);
    }
  }, [kind]);

  // Sigfa shows the Slip No. on the blank form. A peek, not a reservation:
  // opening the slip and walking away must not burn a number and leave a gap
  // in the register.
  const [nextNo, setNextNo] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/next-production-no?kind=${encodeURIComponent(kind)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled && d.success) setNextNo(d.docNo);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [kind, register.length]);

  useEffect(() => {
    if (config.usesFormula) return;
    let cancelled = false;
    Promise.all([
      fetch('/api/get-item').then((r) => r.json()),
      fetch('/api/get-customer').then((r) => r.json()),
    ])
      .then(([itemData, customerData]) => {
        if (cancelled) return;
        setItems(itemData.item || []);
        setCustomers(customerData.customer || []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [config.usesFormula]);

  const loadSeries = useCallback(async () => {
    try {
      const res = await fetch('/api/get-series');
      const data = await res.json();
      if (data.success) setSeriesMaster(data.series || []);
    } catch {
      /* the box still offers whatever the slips already carry */
    }
  }, []);

  useEffect(() => {
    loadBoms();
    loadRegister();
    loadSeries();
  }, [loadBoms, loadRegister, loadSeries]);

  // Which document Sigfa's Series Master files this slip's series under:
  // 'FR' is its Production row, 'IS' Goods Issued, 'RS' Goods Received.
  const seriesDocType = docTypeForStockKind(kind);

  // The series marked default for this slip, on a BLANK form only. Never over
  // a slip being altered -- that would relabel a document that is already in
  // the register -- and never over a choice already made.
  useEffect(() => {
    if (editing) return;
    setForm((prev) => {
      if (prev.series) return prev;
      const preset = defaultSeries(seriesMaster, seriesDocType);
      return preset ? { ...prev, series: preset } : prev;
    });
  }, [seriesMaster, seriesDocType, editing]);

  // What the Series box offers: the master for this slip kind, then whatever
  // the slips already carry that the master does not hold.
  const chosenSeries = normalizeSeriesCode(form.series);
  const seriesChoices = (() => {
    const offered = seriesOptions(seriesMaster, seriesUsed(register), seriesDocType);
    // A value that is not one of the options makes a <select> render BLANK,
    // and because onChange never fires the slip would then be saved with its
    // series cleared. So a series this box is holding is always one of its own
    // options -- a slip altered after its series was deleted, say.
    if (chosenSeries && !offered.some((option) => option.code === chosenSeries)) {
      return [...offered, { code: chosenSeries, name: '', inMaster: false }];
    }
    return offered;
  })();

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
      // The same body either way; the id and the method are what differ.
      // `docNo` is deliberately not sent on an alter -- the number keys the
      // stock rows ("PRD-<docNo>"), and the route ignores it for that reason.
      const res = await fetch(editing ? '/api/production-alter' : '/api/production-add', {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(editing ? { id: editing._id } : {}),
          kind,
          // A goods issue or receipt has neither: its quantities are on its
          // lines, and the server refuses an output on a kind that has none.
          ...(config.usesFormula
            ? {
                bomName: plan.bom.name,
                outputItem: plan.bom.outputItem,
                quantity: Number(form.quantity),
              }
            : {}),
          date: form.date,
          partyName: form.partyName,
          // Sigfa's slip header. Rates are still not sent -- the server reads
          // them from the item master.
          series: chosenSeries,
          store: form.store,
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
        setError(data.error || `Could not ${editing ? 'update' : 'save'} the entry.`);
        return;
      }
      setNotice(data.message || '');
      setEditing(null);
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

  /**
   * Load a recorded entry back into the form.
   *
   * The register deliberately leaves the lines out of its payload, so this
   * fetches the entry in full. The lines that come back are the ones that were
   * SAVED -- not a fresh explosion of the formula, which may have been edited
   * since. A batch that used a bit more of something should keep saying so.
   */
  const loadForEdit = async (row) => {
    setError('');
    setNotice('');
    try {
      const res = await fetch(`/api/get-production?id=${encodeURIComponent(row._id)}`);
      const data = await res.json();
      const entry = data.production || data.entry;
      if (!data.success || !entry) {
        setError(data.error || 'Could not open that entry.');
        return;
      }

      setEditing(entry);
      setForm({
        bomName: entry.bomName || '',
        quantity: String(entry.outputQuantity ?? ''),
        date: entry.date ? new Date(entry.date).toISOString().slice(0, 10) : todayIst(),
        partyName: entry.partyName || '',
        remarks: entry.remarks || '',
        nested: true,
        // Normalized, because the box is a <select> and its options are. A
        // slip written as "mi" before the master existed would otherwise show
        // a blank Series and save with it cleared. The only thing this changes
        // in stored data is the letter case of a label.
        series: normalizeSeriesCode(entry.series),
        store: entry.store || '',
      });
      setLines(entry.lines || []);
      // The costing figures come off the ENTRY rather than from a fresh
      // explode call, for the same reason the lines do: re-exploding would
      // show the recipe's numbers in place of the batch's.
      setPlan({
        bom: { name: entry.bomName || '', outputItem: entry.outputItem },
        costing: {
          materialValue: entry.materialValue,
          wastageValue: entry.wastageValue,
          byproductValue: entry.byproductValue,
          netCost: entry.netCost,
          costPerUnit: entry.costPerUnit,
          missingCosts: entry.missingCosts || [],
        },
        shortfalls: [],
        warnings: entry.warnings || [],
      });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setError(err.message || 'Could not open that entry.');
    }
  };

  const cancelEdit = () => {
    setEditing(null);
    setPlan(null);
    setLines([]);
    setForm((f) => ({ ...f, quantity: '', remarks: '' }));
  };

  /**
   * Ask before deleting, and say what will actually move.
   *
   * A production entry moves stock in both directions at once, so a reversal
   * takes the finished goods back OUT and puts the materials back IN. This
   * used to be a single unconfirmed click, which silently rewrote inventory
   * in two directions with nothing on screen to say it had.
   *
   * The register leaves the lines out of its payload, so the entry is fetched
   * in full to list them -- reversalSummary works off what was SAVED, not off
   * what the formula now says.
   */
  const askDelete = async (row) => {
    setError('');
    setNotice('');
    try {
      const res = await fetch(`/api/get-production?id=${encodeURIComponent(row._id)}`);
      const data = await res.json();
      const entry = data.production || row;
      setConfirming({ entry, reversal: reversalOf(entry) });
    } catch {
      // The dialog still opens: refusing to confirm because a lookup failed
      // would leave no way to delete the entry at all. It just cannot list
      // the lines.
      setConfirming({ entry: row, reversal: reversalOf(row) });
    }
  };

  const doDelete = async () => {
    if (!confirming) return;
    setError('');
    setSaving(true);
    try {
      const res = await fetch(
        `/api/delete-production?id=${encodeURIComponent(confirming.entry._id)}`,
        { method: 'POST' }
      );
      const data = await res.json();
      if (!data.success) {
        setError(data.error || data.message || 'Could not delete the entry.');
        return;
      }
      setNotice(data.message || '');
      // An entry being edited that has just been deleted must not stay in the
      // form, or saving it would recreate it under a number that is gone.
      if (editing && editing._id === confirming.entry._id) cancelEdit();
      await loadRegister();
    } catch (err) {
      setError(err.message || 'Could not delete the entry.');
    } finally {
      setSaving(false);
      setConfirming(null);
    }
  };

  const chosen = boms.find((b) => b.name === form.bomName);

  return (
    <div className="mx-auto w-full max-w-7xl p-4 sm:p-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title text-xl font-semibold">{slipTitle(kind)}</h1>
          <p className="page-subtitle">{config.blurb}</p>
        </div>
        <button type="button" className="btn btn-secondary" onClick={() => router.push('/bom')}>
          Bills of Material
        </button>
      </div>

      {/* Which entry is being changed. Without this the form looks like a new
          one, and "Save" on what you believe is a blank form would quietly
          rewrite a recorded batch. */}
      {editing && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm">
          <span>
            Editing <span className="font-medium">production {editing.docNo}</span> of{' '}
            {asDate(editing.date)}. Saving replaces the stock it moved.
            {editing.editCount > 0 && (
              <span className="field-hint block">
                Changed {editing.editCount} time{editing.editCount === 1 ? '' : 's'} already.
              </span>
            )}
          </span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={cancelEdit}>
            Cancel edit
          </button>
        </div>
      )}

      {notice && (
        <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm">
          <span>{notice}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNotice('')}>
            Dismiss
          </button>
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {!config.usesFormula && (
        <div className="panel mb-4">
          <div className="panel-head">
            <div className="panel-title">{slipTitle(kind)}</div>
          </div>

          {/* === SIGFA'S SLIP HEADER, field for field ===
              Series, Slip No., Date, Store, Party -- in its order and with
              its wording. Slip No. and the day in brackets after the date are
              shown exactly as its form shows them. */}
          <div className="panel-body grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="field">
              <label className="field-label mb-1.5 block" htmlFor="slip-series">
                Series
              </label>
              {/* Sigfa backs this with a master -- its SubKey, seeded with MI,
                  MO and RMI -- and now so does this app. The options are that
                  master plus any series the slips already carry that it does
                  not hold, since this box was free text before it existed. */}
              <select
                id="slip-series"
                className="field-select"
                data-master-field="series"
                value={chosenSeries}
                onChange={(e) => setForm({ ...form, series: e.target.value })}
              >
                <option value="">None</option>
                {seriesChoices.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.name ? `${option.code} — ${option.name}` : option.code}
                    {option.inMaster ? '' : ' (not in the master)'}
                  </option>
                ))}
              </select>
              <p className="field-hint mt-1">
                Alt+A adds a series without leaving the slip. It labels the slip
                and groups the register — it does not number it.
              </p>
            </div>

            <div className="field">
              <label className="field-label mb-1.5 block">Slip No.</label>
              <div className="field-input flex items-center bg-muted/40">
                {editing ? editing.docNo : nextNo ?? '—'}
              </div>
              <p className="field-hint mt-1">
                {editing ? 'Fixed once saved.' : 'Settled when you save.'}
              </p>
            </div>

            <div className="field">
              <label className="field-label mb-1.5 block" htmlFor="slip-date">
                Date
              </label>
              <div className="flex items-center gap-2">
                <input
                  id="slip-date"
                  type="date"
                  className="field-input"
                  value={form.date}
                  onChange={(e) => setForm({ ...form, date: e.target.value })}
                />
                {/* Sigfa prints the day in brackets after the date. */}
                <span className="field-hint whitespace-nowrap">
                  ({slipDayName(form.date) || '—'})
                </span>
              </div>
            </div>

            <div className="field">
              <label className="field-label mb-1.5 block" htmlFor="slip-store">
                Store
              </label>
              <input
                id="slip-store"
                type="text"
                className="field-input"
                value={form.store}
                placeholder="Optional"
                onChange={(e) => setForm({ ...form, store: e.target.value })}
              />
              {/* Said plainly, because the field invites the opposite
                  assumption: Sigfa holds stock per store and this app does
                  not. Recording where goods went is still worth doing. */}
              <p className="field-hint mt-1">
                Recorded on the slip. Stock is held in one place, so the stock
                report will not separate stores.
              </p>
            </div>

            <div className="field">
              <label className="field-label mb-1.5 block" htmlFor="slip-party">
                Party
              </label>
              <input
                id="slip-party"
                type="text"
                className="field-input"
                list="slip-parties"
                value={form.partyName}
                placeholder="Optional"
                onChange={(e) => setForm({ ...form, partyName: e.target.value })}
              />
              <datalist id="slip-parties">
                {customers.map((c) => (
                  <option key={c._id || c.name} value={c.name} />
                ))}
              </datalist>
              <p className="field-hint mt-1">
                {kind === 'IS' ? 'Who the goods went to.' : 'Who they came from.'}
              </p>
            </div>

            <div className="field">
              <ItemSearch
                items={items}
                label="Add item"
                priceOf={(item) => Number(item.cost) || 0}
                stockOf={(item) => Number(item.lastQuantity)}
                onPick={(item) => {
                  setLines((rows) => [
                    ...rows,
                    {
                      itemName: item.name,
                      // Every line on a goods slip moves the way the SLIP
                      // moves, so the line's own kind is not asked -- see
                      // lineDirection in lib/stockVoucher.mjs. Stored as
                      // "material" because that is the model's default.
                      kind: 'material',
                      quantity: '1',
                      unit: item.unit || '',
                      // SHOWN, NOT SENT. The save deliberately omits rates and
                      // the server reads them from the item master, so a
                      // client cannot post its own costs. This is here only so
                      // the Amount column is filled in before saving.
                      rate: Number(item.cost) || 0,
                      depth: 0,
                      via: '',
                    },
                  ]);
                  setPlan(
                    (p) =>
                      p || { bom: { name: '', outputItem: '' }, costing: null, shortfalls: [], warnings: [] }
                  );
                }}
              />
            </div>
          </div>
        </div>
      )}

      {config.usesFormula && (
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
            {/* "Quantity", to match the column it fills in the register
                below -- the field and the column were two names for the
                same number. */}
            <label className="field-label mb-1.5 block">Quantity</label>
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
            <label className="mt-7 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="field-check"
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
      )}

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
                    {config.usesFormula ? (
                      <th>Item</th>
                    ) : (
                      <>
                        <th className="num w-12">S.No.</th>
                        <th>Item Name</th>
                      </>
                    )}
                    {config.usesFormula ? (
                      <>
                        <th>Kind</th>
                        <th className="num">Quantity</th>
                        <th>Unit</th>
                        <th>From</th>
                      </>
                    ) : (
                      <>
                        {/* Sigfa's Issue Slip and Receipt Slip grid, column
                            for column. The first column is the row number;
                            Item Name is the one already rendered above. */}
                        <th>Unit</th>
                        <th className="num">Quantity</th>
                        <th className="num">Rate</th>
                        <th className="num">Amount</th>
                        <th />
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, i) => {
                    const onQuantity = (e) =>
                      setLines((rows) =>
                        rows.map((r, n) => (n === i ? { ...r, quantity: e.target.value } : r))
                      );

                    if (!config.usesFormula) {
                      return (
                        <tr key={`${line.itemName}-${i}`}>
                          <td className="num text-muted-foreground">{i + 1}</td>
                          <td className="font-medium">{line.itemName}</td>
                          <td>{line.unit || '—'}</td>
                          <td className="num">
                            <input
                              className="field-input-sm text-right"
                              type="number"
                              min="0"
                              step="0.001"
                              value={line.quantity}
                              onChange={onQuantity}
                            />
                          </td>
                          {/* Rate is the item master's cost, shown so the
                              Amount column is filled in. It is NOT sent: the
                              server reads it from the master on save, so a
                              client cannot post its own costs. */}
                          <td className="num text-muted-foreground">{money(line.rate)}</td>
                          <td className="num">{money(slipAmount(line))}</td>
                          <td className="num">
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm text-destructive hover:text-destructive"
                              onClick={() =>
                                setLines((rows) => rows.filter((_, n) => n !== i))
                              }
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      );
                    }

                    return (
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
                            onChange={onQuantity}
                          />
                        </td>
                        <td>{line.unit || '—'}</td>
                        <td className="text-muted-foreground">
                          {line.via}
                          {line.mergedFrom > 1 && ` (merged from ${line.mergedFrom})`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                {/* The row Sigfa rules off under its grid. */}
                {!config.usesFormula && lines.length > 0 && (
                  <tfoot>
                    <tr>
                      <td />
                      <td className="font-medium">Total</td>
                      <td />
                      <td className="num font-medium">
                        {qty(lines.reduce((t, l) => t + (Number(l.quantity) || 0), 0))}
                      </td>
                      <td />
                      <td className="num font-medium">{money(slipTotal(lines))}</td>
                      <td />
                    </tr>
                  </tfoot>
                )}
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

          <div className="mb-8 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={editing ? cancelEdit : () => setPlan(null)}
            >
              {editing ? 'Cancel edit' : 'Start again'}
            </button>
            <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
              {saving
                ? editing
                  ? 'Updating…'
                  : 'Saving…'
                : editing
                  ? `Update production ${editing.docNo}`
                  : 'Save production'}
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
                    <div className="flex flex-wrap justify-end gap-1">
                      <button
                        type="button"
                        className="btn btn-sm btn-ghost"
                        onClick={() => loadForEdit(entry)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={() => askDelete(entry)}
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
        Editing an entry replaces the stock it moved; deleting one removes it. Both happen in
        the same transaction as the change itself. An asterisk beside a cost means some line had
        no price in the item master when it was saved.
      </p>

      {/* What a reversal actually does, item by item. "Are you sure?" conveys
          none of it: a production entry moved stock in two directions at once,
          so undoing it moves stock in two directions again. */}
      {confirming && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Confirm delete">
          <div className="modal-card max-w-lg">
            <div className="modal-title">
              Delete production {confirming.entry.docNo}?
              <span className="block text-sm font-normal text-muted-foreground">
                {confirming.entry.outputItem} &mdash; {asDate(confirming.entry.date)}
              </span>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="field-label mb-1">Comes back out of stock</p>
                {confirming.reversal.outOfStock.length === 0 ? (
                  <p className="field-hint">Nothing.</p>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {confirming.reversal.outOfStock.map((row, i) => (
                      <li key={`out-${i}`}>
                        {row.itemName} <span className="num">{qty(row.quantity)}</span>{' '}
                        {row.unit}
                        <span className="field-hint"> {row.why}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <p className="field-label mb-1">Goes back into stock</p>
                {confirming.reversal.backIntoStock.length === 0 ? (
                  <p className="field-hint">Nothing.</p>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {confirming.reversal.backIntoStock.map((row, i) => (
                      <li key={`in-${i}`}>
                        {row.itemName} <span className="num">{qty(row.quantity)}</span>{' '}
                        {row.unit}
                        <span className="field-hint"> {row.why}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <p className="field-hint mt-4">
              The entry and its stock movements go together, in one transaction. This cannot be
              undone, but the entry can be recorded again.
            </p>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setConfirming(null)}
                disabled={saving}
              >
                Cancel
              </button>
              <button type="button" className="btn btn-danger" onClick={doDelete} disabled={saving}>
                {saving ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Sigfa's Create / Alter / Delete keys. A series -- or a party, or an
          item -- can be added from the field you are standing in rather than
          by abandoning a half-filled slip, which is the whole reason the keys
          exist. Mounted here because this screen has no keydown listener of
          its own; the billing screen calls the hook directly instead, since
          two listeners would both fire on Alt+A. */}
      <MasterShortcuts
        lists={{ series: seriesMaster, customer: customers, item: items }}
        onChanged={({ kind: changed }) => {
          // Reload the master that changed, not all of them. Every join in
          // this app is BY NAME, so a dropdown still offering a renamed record
          // is a posting error rather than a cosmetic one.
          if (changed === 'series') loadSeries();
          if (changed === 'item') {
            fetch('/api/get-item')
              .then((r) => r.json())
              .then((d) => setItems(d.item || []))
              .catch(() => {});
          }
          if (changed === 'customer') {
            fetch('/api/get-customer')
              .then((r) => r.json())
              .then((d) => setCustomers(d.customer || []))
              .catch(() => {});
          }
        }}
      />
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
