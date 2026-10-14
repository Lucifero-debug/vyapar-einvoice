'use client';

/**
 * Prefill the stock reports from the URL.
 *
 *   ?report=value&basis=weighted&preset=thisFy
 *   ?report=short
 *   ?report=daybook&item=MS%20Plate%2010mm&preset=prevMonth
 *
 * The Reports hub's five stock tiles all point at the one page and are told
 * apart by `report`, so this is what makes a tile open the sheet it names.
 * `useSearchParams` lives in its own component behind the page's Suspense
 * boundary, the pattern components/ItemLedgerSearchParams.jsx established and
 * which Next requires.
 *
 * Fired ONCE, so the link sets the opening state and the page's own controls
 * own it afterwards.
 */

import { useSearchParams } from 'next/navigation';
import { useEffect, useRef } from 'react';

export default function StockReportSearchParams({ onValues }) {
  const searchParams = useSearchParams();
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    const values = {
      report: searchParams.get('report') || '',
      basis: searchParams.get('basis') || '',
      filter: searchParams.get('filter') || '',
      item: searchParams.get('item') || '',
      preset: searchParams.get('preset') || '',
      from: searchParams.get('from') || '',
      to: searchParams.get('to') || '',
    };
    if (Object.values(values).some(Boolean)) {
      done.current = true;
      onValues?.(values);
    }
  }, [searchParams, onValues]);

  return null;
}
