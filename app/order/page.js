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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const readParams = useCallback((q) => {
    if (ORDER_TYPES.includes(q.type)) setType(q.type);
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
            Orders carry no tax — the GST is worked out when they are billed.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => router.push(`/orderadd?type=${encodeURIComponent(type)}`)}
        >
          New {type} order
        </button>
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
                            onClick={() => setExpanded(open ? null : key)}
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
                            Amend
                          </button>
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
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
          </tbody>
        </table>
      </div>
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
