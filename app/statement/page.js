'use client';
export const dynamic = "force-dynamic";

/**
 * Customer and supplier statements.
 *
 * The sheet a shop emails to a party: the firm's letterhead, the party's
 * details, an opening balance, the period's entries and a closing balance
 * with words for whose money it is.
 *
 * Every figure comes from /api/statement, which computes it through
 * lib/accountBooks.mjs -- the same code the A/C Ledger uses. This page does
 * no arithmetic of its own beyond slicing `lines` for the pager, which is
 * exactly why the statement and the ledger can never disagree.
 *
 * Both downloads go back to the SAME route with `format=csv|xlsx`, so an
 * export is the report, built from the same objects by the same server. The
 * note atop lib/reportHttp.js has the reasoning.
 */

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useCompany } from '@/context/CompanyContext';
// The same letterhead the invoice prints, from the same two components --
// so a statement and the bill it refers to cannot show the firm differently.
import { CompanyBrand, CompanyLogo } from '@/components/CompanyBrand';
import { formatINR } from '@/lib/currency.mjs';
import DateFilter from '@/components/reports/DateFilter';
import StatementSearchParams from '@/components/StatementSearchParams';
import ReportUrlSync from '@/components/reports/ReportUrlSync';
import { REPORT_QUERIES } from '@/lib/reportQuery.mjs';
import { periodText, samePeriod } from '@/lib/reportPeriods.mjs';
import {
  MONTHLY_COLUMNS,
  STATEMENT_COLUMNS,
  STATEMENT_FORMATS,
  STATEMENT_FORMAT_LABELS,
  STATEMENT_SIDES,
  STATEMENT_SIDE_KEYS,
  balanceLine,
  isStatementFormat,
  isStatementSide,
} from '@/lib/statements.mjs';
import { isPreset } from '@/lib/reportPeriods.mjs';
import { Notice } from '@/components/ui/notice';
import { useReportDownload } from '@/components/reports/useReportDownload';

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

const blankOr = (value) => (Number(value) ? formatINR(value) : '');

function Statement() {
  // The firm whose statement this is -- never a hardcoded one.
  const { company } = useCompany();

  const [side, setSide] = useState('customer');
  const [account, setAccount] = useState('');
  const [view, setView] = useState('detailed');
  const [period, setPeriod] = useState({ preset: 'thisFy', from: '', to: '' });

  const [accounts, setAccounts] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);

  // What the last successful fetch was for. The spec asks for no needless
  // requests when the filters have not changed, and re-selecting the chip
  // that is already on is the commonest way that happens.
  const fetched = useRef(null);

  const query = useMemo(() => {
    const params = new URLSearchParams({ side, preset: period.preset, view });
    if (account) params.set('account', account);
    if (period.from) params.set('from', period.from);
    if (period.to) params.set('to', period.to);
    return params;
  }, [side, account, view, period]);

  const load = useCallback(async () => {
    const key = `${side}|${account}|${view}|${period.preset}|${period.from}|${period.to}`;
    if (fetched.current === key) return;

    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/statement?${query.toString()}`);
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body.error || 'Could not draw the statement.');
      setAccounts(body.accounts || []);
      setData(body.statement ? body : null);
      setPage(0);
      fetched.current = key;
    } catch (err) {
      setError(err.message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [query, side, account, view, period]);

  useEffect(() => {
    load();
  }, [load]);

  const sheet = data?.statement || null;
  const sideConfig = STATEMENT_SIDES[side];

  const rows = view === 'monthly' ? data?.months || [] : sheet?.lines || [];
  const columns = view === 'monthly' ? MONTHLY_COLUMNS : STATEMENT_COLUMNS;
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const shown = rows.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  // Downloads fetch first, so a refusal is a message here rather than a
  // page of raw JSON in place of the app. lib/downloadFile.mjs.
  const exporter = useReportDownload();

  const download = (format) => {
    const params = new URLSearchParams(query);
    params.set('format', format);
    // Fetched, then handed to the browser (lib/downloadFile.mjs), so a
    // refusal is a message here; Content-Disposition on the route names it.
    exporter.download(`/api/statement?${params.toString()}`);
  };

  /**
   * A deep link's values, applied once.
   *
   * Every one is checked against the module that owns it before it is used.
   * These come off a URL anybody can edit, and a bad `side` would put the
   * page into a state with no config behind it -- `STATEMENT_SIDES[side]`
   * undefined, and a blank screen rather than an error.
   */
  const applyLink = useCallback((values) => {
    if (isStatementSide(values.side)) setSide(values.side);
    if (isStatementFormat(values.view)) setView(values.view);
    if (values.account) setAccount(values.account);
    if (isPreset(values.preset) || values.from || values.to) {
      setPeriod({
        preset: isPreset(values.preset) ? values.preset : 'custom',
        from: values.from,
        to: values.to,
      });
    }
  }, []);

  const changeSide = (next) => {
    setSide(next);
    // The party belongs to the old side's group, so it cannot carry over --
    // asking for a customer statement for a supplier is refused by the route
    // on purpose, and silently keeping the name would just show that error.
    setAccount('');
    setData(null);
    fetched.current = null;
  };

  return (
    <div className="page-shell-wide">
      {/* A deep link from the Reports hub, or a bookmark. */}
      <StatementSearchParams onValues={applyLink} />
      {/* And back: the filters on screen are written to the URL, so the
          statement can be bookmarked or sent as it stands. The reading stays
          with StatementSearchParams above. */}
      <ReportUrlSync
        schema={REPORT_QUERIES.statement}
        values={{ side, account, view, preset: period.preset, from: period.from, to: period.to }}
        restore={false}
      />

      {/* ── controls ─────────────────────────────────────────────── */}
      <div className="no-print">
        <div className="page-header">
          <h1 className="page-title">Statements</h1>
          <p className="page-subtitle">
            A party&apos;s opening balance, the period&apos;s entries and what is outstanding --
            the same figures as the A/C Ledger, on a sheet you can send them.
          </p>
        </div>

        <div className="panel mb-5">
          <div className="panel-body space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              {STATEMENT_SIDE_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`btn btn-sm ${side === key ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => changeSide(key)}
                >
                  {STATEMENT_SIDES[key].label}
                </button>
              ))}
              <span className="field-hint ml-1">
                {sideConfig.groupName} &mdash; {sideConfig.documents}
              </span>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1fr]">
              <div>
                <label className="field-label" htmlFor="st-account">
                  {sideConfig.party}
                </label>
                <select
                  id="st-account"
                  className="field-select mt-1.5"
                  value={account}
                  onChange={(e) => setAccount(e.target.value)}
                >
                  <option value="">
                    {accounts.length
                      ? `Pick a ${sideConfig.party.toLowerCase()}…`
                      : 'No accounts on this side yet'}
                  </option>
                  {accounts.map((a) => (
                    <option key={a._id || a.name} value={a.name}>
                      {a.name}
                      {a.city ? ` — ${a.city}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="field-label" htmlFor="st-view">
                  Show
                </label>
                <select
                  id="st-view"
                  className="field-select mt-1.5"
                  value={view}
                  onChange={(e) => setView(e.target.value)}
                >
                  {STATEMENT_FORMATS.map((f) => (
                    <option key={f} value={f}>
                      {STATEMENT_FORMAT_LABELS[f]}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <DateFilter
              idPrefix="st"
              preset={period.preset}
              from={period.from}
              to={period.to}
              onChange={setPeriod}
              note={sheet ? `${sheet.lines.length} entr${sheet.lines.length === 1 ? 'y' : 'ies'}` : ''}
            />

            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => window.print()}
                disabled={!sheet}
              >
                Print
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => download('xlsx')}
                disabled={!sheet}
              >
                Download Excel
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => download('csv')}
                disabled={!sheet}
              >
                Download CSV
              </button>
              {sheet && (
                <Link
                  className="btn btn-ghost btn-sm"
                  href={`/account-book?kind=ledger&account=${encodeURIComponent(sheet.account)}&from=${sheet.from || ''}&to=${sheet.to || ''}`}
                >
                  Open the A/C Ledger
                </Link>
              )}
            </div>
          </div>
        </div>
      </div>

      <Notice notice={exporter.notice} onClose={exporter.notify.clear} className='no-print mb-4' />
      {error && (
        <div className="no-print mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading && !sheet && (
        <div className="empty-state no-print">Drawing the statement…</div>
      )}

      {!loading && !error && !account && (
        <div className="empty-state no-print">
          Pick a {sideConfig.party.toLowerCase()} to draw their statement.
        </div>
      )}

      {/* ── the sheet ────────────────────────────────────────────── */}
      {sheet && (
        <div className="doc-sheet report-sheet">
          <div className="doc-head">
            {/* The firm, through the shared components: which details print
                is the firm's own choice (lib/invoicePrefs.mjs) and it must
                be the same choice here as on the bill. This block used to
                read `company.gstin` directly, which ignored that. */}
            <div className="flex flex-col items-center gap-2">
              <CompanyLogo company={company} variant="print" />
              <CompanyBrand company={company} size="report" align="center" />
            </div>
            <p className="doc-kind">{sheet.sideLabel.toUpperCase()}</p>
          </div>

          <div className="report-party">
            <div>
              <p className="report-party-label">{sheet.partyWord}</p>
              <p className="report-party-name">{sheet.account}</p>
              {sheet.party.address ? <p className="doc-meta">{sheet.party.address}</p> : null}
              <p className="doc-meta">
                {[sheet.party.city, sheet.party.state, sheet.party.pincode]
                  .filter(Boolean)
                  .join(', ')}
              </p>
              {sheet.party.gstin ? <p className="doc-meta">GSTIN: {sheet.party.gstin}</p> : null}
              {sheet.party.phone ? <p className="doc-meta">Phone: {sheet.party.phone}</p> : null}
            </div>
            <div className="sm:text-right">
              <p className="doc-meta">
                <span className="font-medium">Period:</span> {periodText(sheet.from, sheet.to)}
              </p>
              <p className="doc-meta">
                <span className="font-medium">Generated:</span> {asDate(sheet.generatedAt)}
              </p>
              <p className="doc-meta">
                <span className="font-medium">Currency:</span> INR
              </p>
              {sheet.resolvedGroup ? (
                <p className="doc-meta">
                  <span className="font-medium">Group:</span> {sheet.resolvedGroup}
                </p>
              ) : null}
            </div>
          </div>

          {/* The three figures that matter, stated in words as well as
              signs -- a sheet that prints "-4,500.00" and leaves the reader
              to work out whose money it is has not done its job. */}
          <div className="mb-5 grid gap-3 sm:grid-cols-3">
            <div className="stat-card">
              <p className="stat-label">Opening balance</p>
              <p className="stat-value">{balanceLine(sheet.openingWording)}</p>
            </div>
            <div className="stat-card">
              <p className="stat-label">Movement in the period</p>
              <p className="stat-value">
                {formatINR(sheet.totals.debit)} Dr · {formatINR(sheet.totals.credit)} Cr
              </p>
            </div>
            <div className="stat-card">
              <p className="stat-label">Closing balance</p>
              <p className="stat-value">{balanceLine(sheet.closingWording)}</p>
            </div>
          </div>

          {!sheet.reconciliation.balanced && (
            <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              The closing balance does not follow from the opening balance plus the period&apos;s
              movements: {formatINR(sheet.reconciliation.difference)} out. The figures are shown
              as computed; please report this.
            </div>
          )}

          {sheet.quiet ? (
            <div className="empty-state">
              Nothing was posted to this account between {periodText(sheet.from, sheet.to)}. The
              opening and closing balances above are therefore the same figure.
            </div>
          ) : (
            <>
              <div className="table-wrap">
                <table className="data-table report-table min-w-[900px]">
                  <thead>
                    <tr>
                      {view === 'detailed' && <th className="num">#</th>}
                      {columns.map((c) => (
                        <th key={c.key} className={c.type === 'text' ? undefined : 'num'}>
                          {c.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {/* The opening line sits inside the table on purpose: a
                        running-balance column whose first row starts from an
                        unexplained figure is a column nobody can check. */}
                    {page === 0 && (
                      <tr className="report-row-opening">
                        {view === 'detailed' && <td className="num" />}
                        <td>{asDate(sheet.from)}</td>
                        <td colSpan={view === 'monthly' ? 1 : 4}>
                          <span className="font-medium">Opening balance</span>
                        </td>
                        <td className="num" />
                        <td className="num" />
                        <td className="num">{formatINR(Math.abs(sheet.opening))}</td>
                        <td className="num">{sheet.openingMode}</td>
                      </tr>
                    )}

                    {shown.map((row, index) =>
                      view === 'monthly' ? (
                        <tr key={row.month}>
                          <td>{row.label}</td>
                          <td className="num">{row.entries}</td>
                          <td className="num">{blankOr(row.debit)}</td>
                          <td className="num">{blankOr(row.credit)}</td>
                          <td className="num">{formatINR(Math.abs(row.balance))}</td>
                          <td className="num">{row.mode}</td>
                        </tr>
                      ) : (
                        <tr key={row._id || `${row.day}-${index}`}>
                          <td className="num">{row.srNo}</td>
                          <td>{asDate(row.date)}</td>
                          <td>{row.particulars}</td>
                          <td className="num">
                            {row.invoiceNo ? (
                              <Link
                                className="no-print underline"
                                href={`/invoice?invoiceNo=${encodeURIComponent(row.invoiceNo)}`}
                              >
                                {row.reference}
                              </Link>
                            ) : (
                              row.reference
                            )}
                          </td>
                          <td>{row.account}</td>
                          <td>{row.narration}</td>
                          <td className="num">{blankOr(row.debit)}</td>
                          <td className="num">{blankOr(row.credit)}</td>
                          <td className="num">{formatINR(Math.abs(row.balance))}</td>
                          <td className="num">{row.mode}</td>
                        </tr>
                      )
                    )}
                  </tbody>
                  <tfoot>
                    <tr>
                      {view === 'detailed' && <td className="num" />}
                      <td colSpan={view === 'monthly' ? 2 : 5}>
                        <span className="font-medium">Period total</span>
                      </td>
                      <td className="num">{formatINR(sheet.totals.debit)}</td>
                      <td className="num">{formatINR(sheet.totals.credit)}</td>
                      <td className="num">{formatINR(Math.abs(sheet.closing))}</td>
                      <td className="num">{sheet.closingMode}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {pages > 1 && (
                <div className="no-print mt-3 flex items-center gap-3">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={page === 0}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                  >
                    Previous
                  </button>
                  <span className="field-hint">
                    Page {page + 1} of {pages} · {rows.length} rows. A download has every row,
                    not this page.
                  </span>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={page >= pages - 1}
                    onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
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

export default function StatementPage() {
  return (
    <Suspense fallback={null}>
      <Statement />
    </Suspense>
  );
}
