'use client';
import React, { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useCompany } from '@/context/CompanyContext';
import { companyAddress } from '@/lib/company.mjs';
import ReportUrlSync from '@/components/reports/ReportUrlSync';
import { REPORT_QUERIES, parseReportQuery } from '@/lib/reportQuery.mjs';
import { useSearchParams } from 'next/navigation';
import { toCsv } from '@/lib/orderReports.mjs';
import {
  BOOK_GRAINS,
  CSV_COLUMNS,
  sheetHeadings,
  DEFAULT_GRAIN,
  DEFAULT_SCOPE,
  DOC_SCOPES,
  REPORT_SIDES,
  SALES_VIEWS,
  csvFilename,
  reportName,
  scopeName,
} from '@/lib/salesReports.mjs';
import { Notice } from '@/components/ui/notice';
import { useReportDownload } from '@/components/reports/useReportDownload';

export const dynamic = 'force-dynamic';

/**
 * Sigfa's Sales and Purchase module reports.
 *
 * SIX REPORTS, THREE SHAPES, ONE SCREEN. Its menus:
 *
 *     &Sales Module          &Purchase Module
 *       &Sales Book            &Purchase Book
 *       &Party Wise Sales      &Party Wise
 *       &Item Wise Sales       &Item Wise
 *
 * The side is a pair of buttons and the shape is a tab, because they are one
 * body of documents looked at three ways -- the same reason the order reports
 * are one page rather than four.
 *
 * THE BOOK OPENS BY MONTH, as Sigfa's does, and a month row opens the dates
 * inside it -- its zoom. A third grain lists the bills themselves, which
 * Sigfa keeps as a separate report and which is what anyone hunting one
 * invoice wants. The scope selector is Sigfa's own, less the challan it has
 * and this app does not. lib/salesReports.mjs has the evidence for all three.
 *
 * NOTHING IS COMPUTED HERE. Every figure comes from that module, by way of
 * the route. The page formats and lays out, and that is all.
 *
 * PRINTING follows the ledger, voucher and order registers: `doc-sheet` for
 * the page, the firm's letterhead at the top, `no-print` on every control, so
 * Ctrl+P gives the same kind of sheet everywhere in the app.
 */

const VIEW_LABELS = { book: 'Book', party: 'Party Wise', item: 'Item Wise' };
const GRAIN_LABELS = { month: 'Month Wise', date: 'Date Wise', document: 'Bill Wise' };

const money = (n) =>
  new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    Number(n) || 0
  );

const qty = (n) => String(parseFloat((Number(n) || 0).toFixed(3)));

const asDate = (v) => (v ? new Date(v).toLocaleDateString('en-IN') : '—');

/** The first and last day of the month a date falls in, as yyyy-mm-dd. */
const monthBounds = () => {
  const now = new Date();
  const ist = new Date(now.getTime() + (5 * 60 + 30) * 60 * 1000);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  const pad = (n) => String(n).padStart(2, '0');
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return { from: `${y}-${pad(m + 1)}-01`, to: `${y}-${pad(m + 1)}-${pad(last)}` };
};

function SalesReports() {
  const { company } = useCompany();
  const bounds = useMemo(() => monthBounds(), []);

  // A shared link's filters, read BEFORE the first render and used as the
  // initial state -- so the first fetch is already the link's report. Read in
  // an effect instead, the page would fetch its defaults first and the two
  // responses would race (lib/reportQuery.mjs validates every value; anything
  // invalid or absent keeps the page's own default).
  const searchParams = useSearchParams();
  const [link] = useState(() => parseReportQuery(REPORT_QUERIES.salesReport, searchParams).values);

  const [side, setSide] = useState(link.side ?? 'Sale');
  const [view, setView] = useState(link.view ?? 'book');
  const [scope, setScope] = useState(link.scope ?? DEFAULT_SCOPE);
  const [grain, setGrain] = useState(link.grain ?? DEFAULT_GRAIN);
  // Set only by clicking a month row, and cleared by every other control:
  // it is a position inside the book, not a filter the user set.
  // A month zoom only means anything on the book's date grain, which is how
  // the link was written.
  const [zoomMonth, setZoomMonth] = useState(() =>
    link.month && (link.view ?? 'book') === 'book' && link.grain === 'date' ? link.month : ''
  );
  const [from, setFrom] = useState(link.from ?? bounds.from);
  const [to, setTo] = useState(link.to ?? bounds.to);

  const [rows, setRows] = useState([]);
  const [totals, setTotals] = useState(null);
  const [covers, setCovers] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  /** The route's query for what is on screen -- the fetch and the downloads share it. */
  const reportQuery = useCallback(() => {
    const qs = new URLSearchParams({ view, side, from, to, scope, grain });
    if (zoomMonth) qs.set('month', zoomMonth);
    return qs;
  }, [view, side, from, to, scope, grain, zoomMonth]);

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const qs = reportQuery();
      const res = await fetch(`/api/sales-report?${qs.toString()}`);
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Could not build the report.');
        setRows([]);
        setTotals(null);
        return;
      }
      setRows(data.rows || []);
      setTotals(data.totals || null);
      setCovers(data.covers || '');
    } catch (err) {
      setError(err.message || 'Could not build the report.');
    } finally {
      setBusy(false);
    }
  }, [reportQuery]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * The workbook, from the SAME route and the same query as the rows on
   * screen, fetched first so a refusal is a message here rather than a page
   * of raw JSON in place of the app (lib/downloadFile.mjs). Content-
   * Disposition on the route names the file.
   */

  const exporter = useReportDownload();
  const downloadXlsx = () => {
    const qs = reportQuery();
    qs.set('format', 'xlsx');
    exporter.download(`/api/sales-report?${qs.toString()}`);
  };

  const title = reportName(view, side);
  const isPeriod = view === 'book' && grain !== 'document';
  const csvView = isPeriod ? 'period' : view;

  /** Any control other than a month row leaves the zoom. */
  const reset = (fn) => (value) => {
    setZoomMonth('');
    fn(value);
  };

  const openMonth = (key) => {
    if (!key) return;
    setZoomMonth(key);
    setGrain('date');
  };

  const download = () => {
    const csv = toCsv(CSV_COLUMNS[csvView], rows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = csvFilename(view, side, from, to, isPeriod ? grain : '');
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="page-shell-wide doc-sheet report-sheet">
      <ReportUrlSync
        schema={REPORT_QUERIES.salesReport}
        values={{ side, view, scope, grain, month: zoomMonth, from, to }}
        restore={false}
      />
      <div className="doc-head">
        <p className="doc-org">{company?.name || ''}</p>
        <p className="doc-meta">{company ? companyAddress(company) : ''}</p>
        <p className="doc-kind">{title.toUpperCase()}</p>
        <p className="doc-meta mt-1">
          {asDate(from)} to {asDate(to)}
          {covers && ` · ${covers}`}
          {isPeriod && ` · ${GRAIN_LABELS[grain]}`}
        </p>
      </div>

      {/* ── controls ─────────────────────────────────────────────── */}
      <div className="no-print mb-5 rounded-xl border border-border bg-card p-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {REPORT_SIDES.map((s) => (
            <button
              key={s}
              type="button"
              className={`btn btn-sm ${side === s ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => reset(setSide)(s)}
            >
              {s === 'Sale' ? 'Sales' : 'Purchase'}
            </button>
          ))}
          <span className="mx-2 h-5 w-px bg-border" />
          {SALES_VIEWS.map((v) => (
            <button
              key={v}
              type="button"
              className={`btn btn-sm ${view === v ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => reset(setView)(v)}
            >
              {VIEW_LABELS[v]}
            </button>
          ))}
        </div>

        {/* Sigfa's own selector, in Sigfa's own words. */}
        {view !== 'party' && (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="field-label">Covering</span>
            {DOC_SCOPES.map((s) => (
              <button
                key={s}
                type="button"
                className={`btn btn-sm ${scope === s ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => reset(setScope)(s)}
              >
                {scopeName(s, side)}
              </button>
            ))}
          </div>
        )}

        {/* The book's grain. Sigfa opens on the month and zooms to the date. */}
        {view === 'book' && (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="field-label">Grouped by</span>
            {BOOK_GRAINS.map((g) => (
              <button
                key={g}
                type="button"
                className={`btn btn-sm ${grain === g && !zoomMonth ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => reset(setGrain)(g)}
              >
                {GRAIN_LABELS[g]}
              </button>
            ))}
            {zoomMonth && (
              <button type="button" className="btn btn-sm btn-secondary" onClick={() => reset(setGrain)('month')}>
                ← Back to months
              </button>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <div>
            <label className="field-label" htmlFor="sr-from">From</label>
            <input
              id="sr-from"
              type="date"
              className="field-input mt-1.5"
              value={from}
              onChange={(e) => reset(setFrom)(e.target.value)}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="sr-to">To</label>
            <input
              id="sr-to"
              type="date"
              className="field-input mt-1.5"
              value={to}
              onChange={(e) => reset(setTo)(e.target.value)}
            />
          </div>
          <div className="flex items-end gap-2 sm:col-span-2">
            <button type="button" className="btn btn-secondary" onClick={() => window.print()}>
              Print
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={download}
              disabled={!rows.length}
            >
              Download CSV
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={downloadXlsx}
              disabled={busy || !rows.length}
            >
              Download Excel
            </button>
          </div>
        </div>
      </div>

      <Notice notice={exporter.notice} onClose={exporter.notify.clear} />
      {error && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="table-wrap">
        <table className="data-table report-table min-w-[760px]">
          {/* The period sheet's captions come off its download columns, so
              the printed sheet and the CSV cannot disagree about a name. */}
          {isPeriod && (
            <thead>
              <tr>
                {sheetHeadings('period', grain === 'date' ? 'Date' : 'Month').map((h) => (
                  <th key={h.key} className={h.numeric ? 'num' : undefined}>
                    {h.label}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          {view === 'book' && !isPeriod && (
            <thead>
              <tr>
                <th>Date</th>
                <th className="num">Invoice No</th>
                <th>Party</th>
                <th>GSTIN</th>
                <th className="num">Taxable Amount</th>
                <th className="num">GST</th>
                <th className="num">Net Amount</th>
                <th className="num">Others</th>
                <th className="num">Bill Amount</th>
                <th className="num">Balance Due</th>
              </tr>
            </thead>
          )}
          {view === 'party' && (
            <thead>
              <tr>
                <th>Party</th>
                <th>GSTIN</th>
                <th className="num">Bills</th>
                <th className="num">Returns</th>
                <th className="num">Taxable Amount</th>
                <th className="num">GST</th>
                <th className="num">Bill Amount</th>
                <th className="num">Balance Due</th>
              </tr>
            </thead>
          )}
          {view === 'item' && (
            <thead>
              <tr>
                <th>Item</th>
                <th>HSN</th>
                <th>Unit</th>
                <th className="num">Bills</th>
                <th className="num">Quantity</th>
                <th className="num">Avg Rate</th>
                <th className="num">Taxable Amount</th>
                <th className="num">GST</th>
                <th className="num">Bill Amount</th>
              </tr>
            </thead>
          )}

          <tbody>
            {busy && (
              <tr>
                <td colSpan={10}>
                  <div className="empty-state">Working it out…</div>
                </td>
              </tr>
            )}

            {!busy && rows.length === 0 && (
              <tr>
                <td colSpan={10}>
                  <div className="empty-state">
                    Nothing in this period. Try a wider range, or the other side.
                  </div>
                </td>
              </tr>
            )}

            {!busy &&
              isPeriod &&
              rows.map((r) => (
                <tr
                  key={r.key}
                  // Sigfa's zoom: a month row opens the dates inside it. On a
                  // date row there is nothing left to open.
                  className={grain === 'month' ? 'cursor-pointer' : undefined}
                  onClick={grain === 'month' ? () => openMonth(r.key) : undefined}
                >
                  <td className="font-medium">
                    {r.label}
                    {grain === 'month' && <span className="field-hint ml-2 no-print">open</span>}
                  </td>
                  <td className="num">{r.documents}</td>
                  <td className="num">{r.returns || '—'}</td>
                  <td className="num">{money(r.taxable)}</td>
                  <td className="num">{money(r.gst)}</td>
                  <td className="num">{money(r.net)}</td>
                  <td className="num">{money(r.others)}</td>
                  <td className="num font-medium">{money(r.total)}</td>
                </tr>
              ))}

            {!busy &&
              view === 'book' &&
              !isPeriod &&
              rows.map((r, i) => (
                <tr key={`${r.invoiceNo}-${i}`}>
                  <td>{asDate(r.date)}</td>
                  <td className="num">{r.invoiceNo}</td>
                  <td>
                    {r.party || '—'}
                    {/* A return is marked, not shown as a negative: a credit
                        note for 500 is a credit note for 500. It subtracts in
                        the total below, which is Sigfa's rule. */}
                    {r.isReturn && <span className="chip ml-2">Return</span>}
                  </td>
                  <td className="text-xs">{r.gstin || '—'}</td>
                  <td className="num">{money(r.taxable)}</td>
                  <td className="num">{money(r.gst)}</td>
                  <td className="num">{money(r.net)}</td>
                  <td className="num">{money(r.others)}</td>
                  <td className="num font-medium">{money(r.total)}</td>
                  <td className="num">{money(r.balanceDue)}</td>
                </tr>
              ))}

            {!busy &&
              view === 'party' &&
              rows.map((r) => (
                <tr key={r.party}>
                  <td className="font-medium">{r.party}</td>
                  <td className="text-xs">{r.gstin || '—'}</td>
                  <td className="num">{r.documents}</td>
                  <td className="num">{r.returns || '—'}</td>
                  <td className="num">{money(r.taxable)}</td>
                  <td className="num">{money(r.gst)}</td>
                  <td className="num font-medium">{money(r.total)}</td>
                  <td className="num">{money(r.balanceDue)}</td>
                </tr>
              ))}

            {!busy &&
              view === 'item' &&
              rows.map((r) => (
                <tr key={r.item}>
                  <td className="font-medium">{r.item}</td>
                  <td>{r.hsn || '—'}</td>
                  <td>{r.unit || '—'}</td>
                  <td className="num">{r.documents}</td>
                  <td className="num">{qty(r.quantity)}</td>
                  <td className="num">{r.rate === null ? '—' : money(r.rate)}</td>
                  <td className="num">{money(r.taxable)}</td>
                  <td className="num">{money(r.gst)}</td>
                  <td className="num font-medium">{money(r.total)}</td>
                </tr>
              ))}
          </tbody>

          {!busy && totals && rows.length > 0 && (
            <tfoot>
              {isPeriod && (
                <tr>
                  <td>TOTAL&nbsp;&nbsp;:-</td>
                  <td className="num font-medium">{totals.documents}</td>
                  <td className="num font-medium">{totals.returns || '—'}</td>
                  <td className="num font-medium">{money(totals.taxable)}</td>
                  <td className="num font-medium">{money(totals.gst)}</td>
                  <td className="num font-medium">{money(totals.net)}</td>
                  <td className="num font-medium">{money(totals.others)}</td>
                  <td className="num font-medium">{money(totals.total)}</td>
                </tr>
              )}
              {view === 'book' && !isPeriod && (
                <tr>
                  <td colSpan={4}>
                    TOTAL&nbsp;&nbsp;:- {totals.documents} bill{totals.documents === 1 ? '' : 's'}
                    {totals.returns > 0 && `, ${totals.returns} of them returns`}
                  </td>
                  <td className="num font-medium">{money(totals.taxable)}</td>
                  <td className="num font-medium">{money(totals.gst)}</td>
                  <td className="num font-medium">{money(totals.net)}</td>
                  <td className="num font-medium">{money(totals.others)}</td>
                  <td className="num font-medium">{money(totals.total)}</td>
                  <td />
                </tr>
              )}
              {view === 'party' && (
                <tr>
                  <td colSpan={4}>TOTAL&nbsp;&nbsp;:- {totals.parties} parties</td>
                  <td className="num font-medium">{money(totals.taxable)}</td>
                  <td className="num font-medium">{money(totals.gst)}</td>
                  <td className="num font-medium">{money(totals.total)}</td>
                  <td className="num font-medium">{money(totals.balanceDue)}</td>
                </tr>
              )}
              {view === 'item' && (
                <tr>
                  <td colSpan={3}>TOTAL&nbsp;&nbsp;:- {totals.items} items</td>
                  <td />
                  <td className="num font-medium">{qty(totals.quantity)}</td>
                  <td />
                  <td className="num font-medium">{money(totals.taxable)}</td>
                  <td className="num font-medium">{money(totals.gst)}</td>
                  <td className="num font-medium">{money(totals.total)}</td>
                </tr>
              )}
            </tfoot>
          )}
        </table>
      </div>

      <p className="field-hint mt-3">
        Returns are included and subtracted, as they are in the old software. A return is listed
        at the value printed on it and taken off the totals. Use Covering to see one or the other
        on its own. Net Amount is the bill before the overheads; Others is the freight and the
        party taxes charged on top of it.
      </p>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
      <SalesReports />
    </Suspense>
  );
}
