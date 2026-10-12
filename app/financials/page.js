'use client';
import React, { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useCompany } from '@/context/CompanyContext';
import { companyAddress } from '@/lib/company.mjs';
import { STATEMENT_KINDS, STATEMENT_TITLES } from '@/lib/financials.mjs';
import { periodText } from '@/lib/accountBooks.mjs';

export const dynamic = 'force-dynamic';

/**
 * Trial Balance, Trading Account, Profit & Loss and Balance Sheet.
 *
 * Sigfa's Trial Balance, Trading, Profit & Loss and Balance Sheet, which its
 * own code groups as "PL,Bsheet,Trading". Four tabs over one fetch, because
 * the four statements share their inputs and have to agree: the gross profit
 * the Trading account arrives at is what the P&L carries in.
 *
 * THE PAGE DOES NO ARITHMETIC. Every figure, every total and every warning
 * comes from /api/financials, which gets them from lib/financials.mjs. A
 * statement recomputed in the browser is a second implementation to keep in
 * step, and the footing is the one thing that must not be approximated.
 *
 * PRINTING follows the ledger, voucher, order and book registers: `doc-sheet`
 * for the page, the firm's letterhead at the top, `no-print` on the controls.
 */

const fmt = (n) =>
  new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    Number(n) || 0
  );

const asDate = (v) => (v ? new Date(v).toLocaleDateString('en-IN') : '');

/** 1 April of the current financial year. */
const fyStart = () => {
  const now = new Date();
  const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}-04-01`;
};

const todayISO = () => new Date().toISOString().substring(0, 10);

/** One side of a horizontal account: rows, then a total. */
function Side({ heading, rows, total, label }) {
  return (
    <div className="table-wrap">
      <table className="data-table report-table">
        <thead>
          <tr>
            <th>{heading}</th>
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={2}>
                <div className="empty-state">Nothing on this side.</div>
              </td>
            </tr>
          )}
          {rows.map((r, i) => (
            <tr key={`${r.label}-${i}`}>
              <td>
                {r.label}
                {r.derived && <span className="chip ml-2">from stock</span>}
                {r.carried && <span className="chip ml-2">carried</span>}
                {r.group && r.group !== r.label && (
                  <span className="block text-xs text-muted-foreground">{r.group}</span>
                )}
              </td>
              <td className="num">{fmt(r.amount)}</td>
            </tr>
          ))}
          <tr className="font-medium">
            <td>{label || 'Total'}</td>
            <td className="num">{fmt(total)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function Financials() {
  const router = useRouter();
  const { company } = useCompany();

  const [kind, setKind] = useState('trial');
  const [from, setFrom] = useState(fyStart());
  const [to, setTo] = useState(todayISO());
  const [expand, setExpand] = useState(false);
  const [closingStock, setClosingStock] = useState('');
  const [openingStock, setOpeningStock] = useState('');

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // What the figures on screen were loaded for. The same guard the order
  // report and the account books needed: `kind` changes the instant a tab is
  // clicked while `data` changes only when the fetch returns.
  const [loadedFor, setLoadedFor] = useState(null);

  const signature = `${from}|${to}|${expand}|${closingStock}|${openingStock}`;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const qs = new URLSearchParams({ from, to });
      if (expand) qs.set('expand', '1');
      if (closingStock.trim() !== '') qs.set('closingStock', closingStock.trim());
      if (openingStock.trim() !== '') qs.set('openingStock', openingStock.trim());

      const res = await fetch(`/api/financials?${qs.toString()}`);
      const body = await res.json();
      if (!body.success) {
        setError(body.error || 'Could not build the statements.');
        setData(null);
      } else {
        setData(body);
      }
    } catch (err) {
      setError(err.message || 'Could not build the statements.');
      setData(null);
    } finally {
      // Every path, failures included.
      setLoadedFor(signature);
      setLoading(false);
    }
  }, [from, to, expand, closingStock, openingStock, signature]);

  useEffect(() => {
    load();
  }, [load]);

  const busy = loading || loadedFor !== signature;
  const shown = loadedFor === signature ? data : null;

  const title = useMemo(() => STATEMENT_TITLES[kind] || STATEMENT_TITLES.trial, [kind]);

  return (
    <div className="doc-sheet report-sheet">
      <div className="doc-head">
        <h2 className="doc-org">{company?.name || ''}</h2>
        <p className="doc-meta">{company ? companyAddress(company) : ''}</p>
        <p className="doc-kind">{title.toUpperCase()}</p>
        <p className="doc-meta mt-1">
          {kind === 'balance'
            ? `as at ${asDate(to)}`
            : periodText(from, to, (d) => asDate(d))}
        </p>
      </div>

      {/* ── controls ─────────────────────────────────────────────── */}
      <div className="no-print mb-5 rounded-xl border border-border bg-card p-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {STATEMENT_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              className={`btn btn-sm ${k === kind ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setKind(k)}
            >
              {STATEMENT_TITLES[k]}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <div className="field">
            <label className="field-label mb-1.5 block">From</label>
            <input
              className="field-input"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="field-label mb-1.5 block">To</label>
            <input
              className="field-input"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="field-label mb-1.5 block">Opening stock</label>
            <input
              className="field-input"
              type="number"
              step="0.01"
              placeholder={shown ? fmt(shown.stock.openingValuation.value) : 'from stock'}
              value={openingStock}
              onChange={(e) => setOpeningStock(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="field-label mb-1.5 block">Closing stock</label>
            <input
              className="field-input"
              type="number"
              step="0.01"
              placeholder={shown ? fmt(shown.stock.closingValuation.value) : 'from stock'}
              value={closingStock}
              onChange={(e) => setClosingStock(e.target.value)}
            />
            <p className="field-hint">Blank values it from the item ledger at cost.</p>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          {kind === 'trial' ? (
            <label className="flex items-center gap-2 whitespace-nowrap text-sm">
              <input
                type="checkbox"
                className="field-check"
                checked={expand}
                onChange={(e) => setExpand(e.target.checked)}
              />
              <span>List every debtor and creditor</span>
            </label>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => router.push('/account-book')}
            >
              Books
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => window.print()}>
              Print
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {busy && <div className="empty-state">Loading…</div>}

      {/* The statements say on their face what would otherwise make them
          quietly wrong -- an unbalanced trial balance, an unfiled account,
          stock valued over half a master. A financial statement that cannot
          be trusted has to admit it. */}
      {!busy && shown?.warnings?.length > 0 && (
        <div className="mb-5 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm">
          <p className="mb-1 font-medium">Worth reading before you act on this:</p>
          <ul className="list-inside list-disc space-y-1">
            {shown.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      {!busy && shown && kind === 'trial' && (
        <>
          <div
            className={`mb-4 rounded-lg border px-4 py-3 text-sm ${
              shown.trial.balanced
                ? 'border-border bg-muted/40'
                : 'border-destructive/40 bg-destructive/10 text-destructive'
            }`}
          >
            {shown.trial.balanced
              ? `Balanced. Debit and credit both ${fmt(shown.trial.totals.debit)} across ${shown.trial.accounts} accounts.`
              : `OUT BY ${fmt(Math.abs(shown.trial.difference))}. Debit ${fmt(
                  shown.trial.totals.debit
                )}, credit ${fmt(shown.trial.totals.credit)}.`}
          </div>

          <div className="table-wrap">
            <table className="data-table report-table">
              <thead>
                <tr>
                  <th>Group / Account</th>
                  <th className="num">Debit</th>
                  <th className="num">Credit</th>
                </tr>
              </thead>
              <tbody>
                {shown.trial.groups.map((g) => (
                  <React.Fragment key={g.code}>
                    <tr className="font-medium">
                      <td style={{ paddingLeft: g.main ? undefined : '1.5rem' }}>
                        {g.group}
                        {g.collapsed && (
                          <span className="ml-2 text-xs font-normal text-muted-foreground">
                            {g.accountCount} accounts, net
                          </span>
                        )}
                      </td>
                      <td className="num">{g.debit ? fmt(g.debit) : ''}</td>
                      <td className="num">{g.credit ? fmt(g.credit) : ''}</td>
                    </tr>
                    {g.accounts.map((a) => (
                      <tr key={a.name}>
                        <td style={{ paddingLeft: '3rem' }} className="text-muted-foreground">
                          {a.name}
                        </td>
                        <td className="num">{a.closing > 0 ? fmt(a.closing) : ''}</td>
                        <td className="num">{a.closing < 0 ? fmt(-a.closing) : ''}</td>
                      </tr>
                    ))}
                  </React.Fragment>
                ))}
                <tr className="font-medium">
                  <td>Total</td>
                  <td className="num">{fmt(shown.trial.totals.debit)}</td>
                  <td className="num">{fmt(shown.trial.totals.credit)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}

      {!busy && shown && kind === 'trading' && (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Side heading="Dr" rows={shown.trading.left} total={shown.trading.leftTotal} />
            <Side heading="Cr" rows={shown.trading.right} total={shown.trading.rightTotal} />
          </div>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="stat-card">
              <div className="stat-label">Opening stock</div>
              <div className="stat-value">{fmt(shown.trading.openingStock)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Closing stock</div>
              <div className="stat-value">{fmt(shown.trading.closingStock)}</div>
              <div className="field-hint">
                {shown.stock.closingOverridden ? 'typed in' : 'valued at cost'}
              </div>
            </div>
            <div className="stat-card">
              <div className="stat-label">
                {shown.trading.gross < 0 ? 'Gross loss' : 'Gross profit'}
              </div>
              <div className="stat-value">{fmt(Math.abs(shown.trading.gross))}</div>
            </div>
          </div>
        </>
      )}

      {!busy && shown && kind === 'pl' && (
        <>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Side heading="Dr" rows={shown.pl.left} total={shown.pl.leftTotal} />
            <Side heading="Cr" rows={shown.pl.right} total={shown.pl.rightTotal} />
          </div>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="stat-card">
              <div className="stat-label">{shown.pl.net < 0 ? 'Net loss' : 'Net profit'} for the period</div>
              <div className="stat-value">{fmt(Math.abs(shown.pl.net))}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Carried on the balance sheet</div>
              <div className="stat-value">{fmt(shown.profit.accumulated)}</div>
              <div className="field-hint">
                {shown.profit.differs ? 'accumulated since the books opened' : 'the same figure'}
              </div>
            </div>
          </div>
        </>
      )}

      {!busy && shown && kind === 'balance' && (
        <>
          <div
            className={`mb-4 rounded-lg border px-4 py-3 text-sm ${
              shown.sheet.balanced
                ? 'border-border bg-muted/40'
                : 'border-destructive/40 bg-destructive/10 text-destructive'
            }`}
          >
            {shown.sheet.balanced
              ? `Balanced at ${fmt(shown.sheet.assetsTotal)}.`
              : `OUT BY ${fmt(Math.abs(shown.sheet.difference))}.`}
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Side
              heading="Liabilities"
              rows={shown.sheet.liabilities}
              total={shown.sheet.liabilitiesTotal}
            />
            <Side heading="Assets" rows={shown.sheet.assets} total={shown.sheet.assetsTotal} />
          </div>
        </>
      )}
    </div>
  );
}

export default function FinancialsPage() {
  return (
    <Suspense fallback={null}>
      <Financials />
    </Suspense>
  );
}
