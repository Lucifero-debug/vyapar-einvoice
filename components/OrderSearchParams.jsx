'use client';
import { useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Reads the order form's query string and hands it up.
 *
 * Its own component, inside a <Suspense>, because `useSearchParams` opts the
 * whole tree into client-side rendering otherwise -- the same reason
 * components/suspense.jsx exists. That one only reads `value`, which is not
 * enough here: an order is identified by a number AND a type, since sales
 * order 7 and purchase order 7 are different documents.
 *
 * `mode` is not part of identifying an order. It is what the home screen's
 * Alter and Delete items send so the register can say which column the user
 * came for -- the register is the only screen that reads it, and it changes
 * nothing but a line of text.
 */
export default function OrderSearchParams({ onValue }) {
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!onValue) return;
    onValue({
      type: searchParams.get('type') || '',
      orderNo: searchParams.get('orderNo') || '',
      customer: searchParams.get('customer') || '',
      mode: searchParams.get('mode') || '',
    });
  }, [searchParams, onValue]);

  return null;
}
