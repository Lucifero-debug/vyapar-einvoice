'use client';
import React, { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import ReportUrlSync from '@/components/reports/ReportUrlSync';
import { REPORT_QUERIES, parseReportQuery } from '@/lib/reportQuery.mjs';
import { useCompany } from '@/context/CompanyContext';
import { companyAddress } from '@/lib/company.mjs';
import { ORDER_TYPES } from '@/lib/orderStatus.mjs';
import {
  AGEING_BUCKETS,
  CONSOLIDATION_LABEL,
  SIGFA_ITEM_HEADERS,
  STOCK_HEADER,
  TOTAL_LABEL,
  sigfaItemTitle,
  sigfaItemTotals,
  sigfaPeriodLine,
  CSV_COLUMNS,
  csvFilename,
  reportTitle,
  toCsv,
  trim,
} from '@/lib/orderReports.mjs';
import { istToday } from '@/lib/istDate.mjs';

export const dynamic = 'force-dynamic';

/**
 * The order reports: register, party-wise pending, item-wise pending, and
 * the reconciliation.
 *
 * ONE PAGE. Sigfa's order module has these as separate report screens; here
 * they are tabs over one query, because they are one body of data looked at
 * four ways and four pages is four places for "pending" to mean something
 * slightly different.
 *
 * NOTHING IS COMPUTED HERE. Every quantity, total, age and heading comes from
 * lib/orderReports.mjs -- the page formats and lays out, and that is all. The
 * moment a screen does the pending subtraction itself it forgets the
 * cancelled quantity, and then the report and the order disagree.
 *
 * PRINTING follows the ledger and voucher registers: `doc-sheet` for the
 * page, the firm's letterhead at the top, `no-print` on every control, so
 * Ctrl+P gives the same kind of sheet everywhere in the app.
 */

const VIEWS = [
  { key: 'register', label: 'Order Register' },
  { key: 'party-pending', label: 'Party-wise Pending' },
  { key: 'item-pending', label: 'Item-wise Pending' },
  { key: 'reconcile', label: 'Reconciliation' },
];

const fmt = (n) =>
  new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .format(Number(n) || 0);

const asDate = (v) => (v ? new Date(v).toLocaleDateString('en-IN') : '—');

const financialYearStart = () => {
  const now = new Date();
  // India's year runs April to March, which is what every date box in this
  // app defaults to.
  const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}-04-01`;
};

// Today in India, not in UTC (which is yesterday until 05:30 IST).
const todayISO = () => istToday();

/** Hand the browser a file without a round trip to the server. */
const downloadCsv = (filename, csv) => {
  // A BOM, so Excel opens it as UTF-8 instead of mangling a rupee sign or a
  // party name in Devanagari.
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

function OrderReports() {
  const router = useRouter();
  const { company } = useCompany();

  // A shared link's filters, read BEFORE the first render and used as the
  // initial state -- so the first fetch is already the link's report. Read in
  // an effect instead, the page would fetch its defaults first and the two
  // responses would race (lib/reportQuery.mjs validates every value; anything
  // invalid or absent keeps the page's own default).
  // `type` and `customer` are the two this page always read from a link
  // (via OrderSearchParams); the view, the register's dates and the item are
  // new.
  const searchParams = useSearchParams();
  const [link] = useState(() => parseReportQuery(REPORT_QUERIES.orderReport, searchParams).values);

  const [type, setType] = useState(link.type ?? 'Sale');
  const [view, setView] = useState(link.view ?? 'register');
  const [from, setFrom] = useState(() => link.from ?? financialYearStart());
  const [to, setTo] = useState(() => link.to ?? todayISO());
  const [party, setParty] = useState(link.party ?? '');
  const [item, setItem] = useState(link.item ?? '');

  const [rows, setRows] = useState([]);
  // WHICH VIEW THESE ROWS BELONG TO.
  //
  // `view` changes the instant a tab is clicked, but `rows` only changes when
  // the fetch comes back. For the render in between, the branch below was
  // chosen by the NEW view while the data was still the OLD view's -- and the
  // branches read different fields. The grouped views reach into `r.lines`,
  // which a register row does not have, so that one render threw
  // "Cannot read properties of undefined (reading 'map')".
  //
  // Guarding each access with `|| []` would only have hidden it: the real
  // fault is rendering one view's branch against another view's data. So the
  // rows carry the view they were loaded for, and nothing is rendered until
  // the two agree.
  const [loadedView, setLoadedView] = useState(null);
  const [summary, setSummary] = useState(null);
  const [checked, setChecked] = useState(null);
  const [detail, setDetail] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [parties, setParties] = useState([]);
  const [items, setItems] = useState([]);

  const isPending = view === 'party-pending' || view === 'item-pending';
  const isReconcile = view === 'reconcile';



  useEffect(() => {
    fetch('/api/get-customer')
      .then((r) => r.json())
      .then((d) => setParties(d.customer || []))
      .catch(() => {});
    fetch('/api/get-item')
      .then((r) => r.json())
      .then((d) => setItems(d.item || []))
      .catch(() => {});
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    setExpanded(null);

    if (isReconcile) {
      // Its own route: it reads the whole invoice collection, which has no
      // business running behind a tab somebody opened to glance at pending
      // orders.
      fetch(`/api/order-reconcile?type=${encodeURIComponent(type)}`)
        .then((r) => r.json())
        .then((d) => {
          if (!d.success) throw new Error(d.error || 'Could not reconcile.');
          setRows(d.rows || []);
          setLoadedView(view);
          setChecked(d.checked || null);
          setSummary(null);
          setDetail([]);
        })
        .catch((e) => {
          setRows([]);
          setLoadedView(view);
          setError(e.message);
        })
        .finally(() => setLoading(false));
      return;
    }

    const qs = new URLSearchParams({ view, type });
    // The register is a date-range report; the pending views are a position
    // as at today, so a date range on them would hide orders placed outside
    // it that are still owed.
    if (view === 'register') {
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
    }
    if (party) qs.set('party', party);
    if (item) qs.set('item', item);

    const main = fetch(`/api/order-report?${qs.toString()}`).then((r) => r.json());
    // The grouped views download line-level detail, not the group totals --
    // an accountant wants the lines.
    const lines = isPending
      ? fetch(`/api/order-report?${new URLSearchParams({ ...Object.fromEntries(qs), view: 'detail' })}`)
          .then((r) => r.json())
          .catch(() => ({ rows: [] }))
      : Promise.resolve({ rows: [] });

    Promise.all([main, lines])
      .then(([d, l]) => {
        if (!d.success) throw new Error(d.error || 'Could not build the report.');
        setRows(d.rows || []);
        setLoadedView(view);
        setSummary(d.summary || null);
        setChecked(null);
        setDetail(l.rows || []);
      })
      .catch((e) => {
        setRows([]);
        setLoadedView(view);
        setError(e.message);
      })
      .finally(() => setLoading(false));
  }, [view, type, from, to, party, item, isPending, isReconcile]);

  useEffect(() => {
    load();
  }, [load]);

  const exportCsv = () => {
    // The grouped views export their LINES; the register and the
    // reconciliation export what is on screen.
    const useDetail = isPending && detail.length > 0;
    const columns = useDetail ? CSV_COLUMNS.detail : CSV_COLUMNS[view] || CSV_COLUMNS.register;
    const data = useDetail ? detail : rows;
    downloadCsv(csvFilename(useDetail ? `${view}-lines` : view, type), toCsv(columns, data));
  };

  // The two gates the table body uses. `busy` covers the render after a tab
  // click, before the new rows have arrived.
  const busy = loading || loadedView !== view;
  const shown = loadedView === view ? rows : [];

  const title = useMemo(() => reportTitle(view, type), [view, type]);
  const groupKey = view === 'item-pending' ? 'item' : 'party';
  // The item-wise view carries two extra columns -- stock and shortfall -- so
  // every colSpan under this table has to follow the view rather than be
  // written as a constant. A mismatched colSpan does not throw; it just
  // leaves a row short and the grid drifts out of line below it.
  const isItemView = view === 'item-pending';

  // Sigfa's totals row. Computed over what is SHOWN, not over everything
  // fetched, so the row under a filtered sheet totals the sheet in front of
  // you rather than one you cannot see.
  const itemTotals = useMemo(
    () => (isItemView ? sigfaItemTotals(shown) : { orderQty: 0, despQty: 0, balance: 0 }),
    [isItemView, shown]
  );

  return (
    <>
      <Suspense fallback={null}>
        <ReportUrlSync
          schema={REPORT_QUERIES.orderReport}
          values={{ type, view, from, to, party, item }}
          restore={false}
        />
      </Suspense>

      <div className="doc-sheet report-sheet">
        <div className="doc-head">
          <h2 className="doc-org">{company?.name || ''}</h2>
          <p className="doc-meta">{company ? companyAddress(company) : ''}</p>
          {/* The item-wise sheet is headed the way Sigfa heads it, because
              that is the sheet this one is read against:

                  ITEM WISE SALES PENDING ORDERS
                      (SUPER CONSOLIDATED)
                  FOR THE PERIOD FROM  01-04-2026 TO 31-03-2027

              "Super consolidated" is Sigfa's name for a sheet that totals an
              item across every order and party rather than listing it per
              order, which is exactly what this view does. */}
          <p className="doc-kind">
            {isItemView ? sigfaItemTitle(type) : title.toUpperCase()}
          </p>
          {isItemView && <p className="doc-meta mt-1">{CONSOLIDATION_LABEL}</p>}
          {isItemView && sigfaPeriodLine(from, to) && (
            <p className="doc-meta mt-1">{sigfaPeriodLine(from, to)}</p>
          )}
          {view === 'register' && (
            <p className="doc-meta mt-1">
              {asDate(from)} to {asDate(to)}
            </p>
          )}
          {isPending && !isItemView && (
            <p className="doc-meta mt-1">Position as at {asDate(todayISO())}</p>
          )}
        </div>

        {/* ── controls ─────────────────────────────────────────────── */}
        <div className="no-print mb-5 rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="mb-3 flex flex-wrap items-center gap-2">
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
            {VIEWS.map((v) => (
              <button
                key={v.key}
                type="button"
                className={`btn btn-sm ${v.key === view ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setView(v.key)}
              >
                {v.label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-end gap-4">
            {view === 'register' && (
              <>
                <div className="field">
                  <label className="field-label">From</label>
                  <input
                    type="date"
                    className="field-input w-44"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label className="field-label">To</label>
                  <input
                    type="date"
                    className="field-input w-44"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                  />
                </div>
              </>
            )}

            {!isReconcile && (
              <>
                <div className="field">
                  <label className="field-label">
                    {type === 'Purchase' ? 'Supplier' : 'Customer'}
                  </label>
                  <select
                    className="field-select w-56"
                    value={party}
                    onChange={(e) => setParty(e.target.value)}
                  >
                    <option value="">All</option>
                    {parties.map((c) => (
                      <option key={c._id || c.name} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label className="field-label">Item</label>
                  <select
                    className="field-select w-56"
                    value={item}
                    onChange={(e) => setItem(e.target.value)}
                  >
                    <option value="">All</option>
                    {items.map((i) => (
                      <option key={i._id || i.name} value={i.name}>
                        {i.name}
                      </option>
                    ))}
                  </select>
                </div>
              </>
            )}

            <div className="ml-auto flex gap-2">
              <button type="button" className="btn btn-secondary" onClick={exportCsv}>
                Download CSV
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => window.print()}>
                Print
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => router.push(`/order?type=${encodeURIComponent(type)}`)}
              >
                Orders
              </button>
            </div>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* ── the totals strip ─────────────────────────────────────── */}
        {summary && isPending && !busy && (
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <div className="stat-card">
              <div className="stat-label">Still to bill</div>
              <div className="stat-value">₹ {fmt(summary.pendingValue)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Orders</div>
              <div className="stat-value">{summary.orders}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Pending lines</div>
              <div className="stat-value">{summary.lines}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">
                {view === 'item-pending' ? 'Items' : 'Parties'}
              </div>
              <div className="stat-value">
                {view === 'item-pending' ? summary.items : summary.parties}
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Overdue</div>
              <div className="stat-value">₹ {fmt(summary.overdueValue)}</div>
              <div className="field-hint">{summary.overdueLines} lines</div>
            </div>
          </div>
        )}

        {summary && isPending && !busy && summary.lines > 0 && (
          <div className="mb-5 table-wrap">
            <table className="data-table report-table">
              <thead>
                <tr>
                  <th>Age of order</th>
                  {AGEING_BUCKETS.map((b) => (
                    <th key={b} className="num">
                      {b} days
                    </th>
                  ))}
                  <th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Pending value</td>
                  {AGEING_BUCKETS.map((b) => (
                    <td key={b} className="num">
                      {fmt(summary.byAgeing[b])}
                    </td>
                  ))}
                  <td className="num font-semibold">{fmt(summary.pendingValue)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {/* ── reconciliation verdict ───────────────────────────────── */}
        {isReconcile && !busy && !error && (
          <div
            className={`mb-5 rounded-lg border px-4 py-3 text-sm ${
              shown.length === 0
                ? 'border-success/40 bg-success/10'
                : 'border-destructive/40 bg-destructive/10 text-destructive'
            }`}
          >
            {shown.length === 0 ? (
              <>
                Every order line agrees with the invoices raised against it.
                {checked && (
                  <span className="field-hint block">
                    {checked.orderLines} order lines checked against{' '}
                    {checked.invoiceLines} referencing invoice lines.
                  </span>
                )}
              </>
            ) : (
              <>
                {shown.length} order line{shown.length === 1 ? '' : 's'} disagree with the
                invoices. Each row below shows what the order records as billed against
                what the invoices actually account for.
              </>
            )}
          </div>
        )}

        {/* ── the report ───────────────────────────────────────────── */}
        <div className="table-wrap">
          <table className="data-table report-table">
            {view === 'register' && (
              <thead>
                <tr>
                  <th>No</th>
                  <th>Date</th>
                  <th>{type === 'Purchase' ? 'Supplier' : 'Customer'}</th>
                  <th>Their ref</th>
                  <th>Status</th>
                  <th className="num">Lines</th>
                  <th className="num">Order value</th>
                  <th className="num">Still to bill</th>
                  <th className="num">Overdue</th>
                </tr>
              </thead>
            )}
            {/* THE ITEM-WISE SHEET CARRIES SIGFA'S OWN HEADINGS, spelled as
                its printed output spells them -- the full stops in
                "ORDER.QTY" and "DESP QTY." included. The shop reads this
                screen with the old sheet beside it, so a tidied-up wording
                would be a worse heading, not a better one. CURRENT STOCK is
                the single addition.

                Pending value and the overdue counts have not gone: they are
                under the table and in the download, so the header row can
                match the paper exactly. */}
            {isPending && isItemView && (
              <thead>
                <tr>
                  {SIGFA_ITEM_HEADERS.map((heading, i) => (
                    <th key={heading} className={i === 0 ? undefined : 'num'}>
                      {heading}
                    </th>
                  ))}
                  <th className="num">{STOCK_HEADER}</th>
                </tr>
              </thead>
            )}

            {isPending && !isItemView && (
              <thead>
                <tr>
                  <th>{type === 'Purchase' ? 'Supplier' : 'Customer'}</th>
                  <th className="num">Orders</th>
                  <th className="num">Lines</th>
                  <th className="num">Pending qty</th>
                  <th className="num">Pending value</th>
                  <th className="num">Overdue lines</th>
                  <th className="num">Oldest</th>
                </tr>
              </thead>
            )}
            {isReconcile && (
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Item</th>
                  <th className="num">Order says billed</th>
                  <th className="num">Invoices say billed</th>
                  <th className="num">Difference</th>
                  <th>What it means</th>
                </tr>
              </thead>
            )}

            <tbody>
              {busy && (
                <tr>
                  <td colSpan={isItemView ? 6 : 9}>
                    <div className="empty-state">Loading…</div>
                  </td>
                </tr>
              )}

              {!busy && shown.length === 0 && !isReconcile && (
                <tr>
                  <td colSpan={isItemView ? 6 : 9}>
                    <div className="empty-state">
                      Nothing to show for this filter.
                    </div>
                  </td>
                </tr>
              )}

              {!busy &&
                view === 'register' &&
                shown.map((r) => (
                  <tr key={`${r.type}-${r.orderNo}`}>
                    <td className="font-medium">{r.orderNo}</td>
                    <td>{asDate(r.date)}</td>
                    <td>{r.party || '—'}</td>
                    <td>{r.reference || '—'}</td>
                    <td>
                      <span className="chip">{r.status}</span>
                      {r.hold && <span className="chip ml-1">hold</span>}
                    </td>
                    <td className="num">
                      {r.pendingCount}/{r.lineCount}
                    </td>
                    <td className="num">{fmt(r.orderValue)}</td>
                    <td className="num font-medium">{fmt(r.pendingValue)}</td>
                    <td className="num">
                      {r.oldestOverdue > 0 ? `${r.oldestOverdue} d` : '—'}
                    </td>
                  </tr>
                ))}

              {!busy &&
                isPending &&
                shown.map((r) => {
                  const key = String(r[groupKey]);
                  const open = expanded === key;
                  return (
                    <React.Fragment key={key}>
                      <tr>
                        <td>
                          <button
                            type="button"
                            className="text-left font-medium hover:underline"
                            onClick={() => setExpanded(open ? null : key)}
                          >
                            {key}
                          </button>
                          {r.onHold > 0 && (
                            <span className="chip ml-2">{r.onHold} on hold</span>
                          )}
                        </td>
                        {isItemView ? (
                          <>
                            <td className="num">{r.unit || '—'}</td>
                            {/* ORDER.QTY is net of anything cancelled, so
                                ORDER.QTY - DESP QTY. equals BALANCE on every
                                row -- see the note in lib/orderReports.mjs. */}
                            <td className="num">{trim(r.orderQty)}</td>
                            <td className="num">{trim(r.despQty)}</td>
                            <td className="num font-medium">{trim(r.balance)}</td>
                            <td className="num">
                              {/* "not in the master" is a different fact from
                                  "none left", and on this report it usually
                                  means the name on the order does not match
                                  the name on the item. */}
                              {r.known ? (
                                trim(r.stock)
                              ) : (
                                <span title="No such item in the master">—</span>
                              )}
                              {/* The shortfall is an annotation rather than a
                                  column of its own, so the header row still
                                  matches Sigfa's exactly. */}
                              {r.shortBy > 0 && (
                                <span className="field-hint block text-destructive">
                                  short by {trim(r.shortBy)}
                                </span>
                              )}
                              {r.cancelledQty > 0 && (
                                <span className="field-hint block">
                                  {trim(r.cancelledQty)} cancelled
                                </span>
                              )}
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="num">{r.orderCount}</td>
                            <td className="num">{r.lineCount}</td>
                            <td className="num">{trim(r.pendingQty)}</td>
                            <td className="num font-medium">{fmt(r.pendingValue)}</td>
                            <td className="num">{r.overdueLines || '—'}</td>
                            <td className="num">
                              {r.oldestOverdue > 0 ? `${r.oldestOverdue} d` : '—'}
                            </td>
                          </>
                        )}
                      </tr>
                      {open &&
                        r.lines.map((l, i) => (
                          <tr key={`${key}-${i}`} className="bg-muted/30">
                            <td className="pl-6 text-sm">
                              {view === 'item-pending' ? l.party : l.item}
                              <span className="field-hint block">
                                {l.type} order {l.orderNo} · {asDate(l.orderDate)}
                                {l.promised ? ` · promised ${asDate(l.promised)}` : ''}
                              </span>
                            </td>
                            {isItemView ? (
                              <>
                                <td className="num text-sm">{l.uqc || '—'}</td>
                                <td className="num text-sm">
                                  {trim(l.ordered - l.cancelled)}
                                </td>
                                <td className="num text-sm">{trim(l.billed)}</td>
                                <td className="num text-sm">{trim(l.pending)}</td>
                                <td className="num text-sm">
                                  {fmt(l.value)}
                                  <span className="field-hint block">
                                    {l.overdueDays > 0 ? `${l.overdueDays} d overdue` : l.ageing}
                                  </span>
                                </td>
                              </>
                            ) : (
                              <>
                                <td className="num text-sm">{l.orderNo}</td>
                                <td className="num text-sm">
                                  {trim(l.billed)}/{trim(l.ordered)}
                                </td>
                                <td className="num text-sm">{trim(l.pending)}</td>
                                <td className="num text-sm">{fmt(l.value)}</td>
                                <td className="num text-sm">
                                  {l.overdueDays > 0 ? `${l.overdueDays} d` : '—'}
                                </td>
                                <td className="num text-sm">{l.ageing}</td>
                              </>
                            )}
                          </tr>
                        ))}
                    </React.Fragment>
                  );
                })}

              {!busy &&
                isReconcile &&
                shown.map((r, i) => (
                  <tr key={`${r.type}-${r.orderNo}-${r.lineId}-${i}`}>
                    <td className="font-medium">
                      {r.type} {r.orderNo}
                    </td>
                    <td>{r.item || '—'}</td>
                    <td className="num">{trim(r.stored)}</td>
                    <td className="num">{trim(r.derived)}</td>
                    <td className="num font-medium">
                      {r.difference > 0 ? '+' : ''}
                      {trim(r.difference)}
                    </td>
                    <td className="text-sm">{r.reason}</td>
                  </tr>
                ))}
            </tbody>

            {!busy && view === 'register' && shown.length > 0 && (
              <tfoot>
                <tr>
                  <td colSpan={6}>{shown.length} orders</td>
                  <td className="num">
                    {fmt(shown.reduce((s, r) => s + r.orderValue, 0))}
                  </td>
                  <td className="num">
                    {fmt(shown.reduce((s, r) => s + r.pendingValue, 0))}
                  </td>
                  <td />
                </tr>
              </tfoot>
            )}

            {!busy && isPending && isItemView && shown.length > 0 && (
              <tfoot>
                <tr>
                  {/* Sigfa prints its totals row as "TOTAL  :-", with the
                      quantity columns added and the stock column left
                      blank -- adding a tonne of steel to four hundred washers
                      gives a number that answers nothing. */}
                  <td className="font-medium">{TOTAL_LABEL}</td>
                  <td />
                  <td className="num font-medium">{trim(itemTotals.orderQty)}</td>
                  <td className="num font-medium">{trim(itemTotals.despQty)}</td>
                  <td className="num font-medium">{trim(itemTotals.balance)}</td>
                  <td />
                </tr>
              </tfoot>
            )}

            {!busy && isPending && !isItemView && shown.length > 0 && (
              <tfoot>
                <tr>
                  <td colSpan={4}>{shown.length} parties</td>
                  <td className="num">
                    {fmt(shown.reduce((s, r) => s + r.pendingValue, 0))}
                  </td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        {/* Pending value and the overdue counts moved off the header row so it
            could match Sigfa's exactly. They are here and in the download --
            nothing was dropped, only relocated. */}
        {!busy && isItemView && shown.length > 0 && (
          <p className="field-hint mt-3">
            {shown.length} item{shown.length === 1 ? '' : 's'} · pending value{' '}
            {fmt(shown.reduce((s, r) => s + r.pendingValue, 0))}
            {shown.reduce((s, r) => s + (r.overdueLines || 0), 0) > 0 &&
              ` · ${shown.reduce((s, r) => s + (r.overdueLines || 0), 0)} overdue line(s)`}
            {shown.reduce((s, r) => s + (r.shortBy || 0), 0) > 0 &&
              ` · short on ${shown.filter((r) => r.shortBy > 0).length} item(s)`}
          </p>
        )}
      </div>
    </>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
      <OrderReports />
    </Suspense>
  );
}
