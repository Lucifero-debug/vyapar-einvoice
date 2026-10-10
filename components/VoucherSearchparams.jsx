// components/VoucherSearchParams.jsx
'use client';
import { useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

export default function VoucherSearchParams({ onParams }) {
  const searchParams = useSearchParams();

  useEffect(() => {
    const type = searchParams.get("type");
    const value = searchParams.get("value");

    if (onParams) {
      onParams({ type, value });
    }

    // Debug log
    console.log("Voucher Search Params:", { type, value });
  }, [searchParams, onParams]);

  return null;
}
