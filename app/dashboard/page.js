'use client';
import React, { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useCompany } from '@/context/CompanyContext';
import HindiInsights from '@/components/HindiInsights';
import {
  CHART_GRAINS,
  PERIOD_PRESETS,
  PRESET_LABELS,
  STOCK_REASON_LABELS,
} from '@/lib/dashboard.mjs';

export const dynamic = 'force-dynamic';

/**
 * The owner's dashboard.
 *
 * NOTHING IS COMPUTED HERE. Every figure comes from lib/dashboard.mjs, by way
 * of /api/analytics -- which in turn defers to the sources that already own
 * each number: lib/salesReports.mjs for what counts as a sale,
 * `Customer.lastBal` for balances, lib/itemStock.mjs for stock. A dashboard
 * that did its own arithmetic would be a second opinion about the firm's
 * money, and one of the two would be wrong.
 *
 * THE CHART IS HAND-DRAWN SVG, on purpose. This app has no charting
 * dependency and does not need one for two series of bars; a 200 KB library
 * for this would be the largest thing on the page. Tooltips are a `<title>`
 * inside each bar, which is what a browser already knows how to show.
 *
 * PERIOD AND POINT-IN-TIME ARE KEPT APART. The date filter moves the sales,
 * the receipts and the comparison. It does NOT move the receivables, the
 * payables or the stock -- those are what is true now, and every one of them
 * says so on screen rather than leaving a reader to assume the filter applied.
 */

const money = (n) =>
  new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Number(n) || 0);

const money2 = (n) =>
  new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    Number(n) || 0
  );

const qty = (n) => String(parseFloat((Number(n) || 0).toFixed(3)));

const pctText = (row) => {
  if (row.direction === 'new') return 'New';
  if (row.pct === null) return '—';
  const sign = row.pct > 0 ? '+' : '';
  return `${sign}${row.pct.toFixed(1)}%`;
};

const ARROWS = { up: '▲', down: '▼', same: '–', new: '★' };

const toneFor = (direction, inverted) => {
  if (direction === 'same') return 'text-muted-foreground';
  const good = inverted ? direction === 'down' : direction === 'up';
  return good ? 'text-emerald-600' : 'text-rose-600';
};

/** Returns and purchase returns going UP is not good news. */
const INVERTED = new Set(['salesReturns', 'purchaseReturns']);

function Stat({ label, value, note, tone }) {
  return (
    <div className="stat-card">
      <p className="stat-label">{label}</p>
      <p className={`stat-value ${tone || ''}`}>{value}</p>
      {note && <p className="field-hint mt-1">{note}</p>}
    </div>
  );
}

/**
 * Gross and returns, one pair of bars per bucket.
 *
 * Drawn in a viewBox and scaled by CSS, so it is readable at phone width
 * without a resize listener.
 */
function TrendChart({ series, grain }) {
  const bars = series || [];
  if (!bars.length) {
    return <div className="empty-state">Nothing to chart in this period.</div>;
  }

  const peak = Math.max(1, ...bars.map((b) => Math.max(b.gross, b.returns)));
  const W = 1000;
  const H = 260;
  const padL = 8;
  const padB = 34;
  const slot = (W - padL * 2) / bars.length;
  const barW = Math.max(2, Math.min(28, slot * 0.34));
  const scale = (v) => ((H - padB) * (Number(v) || 0)) / peak;

  // On a long series, label every nth bucket so the axis stays readable.
  const every = Math.ceil(bars.length / 14);

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-64 w-full" role="img"
        aria-label={`Sales by ${grain}`}>
        {/* three guide lines, so a bar can be read without a scale */}
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line
            key={f}
            x1={0}
            x2={W}
            y1={H - padB - (H - padB) * f}
            y2={H - padB - (H - padB) * f}
            className="stroke-border"
            strokeWidth="1"
            strokeDasharray="4 4"
          />
        ))}
        <line x1={0} x2={W} y1={H - padB} y2={H - padB} className="stroke-border" strokeWidth="1" />

        {bars.map((b, i) => {
          const cx = padL + slot * i + slot / 2;
          const gh = scale(b.gross);
          const rh = scale(b.returns);
          return (
            <g key={b.key}>
              <rect
                x={cx - barW - 1}
                y={H - padB - gh}
                width={barW}
                height={gh}
                className="fill-primary"
                rx="1"
              >
                <title>{`${b.label} — sales ₹${money2(b.gross)} (${b.invoices} bill${
                  b.invoices === 1 ? '' : 's'
                })`}</title>
              </rect>
              {b.returns > 0 && (
                <rect
                  x={cx + 1}
                  y={H - padB - rh}
                  width={barW}
                  height={rh}
                  className="fill-rose-400"
                  rx="1"
                >
                  <title>{`${b.label} — returns ₹${money2(b.returns)}`}</title>
                </rect>
              )}
              {i % every === 0 && (
                <text
                  x={cx}
                  y={H - padB + 16}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[11px]"
                >
                  {b.label}
                </text>
              )}
            </g>
          );
        })}

        <text x={2} y={12} className="fill-muted-foreground text-[11px]">
          ₹{money(peak)}
        </text>
      </svg>

      <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-primary" /> Sales
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-rose-400" /> Sales returns
        </span>
        <span>All figures include GST.</span>
      </div>
    </div>
  );
}

function PartyTable({ title, data, side, note, onOpen }) {
  if (!data) return null;
  return (
    <div className="panel">
      <div className="panel-head">
        <h2 className="panel-title">{title}</h2>
        <span className="chip">As at today</span>
      </div>
      <div className="panel-body">
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Outstanding" value={`₹${money2(data.total)}`} />
          <Stat label="Parties" value={data.parties} />
          <Stat
            label={side === 'receivable' ? 'Received in period' : 'Paid in period'}
            value={data.collected === null ? '—' : `₹${money2(data.collected)}`}
            note="From vouchers, not from bills"
          />
          <Stat
            label="Overdue"
            value="—"
            note="No due dates recorded"
          />
        </div>

        {data.advanceParties > 0 && (
          <p className="field-hint mb-3">
            {data.advanceParties}{' '}
            {side === 'receivable'
              ? 'customer(s) are in credit (advances received)'
              : 'supplier(s) are in debit (advances paid)'}{' '}
            totalling ₹{money2(data.advances)}. Not included above — it is not{' '}
            {side === 'receivable' ? 'money owed to you' : 'money you owe'}.
          </p>
        )}

        {data.rows.length === 0 ? (
          <div className="empty-state">Nothing outstanding.</div>
        ) : (
          <>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>{side === 'receivable' ? 'Customer' : 'Supplier'}</th>
                    <th>City</th>
                    <th className="num">Outstanding</th>
                    <th>Dr/Cr</th>
                    <th className="no-print" />
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.name}>
                      <td className="font-medium">{r.name}</td>
                      <td>{r.city || '—'}</td>
                      <td className="num font-medium">{money2(r.outstanding)}</td>
                      <td>{r.mode}</td>
                      <td className="no-print">
                        {r.id ? (
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => onOpen(r.id)}
                          >
                            Ledger
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={2}>
                      {data.total === undefined ? '' : `${data.parties} parties`}
                    </td>
                    <td className="num font-medium">{money2(data.total)}</td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </div>
            {data.pages > 1 && (
              <p className="field-hint mt-2 no-print">
                Showing {data.rows.length} of {data.total ?? 0} — page {data.page} of {data.pages}.
              </p>
            )}
          </>
        )}
        <p className="field-hint mt-3">{note}</p>
      </div>
    </div>
  );
}

function Dashboard() {
  const router = useRouter();
  const { company } = useCompany();

  const [preset, setPreset] = useState('thisMonth');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [grain, setGrain] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // The query, as a string, so an unchanged filter does not refetch.
  const query = useMemo(() => {
    const qs = new URLSearchParams({ preset, page: String(page) });
    if (preset === 'custom') {
      qs.set('from', from);
      qs.set('to', to);
    }
    if (grain) qs.set('grain', grain);
    if (search) qs.set('search', search);
    return qs.toString();
  }, [preset, from, to, grain, search, page]);

  const load = useCallback(async () => {
    // A custom range with only one end is not a question worth asking.
    if (preset === 'custom' && (!from || !to)) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/analytics?${query}`);
      const body = await res.json();
      if (!body.success) {
        setError(body.error || 'Could not build the dashboard.');
        return;
      }
      setData(body);
    } catch (err) {
      setError(err.message || 'Could not build the dashboard.');
    } finally {
      setBusy(false);
    }
  }, [query, preset, from, to]);

  useEffect(() => {
    load();
  }, [load]);

  const sales = data?.sales?.metrics;
  const purchases = data?.purchases?.metrics;

  // The ledger pages take ids, as the dashboard tiles do.
  const openLedger = (id) => id && router.push(`/ledger?customerId=${encodeURIComponent(id)}`);
  const openItem = (id) => id && router.push(`/item-ledger?itemId=${encodeURIComponent(id)}`);

  /**
   * Mark a low-stock alert as seen. It stays listed while the item is short;
   * it only stops counting as new -- and if the shortage gets worse it is new
   * again (lib/stockAlerts.mjs).
   */
  const acknowledge = async (id) => {
    try {
      const res = await fetch('/api/stock-alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const body = await res.json().catch(() => ({}));
      if (!body.success) return;
      setData((current) => {
        if (!current?.stock) return current;
        const wasNew = current.stock.rows.some((r) => r.alert?.id === id && r.alert?.isNew);
        const rows = current.stock.rows.map((r) =>
          r.alert?.id === id ? { ...r, alert: body.alert } : r
        );
        // Counted down rather than recounted: the table shows the first fifty
        // rows, and the count is over every open alert.
        const unseen = Math.max(0, (current.stock.alertCounts?.unseen || 0) - (wasNew ? 1 : 0));
        return {
          ...current,
          stock: {
            ...current.stock,
            rows,
            alertCounts: { ...(current.stock.alertCounts || {}), unseen },
          },
        };
      });
    } catch {
      // Nothing to undo: the alert simply stays new.
    }
  };

  return (
    <div className="page-shell-wide">
      <div className="page-header">
        <h1 className="page-title">{company?.name || 'Dashboard'}</h1>
        <p className="page-subtitle">
          {data?.period?.label || '—'}
          {data?.period?.from && ` · ${data.period.from} to ${data.period.to}`}
        </p>
      </div>

      {/* ── the shared date filter ───────────────────────────────── */}
      <div className="no-print mb-5 rounded-xl border border-border bg-card p-4 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {PERIOD_PRESETS.map((p) => (
            <button
              key={p}
              type="button"
              className={`btn btn-sm ${preset === p ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => {
                setPreset(p);
                setPage(1);
              }}
            >
              {PRESET_LABELS[p]}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          {preset === 'custom' && (
            <>
              <div>
                <label className="field-label" htmlFor="db-from">From</label>
                <input
                  id="db-from"
                  type="date"
                  className="field-input mt-1.5"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </div>
              <div>
                <label className="field-label" htmlFor="db-to">To</label>
                <input
                  id="db-to"
                  type="date"
                  className="field-input mt-1.5"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </div>
            </>
          )}
          <div>
            <label className="field-label" htmlFor="db-grain">Chart by</label>
            <select
              id="db-grain"
              className="field-select mt-1.5"
              value={grain}
              onChange={(e) => setGrain(e.target.value)}
            >
              <option value="">Automatic</option>
              {CHART_GRAINS.map((g) => (
                <option key={g} value={g}>
                  {g[0].toUpperCase() + g.slice(1)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="db-search">Find a party</label>
            <input
              id="db-search"
              className="field-input mt-1.5"
              placeholder="Name or city"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
            />
          </div>
        </div>
        <p className="field-hint mt-3">
          This filter moves the sales, the receipts and the comparison. Receivables, payables and
          stock are what is true <strong>now</strong> — a balance has no period.
        </p>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {busy && !data && <div className="empty-state">Working it out…</div>}

      {data && (
        <>
          {/* ── the same figures, said in Hindi ──────────────────── */}
          {/* topParty: the receivables rows are the largest balances only on
              page 1 with no search -- see lib/hindiInsights.mjs factsFrom. */}
          <HindiInsights data={data} preset={preset} topParty={!search && page === 1} />

          {/* ── sales ───────────────────────────────────────────── */}
          <div className="panel mb-4">
            <div className="panel-head">
              <h2 className="panel-title">Sales</h2>
              {busy && <span className="chip">refreshing…</span>}
            </div>
            <div className="panel-body">
              <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                <Stat label="Gross sales" value={`₹${money2(sales.gross)}`} note="GST included" />
                <Stat label="Sales returns" value={`₹${money2(sales.returns)}`} />
                <Stat label="Net sales" value={`₹${money2(sales.net)}`} note="Gross less returns" />
                <Stat label="Bills" value={sales.invoices} note={`${sales.returnNotes} credit note(s)`} />
                <Stat label="Average bill" value={`₹${money2(sales.average)}`} />
                <Stat label="Taxable value" value={`₹${money2(sales.taxable)}`} note="Before GST" />
              </div>
              <TrendChart series={data.sales.series} grain={data.grain} />
            </div>
          </div>

          {/* ── receivables and payables ────────────────────────── */}
          <div className="mb-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
            <PartyTable
              title="Customers owe us"
              data={data.receivables}
              side="receivable"
              note="A debit balance is money owed to the firm. Balances come from the party ledger, which every invoice and receipt posts to."
              onOpen={openLedger}
            />
            <PartyTable
              title="We owe suppliers"
              data={data.payables}
              side="payable"
              note="A credit balance is money the firm owes. Shown as a positive amount payable."
              onOpen={openLedger}
            />
          </div>

          {/* ── low stock ───────────────────────────────────────── */}
          <div className="panel mb-4">
            <div className="panel-head">
              <h2 className="panel-title">Stock to reorder</h2>
              <span className="chip">As at today</span>
              {data.stock.alertCounts?.unseen > 0 && (
                <span className="chip">{data.stock.alertCounts.unseen} new</span>
              )}
            </div>
            <div className="panel-body">
              <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Needs attention" value={data.stock.alerts} />
                <Stat label="Out of stock" value={data.stock.out} />
                <Stat
                  label="Negative stock"
                  value={data.stock.negative}
                  note={data.stock.negative > 0 ? 'More issued than received' : null}
                />
                <Stat
                  label="Below minimum"
                  value={data.stock.below}
                  note={`${data.stock.withMinimum} of ${data.stock.items} items have one set`}
                />
              </div>

              {data.stock.rows.length === 0 ? (
                <div className="empty-state">Nothing needs reordering.</div>
              ) : (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Item</th>
                        <th>HSN</th>
                        <th>Unit</th>
                        <th className="num">In stock</th>
                        <th className="num">Minimum</th>
                        <th className="num">Short by</th>
                        <th>Why</th>
                        <th>Since</th>
                        <th className="no-print" />
                      </tr>
                    </thead>
                    <tbody>
                      {data.stock.rows.map((r) => (
                        <tr key={r.name}>
                          <td className="font-medium">{r.name}</td>
                          <td>{r.hsn || '—'}</td>
                          <td>{r.unit || '—'}</td>
                          <td className="num">{qty(r.quantity)}</td>
                          <td className="num">{r.minimum === null ? '—' : qty(r.minimum)}</td>
                          <td className="num">{r.shortfall === null ? '—' : qty(r.shortfall)}</td>
                          <td>
                            <span className="chip">{STOCK_REASON_LABELS[r.reason]}</span>
                            {r.alert?.isNew && <span className="chip ml-1">New</span>}
                          </td>
                          {/* When this shortage was first recorded -- the stored
                              alert, which is raised once and kept until the
                              stock recovers (lib/stockAlerts.mjs). */}
                          <td className="text-xs">
                            {r.alert?.raisedAt ? new Date(r.alert.raisedAt).toLocaleDateString('en-IN') : '—'}
                            {r.alert?.acknowledgedBy && (
                              <span className="block text-muted-foreground">Seen by {r.alert.acknowledgedBy}</span>
                            )}
                          </td>
                          <td className="no-print">
                            {r.alert?.isNew && (
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                onClick={() => acknowledge(r.alert.id)}
                              >
                                Mark seen
                              </button>
                            )}
                            {r.id ? (
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                onClick={() => openItem(r.id)}
                              >
                                Ledger
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {data.stock.withoutMinimum > 0 && (
                <p className="field-hint mt-3">
                  {data.stock.withoutMinimum} item(s) have no minimum set, so they are only listed
                  here once they run out. Set one on the item to be warned earlier.
                </p>
              )}
            </div>
          </div>

          {/* ── the comparison ──────────────────────────────────── */}
          <div className="panel">
            <div className="panel-head">
              <h2 className="panel-title">
                {data.period.label} against {data.previous?.label || 'the period before'}
              </h2>
            </div>
            <div className="panel-body">
              {data.previous?.partial && (
                <p className="field-hint mb-3">
                  This period is still running, so the comparison uses{' '}
                  {data.previous.partial} of {data.previous.label} — like for like.
                </p>
              )}
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Metric</th>
                      <th>What it measures</th>
                      <th className="num">{data.period.label}</th>
                      <th className="num">{data.previous?.label || 'Before'}</th>
                      <th className="num">Change</th>
                      <th className="num">%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.comparison.map((row) => (
                      <tr key={row.key}>
                        <td className="font-medium">{row.label}</td>
                        <td className="text-xs text-muted-foreground">{row.measure}</td>
                        <td className="num">{money2(row.current)}</td>
                        <td className="num">{money2(row.previous)}</td>
                        <td className={`num ${toneFor(row.direction, INVERTED.has(row.key))}`}>
                          {ARROWS[row.direction]} {money2(Math.abs(row.diff))}
                        </td>
                        <td className={`num ${toneFor(row.direction, INVERTED.has(row.key))}`}>
                          {pctText(row)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="field-hint mt-3">
                Bills, money received and balances are three different measures — the second column
                says which each row is. None of these is profit: for that, see the Trading account
                and the Profit &amp; Loss, which value stock and take the expenses in.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading…</div>}>
      <Dashboard />
    </Suspense>
  );
}
