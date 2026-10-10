// context/CompanyContext.js
'use client'
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { BLANK_COMPANY, companyFrom } from '@/lib/company.mjs';

/**
 * The signed-in firm's letterhead, fetched once and shared.
 *
 * Every document in the app -- the invoice, the ledger, the stock report, the
 * voucher register -- used to import a hardcoded constant. On a shared
 * instance that printed the first firm's name on everybody's bills, so they
 * read it from here instead.
 *
 * The default value is the BLANK company, not null, so a component rendered
 * outside the provider shows an empty letterhead rather than crashing -- and
 * never shows somebody else's.
 */
const CompanyContext = createContext({
  company: BLANK_COMPANY,
  loading: true,
  refresh: () => {},
});

export const CompanyProvider = ({ children }) => {
  const [company, setCompany] = useState(BLANK_COMPANY);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/company', { cache: 'no-store' });
      // 401 on the sign-in page, which is not an error worth showing.
      if (!res.ok) return;
      const data = await res.json();
      if (data?.success) setCompany(companyFrom(data.company));
    } catch (err) {
      // Offline, or the request was cancelled by a navigation. A blank
      // letterhead is the honest fallback; a stale one is not.
      console.error('Could not load the company profile:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <CompanyContext.Provider value={{ company, loading, refresh: load }}>
      {children}
    </CompanyContext.Provider>
  );
};

/** The firm whose books these are. Never null. */
export const useCompany = () => useContext(CompanyContext);
