'use client';
export const dynamic = "force-dynamic";

/**
 * Every report, in categories.
 *
 * A loop over lib/reportCatalogue.mjs, not a hand-written page of tiles. The
 * list, the permission each report needs and the gaps a category still has
 * all live in that module, so adding a report is an entry there and nothing
 * here.
 *
 * A report the signed-in role cannot open is shown GREYED with the reason,
 * not hidden. A biller who cannot reach the ledger should learn that the firm
 * has a statement and that it is not theirs to run -- hiding it only makes
 * them ask the owner whether one exists.
 */

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { reportHub } from '@/lib/reportCatalogue.mjs';
import { canAccessPath, permissionForPath } from '@/lib/roles.mjs';

const FORMAT_LABELS = { csv: 'CSV', xlsx: 'Excel', json: 'JSON' };

export default function ReportsHubPage() {
  const [role, setRole] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data?.success) setRole(data.user?.role || '');
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Until the role is known, nothing is marked locked -- a tile that flickers
  // from open to locked reads as a bug. The edge middleware enforces the real
  // rule either way (lib/roles.mjs); this is a label, not a gate.
  const hub = reportHub({
    allowed: (path) => (role ? canAccessPath(role, path) : true),
  });

  return (
    <div className="page-shell-wide">
      <div className="page-header">
        <h1 className="page-title">Reports</h1>
        <p className="page-subtitle">
          Every report in Vyapaar, grouped by what it answers. Each one takes a date range,
          prints on A4 and -- where it says so -- downloads as a spreadsheet.
        </p>
      </div>

      <div className="space-y-6">
        {hub.map((category) => (
          <section key={category.key} className="panel">
            <div className="panel-head">
              <div>
                <h2 className="panel-title">{category.label}</h2>
                <p className="field-hint mt-0.5">{category.blurb}</p>
              </div>
            </div>
            <div className="panel-body">
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {category.reports.map((report) =>
                  report.locked ? (
                    <div
                      key={report.key}
                      className="rounded-xl border border-dashed border-border px-4 py-3 opacity-60"
                      aria-disabled="true"
                    >
                      <p className="text-sm font-medium">{report.name}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{report.blurb}</p>
                      <p className="mt-2 text-xs text-muted-foreground">
                        Your role ({role}) cannot open this report. It needs{' '}
                        <span className="font-mono">{permissionForPath(report.path) || 'a sign-in'}</span>.
                      </p>
                    </div>
                  ) : (
                    <Link
                      key={report.key}
                      href={report.href}
                      className="rounded-xl border border-border px-4 py-3 transition hover:border-primary/60 hover:bg-accent"
                    >
                      <p className="text-sm font-medium">{report.name}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{report.blurb}</p>
                      <p className="mt-2 flex flex-wrap gap-1.5">
                        {report.period && <span className="chip">Date range</span>}
                        {report.print && <span className="chip">Print</span>}
                        {report.exports.map((format) => (
                          <span key={format} className="chip">
                            {FORMAT_LABELS[format] || format}
                          </span>
                        ))}
                      </p>
                    </Link>
                  )
                )}
              </div>

              {/* What this category has NOT got. An honest gap beats a tile
                  that opens an empty page. */}
              {category.gaps.map((gap) => (
                <p key={gap} className="report-note mt-3">
                  {gap}
                </p>
              ))}
            </div>
          </section>
        ))}
      </div>

      {loading && <p className="field-hint mt-4">Checking what your role may open…</p>}
    </div>
  );
}
