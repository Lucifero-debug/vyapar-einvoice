'use client';
import React, { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Sigfa's "Help Window" — Shift+F1 to Shift+F4.
 *
 * A searchable list of accounts, filtered to one group. Sigfa's four are the
 * customer list, the supplier list, every account, and the sale/purchase
 * heads; `lib/billingKeys.mjs`'s `LOOKUP_LISTS` holds which is which, and the
 * caller has already applied the filter.
 *
 * Two of the four **pick** — choosing a row sets the bill's party, which is
 * genuinely quicker than the dropdown on a purchase bill with four hundred
 * customers and twenty suppliers. The other two are reference only, because
 * that is what Sigfa's window is for: you read a code off it. A list that
 * silently set the party from the *account* list would be a surprise.
 *
 * Arrow keys move, Enter picks, Escape closes — the same rhythm as the item
 * search box, so there is one thing to learn rather than two.
 */
export default function LookupList({ open, title, rows, picks, onPick, onClose }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    inputRef.current?.focus();
  }, [open]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const all = rows || [];
    if (!needle) return all.slice(0, 200);
    return all
      .filter(
        (r) =>
          String(r.name || '').toLowerCase().includes(needle) ||
          String(r.city || '').toLowerCase().includes(needle)
      )
      .slice(0, 200);
  }, [rows, query]);

  if (!open) return null;

  const choose = (row) => {
    if (!row) return;
    if (picks) onPick?.(row);
    onClose?.();
  };

  const onKeyDown = (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((at) => Math.min(at + 1, Math.max(0, shown.length - 1)));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((at) => Math.max(at - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      // Always prevented: a bare Enter here would submit the bill behind the
      // overlay, which is the worst thing a stray keystroke could do.
      event.preventDefault();
      choose(shown[active]);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose?.();
    }
  };

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal-card max-w-xl" onKeyDown={onKeyDown}>
        <div className="modal-title">
          {title}
          <span className="block text-sm font-normal text-muted-foreground">
            {picks
              ? 'Arrows move, Enter chooses the party, Escape closes.'
              : 'For reference. Arrows move, Escape closes — nothing on the bill changes.'}
          </span>
        </div>

        <input
          ref={inputRef}
          className="field-input mb-3"
          placeholder="Type to narrow the list"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
        />

        {shown.length === 0 ? (
          <div className="empty-state">Nothing in this list.</div>
        ) : (
          <div className="table-wrap max-h-[50vh] overflow-y-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>City</th>
                  <th>Group</th>
                  <th className="num">Balance</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((row, index) => (
                  <tr
                    key={row.name}
                    className={index === active ? 'bg-accent' : undefined}
                    onMouseEnter={() => setActive(index)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(row)}
                    style={picks ? { cursor: 'pointer' } : undefined}
                  >
                    <td className="font-medium">{row.name}</td>
                    <td>{row.city || '—'}</td>
                    <td className="field-hint">{row.group || '—'}</td>
                    <td className="num">
                      {Number(row.lastBal || 0).toFixed(2)} {Number(row.lastBal || 0) >= 0 ? 'Dr' : 'Cr'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-4 flex justify-end">
          <button type="button" className="btn btn-secondary" onClick={() => onClose?.()}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
