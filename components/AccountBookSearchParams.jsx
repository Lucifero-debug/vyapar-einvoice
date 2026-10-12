'use client';

/**
 * Prefill the account book from the URL.
 *
 * `?kind=ledger&account=Acme%20Traders&from=2026-04-01&to=2026-06-30`
 *
 * The statement's "Open the A/C Ledger" link and the Reports hub's cash-book
 * and bank-book tiles both need the page to open where they point. Reading
 * `useSearchParams` in its own component, behind the Suspense boundary the
 * page already has, is the pattern components/ItemLedgerSearchParams.jsx
 * established -- Next requires it, and a page that calls the hook directly
 * fails the build with a missing-suspense error.
 *
 * Fired ONCE. A deep link sets the opening state; after that the page's own
 * controls own it, and re-applying the URL on every render would make the
 * pickers spring back to whatever the link said.
 */

import { useSearchParams } from 'next/navigation';
import { useEffect, useRef } from 'react';

export default function AccountBookSearchParams({ onValues }) {
  const searchParams = useSearchParams();
  const done = useRef(false);

  useEffect(() => {
    if (done.current) return;
    // Once, whatever the URL held. The page now writes its filters back to the
    // URL (components/reports/ReportUrlSync.jsx); a reader still waiting for
    // values would pick up that write-back and apply it as if it were a link.
    done.current = true;
    const values = {
      kind: searchParams.get('kind') || '',
      account: searchParams.get('account') || '',
      group: searchParams.get('group') || '',
      // Written back by components/reports/ReportUrlSync.jsx, so a preset
      // survives a shared link as a preset rather than as frozen dates.
      preset: searchParams.get('preset') || '',
      daywise: searchParams.get('daywise') || '',
      from: searchParams.get('from') || '',
      to: searchParams.get('to') || '',
    };
    if (Object.values(values).some(Boolean)) {
      onValues?.(values);
    }
  }, [searchParams, onValues]);

  return null;
}
