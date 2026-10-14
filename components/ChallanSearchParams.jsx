'use client';
import { useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Reads a challan screen's query string and hands it up -- in its own
 * <Suspense>, like components/OrderSearchParams.jsx. A challan is a number AND
 * a type: sales challan 7 and purchase challan 7 are different documents.
 */
export default function ChallanSearchParams({ onValue }) {
  const searchParams = useSearchParams();
  useEffect(() => {
    if (!onValue) return;
    onValue({
      type: searchParams.get('type') || '',
      challanNo: searchParams.get('challanNo') || '',
      customer: searchParams.get('customer') || '',
      // null when absent, so a register opened with no filter keeps its own
      // default instead of reading "no filter" as "All".
      status: searchParams.get('status'),
      // "1" on a purchase challan opened from the Purchase MRI entry.
      mri: searchParams.get('mri') || '',
    });
  }, [searchParams, onValue]);
  return null;
}
