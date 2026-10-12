'use client';
/**
 * Keep a report's filters in its URL, both ways.
 *
 *   <ReportUrlSync
 *     schema={REPORT_QUERIES.salesReport}
 *     values={{ side, view, scope, grain, month, from, to }}
 *     onRestore={applyLink}
 *   />
 *
 * READS ONCE. On mount, the filters the URL validly names (lib/reportQuery.mjs
 * checks every one) are handed to `onRestore`; after that the page's own
 * controls own the state. Re-reading on every URL change is what makes
 * pickers spring back -- see the note in components/AccountBookSearchParams.jsx.
 * `restore={false}` skips this, for a page that already has its own reader.
 *
 * WRITES ON EVERY CHANGE, WITHOUT NAVIGATING. The canonical query for the
 * current filters replaces the URL through `history.replaceState`, which the
 * App Router keeps `useSearchParams` in step with:
 *
 *   - no history entry per click, so Back leaves the report rather than
 *     stepping through every filter that was tried
 *   - no navigation, so no server round trip and no remount
 *   - no loop: nothing here reacts to the URL after the first read, and the
 *     write is skipped when the URL already says the same thing
 *
 * The first write waits one render, so a link's own filters are applied
 * before anything is written -- otherwise the page's defaults would overwrite
 * the very link being opened.
 *
 * `useSearchParams` needs a Suspense boundary above it. Every report page
 * already renders its body inside one; this belongs inside that body.
 */
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { buildReportQuery, parseReportQuery, sameQuery } from '@/lib/reportQuery.mjs';

export default function ReportUrlSync({ schema, values, onRestore, restore = true }) {
  const searchParams = useSearchParams();
  const started = useRef(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (restore) {
      const { values: found } = parseReportQuery(schema, searchParams);
      if (Object.keys(found).length) onRestore?.(found);
    }
    // Batched with the restore's own state updates, so the first write sees
    // the restored filters, not the defaults.
    setReady(true);
    // Deliberately once: see the header.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const query = buildReportQuery(schema, values);

  useEffect(() => {
    if (!ready || typeof window === 'undefined') return;
    const current = window.location.search.replace(/^\?/, '');
    if (sameQuery(current, query)) return;
    const url = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
    window.history.replaceState(null, '', url);
  }, [ready, query]);

  return null;
}
