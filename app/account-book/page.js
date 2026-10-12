'use client';
import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useCompany } from '@/context/CompanyContext';
import { companyAddress } from '@/lib/company.mjs';
import DateFilter from '@/components/reports/DateFilter';
import { resolvePeriod } from '@/lib/reportPeriods.mjs';
import AccountBookSearchParams from '@/components/AccountBookSearchParams';
import ReportUrlSync from '@/components/reports/ReportUrlSync';
import { REPORT_QUERIES } from '@/lib/reportQuery.mjs';
import { isPreset } from '@/lib/reportPeriods.mjs';
import {
  BOOK_KINDS,
  BOOK_NAMES,
  CSV_COLUMNS,
  balanceText,
  bookFilename,
  bookTitle,
  periodText,
  toCsv,
} from '@/lib/accountBooks.mjs';
import { Notice } from '@/components/ui/notice';
import { useReportDownload } from '@/components/reports/useReportDownload';

export const dynamic = 'force-dynamic';

/**
 * Cash Book, Bank Book and A/C Ledger.
 *
 * Sigfa's Cash Book, Bank Book, Petty Cash Book, Account Ledger and A/C Ledger
 * Group Wise, which are one sheet with a different account chosen. Tabs rather
 * than five menu items: the only thing that changes between them is which
 * accounts the picker offers.
 *
 * PRINTING follows the ledger, voucher and order registers: `doc-sheet` for
 * the page, the firm's letterhead at the top, `no-print` on every control.
 *
 * THE FIGURES ARE THE SERVER'S. This page lays out what /api/account-book
 * computed and does no arithmetic of its own -- not even the totals row. The
 * opening balance, the running column and the closing figure all come from
 * lib/accountBooks.mjs, so what is printed is what the trial balance will
 * later take from the same function.
 */

const fmt = (n) =>
  new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    Number(n) || 0
  );

const asDate = (v) => (v ? new Date(v).toLocaleDateString('en-IN') : '');

/*
 * The default period used to be worked out here, from the BROWSER's clock:
 *
 *     const fyStart = () => { const now = new Date();
 *       const year = now.getMonth() >= 3 ? ... }
 *     const todayISO = () => new Date().toISOString().substring(0, 10);
 *
 * Both were wrong in the same way. `getMonth()` is the viewer's local month,
 * so a laptop set to New York opened the book on the wrong financial year for
 * the first eleven hours of 1 April; and `toISOString()` is UTC, so between
 * midnight and 5:30am IST "today" was yesterday and a bill entered that
 * morning fell outside the default range.
 *
 * lib/reportPeriods.mjs resolves every period as an IST calendar day, and the
 * server resolves the same preset the same way. Thirteen presets come with it.
 */
const DEFAULT_PRESET = 'thisFy';

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

function AccountBooks() {
  const router = useRouter();
  const { company } = useCompany();

  const [kind, setKind] = useState('cash');
  const [account, setAccount] = useState('');
  const [group, setGroup] = useState('');
  const [period, setPeriod] = useState(() => resolvePeriod({ preset: DEFAULT_PRESET }));
  const { from, to } = period;
  const [wantDayWise, setWantDayWise] = useState(false);

  const [accounts, setAccounts] = useState([]);
  const [books, setBooks] = useState([]);
  const [groupTotals, setGroupTotals] = useState(null);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // What the rows on screen were actually loaded for. The same guard the order
  // report needed: `kind` changes the instant a tab is clicked, while `books`
  // only changes when the fetch returns, so for one render the cash book's
  // rows would be drawn under the bank book's heading.
  const [loadedFor, setLoadedFor] = useState(null);

  // A deep link's account and group, held until the book they belong to has
  // loaded its accounts. They used to be applied with a setTimeout and then
  // overwritten -- the group by the tab effect below, the account by
  // `loadAccounts` opening on the book's first account -- so a link to one
  // ledger opened another. Now that the URL follows the screen, that would
  // also have rewritten the link itself.
  const linked = useRef(null);
  // The tab whose accounts are wanted, so a slow reply for a tab already
  // left cannot fill the picker with another book's accounts.
  const latestKind = useRef(kind);

  /** The accounts this book offers. Also runs when the tab changes. */
  const loadAccounts = useCallback(async (nextKind) => {
    setError('');
    try {
      const res = await fetch(`/api/account-book?kind=${encodeURIComponent(nextKind)}`);
      const data = await res.json();
      if (latestKind.current !== nextKind) return;
      if (!data.success) {
        setError(data.error || 'Could not load the accounts.');
        return;
      }
      setAccounts(data.accounts || []);
      setGroups(data.groups || []);
      const link = linked.current;
      if (link && link.kind === nextKind && link.account) {
        // The link's account, once. A link naming an account this book does
        // not offer still opens on it, and the route answers "No account
        // named ...", which is the right error to show.
        setAccount(link.account);
        linked.current = { ...link, account: '' };
      } else {
        // Open on the first account rather than on nothing: a cash book with
        // one cash account should not need a choice made before it shows
        // anything.
        setAccount((data.accounts || [])[0]?.name || '');
      }
    } catch (err) {
      setError(err.message || 'Could not load the accounts.');
    }
  }, []);

  useEffect(() => {
    latestKind.current = kind;
    setBooks([]);
    setGroupTotals(null);
    const link = linked.current;
    setGroup(link && link.kind === kind && link.group ? link.group : '');
    if (link && link.kind === kind) linked.current = { ...link, group: '' };
    setLoadedFor(null);
    loadAccounts(kind);
  }, [kind, loadAccounts]);

  const load = useCallback(async () => {
    if (!account && !group) return;
    setLoading(true);
    setError('');
    setNotice('');
    const signature = `${kind}|${account}|${group}|${from}|${to}|${wantDayWise}`;
    try {
      const qs = new URLSearchParams({ kind, from, to });
      if (group) qs.set('group', group);
      else qs.set('account', account);
      if (wantDayWise) qs.set('daywise', '1');

      const res = await fetch(`/api/account-book?${qs.toString()}`);
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Could not load the book.');
        setBooks([]);
        setGroupTotals(null);
      } else {
        setBooks(data.books || []);
        setGroupTotals(data.groupTotals || null);
        if (data.message) setNotice(data.message);
      }
    } catch (err) {
      setError(err.message || 'Could not load the book.');
      setBooks([]);
      setGroupTotals(null);
    } finally {
      // Stamped on EVERY path, successes and failures alike. A failure that
      // left the previous signature in place would show stale rows under the
      // new heading, which is the exact shape of the bug this guards.
      setLoadedFor(signature);
      setLoading(false);
    }
  }, [kind, account, group, from, to, wantDayWise]);

  useEffect(() => {
    load();
  }, [load]);

  const signature = `${kind}|${account}|${group}|${from}|${to}|${wantDayWise}`;
  const busy = loading || loadedFor !== signature;
  const shown = loadedFor === signature ? books : [];

  const title = useMemo(
    () => bookTitle(kind, group ? '' : account, group),
    [kind, account, group]
  );

  // Downloads fetch first, so a refusal is a message here rather than a
  // page of raw JSON in place of the app. lib/downloadFile.mjs.
  const exporter = useReportDownload();

  /** Whatever is on screen, as a workbook, from the same route. */
  const downloadXlsx = () => {
    if (!shown.length) return;
    const qs = new URLSearchParams({ kind, from, to, format: 'xlsx' });
    if (group) qs.set('group', group);
    else qs.set('account', account);
    if (wantDayWise) qs.set('daywise', '1');
    // Fetched, then handed to the browser (lib/downloadFile.mjs);
    // Content-Disposition on the route names it.
    exporter.download(`/api/account-book?${qs.toString()}`);
  };

  /**
   * A deep link's values, applied once.
   *
   * `account` is set here AND by `loadAccounts`, which opens on the first
   * account of the book. The order works out because the link's kind lands
   * first and `loadAccounts` runs off the kind change -- but the account from
   * the link is applied after, so it wins. A link naming an account this book
   * does not offer leaves the picker on it and the route answers "No account
   * named ...", which is the right error to show rather than silently opening
   * somebody else's ledger.
   */
  const applyLink = useCallback((values) => {
    const linkKind = values.kind && BOOK_KINDS.includes(values.kind) ? values.kind : latestKind.current;
    // Held for the tab effect and `loadAccounts` above, which apply them once
    // the linked book is the one open.
    linked.current = { kind: linkKind, account: values.account || '', group: values.group || '' };
    if (linkKind !== latestKind.current) setKind(linkKind);
    if (isPreset(values.preset) && values.preset !== 'custom') {
      // A preset keeps its meaning: resolved now, in IST, by the one resolver.
      setPeriod(resolvePeriod({ preset: values.preset }));
    } else if (values.from || values.to) {
      setPeriod((current) => ({
        preset: 'custom',
        from: values.from || current.from,
        to: values.to || current.to,
      }));
    }
    if (values.daywise === '1') setWantDayWise(true);
  }, []);

  const exportCsv = () => {
    const book = shown[0];
    if (!book) return;
    if (wantDayWise) {
      downloadCsv(
        bookFilename(kind, `${book.account}-daywise`),
        toCsv(CSV_COLUMNS.daywise, book.daywise || [])
      );
      return;
    }
    downloadCsv(
      bookFilename(kind, book.account),
      toCsv(
        CSV_COLUMNS.entries,
        (book.lines || []).map((l) => ({ ...l, date: asDate(l.date) }))
      )
    );
  };

  return (
    <div className="doc-sheet report-sheet">
      {/* A deep link from the statement or the Reports hub. */}
      <AccountBookSearchParams onValues={applyLink} />
      {/* And back: the book on screen, written to the URL. A group book names
          the group and not the account the picker happens to hold. */}
      <ReportUrlSync
        schema={REPORT_QUERIES.accountBook}
        values={{
          kind,
          account: group ? '' : account,
          group,
          preset: period.preset,
          from,
          to,
          daywise: wantDayWise,
        }}
        restore={false}
      />
      <div className="doc-head">
        <h2 className="doc-org">{company?.name || ''}</h2>
        <p className="doc-meta">{company ? companyAddress(company) : ''}</p>
        <p className="doc-kind">{title.toUpperCase()}</p>
        <p className="doc-meta mt-1">{periodText(from, to, (d) => asDate(d))}</p>
      </div>

      {/* ── controls ─────────────────────────────────────────────── */}
      <div className="no-print mb-5 rounded-xl border border-border bg-card p-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {BOOK_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              className={`btn btn-sm ${k === kind ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setKind(k)}
            >
              {BOOK_NAMES[k]}
            </button>
          ))}
          <span className="mx-2 h-6 w-px bg-border" />
          {/* `field-check` styles the INPUT (18x18); putting it on the label
              squeezed the label to 18px and wrapped the text one word per
              line. `whitespace-nowrap` keeps it from being squeezed again by
              the flex row it sits in. */}
          <label className="flex items-center gap-2 whitespace-nowrap text-sm">
            <input
              type="checkbox"
              className="field-check"
              checked={wantDayWise}
              onChange={(e) => setWantDayWise(e.target.checked)}
            />
            <span>One line per day</span>
          </label>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <div className="field sm:col-span-2">
            <label className="field-label mb-1.5 block">Account</label>
            <select
              className="field-select"
              value={group ? '' : account}
              onChange={(e) => {
                setGroup('');
                setAccount(e.target.value);
              }}
            >
              {accounts.length === 0 && <option value="">No accounts in this book</option>}
              {accounts.map((a) => (
                <option key={a._id} value={a.name}>
                  {a.name}
                  {a.resolvedGroup ? ` — ${a.resolvedGroup}` : ''}
                </option>
              ))}
            </select>
            {accounts.length === 0 && kind !== 'ledger' && (
              <p className="field-hint">
                Nothing is filed under {kind === 'cash' ? 'Cash In Hand' : 'Bank Account'} yet.
                An account picks up its book from its group on the party master.
              </p>
            )}
          </div>

        </div>

        {/* The shared filter -- the same thirteen presets, resolved by the
            same module, as every other report in the app. */}
        <div className="mt-4">
          <DateFilter
            idPrefix="ab"
            preset={period.preset}
            from={from}
            to={to}
            onChange={setPeriod}
          />
        </div>

        {/* Sigfa's "A/C Ledger Group Wise" -- every account in one group,
            one after another, with the group's own totals. */}
        {kind === 'ledger' && (
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="field">
              <label className="field-label mb-1.5 block">…or a whole group</label>
              <select
                className="field-select"
                value={group}
                onChange={(e) => setGroup(e.target.value)}
              >
                <option value="">One account only</option>
                {groups.map((g) => (
                  <option key={g.code} value={g.name}>
                    {g.main ? g.name : `— ${g.name}`}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <button type="button" className="btn btn-secondary" onClick={() => router.push('/ledger')}>
            Party ledger
          </button>
          {/* Excel goes back to the SAME route with format=xlsx, so the
              workbook is built from the figures the server already computed
              -- and a group-wise book downloads every account as its own
              worksheet, which a client-side CSV of `shown[0]` cannot do. */}
          <button
            type="button"
            className="btn btn-secondary"
            onClick={downloadXlsx}
            disabled={busy || !shown.length}
          >
            Download Excel
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={exportCsv}
            disabled={busy || shown.length !== 1}
          >
            Download CSV
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => window.print()}>
            Print
          </button>
        </div>
      </div>

      <Notice notice={exporter.notice} onClose={exporter.notify.clear} />
      {error && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-4 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm">
          {notice}
        </div>
      )}

      {busy && <div className="empty-state">Loading…</div>}

      {!busy && shown.length === 0 && !error && (
        <div className="empty-state">
          {accounts.length === 0
            ? 'No accounts to show in this book.'
            : 'Nothing to show. Pick an account, or widen the dates.'}
        </div>
      )}

      {!busy &&
        shown.map((book) => (
          <div key={book.account} className="mb-6">
            {shown.length > 1 && (
              <h3 className="section-title mb-2">
                {book.account}
                {book.resolvedGroup ? (
                  <span className="chip ml-2">{book.resolvedGroup}</span>
                ) : null}
              </h3>
            )}

            <div className="table-wrap">
              <table className="data-table report-table">
                <thead>
                  {wantDayWise ? (
                    <tr>
                      <th>Date</th>
                      <th className="num">Entries</th>
                      <th className="num">Receipts</th>
                      <th className="num">Payments</th>
                      <th className="num">Balance</th>
                    </tr>
                  ) : (
                    <tr>
                      <th>Date</th>
                      <th>Particulars</th>
                      <th>Narration</th>
                      <th className="num">Debit</th>
                      <th className="num">Credit</th>
                      <th className="num">Balance</th>
                    </tr>
                  )}
                </thead>
                <tbody>
                  {/* The carried-forward figure. Always shown, even at zero:
                      a book that simply begins mid-column leaves the reader
                      unable to tell an opening of nil from one nobody
                      computed. */}
                  <tr className="font-medium">
                    <td>{asDate(from)}</td>
                    <td colSpan={wantDayWise ? 3 : 4}>Opening balance</td>
                    <td className="num">{balanceText(book.opening)}</td>
                  </tr>

                  {wantDayWise
                    ? (book.daywise || []).map((d) => (
                        <tr key={d.day}>
                          <td>{asDate(d.date)}</td>
                          <td className="num">{d.entries}</td>
                          <td className="num">{d.debit ? fmt(d.debit) : ''}</td>
                          <td className="num">{d.credit ? fmt(d.credit) : ''}</td>
                          <td className="num">{balanceText(d.balance)}</td>
                        </tr>
                      ))
                    : (book.lines || []).map((l) => (
                        <tr key={l._id}>
                          <td>{asDate(l.date)}</td>
                          <td>{l.particulars}</td>
                          <td className="text-muted-foreground">{l.narration}</td>
                          <td className="num">{l.debit ? fmt(l.debit) : ''}</td>
                          <td className="num">{l.credit ? fmt(l.credit) : ''}</td>
                          <td className="num">{balanceText(l.balance)}</td>
                        </tr>
                      ))}

                  {(book.lines || []).length === 0 && (
                    <tr>
                      <td colSpan={wantDayWise ? 5 : 6}>
                        <div className="empty-state">No entries in this period.</div>
                      </td>
                    </tr>
                  )}

                  <tr className="font-medium">
                    <td>{asDate(to)}</td>
                    <td colSpan={wantDayWise ? 1 : 2}>Closing balance</td>
                    <td className="num">{fmt(book.totals.debit)}</td>
                    <td className="num">{fmt(book.totals.credit)}</td>
                    <td className="num">{balanceText(book.closing)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        ))}

      {/* Sigfa's group total. The sum of the CLOSING balances, not of the
          debit and credit columns -- those are the movement in the window,
          and a group's position is what the trial balance will want. */}
      {!busy && groupTotals && shown.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <div className="stat-card">
            <div className="stat-label">Accounts</div>
            <div className="stat-value">{groupTotals.accounts}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Opening</div>
            <div className="stat-value">{balanceText(groupTotals.opening)}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Movement</div>
            <div className="stat-value">
              {fmt(groupTotals.totals.debit)} / {fmt(groupTotals.totals.credit)}
            </div>
            <div className="field-hint">debit / credit</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">{groupTotals.group} closing</div>
            <div className="stat-value">{balanceText(groupTotals.closing)}</div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function AccountBookPage() {
  return (
    <Suspense fallback={null}>
      <AccountBooks />
    </Suspense>
  );
}
