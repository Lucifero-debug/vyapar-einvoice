// components/VoucherSearchParams.jsx
'use client';
import { useSearchParams } from 'next/navigation';
import { useEffect } from 'react';

export default function VoucherSearchParams({ onParams }) {
  const searchParams = useSearchParams();

  useEffect(() => {
    const type = searchParams.get("type");
    const value = searchParams.get("value");
    // Receipt, Payment, Journal or Contra -- so the dashboard can link
    // straight to the one you want. The form validates it and falls back to
    // its own default, exactly as it does for `type`.
    const kind = searchParams.get("kind");

    if (onParams) {
      onParams({ type, value, kind });
    }
  }, [searchParams, onParams]);

  return null;
}
