'use client';
import React, { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import OrderSearchParams from '@/components/OrderSearchParams';
import {
  ORDER_TYPES,
  lineSummary,
  orderStatus,
  pendingLines,
  pendingValue,
  trim,
} from '@/lib/orderStatus.mjs';
import { billingSummary } from '@/lib/orderReports.mjs';
import {
  cancelBlockedReason,
  cancellationSummary,
  restoreBlockedReason,
} from '@/lib/orderStatus.mjs';

export const dynamic = 'force-dynamic';

/**
 * The order register: what is on the books and what is still owed.
 *
 * "Open" here means open OR partly billed -- anything still owing something.
 * Asking for open orders and being shown only the untouched ones is the kind
 * of wrong that reads as missing data, so the filter and the API agree on it.
 *
 * The row that matters is PENDING, not the order value. An order worth
 * Rs 5,00,000 with Rs 4,90,000 already billed is a Rs 10,000 job, and sorting
 * a supplier chase list by order value would put it at the top.
 */

const fmt = (n) =>
  new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .format(Number(n) || 0);

const asDate = (v) => (v ? new Date(v).toLocaleDateString('en-IN') : '—');

const STATUS_FILTERS = [
  { key: 'open', label: 'Still owed' },
  { key: 'closed', label: 'Completed' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: '', label: 'All' },
];

function OrderRegister() {
  const router = useRouter();

  const [type, setType] = useState('Sale');
  const [status, setStatus] = useState('open');
  const [orders, setOrders] = useState([]);
  const [expanded, setExpanded] = useState(null);
  // What billed the order currently open. Fetched per row rather than with
  // the list: the register shows up to 200 orders and almost nobody expands
  // more than one, so joining invoices for all of them would be paid for
  // every page load and used almost never.
  const [billed, setBilled] = useState({ key: null, invoices: null, error: '' });
  // The cancel prompt. A reason is required on the way out, so this cannot be
  // a window.confirm -- and a bare confirm on an action that writes off a
  // customer's order is too easy to click through anyway.
  const [cancelling, setCancelling] = useState(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // What the caller came to do, when it said so. Only the line under the
  // heading changes: Edit and Delete sit on every row either way, because an
  // order that cannot be deleted must say so when it is tried, not be hidden.
  const [mode, setMode] = useState('');

  const readParams = useCallback((q) => {
    if (ORDER_TYPES.includes(q.type)) setType(q.type);
    setMode(q.mode === 'alter' || q.mode === 'delete' ? q.mode : '');
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    const qs = new URLSearchParams({ type });
    if (status) qs.set('status', status);
    fetch(`/api/order?${qs.toString()}`)
      .then((r) => r.json())
      .then((d) => {
        if (!d.success) throw new Error(d.error || 'Could not load the orders.');
        setOrders(d.orders || []);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [type, status]);

  useEffect(() => {
    load();
  }, [load]);

  const remove = async (order) => {
    setError('');
    const res = await fetch(
      `/api/delete-order?orderNo=${order.orderNo}&type=${encodeURIComponent(order.type)}`,
      { method: 'POST' }
    );
    const result = await res.json();
    if (!result.success) {
      setError(result.error || 'Could not delete the order.');
      return;
    }
    load();
  };

  /** Call off the unbilled balance, or put a cancellation back. */
  const sendCancel = async (order, restore) => {
    setError('');
    setBusy(true);
    try {
      const res = await fetch('/api/order-cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderNo: order.orderNo,
          type: order.type,
          reason: restore ? '' : reason,
          restore,
        }),
      });
      const result = await res.json();
      if (!result.success) {
        setError(result.error || 'Could not cancel the order.');
        return;
      }
      setCancelling(null);
      setReason('');
      load();
    } catch (err) {
      setError(err.message || 'Could not cancel the order.');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Carry an order into a bill.
   *
   * The billing page reads the order itself through /api/get-order, so only
   * the reference travels in the URL -- quantities and rates in a query
   * string would be a set of figures nobody had checked against the order.
   */
  const bill = (order) => {
    const page = order.type === 'Purchase' ? '/purchaseadd' : '/saleadd';
    router.push(`${page}?fromOrder=${order.orderNo}&orderType=${encodeURIComponent(order.type)}`);
  };

  const totalPending = orders.reduce((s, o) => s + (Number(o.pendingValue) || 0), 0);

  return (
    <div className="mx-auto w-full max-w-7xl p-4 sm:p-6">
      <Suspense fallback={null}>
        <OrderSearchParams onValue={readParams} />
      </Suspense>

      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title text-xl font-semibold">
            {type === 'Purchase' ? 'Purchase Orders' : 'Sales Orders'}
          </h1>
          <p className="page-subtitle">
            {mode === 'alter'
              ? 'Pick the order to alter, then Edit on its row.'
              : mode === 'delete'
                ? 'Pick the order to delete, then Delete on its row. A billed order cannot be deleted — cancel the unbilled part instead.'
                : 'Orders carry no tax — the GST is worked out when they are billed.'}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => router.push(`/order-report?type=${encodeURIComponent(type)}`)}
          >
            Reports
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => router.push(`/orderadd?type=${encodeURIComponent(type)}`)}
          >
            New {type} order
          </button>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
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
        <span className="mx-2 h-6 w-px bg-border" />
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.key || 'all'}
            type="button"
            className={`btn btn-sm ${f.key === status ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setStatus(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {!loading && orders.length > 0 && (
        <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="stat-card">
            <div className="stat-label">Orders listed</div>
            <div className="stat-value">{orders.length}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Still to bill</div>
            <div className="stat-value">₹ {fmt(totalPending)}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Order value listed</div>
            <div className="stat-value">
              ₹ {fmt(orders.reduce((s, o) => s + (Number(o.totalAmount) || 0), 0))}
            </div>
          </div>
        </div>
      )}

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>No</th>
              <th>Date</th>
              <th>{type === 'Purchase' ? 'Supplier' : 'Customer'}</th>
              <th>Their ref</th>
              <th>Delivery by</th>
              <th>Status</th>
              <th className="num">Order value</th>
              <th className="num">Still to bill</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={9}>
                  <div className="empty-state">Loading…</div>
                </td>
              </tr>
            )}
            {!loading && orders.length === 0 && (
              <tr>
                <td colSpan={9}>
                  <div className="empty-state">
                    No {type.toLowerCase()} orders match this filter.
                  </div>
                </td>
              </tr>
            )}
            {!loading &&
              orders.map((order) => {
                const key = `${order.type}-${order.orderNo}`;
                const open = expanded === key;
                const derived = orderStatus(order);
                const pending = pendingLines(order);
                return (
                  <React.Fragment key={key}>
                    <tr>
                      <td className="font-medium">{order.orderNo}</td>
                      <td>{asDate(order.date)}</td>
                      <td>{order.customer?.name || '—'}</td>
                      <td>{order.reference || '—'}</td>
                      <td>{asDate(order.deliveryDate)}</td>
                      <td>
                        <span className="chip">{derived}</span>
                        {order.hold && <span className="chip ml-1">on hold</span>}
                      </td>
                      <td className="num">{fmt(order.totalAmount)}</td>
                      <td className="num font-medium">{fmt(pendingValue(order))}</td>
                      <td>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            className="btn btn-sm btn-secondary"
                            onClick={() => {
                              if (open) {
                                setExpanded(null);
                                return;
                              }
                              setExpanded(key);
                              setBilled({ key, invoices: null, error: '' });
                              fetch(
                                `/api/get-order?orderNo=${order.orderNo}&type=${encodeURIComponent(order.type)}`
                              )
                                .then((r) => r.json())
                                .then((d) => {
                                  if (!d.success) throw new Error(d.error || 'Could not load the order.');
                                  setBilled({ key, invoices: d.order?.invoices || [], error: '' });
                                })
                                .catch((e) =>
                                  setBilled({ key, invoices: [], error: e.message })
                                );
                            }}
                          >
                            {open ? 'Hide' : `${(order.items || []).length} lines`}
                          </button>
                          {pending.length > 0 && !order.hold && (
                            <button
                              type="button"
                              className="btn btn-sm btn-success"
                              onClick={() => bill(order)}
                            >
                              Bill
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn-sm btn-secondary"
                            onClick={() =>
                              router.push(
                                `/orderadd?type=${encodeURIComponent(order.type)}&orderNo=${order.orderNo}`
                              )
                            }
                          >
                            Edit
                          </button>
                          {!cancelBlockedReason(order) && (
                            <button
                              type="button"
                              className="btn btn-sm btn-secondary"
                              onClick={() => {
                                setReason('');
                                setCancelling(order);
                              }}
                              title="Call off whatever is still unbilled on this order"
                            >
                              Cancel order
                            </button>
                          )}
                          {!restoreBlockedReason(order) && (
                            <button
                              type="button"
                              className="btn btn-sm btn-secondary"
                              onClick={() => sendCancel(order, true)}
                              disabled={busy}
                              title="Put the cancelled quantity back"
                            >
                              Restore
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn-sm btn-danger"
                            onClick={() => remove(order)}
                            title={
                              derived === 'open'
                                ? 'Delete this order'
                                : 'Billed orders cannot be deleted'
                            }
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={9} className="bg-muted/30">
                          <ul className="space-y-1 py-1 text-sm">
                            {(order.items || []).filter(Boolean).map((l, i) => (
                              <li key={l._id || i} className="flex flex-wrap gap-x-3">
                                <span className="font-medium">{l.name}</span>
                                <span className="text-muted-foreground">
                                  {lineSummary(l)}
                                </span>
                                <span className="text-muted-foreground">
                                  @ {fmt(l.cost)}
                                  {Number(l.discount) ? ` less ${trim(l.discount)}%` : ''}
                                </span>
                                {l.deliveryDate && (
                                  <span className="text-muted-foreground">
                                    promised {asDate(l.deliveryDate)}
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>

                          {cancellationSummary(order) && (
                            <div className="border-t border-border/60 py-2 text-sm">
                              <span className="font-medium">Cancellation: </span>
                              <span className="text-muted-foreground">
                                {cancellationSummary(order)}
                              </span>
                            </div>
                          )}

                          {/* What billed it. The other half of the link:
                              the invoice line knows its order, and now the
                              order can say what billed it. */}
                          <div className="border-t border-border/60 py-2 text-sm">
                            {billed.key !== key || billed.invoices === null ? (
                              <span className="text-muted-foreground">Loading invoices…</span>
                            ) : billed.error ? (
                              <span className="text-destructive">{billed.error}</span>
                            ) : (
                              <>
                                <span className="font-medium">
                                  {billingSummary(billed.invoices)}
                                </span>
                                {billed.invoices.length > 0 && (
                                  <ul className="mt-1 space-y-0.5">
                                    {billed.invoices.map((inv) => (
                                      <li key={`${inv.invoiceNo}-${inv.isReturn}`}>
                                        <button
                                          type="button"
                                          className="hover:underline"
                                          onClick={() =>
                                            router.push(`/invoice?invoiceNo=${inv.invoiceNo}`)
                                          }
                                        >
                                          {inv.isReturn ? 'Return' : 'Invoice'} {inv.invoiceNo}
                                        </button>
                                        <span className="text-muted-foreground">
                                          {' '}· {asDate(inv.date)} · {trim(inv.quantity)} off this order
                                        </span>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
          </tbody>
        </table>
      </div>
      {cancelling && (
        <div className="modal-overlay no-print" role="dialog" aria-modal="true">
          <div className="modal-card">
            <h2 className="modal-title mb-1">
              Cancel the rest of {cancelling.type} order {cancelling.orderNo}?
            </h2>
            <p className="field-hint mb-4">
              Whatever is still unbilled on this order is called off. Anything
              already invoiced stays — the order is short-closed, not deleted,
              and Restore puts it back.
            </p>
            <div className="field mb-4">
              <label className="field-label">Reason</label>
              <input
                className="field-input"
                autoFocus
                placeholder="Customer deferred the balance"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <span className="field-hint">
                Kept against the order, with who cancelled it and when.
              </span>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setCancelling(null);
                  setReason('');
                }}
              >
                Keep the order
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => sendCancel(cancelling, false)}
                disabled={busy || !reason.trim()}
              >
                {busy ? 'Cancelling…' : 'Cancel the balance'}
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
      <OrderRegister />
    </Suspense>
  );
}
