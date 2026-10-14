'use client';
export const dynamic = "force-dynamic";

/**
 * Sigfa's stock reports.
 *
 *   Stock Summary · Stock Summary Value Wise · Stock Short List ·
 *   Stock Aging Analysis · Stock Day Book
 *
 * One page, one route, five sheets -- told apart by `report`, which is what
 * each of the Reports hub's five tiles preselects.
 *
 * THIS PAGE COMPUTES NOTHING. Every figure comes from /api/stock-report,
 * which builds it through lib/inventory.mjs, which in turn defers to
 * lib/itemStock.mjs for the closing quantity, lib/dashboard.mjs for what
 * counts as low and lib/salesReports.mjs for the weighted average rate. The
 * only arithmetic here is slicing `rows` for the pager.
 *
 * Both downloads go back to the SAME route with `format=csv|xlsx`, so an
 * export is the report rather than a second rendering of it. The note atop
 * lib/reportHttp.js has the reasoning.
 */

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useCompany } from '@/context/CompanyContext';
// The same letterhead the invoice and the statements print, from the same
// components -- a stock sheet and the bill behind it must not show the firm
// differently.
import { CompanyBrand, CompanyLogo } from '@/components/CompanyBrand';
import { formatINR } from '@/lib/currency.mjs';
import DateFilter from '@/components/reports/DateFilter';
import StockReportSearchParams from '@/components/StockReportSearchParams';
import { Notice } from '@/components/ui/notice';
import { useReportDownload } from '@/components/reports/useReportDownload';
import { isPreset, periodText } from '@/lib/reportPeriods.mjs';
import {
  DEFAULT_BASIS,
  DEFAULT_FILTER,
  FILTER_LABELS,
  STOCK_FILTERS,
  STOCK_REPORTS,
  STOCK_REPORT_KEYS,
  agingColumns,
  basisOf,
  headings,
  isStockFilter,
  isStockReport,
  reportTakesPeriod,
  showQuantity,
  SHORT_COLUMNS,
  STOCK_COLUMNS,
  DAY_BOOK_COLUMNS,
  valueColumns,
} from '@/lib/inventory.mjs';

const PAGE_SIZE = 100;

const asDate = (value) => {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  // IST, like every other date in this app: the browser may be anywhere.
  const ist = new Date(d.getTime() + (5 * 60 + 30) * 60 * 1000);
  const dd = String(ist.getUTCDate()).padStart(2, '0');
  const mm = String(ist.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${ist.getUTCFullYear()}`;
};

/** A quantity, or nothing. A grid of 0.000 is a grid nobody can read. */
const qty = (value) => showQuantity(value) === '0' ? '' : showQuantity(value);
const money = (value) =>
  value === null || value === undefined ? '' : formatINR(value);

function StockReport() {
  // The firm whose stock this is -- never a hardcoded one.
  const { company } = useCompany();

  const [report, setReport] = useState('summary');
  const [basis, setBasis] = useState(DEFAULT_BASIS);
  const [filter, setFilter] = useState(DEFAULT_FILTER);
  const [item, setItem] = useState('');
  const [period, setPeriod] = useState({ preset: 'thisFy', from: '', to: '' });

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const exporter = useReportDownload();

  // What the last successful fetch was for, so re-selecting the chip that is
  // already on costs no request.
  const fetched = useRef(null);
  // Which request is the newest. Switching chips fires a fetch per click,
  // and a slow reply for a sheet already left must not overwrite the one now
  // on screen.
  const latest = useRef(0);

  const query = useMemo(() => {
    const params = new URLSearchParams({ report, preset: period.preset });
    if (report === 'value') params.set('basis', basis);
    if (report === 'summary' || report === 'value') params.set('filter', filter);
    if (report === 'daybook' && item) params.set('item', item);
    if (period.from) params.set('from', period.from);
    if (period.to) params.set('to', period.to);
    return params;
  }, [report, basis, filter, item, period]);

  const load = useCallback(async () => {
    const key = query.toString();
    if (fetched.current === key) return;
    const mine = ++latest.current;

    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/stock-report?${key}`);
      const body = await res.json();
      if (mine !== latest.current) return;
      if (!res.ok || !body.success) throw new Error(body.error || 'Could not draw the sheet.');
      setData(body);
      setPage(0);
      fetched.current = key;
    } catch (err) {
      if (mine !== latest.current) return;
      setError(err.message);
      setData(null);
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    load();
  }, [load]);

  const columns = useMemo(() => {
    if (report === 'value') return valueColumns();
    if (report === 'short') return SHORT_COLUMNS;
    if (report === 'aging') return agingColumns(data?.slabs);
    if (report === 'daybook') return DAY_BOOK_COLUMNS;
    return STOCK_COLUMNS;
  }, [report, data?.slabs]);

  const rows = data?.rows || [];
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const shown = rows.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const totals = data?.totals || null;
  const takesPeriod = reportTakesPeriod(report);
  const config = STOCK_REPORTS.find((r) => r.key === report);

  const download = (format) => {
    const params = new URLSearchParams(query);
    params.set('format', format);
    // Fetched, so a refused export shows its reason on this screen instead of
    // replacing the app with a page of JSON. components/reports/useReportDownload.
    exporter.download(`/api/stock-report?${params.toString()}`);
  };

  /**
   * A deep link's values, applied once.
   *
   * Every one is checked against the module that owns it: these come off a
   * URL anybody can edit, and an unknown `report` would leave the page in a
   * state with no config behind it.
   */
  const applyLink = useCallback((values) => {
    if (isStockReport(values.report)) setReport(values.report);
    if (basisOf(values.basis)?.supported) setBasis(values.basis);
    if (isStockFilter(values.filter)) setFilter(values.filter);
    if (values.item) setItem(values.item);
    if (isPreset(values.preset) || values.from || values.to) {
      setPeriod({
        preset: isPreset(values.preset) ? values.preset : 'custom',
        from: values.from,
        to: values.to,
      });
    }
  }, []);

  /** The cell for one column of one row, by the column's own type. */
  const cellOf = (column, row) => {
    const value = typeof column.value === 'function' ? column.value(row) : row?.[column.key];
    if (column.type === 'qty') return qty(value);
    if (column.type === 'money') return money(value);
    if (column.type === 'date') return asDate(value);
    if (column.type === 'int') return value === null || value === undefined ? '' : String(value);
    return value === null || value === undefined ? '' : String(value);
  };

  return (
    <div className="page-shell-wide">
      {/* A deep link from the Reports hub, or a bookmark. */}
      <StockReportSearchParams onValues={applyLink} />

      {/* ── controls ─────────────────────────────────────────────── */}
      <div className="no-print">
        <div className="page-header">
          <h1 className="page-title">Stock reports</h1>
          <p className="page-subtitle">
            What moved and what is on the shelf, summed from the stock ledger &mdash; never from
            the quantity typed into the item master.
          </p>
        </div>

        <div className="panel mb-5">
          <div className="panel-body space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              {STOCK_REPORT_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`btn btn-sm ${report === key ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setReport(key)}
                >
                  {STOCK_REPORTS.find((r) => r.key === key).name}
                </button>
              ))}
            </div>
            {config ? <p className="field-hint">{config.blurb}</p> : null}

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {report === 'value' && (
                <div>
                  <label className="field-label" htmlFor="sr-basis">
                    Valuation
                  </label>
                  <select
                    id="sr-basis"
                    className="field-select mt-1.5"
                    value={basis}
                    onChange={(e) => setBasis(e.target.value)}
                  >
                    {/* Sigfa's seven, with the two this app's data cannot
                        carry shown and disabled rather than quietly dropped
                        -- somebody looking for FIFO deserves to be told why
                        it is not there. */}
                    {(data?.bases || []).map((b) => (
                      <option key={b.key} value={b.key} disabled={!b.supported}>
                        {b.name}
                        {b.supported ? '' : ' — not available'}
                      </option>
                    ))}
                  </select>
                  <p className="field-hint mt-1">{basisOf(basis)?.source}</p>
                </div>
              )}

              {(report === 'summary' || report === 'value') && (
                <div>
                  <label className="field-label" htmlFor="sr-filter">
                    Showing
                  </label>
                  <select
                    id="sr-filter"
                    className="field-select mt-1.5"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  >
                    {STOCK_FILTERS.map((f) => (
                      <option key={f} value={f}>
                        {FILTER_LABELS[f]}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {report === 'daybook' && (
                <div>
                  <label className="field-label" htmlFor="sr-item">
                    One item only
                  </label>
                  <input
                    id="sr-item"
                    className="field-input mt-1.5"
                    value={item}
                    placeholder="Every item"
                    onChange={(e) => setItem(e.target.value)}
                  />
                  <p className="field-hint mt-1">
                    Leave blank for every item. For one item&apos;s running balance use the{' '}
                    <Link className="link" href="/item-ledger">
                      Stock Ledger
                    </Link>
                    .
                  </p>
                </div>
              )}
            </div>

            {takesPeriod ? (
              <DateFilter
                idPrefix="sr"
                preset={period.preset}
                from={period.from}
                to={period.to}
                onChange={setPeriod}
                note={rows.length ? `${rows.length} row${rows.length === 1 ? '' : 's'}` : ''}
              />
            ) : (
              /* Not a date range, and the sheet says so rather than offering
                 a filter that would not change the answer: a level and an
                 age are both about stock as it stands today. */
              <p className="field-hint">
                As on {asDate(data?.asOf)} &mdash; a level and an age are about the stock on the
                shelf now, so this sheet takes no date range.
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => window.print()}
                disabled={!data}
              >
                Print
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => download('xlsx')}
                disabled={!rows.length || exporter.busy}
              >
                Download Excel
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => download('csv')}
                disabled={!rows.length || exporter.busy}
              >
                Download CSV
              </button>
              <Link className="btn btn-ghost btn-sm" href="/reports">
                All reports
              </Link>
            </div>
            <Notice notice={exporter.notice} onClose={exporter.notify.clear} />
          </div>
        </div>
      </div>

      {error && (
        <div className="no-print mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading && !data && <div className="empty-state no-print">Drawing the sheet…</div>}

      {/* ── the sheet ────────────────────────────────────────────── */}
      {data && (
        <div className="doc-sheet report-sheet">
          <div className="doc-head">
            <div className="flex flex-col items-center gap-2">
              <CompanyLogo company={company} variant="print" />
              <CompanyBrand company={company} size="report" align="center" />
            </div>
            <p className="doc-kind">{(data.reportName || '').toUpperCase()}</p>
          </div>

          <div className="report-party">
            <div>
              <p className="doc-meta">
                <span className="font-medium">{takesPeriod ? 'Period:' : 'As on:'}</span>{' '}
                {takesPeriod ? periodText(data.period?.from, data.period?.to) : asDate(data.asOf)}
              </p>
              {report === 'value' ? (
                <p className="doc-meta">
                  <span className="font-medium">Valuation:</span> {basisOf(data.basis)?.name}
                </p>
              ) : null}
              {report === 'aging' ? (
                <p className="doc-meta">
                  <span className="font-medium">Day slabs:</span> {(data.slabs || []).join(', ')}
                </p>
              ) : null}
            </div>
            <div className="sm:text-right">
              <p className="doc-meta">
                <span className="font-medium">Items:</span> {rows.length}
              </p>
              {filter !== DEFAULT_FILTER && (report === 'summary' || report === 'value') ? (
                <p className="doc-meta">
                  <span className="font-medium">Showing:</span> {FILTER_LABELS[filter]}
                </p>
              ) : null}
            </div>
          </div>

          {/* What the value-wise sheet could NOT value, said plainly under
              the heading rather than left for somebody to notice. */}
          {report === 'value' && data.coverage?.unvalued ? (
            <div className="mb-4 rounded-lg border border-amber-400/40 bg-amber-400/10 px-4 py-3 text-sm">
              {data.coverage.unvalued} of {data.coverage.items} items holding stock have no rate on
              this basis, so they are not in the total:{' '}
              {data.coverage.names.join(', ')}
              {data.coverage.unvalued > data.coverage.names.length ? ', …' : ''}. The figure below
              is for the {data.coverage.valued} that do.
            </div>
          ) : null}

          {report === 'short' && data.summary ? (
            <div className="mb-5 grid gap-3 sm:grid-cols-4">
              <div className="stat-card">
                <p className="stat-label">Needing attention</p>
                <p className="stat-value">{data.summary.alerts}</p>
              </div>
              <div className="stat-card">
                <p className="stat-label">Out or negative</p>
                <p className="stat-value">{data.summary.out + data.summary.negative}</p>
              </div>
              <div className="stat-card">
                <p className="stat-label">Below a level</p>
                <p className="stat-value">{data.summary.below + data.summary.reorder}</p>
              </div>
              <div className="stat-card">
                <p className="stat-label">Over the maximum</p>
                <p className="stat-value">{data.summary.over}</p>
              </div>
            </div>
          ) : null}

          {report === 'short' && data.summary?.withoutMinimum ? (
            <p className="field-hint mb-3">
              {data.summary.withMinimum} of {data.summary.items} items have a level set. The rest
              appear here only when they run out or go negative, which needs no level &mdash; set
              one on the item master to be warned sooner.
            </p>
          ) : null}

          {!rows.length ? (
            <div className="empty-state">
              {report === 'short'
                ? 'Nothing is out of stock, below a level or over its maximum.'
                : report === 'daybook'
                ? `Nothing moved ${periodText(data.period?.from, data.period?.to).toLowerCase()}.`
                : 'No items match this filter.'}
            </div>
          ) : (
            <>
              <div className="table-wrap">
                <table className="data-table report-table min-w-[900px]">
                  <thead>
                    <tr>
                      <th className="num">#</th>
                      {columns.map((c) => (
                        <th key={c.key} className={c.type === 'text' ? undefined : 'num'}>
                          {c.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((row, index) => (
                      <tr key={`${row.name || row.voucher || ''}-${row._id || index}`}>
                        <td className="num">{page * PAGE_SIZE + index + 1}</td>
                        {columns.map((c) => (
                          <td key={c.key} className={c.type === 'text' ? undefined : 'num'}>
                            {cellOf(c, row)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                  {totals ? (
                    <tfoot>
                      <tr>
                        <td className="num" />
                        {columns.map((c, i) => (
                          <td key={c.key} className={c.type === 'text' ? undefined : 'num'}>
                            {i === 0
                              ? 'Total'
                              : /* Only the columns a total is meaningful for --
                                   the same rule lib/inventory.mjs's sheetTotals
                                   applies to the export, so the printed sheet
                                   and the spreadsheet foot the same way. */
                                totalOf(c, totals, data)}
                          </td>
                        ))}
                      </tr>
                    </tfoot>
                  ) : null}
                </table>
              </div>

              {pages > 1 && (
                <div className="no-print mt-3 flex items-center justify-between">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0}
                  >
                    Previous
                  </button>
                  <span className="field-hint">
                    Page {page + 1} of {pages} &mdash; the download has every row.
                  </span>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
                    disabled={page >= pages - 1}
                  >
                    Next
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The footer cell for one column.
 *
 * The totals object carries only the keys a sum means something for, which is
 * why this reads it rather than summing anything: a "Reason" column under the
 * word Total would read as a reason, and a sum of minimum levels is not a
 * number anybody wants.
 */
const totalOf = (column, totals, data) => {
  if (column.key?.startsWith('slab')) {
    const index = Number(column.key.slice(4));
    const value = data?.totals?.buckets?.[index];
    return value === undefined ? '' : showQuantity(value);
  }
  if (!(column.key in (totals || {}))) return '';
  const value = totals[column.key];
  if (column.type === 'money') return money(value);
  if (column.type === 'qty') return showQuantity(value);
  return value === null || value === undefined ? '' : String(value);
};

const page = () => (
  <Suspense fallback={<div className="page-shell text-sm text-muted-foreground">Loading…</div>}>
    <StockReport />
  </Suspense>
);

export default page;
