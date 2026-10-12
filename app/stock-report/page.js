'use client';
import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useCompany } from '@/context/CompanyContext';
import { companyAddress } from '@/lib/company.mjs';
import DateFilter from '@/components/reports/DateFilter';
import ReportUrlSync from '@/components/reports/ReportUrlSync';
import { REPORT_QUERIES, parseReportQuery } from '@/lib/reportQuery.mjs';
import { resolvePeriod } from '@/lib/reportPeriods.mjs';
import {
  COSTING_METHOD,
  MOVEMENT_TYPES,
  MOVEMENT_TYPE_KEYS,
} from '@/lib/inventoryReports.mjs';
import { Notice } from '@/components/ui/notice';
import { useReportDownload } from '@/components/reports/useReportDownload';

export const dynamic = 'force-dynamic';

/**
 * The inventory reports: stock summary, movement history, valuation.
 *
 * NOTHING IS COMPUTED HERE. Every figure comes from /api/stock-report, which
 * sums the stock ledger exactly as the dashboard, the billing screens and the
 * financial statements do (lib/inventoryReports.mjs). The page lays it out,
 * pages through long movement lists, and asks the same route for the CSV and
 * the workbook.
 *
 * The filters live in the URL (lib/reportQuery.mjs), read before the first
 * fetch, so a report can be bookmarked or sent. The period is the shared
 * DateFilter with all thirteen presets; the valuation is as at its end date.
 *
 * PRINTING follows the other registers: `doc-sheet`, the firm's letterhead,
 * `no-print` on every control.
 */

const VIEWS = [
  { key: 'summary', label: 'Stock summary' },
  { key: 'movements', label: 'Movements' },
  { key: 'valuation', label: 'Valuation' },
];

const STATUS_LABELS = {
  all: 'All items',
  low: 'Needs attention',
  negative: 'Negative stock',
  out: 'Out of stock',
  below: 'Below minimum',
  'in-stock': 'In stock',
};

const qty = (n) =>
  n === null || n === undefined ? '—' : String(parseFloat((Number(n) || 0).toFixed(3)));

const money = (n) =>
  n === null || n === undefined
    ? '—'
    : new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
        Number(n) || 0
      );

const asDate = (v) => (v ? new Date(v).toLocaleDateString('en-IN') : '—');

function StockReport() {
  const { company } = useCompany();

  // A shared link's filters, read BEFORE the first render, so the first fetch
  // is already the link's report (the reason is in lib/reportQuery.mjs).
  const searchParams = useSearchParams();
  const [link] = useState(() => parseReportQuery(REPORT_QUERIES.stockReport, searchParams).values);

  const [view, setView] = useState(link.view ?? 'summary');
  const [period, setPeriod] = useState(() =>
    resolvePeriod({ preset: link.preset ?? 'thisMonth', from: link.from, to: link.to })
  );
  const [q, setQ] = useState(link.q ?? '');
  const [item, setItem] = useState(link.item ?? '');
  const [type, setType] = useState(link.type ?? '');
  const [ref, setRef] = useState(link.ref ?? '');
  // What is typed in the two text boxes, applied after a pause -- a report per
  // keystroke would read up to 20,000 movements each time.
  const [qInput, setQInput] = useState(link.q ?? '');
  const [refInput, setRefInput] = useState(link.ref ?? '');
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(qInput);
      setRef(refInput);
    }, 350);
    return () => clearTimeout(t);
  }, [qInput, refInput]);
  const [status, setStatus] = useState(link.status ?? 'all');

  const [items, setItems] = useState([]);
  const [data, setData] = useState(null);
  const [loadedFor, setLoadedFor] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/get-item')
      .then((r) => r.json())
      .then((d) => setItems((d.item || []).map((i) => i.name).filter(Boolean).sort()))
      .catch(() => {});
  }, []);

  /** The route's query for what is on screen -- the fetch and the downloads share it. */
  const query = useMemo(() => {
    const qs = new URLSearchParams({ view, from: period.from || '', to: period.to || '' });
    if (q.trim()) qs.set('q', q.trim());
    if (view === 'movements') {
      if (item) qs.set('item', item);
      if (type) qs.set('type', type);
      if (ref.trim()) qs.set('ref', ref.trim());
    }
    if (view === 'summary' && status !== 'all') qs.set('status', status);
    return qs.toString();
  }, [view, period.from, period.to, q, item, type, ref, status]);

  // The page belongs to the filters it was chosen under: change a filter and
  // the list starts again at page 1, in the same render -- no second fetch.
  const [paging, setPaging] = useState({ query: '', page: 1 });
  const page = paging.query === query ? paging.page : 1;
  const setPage = (next) =>
    setPaging({ query, page: typeof next === 'function' ? next(page) : next });

  const signature = `${query}|${page}`;

  // Only the newest request may touch the screen. A slower reply for filters
  // already left behind would otherwise overwrite the current report -- or
  // stamp its own signature and leave the page on "Working it out…" for good.
  const latest = useRef(0);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    setLoading(true);
    setError('');
    try {
      const qs = new URLSearchParams(query);
      if (view === 'movements') qs.set('page', String(page));
      const res = await fetch(`/api/stock-report?${qs.toString()}`);
      const body = await res.json();
      if (mine !== latest.current) return;
      if (!body.success) {
        setError(body.error || 'Could not build the report.');
        setData(null);
      } else {
        setData(body);
      }
    } catch (err) {
      if (mine !== latest.current) return;
      setError(err.message || 'Could not build the report.');
      setData(null);
    } finally {
      // Stamped on every path of the NEWEST request, so the figures on screen
      // always say which filters they were built for.
      if (mine === latest.current) {
        setLoadedFor(`${query}|${page}`);
        setLoading(false);
      }
    }
  }, [query, page, view]);

  useEffect(() => {
    load();
  }, [load]);

  const busy = loading || loadedFor !== signature;
  const shown = loadedFor === signature ? data : null;
  const rows = shown?.rows || [];

  // Downloads fetch first, so a refusal is a message here rather than a
  // page of raw JSON in place of the app. lib/downloadFile.mjs.
  const exporter = useReportDownload();

  const download = (format) => {
    const qs = new URLSearchParams(query);
    qs.set('format', format);
    exporter.download(`/api/stock-report?${qs.toString()}`);
  };

  const title = VIEWS.find((v) => v.key === view)?.label || 'Stock';

  return (
    <div className="page-shell-wide doc-sheet report-sheet">
      <ReportUrlSync
        schema={REPORT_QUERIES.stockReport}
        values={{ view, preset: period.preset, from: period.from, to: period.to, q, item, type, ref, status }}
        restore={false}
      />

      <div className="doc-head">
        <p className="doc-org">{company?.name || ''}</p>
        <p className="doc-meta">{company ? companyAddress(company) : ''}</p>
        <p className="doc-kind">{title.toUpperCase()}</p>
        <p className="doc-meta mt-1">
          {view === 'valuation'
            ? `As at ${asDate(period.to)}`
            : `${asDate(period.from)} to ${asDate(period.to)}`}
        </p>
      </div>

      {/* ── controls ─────────────────────────────────────────────── */}
      <div className="no-print mb-5 rounded-xl border border-border bg-card p-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              className={`btn btn-sm ${view === v.key ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setView(v.key)}
            >
              {v.label}
            </button>
          ))}
        </div>

        <div className="mb-3">
          <DateFilter
            idPrefix="sr"
            preset={period.preset}
            from={period.from}
            to={period.to}
            onChange={setPeriod}
            note={view === 'valuation' ? 'The valuation is as at the end of the period.' : ''}
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <div>
            <label className="field-label" htmlFor="sr-q">Search</label>
            <input
              id="sr-q"
              className="field-input mt-1.5"
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              placeholder={view === 'movements' ? 'Item, party or document' : 'Item, HSN or group'}
              maxLength={120}
            />
          </div>

          {view === 'movements' && (
            <>
              <div>
                <label className="field-label" htmlFor="sr-item">Item</label>
                <select
                  id="sr-item"
                  className="field-input mt-1.5"
                  value={item}
                  onChange={(e) => setItem(e.target.value)}
                >
                  <option value="">All items</option>
                  {items.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="field-label" htmlFor="sr-type">Type</label>
                <select
                  id="sr-type"
                  className="field-input mt-1.5"
                  value={type}
                  onChange={(e) => setType(e.target.value)}
                >
                  <option value="">All movements</option>
                  {MOVEMENT_TYPE_KEYS.map((k) => (
                    <option key={k} value={k}>
                      {MOVEMENT_TYPES[k]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="field-label" htmlFor="sr-ref">Document No</label>
                <input
                  id="sr-ref"
                  className="field-input mt-1.5"
                  value={refInput}
                  onChange={(e) => setRefInput(e.target.value)}
                  placeholder="e.g. 412 or PRD-7"
                  maxLength={120}
                />
              </div>
            </>
          )}

          {view === 'summary' && (
            <div>
              <label className="field-label" htmlFor="sr-status">Showing</label>
              <select
                id="sr-status"
                className="field-input mt-1.5"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                {Object.entries(STATUS_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-secondary" onClick={() => window.print()}>
            Print
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => download('xlsx')}
            disabled={busy || !rows.length}
          >
            Download Excel
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => download('csv')}
            disabled={busy || !rows.length}
          >
            Download CSV
          </button>
        </div>
      </div>

      <Notice notice={exporter.notice} onClose={exporter.notify.clear} />
      {error && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {busy && <div className="empty-state">Working it out…</div>}

      {/* ── summary ─────────────────────────────────────────────── */}
      {!busy && shown && view === 'summary' && (
        <>
          <p className="field-hint mb-3">
            {shown.totals.items} item(s) · {shown.totals.low} need attention ({shown.totals.out} out,{' '}
            {shown.totals.negative} negative, {shown.totals.below} below minimum). Opening is the
            stock at the start of the period; quantities in different units are not added up.
          </p>
          <div className="table-wrap">
            <table className="data-table report-table min-w-[760px]">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>HSN</th>
                  <th>Unit</th>
                  <th className="num">Opening</th>
                  <th className="num">In</th>
                  <th className="num">Out</th>
                  <th className="num">Closing</th>
                  <th className="num">Minimum</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={9}>
                      <div className="empty-state">No items match.</div>
                    </td>
                  </tr>
                )}
                {rows.map((r) => (
                  <tr key={r.name}>
                    <td className="font-medium">
                      {r.name}
                      {r.isService && <span className="chip ml-2">Service</span>}
                      {!r.inMaster && <span className="chip ml-2">Not in item master</span>}
                    </td>
                    <td>{r.hsn || '—'}</td>
                    <td>{r.unit || '—'}</td>
                    <td className="num">{qty(r.opening)}</td>
                    <td className="num">{r.received ? qty(r.received) : ''}</td>
                    <td className="num">{r.issued ? qty(r.issued) : ''}</td>
                    <td className="num font-medium">{qty(r.closing)}</td>
                    <td className="num">{qty(r.minimum)}</td>
                    <td>{r.statusLabel ? <span className="chip">{r.statusLabel}</span> : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ── movements ───────────────────────────────────────────── */}
      {!busy && shown && view === 'movements' && (
        <>
          <p className="field-hint mb-3">
            {shown.totals.movements} movement(s). The running quantity counts every movement of the
            item in date order, including any the filters hide.
          </p>
          <div className="table-wrap">
            <table className="data-table report-table min-w-[860px]">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Item</th>
                  <th>Type</th>
                  <th>Document</th>
                  <th>Party</th>
                  <th className="num">In</th>
                  <th className="num">Out</th>
                  <th className="num">Running</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={8}>
                      <div className="empty-state">No movements in this period.</div>
                    </td>
                  </tr>
                )}
                {rows.map((r) => (
                  <tr key={r.id || `${r.ref}-${r.itemName}-${r.date}`}>
                    <td>{asDate(r.date)}</td>
                    <td className="font-medium">{r.itemName}</td>
                    <td>{r.typeLabel}</td>
                    <td>{r.ref}</td>
                    <td>{r.party}</td>
                    <td className="num">{r.received ? qty(r.received) : ''}</td>
                    <td className="num">{r.issued ? qty(r.issued) : ''}</td>
                    <td className="num font-medium">
                      {qty(r.running)} {r.unit}
                    </td>
                  </tr>
                ))}
              </tbody>
              {rows.length > 0 && (
                <tfoot>
                  <tr className="font-medium">
                    <td colSpan={5}>Total of the movements listed</td>
                    <td className="num">{qty(shown.totals.received)}</td>
                    <td className="num">{qty(shown.totals.issued)}</td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          {shown.pages > 1 && (
            <div className="no-print mt-3 flex items-center gap-2">
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </button>
              <span className="text-sm">
                Page {shown.page} of {shown.pages}
              </span>
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                disabled={page >= shown.pages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}

      {/* ── valuation ───────────────────────────────────────────── */}
      {!busy && shown && view === 'valuation' && (
        <>
          <div className="mb-4 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm">
            <p className="font-medium">Closing stock {money(shown.totals.value)}</p>
            <p className="mt-1">
              Valued {shown.totals.valued} of {shown.totals.held} items holding stock. {COSTING_METHOD}
            </p>
            {shown.totals.missingCosts?.length > 0 && (
              <p className="mt-1 text-destructive">
                No cost in the item master for: {shown.totals.missingCosts.join(', ')}. They are not
                in the total.
              </p>
            )}
          </div>
          <div className="table-wrap">
            <table className="data-table report-table min-w-[760px]">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>HSN</th>
                  <th>Unit</th>
                  <th className="num">Quantity</th>
                  <th className="num">Cost</th>
                  <th className="num">Value</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={7}>
                      <div className="empty-state">No stock on hand at this date.</div>
                    </td>
                  </tr>
                )}
                {rows.map((r) => (
                  <tr key={r.name}>
                    <td className="font-medium">{r.name}</td>
                    <td>{r.hsn || '—'}</td>
                    <td>{r.unit || '—'}</td>
                    <td className="num">{qty(r.quantity)}</td>
                    <td className="num">{money(r.cost)}</td>
                    <td className="num">{money(r.value)}</td>
                    <td>{r.note}</td>
                  </tr>
                ))}
              </tbody>
              {rows.length > 0 && (
                <tfoot>
                  <tr className="font-medium">
                    <td colSpan={5}>Total of the items listed</td>
                    <td className="num">{money(shown.totals.shownValue)}</td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </>
      )}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
      <StockReport />
    </Suspense>
  );
}
