'use client';
import React, { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import ChallanSearchParams from '@/components/ChallanSearchParams';
import PartyBalance from '@/components/PartyBalance';
import ItemSearch from '@/components/billing/ItemSearch';
import {
  CHALLAN_KINDS,
  CHALLAN_TYPES,
  STATUS_LABELS,
  billedQty,
  challanStatus,
  challanTotals,
  pendingQty,
  priceLine,
  roundQty,
} from '@/lib/challanStatus.mjs';
import { trim } from '@/lib/orderStatus.mjs';
import { istToday } from '@/lib/istDate.mjs';
import { readResponse } from '@/lib/apiResponse.mjs';
import MriPanel from '@/components/billing/MriPanel';
import { rejectedQty } from '@/lib/mri.mjs';

export const dynamic = 'force-dynamic';

/**
 * Make or alter a Sales Challan or Purchase Challan (SIGFA's SC / PC).
 *
 * One page for both, as with orders: `?type=Sale|Purchase` is the only
 * difference. A challan sends (or takes in) the goods ahead of the bill:
 * it carries the value and GST, moves stock when "Stock effect" is ticked,
 * and posts nothing to the accounts. Bill it later from the sale or purchase
 * screen with "Pending challan [Alt+L]".
 */

const asISO = (value) => (value ? new Date(value).toISOString().substring(0, 10) : '');
const money = (n) => (Number(n) || 0).toFixed(2);

const blankLine = () => ({ name: '', description: '', hsn: '', quantity: '', receivedQty: '', cost: '', discount: 0, gstRate: 0 });

function ChallanForm() {
  const router = useRouter();

  const [type, setType] = useState('Sale');
  const [editingNo, setEditingNo] = useState(null);
  const [paramsRead, setParamsRead] = useState(false);

  const [challanNo, setChallanNo] = useState('');
  const [date, setDate] = useState(istToday());
  const [customers, setCustomers] = useState([]);
  const [items, setItems] = useState([]);
  const [partyName, setPartyName] = useState('');
  const [stockEffect, setStockEffect] = useState(true);

  const [partyChallanNo, setPartyChallanNo] = useState('');
  const [partyChallanDate, setPartyChallanDate] = useState('');
  const [transport, setTransport] = useState('');
  const [vehicleNo, setVehicleNo] = useState('');
  const [grNo, setGrNo] = useState('');
  const [grDate, setGrDate] = useState('');
  const [ewayBillNo, setEwayBillNo] = useState('');
  const [ewayBillDate, setEwayBillDate] = useState('');
  const [shippedTo, setShippedTo] = useState('');
  const [remarks, setRemarks] = useState('');
  // Purchase M.R.I. (lib/mri.mjs): received beside accepted on each line.
  const [mri, setMri] = useState({ on: false, remark: '', againstMriNo: null });
  const [mriNo, setMriNo] = useState(null);

  const [lines, setLines] = useState([]);
  const [draft, setDraft] = useState(blankLine());
  const [invoices, setInvoices] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const kind = CHALLAN_KINDS[type];
  const isPurchase = type === 'Purchase';
  const showMri = isPurchase && mri.on;
  const partyLabel = isPurchase ? 'Supplier' : 'Customer';

  const readParams = useCallback((q) => {
    if (CHALLAN_TYPES.includes(q.type)) setType(q.type);
    if (q.challanNo) setEditingNo(Number(q.challanNo));
    if (q.customer) setPartyName(q.customer);
    if (q.mri === '1' && q.type === 'Purchase' && !q.challanNo) setMri((m) => ({ ...m, on: true }));
    setParamsRead(true);
  }, []);

  useEffect(() => {
    fetch('/api/get-customer')
      .then((r) => r.json())
      .then((d) => setCustomers(d.customer || []))
      .catch(() => setError('Could not load the party list.'));
    fetch('/api/get-item')
      .then((r) => r.json())
      .then((d) => setItems(d.item || []))
      .catch(() => setError('Could not load the item list.'));
  }, []);

  // The number: peeked for a new challan, fixed for an alteration.
  useEffect(() => {
    if (!paramsRead || editingNo) return;
    fetch(`/api/next-challan-no?type=${encodeURIComponent(type)}`)
      .then((r) => r.json())
      .then((d) => setChallanNo(d.challanNo ?? ''))
      .catch(() => {});
  }, [paramsRead, type, editingNo]);

  useEffect(() => {
    if (!paramsRead || !editingNo) return;
    fetch(`/api/get-challan?challanNo=${editingNo}&type=${encodeURIComponent(type)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!d.success) return setError(d.error || 'Challan not found.');
        const c = d.challan;
        setChallanNo(c.challanNo);
        setDate(asISO(c.date));
        setPartyName(c.customer?.name || '');
        setStockEffect(Boolean(c.stockEffect));
        setPartyChallanNo(c.partyChallanNo || '');
        setPartyChallanDate(asISO(c.partyChallanDate));
        setTransport(c.transport || '');
        setVehicleNo(c.vehicleNo || '');
        setGrNo(c.grNo || '');
        setGrDate(asISO(c.grDate));
        setEwayBillNo(c.ewayBillNo || '');
        setEwayBillDate(asISO(c.ewayBillDate));
        setShippedTo(c.shippedTo || '');
        setRemarks(c.remarks || '');
        setMriNo(c.mriNo || null);
        setMri({ on: Boolean(c.mriNo), remark: c.mriRemark || '', againstMriNo: c.againstMriNo || null });
        setInvoices(c.invoices || []);
        // `_id` is carried untouched: invoice lines point at it.
        setLines(
          (c.items || []).map((l) => ({
            _id: String(l._id || ''),
            name: l.name || '',
            description: l.description || '',
            hsn: l.hsn || '',
            quantity: l.quantity ?? '',
            // Equal to the accepted figure means it was entered blank; kept
            // blank so the two move together on an edit.
            receivedQty:
              l.receivedQty === undefined || l.receivedQty === null || Number(l.receivedQty) === Number(l.quantity)
                ? ''
                : l.receivedQty,
            billedQty: l.billedQty || 0,
            cost: l.cost ?? '',
            discount: l.discount || 0,
            gstRate: l.gstRate || 0,
          }))
        );
      })
      .catch(() => setError('Could not load the challan.'));
  }, [paramsRead, editingNo, type]);

  const pickItem = (name) => {
    const master = items.find((i) => i.name === name);
    setDraft((d) => ({
      ...d,
      name,
      hsn: master?.hsn || '',
      // A sales challan values the goods at the sale price, a purchase
      // challan at the purchase price.
      cost: master ? (isPurchase ? master.purchasePrice ?? master.salePrice : master.salePrice) ?? '' : '',
      gstRate: Number(master?.gst ?? master?.gstRate) || 0,
    }));
  };

  const addLine = () => {
    setError('');
    if (!draft.name) return setError('Pick an item first.');
    // The box is a search, so it will hold whatever was typed. A `<select>`
    // could not offer a name that is not in the master and this has to say
    // so itself, or goods go out on a challan for an item nobody stocks.
    if (!items.some((i) => i.name === draft.name)) {
      return setError(`There is no item called "${draft.name}". Pick one from the list.`);
    }
    const mriLine = isPurchase && mri.on;
    const accepted = Number(draft.quantity);
    const received = draft.receivedQty === '' ? null : Number(draft.receivedQty);
    if (mriLine) {
      if (draft.quantity === '' || !(accepted >= 0)) return setError('Enter the quantity accepted.');
      if (received !== null && received < accepted) return setError('Accepted Qty. Is More Than Received Qty.');
      if (!(accepted > 0) && !(received > 0)) return setError('Enter the quantity received.');
    } else if (!(accepted > 0)) {
      return setError('A line needs a quantity.');
    }
    setLines((rows) => [
      ...rows,
      { ...draft, quantity: roundQty(draft.quantity), receivedQty: mriLine && received !== null ? roundQty(received) : '' },
    ]);
    setDraft(blankLine());
  };

  const editLine = (index, field, value) =>
    setLines((rows) => rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)));

  const removeLine = (index) => {
    const row = lines[index];
    if (billedQty(row) > 0) {
      return setError(`${row.name} has ${trim(billedQty(row))} already billed, so the line cannot be removed.`);
    }
    setLines((rows) => rows.filter((_, i) => i !== index));
  };

  const totals = useMemo(() => challanTotals(lines), [lines]);
  const status = useMemo(() => challanStatus({ items: lines }), [lines]);
  const anyBilled = useMemo(() => lines.some((l) => billedQty(l) > 0), [lines]);

  const save = async () => {
    setError('');
    if (!partyName) return setError(`Pick a ${partyLabel.toLowerCase()}.`);
    if (!lines.length) return setError('A challan needs at least one item.');
    setSaving(true);
    const body = {
      type,
      challanNo: Number(challanNo) || undefined,
      date,
      customer: { name: partyName },
      stockEffect,
      items: lines.map((l) => ({
        ...(l._id ? { _id: l._id } : {}),
        name: l.name,
        description: l.description,
        hsn: l.hsn,
        quantity: l.quantity,
        ...(isPurchase && mri.on && l.receivedQty !== '' && l.receivedQty !== null && l.receivedQty !== undefined
          ? { receivedQty: l.receivedQty }
          : {}),
        cost: l.cost,
        discount: l.discount,
        gstRate: l.gstRate,
      })),
      partyChallanNo,
      partyChallanDate: partyChallanDate || undefined,
      transport,
      vehicleNo,
      grNo,
      grDate: grDate || undefined,
      ewayBillNo,
      ewayBillDate: ewayBillDate || undefined,
      shippedTo,
      remarks,
      ...(isPurchase ? { mri } : {}),
    };
    try {
      const res = await fetch(editingNo ? '/api/challan-alter' : '/api/challan-add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const { ok, message } = await readResponse(res);
      if (!ok) return setError(message);
      router.push(`/challan?type=${encodeURIComponent(type)}`);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-6xl p-4 sm:p-6">
      <Suspense fallback={null}>
        <ChallanSearchParams onValue={readParams} />
      </Suspense>

      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title text-xl font-semibold">
            {editingNo ? `Alter ${kind.label} ${editingNo}` : `New ${kind.label}`}
          </h1>
          <p className="page-subtitle">
            Goods {isPurchase ? 'received' : 'sent'} ahead of the bill. Nothing is posted to the
            accounts until it is billed.
          </p>
        </div>
        {!editingNo && (
          <div className="flex gap-2">
            {CHALLAN_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                className={`btn btn-sm ${t === type ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setType(t)}
              >
                {CHALLAN_KINDS[t].label}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive" role="alert">
          {error}
        </div>
      )}
      {anyBilled && (
        <div className="mb-4 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
          Part of this challan is billed
          {invoices.length ? ` (invoice ${invoices.map((i) => i.invoiceNo).join(', ')})` : ''}. Billed
          lines cannot be removed or reduced below what was billed, and the party and stock effect are
          fixed.
        </div>
      )}

      <div className="panel mb-5">
        <div className="panel-head">
          <span className="panel-title">{kind.label}</span>
          <span className="chip">{STATUS_LABELS[status]}</span>
        </div>
        <div className="panel-body grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="field">
            <label className="field-label">Challan No.</label>
            <input className="field-input num" value={challanNo} onChange={(e) => setChallanNo(e.target.value)} disabled={Boolean(editingNo)} />
          </div>
          <div className="field">
            <label className="field-label">Challan Date</label>
            <input type="date" className="field-input" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="field lg:col-span-2">
            <label className="field-label">{partyLabel}</label>
            <select className="field-select" value={partyName} onChange={(e) => setPartyName(e.target.value)} disabled={anyBilled}>
              <option value="">Select…</option>
              {customers.map((c) => (
                <option key={c._id || c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
            {partyName && <PartyBalance selected={customers.find((c) => c.name === partyName) || {}} customers={customers} />}
          </div>
          <label className="flex items-start gap-2 text-sm lg:col-span-2">
            <input
              type="checkbox"
              className="field-check mt-0.5"
              checked={stockEffect}
              disabled={anyBilled}
              onChange={(e) => setStockEffect(e.target.checked)}
            />
            <span>
              Stock effect
              <span className="field-hint block">
                {stockEffect
                  ? `Stock moves now, when this challan is saved. The bill made from it will not move it again.`
                  : 'No stock moves now. The bill made from this challan moves it.'}
              </span>
            </span>
          </label>
          {isPurchase && (
            <>
              <div className="field">
                <label className="field-label">Supplier&apos;s challan No.</label>
                <input className="field-input" value={partyChallanNo} onChange={(e) => setPartyChallanNo(e.target.value)} />
              </div>
              <div className="field">
                <label className="field-label">Supplier&apos;s challan date</label>
                <input type="date" className="field-input" value={partyChallanDate} onChange={(e) => setPartyChallanDate(e.target.value)} />
              </div>
            </>
          )}
        </div>
      </div>

      {isPurchase && (
        <div className="mb-5">
          <MriPanel mri={mri} onChange={setMri} mriNo={mriNo} party={partyName} />
        </div>
      )}

      <div className="panel mb-5">
        <div className="panel-head">
          <span className="panel-title">Add an item</span>
        </div>
        <div className="panel-body grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-6">
          <div className="field lg:col-span-2">
            {/* The billing screen's own search, not a <select> of the whole
                master. Controlled, because the name has to stay in the box
                while the quantity and the rate are filled in. Typing and
                picking both go through pickItem, as the <select>'s onChange
                did, so the HSN and the rate follow the name. */}
            <ItemSearch
              items={items}
              label="Item"
              value={draft.name}
              onQueryChange={pickItem}
              onPick={(item) => pickItem(item.name)}
              priceOf={(item) =>
                Number(isPurchase ? item.purchasePrice ?? item.salePrice : item.salePrice) || 0
              }
              stockOf={(item) => Number(item.lastQuantity)}
              hint="Click to see every item, or type a name, code or HSN."
              emptyHint=""
            />
          </div>
          {showMri && (
            <div className="field">
              <label className="field-label">Received</label>
              <input type="number" step="0.001" className="field-input num" value={draft.receivedQty} placeholder={String(draft.quantity || '')} onChange={(e) => setDraft({ ...draft, receivedQty: e.target.value })} />
            </div>
          )}
          <div className="field">
            <label className="field-label">{showMri ? 'Accepted' : 'Quantity'}</label>
            <input type="number" step="0.001" className="field-input num" value={draft.quantity} onChange={(e) => setDraft({ ...draft, quantity: e.target.value })} />
          </div>
          <div className="field">
            <label className="field-label">Rate</label>
            <input type="number" step="0.01" className="field-input num" value={draft.cost} onChange={(e) => setDraft({ ...draft, cost: e.target.value })} />
          </div>
          <div className="field">
            <label className="field-label">Discount %</label>
            <input type="number" step="0.01" className="field-input num" value={draft.discount} onChange={(e) => setDraft({ ...draft, discount: e.target.value })} />
          </div>
          <div className="field">
            <label className="field-label">GST %</label>
            <input type="number" step="0.01" className="field-input num" value={draft.gstRate} onChange={(e) => setDraft({ ...draft, gstRate: e.target.value })} />
          </div>
          <div className="field lg:col-span-5">
            <label className="field-label">Description</label>
            <input className="field-input" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </div>
          <div className="flex items-end">
            <button type="button" className="btn btn-primary w-full" onClick={addLine}>
              Add
            </button>
          </div>
        </div>
      </div>

      <div className="table-wrap mb-5">
        <table className="data-table">
          <thead>
            <tr>
              <th>Item</th>
              <th>HSN</th>
              {showMri && <th className="num">Received</th>}
              <th className="num">{showMri ? 'Accepted' : 'Qty'}</th>
              {showMri && <th className="num">Rejected</th>}
              <th className="num">Billed</th>
              <th className="num">Pending</th>
              <th className="num">Rate</th>
              <th className="num">Disc %</th>
              <th className="num">GST %</th>
              <th className="num">Amount</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && (
              <tr>
                <td colSpan={showMri ? 12 : 10}>
                  <div className="empty-state">No items on this challan yet.</div>
                </td>
              </tr>
            )}
            {lines.map((row, i) => (
              <tr key={row._id || `new-${i}`}>
                <td>
                  {row.name}
                  {row.description && <div className="text-xs text-muted-foreground">{row.description}</div>}
                </td>
                <td>{row.hsn}</td>
                {showMri && (
                  <td className="num">
                    <input type="number" step="0.001" className="field-input field-input-sm num w-24" value={row.receivedQty ?? ''} placeholder={String(row.quantity ?? '')} onChange={(e) => editLine(i, 'receivedQty', e.target.value)} />
                  </td>
                )}
                <td className="num">
                  <input type="number" step="0.001" className="field-input field-input-sm num w-24" value={row.quantity} onChange={(e) => editLine(i, 'quantity', e.target.value)} />
                </td>
                {showMri && (
                  <td className="num">
                    {rejectedQty(row) > 0 ? <span className="font-medium text-destructive">{trim(rejectedQty(row))}</span> : '—'}
                  </td>
                )}
                <td className="num">{trim(billedQty(row))}</td>
                <td className="num font-medium">{trim(pendingQty(row))}</td>
                <td className="num">
                  <input type="number" step="0.01" className="field-input field-input-sm num w-24" value={row.cost} onChange={(e) => editLine(i, 'cost', e.target.value)} />
                </td>
                <td className="num">
                  <input type="number" step="0.01" className="field-input field-input-sm num w-20" value={row.discount || 0} onChange={(e) => editLine(i, 'discount', e.target.value)} />
                </td>
                <td className="num">
                  <input type="number" step="0.01" className="field-input field-input-sm num w-20" value={row.gstRate || 0} onChange={(e) => editLine(i, 'gstRate', e.target.value)} />
                </td>
                <td className="num">{money(priceLine(row).total)}</td>
                <td>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={() => removeLine(i)}
                    disabled={billedQty(row) > 0}
                    title={billedQty(row) > 0 ? 'Already billed' : 'Remove this line'}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          {lines.length > 0 && (
            <tfoot>
              <tr>
                <td colSpan={showMri ? 10 : 8}>Taxable {money(totals.taxable)} · GST {money(totals.gst)} · Total</td>
                <td className="num">{money(totals.total)}</td>
                <td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <div className="panel mb-5">
        <div className="panel-head">
          <span className="panel-title">Despatch</span>
        </div>
        <div className="panel-body grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="field">
            <label className="field-label">Transport</label>
            <input className="field-input" value={transport} onChange={(e) => setTransport(e.target.value)} />
          </div>
          <div className="field">
            <label className="field-label">Vehicle No.</label>
            <input className="field-input" value={vehicleNo} onChange={(e) => setVehicleNo(e.target.value)} />
          </div>
          <div className="field">
            <label className="field-label">GR / LR No.</label>
            <input className="field-input" value={grNo} onChange={(e) => setGrNo(e.target.value)} />
          </div>
          <div className="field">
            <label className="field-label">GR date</label>
            <input type="date" className="field-input" value={grDate} onChange={(e) => setGrDate(e.target.value)} />
          </div>
          <div className="field">
            <label className="field-label">E-way bill No.</label>
            <input className="field-input" value={ewayBillNo} onChange={(e) => setEwayBillNo(e.target.value)} />
          </div>
          <div className="field">
            <label className="field-label">E-way bill date</label>
            <input type="date" className="field-input" value={ewayBillDate} onChange={(e) => setEwayBillDate(e.target.value)} />
          </div>
          <div className="field lg:col-span-2">
            <label className="field-label">Shipped to</label>
            <input className="field-input" value={shippedTo} onChange={(e) => setShippedTo(e.target.value)} />
          </div>
          <div className="field lg:col-span-4">
            <label className="field-label">Remarks</label>
            <input className="field-input" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap justify-end gap-2 pb-10">
        <button type="button" className="btn btn-secondary" onClick={() => router.push(`/challan?type=${encodeURIComponent(type)}`)}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : editingNo ? 'Update challan' : 'Save challan'}
        </button>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
      <ChallanForm />
    </Suspense>
  );
}
