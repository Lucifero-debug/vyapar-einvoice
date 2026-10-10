'use client';
import React, { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import OrderSearchParams from '@/components/OrderSearchParams';
import PartyBalance from '@/components/PartyBalance';
import {
  ORDER_TYPES,
  invoicedQty,
  lineStatus,
  lineTotal,
  orderStatus,
  orderTotal,
  pendingQty,
  roundQty,
  trim,
} from '@/lib/orderStatus.mjs';

export const dynamic = 'force-dynamic';

/**
 * Take or amend a sales or purchase order.
 *
 * ONE PAGE, NOT FOUR
 * ------------------
 * `?type=Sale` or `?type=Purchase` is the only difference between the two
 * documents, so there is one page. The billing side of this app has four
 * near-identical copies (saleadd, purchaseadd, salereturn, purchasereturn),
 * and the last round of patches had to be applied to all four by hand -- one
 * of them was missed, and the bug lived for a week. Not repeating that here.
 *
 * NO TAX ON THIS SCREEN
 * ---------------------
 * Deliberate, and the one thing worth knowing before reading the totals: an
 * order carries quantity, rate and discount and stops. The GST is whatever
 * the item master says on the day the order is billed, so showing a tax
 * figure here would only promise a number that may not hold. The note under
 * the total says so, because a user who expects a tax column will otherwise
 * assume it is broken.
 */

const todayISO = () => new Date().toISOString().substring(0, 10);
const asISO = (value) => (value ? new Date(value).toISOString().substring(0, 10) : '');

const blankLine = () => ({
  name: '',
  description: '',
  hsn: '',
  quantity: '',
  cost: '',
  discount: 0,
  deliveryDate: '',
});

function OrderForm() {
  const router = useRouter();

  const [type, setType] = useState('Sale');
  const [editingNo, setEditingNo] = useState(null);
  const [paramsRead, setParamsRead] = useState(false);

  const [orderNo, setOrderNo] = useState('');
  const [date, setDate] = useState(todayISO());
  const [deliveryDate, setDeliveryDate] = useState('');
  const [deliveryDays, setDeliveryDays] = useState('');

  const [customers, setCustomers] = useState([]);
  const [items, setItems] = useState([]);
  const [partyName, setPartyName] = useState('');

  const [reference, setReference] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [deliveryPeriod, setDeliveryPeriod] = useState('');
  const [despatchThrough, setDespatchThrough] = useState('');
  const [transport, setTransport] = useState('');
  const [freight, setFreight] = useState('');
  const [remarks, setRemarks] = useState('');
  const [hold, setHold] = useState(false);

  const [lines, setLines] = useState([]);
  const [draft, setDraft] = useState(blankLine());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const isPurchase = type === 'Purchase';
  const partyLabel = isPurchase ? 'Supplier' : 'Customer';

  // ── the query string ────────────────────────────────────────────────────
  const readParams = useCallback((q) => {
    if (ORDER_TYPES.includes(q.type)) setType(q.type);
    if (q.orderNo) setEditingNo(Number(q.orderNo));
    if (q.customer) setPartyName(q.customer);
    setParamsRead(true);
  }, []);

  // ── masters ─────────────────────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/get-customer')
      .then((r) => r.json())
      .then((d) => setCustomers(d.customer || []))
      .catch(() => setError('Could not load the customer list.'));

    fetch('/api/get-item')
      .then((r) => r.json())
      .then((d) => setItems(d.item || []))
      .catch(() => setError('Could not load the item list.'));
  }, []);

  // ── the number: peeked for a new order, fixed for an edit ───────────────
  useEffect(() => {
    if (!paramsRead || editingNo) return;
    fetch(`/api/next-order-no?type=${encodeURIComponent(type)}`)
      .then((r) => r.json())
      .then((d) => setOrderNo(d.orderNo ?? ''))
      .catch(() => {});
  }, [paramsRead, type, editingNo]);

  // ── loading an order to amend ───────────────────────────────────────────
  useEffect(() => {
    if (!paramsRead || !editingNo) return;
    fetch(`/api/get-order?orderNo=${editingNo}&type=${encodeURIComponent(type)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!d.success) {
          setError(d.error || 'Order not found.');
          return;
        }
        const o = d.order;
        setOrderNo(o.orderNo);
        setDate(asISO(o.date));
        setDeliveryDate(asISO(o.deliveryDate));
        setDeliveryDays(o.deliveryDays || '');
        setPartyName(o.customer?.name || '');
        setReference(o.reference || '');
        setPaymentTerms(o.paymentTerms || '');
        setDeliveryPeriod(o.deliveryPeriod || '');
        setDespatchThrough(o.despatchThrough || '');
        setTransport(o.transport || '');
        setFreight(o.freight || '');
        setRemarks(o.remarks || '');
        setHold(Boolean(o.hold));
        // `_id` is carried through the form untouched. It is what the invoice
        // line references, so losing it on an edit would orphan every bill
        // already raised against this order.
        setLines(
          (o.items || []).map((l) => ({
            _id: String(l._id || ''),
            name: l.name || '',
            description: l.description || '',
            hsn: l.hsn || '',
            quantity: l.quantity ?? '',
            cancelledQty: l.cancelledQty || 0,
            invoicedQty: l.invoicedQty || 0,
            cost: l.cost ?? '',
            discount: l.discount || 0,
            deliveryDate: asISO(l.deliveryDate),
          }))
        );
      })
      .catch(() => setError('Could not load the order.'));
  }, [paramsRead, editingNo, type]);

  // ── line entry ──────────────────────────────────────────────────────────
  const pickItem = (name) => {
    const master = items.find((i) => i.name === name);
    setDraft((d) => ({
      ...d,
      name,
      hsn: master?.hsn || '',
      // A sales order quotes the sale price, a purchase order the purchase
      // price. Getting this the wrong way round is the kind of slip that
      // reaches a customer on paper.
      cost: master ? (isPurchase ? master.purchasePrice : master.salePrice) ?? '' : '',
      discount: master?.discount ?? 0,
    }));
  };

  const addLine = () => {
    setError('');
    if (!draft.name) return setError('Pick an item first.');
    if (!(Number(draft.quantity) > 0)) return setError('A line needs a quantity.');
    setLines((rows) => [...rows, { ...draft, quantity: roundQty(draft.quantity) }]);
    setDraft(blankLine());
  };

  const removeLine = (index) => {
    const row = lines[index];
    if (invoicedQty(row) > 0) {
      setError(
        `${row.name} has ${trim(invoicedQty(row))} already billed, so the line cannot be removed. Cancel the unbilled part instead.`
      );
      return;
    }
    setLines((rows) => rows.filter((_, i) => i !== index));
  };

  const editLine = (index, field, value) => {
    setLines((rows) =>
      rows.map((row, i) => (i === index ? { ...row, [field]: value } : row))
    );
  };

  const total = useMemo(() => orderTotal(lines), [lines]);
  const status = useMemo(() => orderStatus({ items: lines }), [lines]);
  const anyBilled = useMemo(() => lines.some((l) => invoicedQty(l) > 0), [lines]);

  // ── save ────────────────────────────────────────────────────────────────
  const save = async () => {
    setError('');
    setNotice('');
    if (!partyName) return setError(`Pick a ${partyLabel.toLowerCase()}.`);
    if (!lines.length) return setError('An order needs at least one item.');

    setSaving(true);
    const body = {
      orderNo: Number(orderNo) || undefined,
      originalOrderNo: editingNo || undefined,
      type,
      date,
      deliveryDate: deliveryDate || null,
      deliveryDays: Number(deliveryDays) || 0,
      customer: { name: partyName },
      items: lines,
      reference,
      paymentTerms,
      deliveryPeriod,
      despatchThrough,
      transport,
      freight,
      remarks,
      hold,
    };

    try {
      const res = await fetch(editingNo ? '/api/order-alter' : '/api/order-add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      if (!result.success) {
        setError(result.error || 'Could not save the order.');
        return;
      }
      setNotice(result.message || 'Saved.');
      router.push(`/order?type=${encodeURIComponent(type)}`);
    } catch (err) {
      setError(err.message || 'Could not save the order.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-6xl p-4 sm:p-6">
      <Suspense fallback={null}>
        <OrderSearchParams onValue={readParams} />
      </Suspense>

      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title text-xl font-semibold">
            {editingNo ? `Amend ${type} Order ${editingNo}` : `New ${type} Order`}
          </h1>
          <p className="page-subtitle">
            A commitment to supply. No tax is recorded on an order — the GST is
            worked out when it is billed.
          </p>
        </div>
        {!editingNo && (
          <div className="flex gap-2">
            {ORDER_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                className={`btn btn-sm ${t === type ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setType(t)}
              >
                {t}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-4 rounded-lg border border-success/40 bg-success/10 px-4 py-3 text-sm">
          {notice}
        </div>
      )}
      {anyBilled && (
        <div className="mb-4 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm">
          Part of this order is already billed. Those quantities cannot be
          reduced or removed — cancel the unbilled balance instead.
        </div>
      )}

      {/* ── header ───────────────────────────────────────────────────── */}
      <div className="panel mb-5">
        <div className="panel-head">
          <span className="panel-title">Order</span>
          <span className="chip">{status}</span>
        </div>
        <div className="panel-body grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="field">
            <label className="field-label">Order No</label>
            <input
              className="field-input num"
              value={orderNo}
              onChange={(e) => setOrderNo(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="field-label">Date</label>
            <input
              type="date"
              className="field-input"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="field-label">Delivery by</label>
            <input
              type="date"
              className="field-input"
              value={deliveryDate}
              onChange={(e) => setDeliveryDate(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="field-label">Or within (days)</label>
            <input
              type="number"
              className="field-input num"
              value={deliveryDays}
              onChange={(e) => setDeliveryDays(e.target.value)}
            />
          </div>

          <div className="field lg:col-span-2">
            <label className="field-label">{partyLabel}</label>
            <select
              className="field-select"
              value={partyName}
              onChange={(e) => setPartyName(e.target.value)}
            >
              <option value="">Select…</option>
              {customers.map((c) => (
                <option key={c._id || c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
            {partyName && (
              <PartyBalance
                selected={customers.find((c) => c.name === partyName) || {}}
                customers={customers}
              />
            )}
          </div>
          <div className="field">
            <label className="field-label">Their reference</label>
            <input
              className="field-input"
              placeholder="Their PO number"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="field-label">Payment terms</label>
            <input
              className="field-input"
              value={paymentTerms}
              onChange={(e) => setPaymentTerms(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* ── add a line ───────────────────────────────────────────────── */}
      <div className="panel mb-5">
        <div className="panel-head">
          <span className="panel-title">Add an item</span>
        </div>
        <div className="panel-body grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-6">
          <div className="field lg:col-span-2">
            <label className="field-label">Item</label>
            <select
              className="field-select"
              value={draft.name}
              onChange={(e) => pickItem(e.target.value)}
            >
              <option value="">Select…</option>
              {items.map((i) => (
                <option key={i._id || i.name} value={i.name}>
                  {i.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field-label">Quantity</label>
            <input
              type="number"
              step="0.001"
              className="field-input num"
              value={draft.quantity}
              onChange={(e) => setDraft({ ...draft, quantity: e.target.value })}
            />
          </div>
          <div className="field">
            <label className="field-label">Rate</label>
            <input
              type="number"
              step="0.01"
              className="field-input num"
              value={draft.cost}
              onChange={(e) => setDraft({ ...draft, cost: e.target.value })}
            />
          </div>
          <div className="field">
            <label className="field-label">Discount %</label>
            <input
              type="number"
              step="0.01"
              className="field-input num"
              value={draft.discount}
              onChange={(e) => setDraft({ ...draft, discount: e.target.value })}
            />
          </div>
          <div className="field">
            <label className="field-label">Promised</label>
            <input
              type="date"
              className="field-input"
              value={draft.deliveryDate}
              onChange={(e) => setDraft({ ...draft, deliveryDate: e.target.value })}
            />
          </div>
          <div className="field lg:col-span-5">
            <label className="field-label">Description</label>
            <input
              className="field-input"
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </div>
          <div className="flex items-end">
            <button type="button" className="btn btn-primary w-full" onClick={addLine}>
              Add
            </button>
          </div>
        </div>
      </div>

      {/* ── the lines ────────────────────────────────────────────────── */}
      <div className="table-wrap mb-5">
        <table className="data-table">
          <thead>
            <tr>
              <th>Item</th>
              <th>HSN</th>
              <th className="num">Ordered</th>
              <th className="num">Billed</th>
              <th className="num">Cancelled</th>
              <th className="num">Pending</th>
              <th className="num">Rate</th>
              <th className="num">Disc %</th>
              <th className="num">Value</th>
              <th>Promised</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && (
              <tr>
                <td colSpan={11}>
                  <div className="empty-state">No items on this order yet.</div>
                </td>
              </tr>
            )}
            {lines.map((row, i) => (
              <tr key={row._id || `new-${i}`}>
                <td>
                  {row.name}
                  {row.description && (
                    <div className="text-xs text-muted-foreground">{row.description}</div>
                  )}
                </td>
                <td>{row.hsn}</td>
                <td className="num">
                  <input
                    type="number"
                    step="0.001"
                    className="field-input field-input-sm num w-24"
                    value={row.quantity}
                    onChange={(e) => editLine(i, 'quantity', e.target.value)}
                  />
                </td>
                <td className="num">{trim(invoicedQty(row))}</td>
                <td className="num">
                  <input
                    type="number"
                    step="0.001"
                    className="field-input field-input-sm num w-24"
                    value={row.cancelledQty || 0}
                    onChange={(e) => editLine(i, 'cancelledQty', e.target.value)}
                  />
                </td>
                <td className="num font-medium">{trim(pendingQty(row))}</td>
                <td className="num">
                  <input
                    type="number"
                    step="0.01"
                    className="field-input field-input-sm num w-24"
                    value={row.cost}
                    onChange={(e) => editLine(i, 'cost', e.target.value)}
                  />
                </td>
                <td className="num">
                  <input
                    type="number"
                    step="0.01"
                    className="field-input field-input-sm num w-20"
                    value={row.discount || 0}
                    onChange={(e) => editLine(i, 'discount', e.target.value)}
                  />
                </td>
                <td className="num">{lineTotal(row).toFixed(2)}</td>
                <td>
                  <input
                    type="date"
                    className="field-input field-input-sm"
                    value={row.deliveryDate || ''}
                    onChange={(e) => editLine(i, 'deliveryDate', e.target.value)}
                  />
                </td>
                <td>
                  <div className="flex items-center gap-2">
                    <span className="chip">{lineStatus(row)}</span>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      onClick={() => removeLine(i)}
                      disabled={invoicedQty(row) > 0}
                      title={
                        invoicedQty(row) > 0
                          ? 'Already billed — cancel the unbilled balance instead'
                          : 'Remove this line'
                      }
                    >
                      Remove
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
          {lines.length > 0 && (
            <tfoot>
              <tr>
                <td colSpan={8}>Order value</td>
                <td className="num">{total.toFixed(2)}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {/* ── terms and save ───────────────────────────────────────────── */}
      <div className="panel mb-5">
        <div className="panel-head">
          <span className="panel-title">Despatch and terms</span>
        </div>
        <div className="panel-body grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="field">
            <label className="field-label">Delivery period</label>
            <input
              className="field-input"
              value={deliveryPeriod}
              onChange={(e) => setDeliveryPeriod(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="field-label">Despatch through</label>
            <input
              className="field-input"
              value={despatchThrough}
              onChange={(e) => setDespatchThrough(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="field-label">Transport</label>
            <input
              className="field-input"
              value={transport}
              onChange={(e) => setTransport(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="field-label">Freight</label>
            <input
              className="field-input"
              value={freight}
              onChange={(e) => setFreight(e.target.value)}
            />
          </div>
          <div className="field lg:col-span-3">
            <label className="field-label">Remarks</label>
            <input
              className="field-input"
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
            />
          </div>
          <label className="flex items-end gap-2 text-sm">
            <input
              type="checkbox"
              className="field-check"
              checked={hold}
              onChange={(e) => setHold(e.target.checked)}
            />
            <span>
              On hold
              <span className="field-hint block">
                Stands, but will not be offered for billing.
              </span>
            </span>
          </label>
        </div>
      </div>

      <div className="flex flex-wrap justify-end gap-2 pb-10">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => router.push(`/order?type=${encodeURIComponent(type)}`)}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={save}
          disabled={saving}
        >
          {saving ? 'Saving…' : editingNo ? 'Update order' : 'Save order'}
        </button>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
      <OrderForm />
    </Suspense>
  );
}
