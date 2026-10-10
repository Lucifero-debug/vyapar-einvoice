'use client';
import { useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

export default function ItemLedgerSearchParams({ onValue }) {
  const searchParams = useSearchParams();

  useEffect(() => {
    const value = searchParams.get('itemId');
    if (value && onValue) onValue(value);
    console.log("JHULA",value)
  }, [searchParams, onValue]);

  return null;
}
