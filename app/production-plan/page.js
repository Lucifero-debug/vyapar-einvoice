'use client';
import React, { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useCompany } from '@/context/CompanyContext';
import { companyAddress } from '@/lib/company.mjs';
import { trim } from '@/lib/orderStatus.mjs';
import { toCsv } from '@/lib/orderReports.mjs';
import { PLAN_CSV_COLUMNS, planFilename } from '@/lib/productionPlan.mjs';

export const dynamic = 'force-dynamic';

/**
 * Production planning: what to make, and what is short to make it.
 *
 * NOT from Sigfa -- it has no planner. Its binary holds `PlanGrid` (a VB grid
 * control), `PLANo` (a document number) and `Deposit Planning` (a banking
 * feature), and every `MRP` string in it is Maximum Retail Price. There are no
 * PLAN, SCHED or REQ tables in its program file or in the client's data.
 *
 * READ ONLY by design. It writes nothing: the purchase orders and production
 * entries it implies are raised on the screens that already exist, where they
 * get the checks those screens carry.
 *
 * THE PAGE DOES NO ARITHMETIC. Every figure comes from /api/production-plan,
 * which gets them from lib/productionPlan.mjs -- including the netting, which
 * is the part that is easy to get wrong twice over.
 */

const fmt = (n) =>
  new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    Number(n) || 0
  );

/** Hand the browser a file without a round trip to the server. */
const downloadCsv = (filename, csv) => {
  // A BOM, so Excel opens it as UTF-8 rather than mangling a rupee sign.
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

function ProductionPlan() {
  const router = useRouter();
  const { company } = useCompany();

  const [nested, setNested] = useState(true);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // What the figures on screen were loaded for -- the same guard the order
  // report and the books needed.
  const [loadedFor, setLoadedFor] = useState(null);
  const signature = String(nested);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/production-plan?nested=${nested ? '1' : '0'}`);
      const body = await res.json();
      if (!body.success) {
        setError(body.error || 'Could not build the plan.');
        setData(null);
      } else {
        setData(body);
      }
    } catch (err) {
      setError(err.message || 'Could not build the plan.');
      setData(null);
    } finally {
      // Every path, failures included.
      setLoadedFor(String(nested));
      setLoading(false);
    }
  }, [nested]);

  useEffect(() => {
    load();
  }, [load]);

  const busy = loading || loadedFor !== signature;
  const shown = loadedFor === signature ? data : null;

  return (
    <div className="doc-sheet">
      <div className="doc-head">
        <h2 className="doc-org">{company?.name || ''}</h2>
        <p className="doc-meta">{company ? companyAddress(company) : ''}</p>
        <p className="doc-kind">PRODUCTION PLAN</p>
        <p className="doc-meta mt-1">
          From open sales orders, as at {new Date().toLocaleDateString('en-IN')}
        </p>
      </div>

      <div className="no-print mb-5 rounded-xl border border-border bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 whitespace-nowrap text-sm">
            <input
              type="checkbox"
              className="field-check"
              checked={nested}
              onChange={(e) => setNested(e.target.checked)}
            />
            <span>Break down sub-formulas</span>
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => router.push('/order-report?view=item-pending')}
            >
              Pending by item
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => router.push('/production')}
            >
              Production
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || !shown?.buy?.length}
              onClick={() =>
                downloadCsv(planFilename('buy'), toCsv(PLAN_CSV_COLUMNS.buy, shown.buy))
              }
            >
              Materials CSV
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

      {!busy && shown && (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <div className="stat-card">
              <div className="stat-label">Items on order</div>
              <div className="stat-value">{shown.summary.itemsOnOrder}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">To make</div>
              <div className="stat-value">{shown.summary.itemsToMake}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Covered from stock</div>
              <div className="stat-value">{shown.summary.coveredFromStock}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Materials short</div>
              <div className="stat-value">{shown.summary.shortMaterials}</div>
              <div className="field-hint">of {shown.summary.materials}</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Value to buy</div>
              <div className="stat-value">₹ {fmt(shown.summary.shortValue)}</div>
            </div>
          </div>

          {shown.warnings.length > 0 && (
            <div className="mb-5 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm">
              <p className="mb-1 font-medium">Worth reading before you act on this:</p>
              <ul className="list-inside list-disc space-y-1">
                {shown.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          <h3 className="section-title mb-2">What to make</h3>
          <div className="mb-6 table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="num">On order</th>
                  <th className="num">In stock</th>
                  <th className="num">From stock</th>
                  <th className="num">To make</th>
                  <th>Formula</th>
                  <th className="num">Orders</th>
                </tr>
              </thead>
              <tbody>
                {shown.make.length === 0 && (
                  <tr>
                    <td colSpan={7}>
                      <div className="empty-state">No open sales orders.</div>
                    </td>
                  </tr>
                )}
                {shown.make.map((m) => (
                  <tr key={m.item}>
                    <td className="font-medium">{m.item}</td>
                    <td className="num">{trim(m.pending)}</td>
                    <td className="num">
                      {m.known ? trim(m.inStock) : <span title="No such item in the master">—</span>}
                    </td>
                    <td className="num">{m.fromStock > 0 ? trim(m.fromStock) : '—'}</td>
                    <td className="num font-medium">{m.toMake > 0 ? trim(m.toMake) : '—'}</td>
                    <td>
                      {m.formulaName || (
                        <span className="text-muted-foreground">
                          {m.ambiguous ? 'more than one formula' : 'bought in'}
                        </span>
                      )}
                    </td>
                    <td className="num">{m.orders}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 className="section-title mb-2">What is short</h3>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Material</th>
                  <th className="num">Required</th>
                  <th className="num">In stock</th>
                  <th className="num">On order</th>
                  <th className="num">Short</th>
                  <th className="num">Value</th>
                  <th>Needed for</th>
                </tr>
              </thead>
              <tbody>
                {shown.buy.length === 0 && (
                  <tr>
                    <td colSpan={7}>
                      <div className="empty-state">
                        Nothing is required — everything on order is covered from stock.
                      </div>
                    </td>
                  </tr>
                )}
                {shown.buy.map((b) => (
                  <tr key={b.item} className={b.short > 0 ? '' : 'text-muted-foreground'}>
                    <td className={b.short > 0 ? 'font-medium' : ''}>{b.item}</td>
                    <td className="num">{trim(b.required)}</td>
                    <td className="num">
                      {b.known ? trim(b.inStock) : <span title="No such item in the master">—</span>}
                    </td>
                    {/* Its own column, never folded into the stock figure: a
                        shortfall that is surprisingly small should be
                        visibly small for a reason. */}
                    <td className="num">{b.onOrder > 0 ? trim(b.onOrder) : '—'}</td>
                    <td className={`num ${b.short > 0 ? 'font-medium text-destructive' : ''}`}>
                      {b.short > 0 ? trim(b.short) : '—'}
                    </td>
                    <td className="num">{b.short > 0 ? fmt(b.value) : '—'}</td>
                    <td className="text-sm text-muted-foreground">
                      {b.forItems.length ? b.forItems.join(', ') : 'ordered directly'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="field-hint mt-2">
            Read only. Raise the purchase orders and production entries on their own screens —
            a plan is a derived figure, and nothing here writes one into your books.
          </p>
        </>
      )}
    </div>
  );
}

export default function ProductionPlanPage() {
  return (
    <Suspense fallback={null}>
      <ProductionPlan />
    </Suspense>
  );
}
