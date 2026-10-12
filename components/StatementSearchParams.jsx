'use client';

/**
 * Prefill the statement from the URL.
 *
 *   ?side=supplier&account=Bharat%20Steel&preset=prevQuarter
 *   ?side=customer&preset=custom&from=2026-04-01&to=2026-06-30
 *
 * The Reports hub's two statement tiles point here with a `side`, and a
 * statement is the sort of sheet somebody bookmarks or sends a colleague.
 * `useSearchParams` lives in its own component behind the page's Suspense
 * boundary, which is the pattern components/ItemLedgerSearchParams.jsx
 * established and which Next requires.
 *
 * Fired ONCE, so the link sets the opening state and the page's own controls
 * own it afterwards.
 */

import { useSearchParams } from 'next/navigation';
import { useEffect, useRef } from 'react';

export default function StatementSearchParams({ onValues }) {
  const searchParams = useSearchParams();
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    // Once, whatever the URL held. The page now writes its filters back to the
    // URL (components/reports/ReportUrlSync.jsx); a reader still waiting for
    // values would pick up that write-back and apply it as if it were a link.
    done.current = true;
    const values = {
      side: searchParams.get('side') || '',
      account: searchParams.get('account') || '',
      view: searchParams.get('view') || '',
      preset: searchParams.get('preset') || '',
      from: searchParams.get('from') || '',
      to: searchParams.get('to') || '',
    };
    if (Object.values(values).some(Boolean)) {
      onValues?.(values);
    }
  }, [searchParams, onValues]);

  return null;
}
