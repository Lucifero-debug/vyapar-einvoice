'use client';
import React, { useEffect, useRef, useState } from 'react';
import { MRI_LABEL } from '@/lib/mri.mjs';
import { trim as trimQty } from '@/lib/orderStatus.mjs';

/**
 * The purchase M.R.I. strip, shared by the purchase bill and the purchase
 * challan screens (lib/mri.mjs).
 *
 *   mri        { on, remark, againstMriNo } -- what the request will carry
 *   onChange   (next) => void
 *   mriNo      the stored number when editing an MRI, else null
 *   party      the supplier's name, for the Re-MRI list
 *
 * The number is only ever a peek here; the server reserves it on save.
 * "Ag. MRI No." lists this supplier's MRIs with rejected material and no
 * Re-MRI yet -- SIGFA's "List Of Pending MRI" -- and the server re-checks it.
 */
export default function MriPanel({ mri, onChange, mriNo = null, party = '' }) {
  const [peek, setPeek] = useState(null);
  const [loaded, setPending] = useState({ party: '', rows: [] });

  useEffect(() => {
    if (!mri.on || mriNo) return undefined;
    let live = true;
    fetch('/api/next-mri-no')
      .then((r) => r.json())
      .then((d) => live && d?.success && setPeek(d.mriNo))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [mri.on, mriNo]);

  useEffect(() => {
    if (!mri.on || !party) return undefined;
    let live = true;
    fetch(`/api/mri?view=pending&party=${encodeURIComponent(party)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!live || !d?.success) return;
        setPending({ party, rows: (d.rows || []).filter((r) => r.mriNo !== mriNo) });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [mri.on, party, mriNo]);

  const set = (patch) => onChange({ ...mri, ...patch });

  // A Re-MRI belongs to one supplier's MRI: choosing another supplier clears
  // it rather than leaving a choice the save would refuse.
  const lastParty = useRef(party);
  useEffect(() => {
    if (lastParty.current && lastParty.current !== party && mri.againstMriNo) {
      onChange({ ...mri, againstMriNo: null });
    }
    lastParty.current = party;
  }, [party, mri, onChange]);
  // Only the list fetched for THIS supplier, and only while it is an MRI.
  const pending = mri.on && party && loaded.party === party ? loaded.rows : [];
  // The chosen Re-MRI stays listed even once it is no longer "pending" --
  // which is exactly what happens to it after this document is saved.
  const listed = mri.againstMriNo && !pending.some((r) => r.mriNo === mri.againstMriNo)
    ? [{ mriNo: mri.againstMriNo, rejected: null, documentLabel: '', documentNo: '' }, ...pending]
    : pending;

  return (
    <div className="no-print rounded-lg border border-border bg-muted/30 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={mri.on}
            onChange={(e) => set({ on: e.target.checked, ...(e.target.checked ? {} : { againstMriNo: null }) })}
          />
          {MRI_LABEL} (material receipt)
        </label>
        {mri.on && (
          <>
            <span className="text-sm">
              {MRI_LABEL} No.{' '}
              <span className="font-semibold">{mriNo || (peek ? `${peek} (on save)` : 'on save')}</span>
            </span>
            <label className="flex items-center gap-2 text-sm">
              Ag. MRI No.
              <select
                className="field-input field-input-sm"
                value={mri.againstMriNo || ''}
                onChange={(e) => set({ againstMriNo: e.target.value ? Number(e.target.value) : null })}
                disabled={!party}
                title={party ? 'A Re-MRI: rejected material from an earlier MRI, taken in again' : 'Choose the supplier first'}
              >
                <option value="">— none (a fresh MRI) —</option>
                {listed.map((r) => (
                  <option key={r.mriNo} value={r.mriNo}>
                    {MRI_LABEL} {r.mriNo}
                    {r.documentLabel ? ` — ${r.documentLabel} ${r.documentNo}` : ''}
                    {r.rejected !== null && r.rejected !== undefined ? `, ${trimQty(r.rejected)} rejected` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex min-w-[220px] flex-1 items-center gap-2 text-sm">
              Remark
              <input
                type="text"
                className="field-input field-input-sm flex-1"
                maxLength={300}
                value={mri.remark || ''}
                onChange={(e) => set({ remark: e.target.value })}
                placeholder="Inspected by, reason for rejection…"
              />
            </label>
          </>
        )}
      </div>
      {mri.on && (
        <p className="field-hint mt-2">
          Enter what was <strong>received</strong> on each line; the quantity is what you <strong>accept</strong>.
          Only the accepted quantity is billed and taken into stock. The rest shows in the rejected material register.
        </p>
      )}
    </div>
  );
}
