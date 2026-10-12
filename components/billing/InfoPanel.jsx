'use client';
import React, { useEffect, useRef } from 'react';

/**
 * Sigfa's "Alt + J — Show Item Information" and "Alt + Y — Show Party
 * Information".
 *
 * A read-only window on the master record behind what is in hand, so a rate
 * or a GSTIN can be checked without losing a half-typed bill. Read-only on
 * purpose: Alt+M is the key that goes to the master to change it, and a panel
 * that both shows and edits is a panel somebody edits by accident.
 *
 * `rows` is `[{ label, value }]`, built by the caller from the master record —
 * this component decides nothing about which fields matter.
 */
export default function InfoPanel({ open, title, subtitle, rows, onClose }) {
  const closeRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div
        className="modal-card max-w-lg"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            // Stopped here so the screen's own Escape handler does not also
            // fire and navigate away from the bill.
            e.stopPropagation();
            onClose?.();
          }
        }}
      >
        <div className="modal-title">
          {title}
          {subtitle && (
            <span className="block text-sm font-normal text-muted-foreground">{subtitle}</span>
          )}
        </div>

        {!rows?.length ? (
          <div className="empty-state">
            Nothing to show — this record is not in the master.
          </div>
        ) : (
          <div className="table-wrap max-h-[55vh] overflow-y-auto">
            <table className="data-table">
              <tbody>
                {rows.map((row) => (
                  <tr key={row.label}>
                    <td className="whitespace-nowrap field-hint">{row.label}</td>
                    <td className="font-medium">
                      {row.value === null || row.value === undefined || row.value === ''
                        ? '—'
                        : String(row.value)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-4 flex justify-end">
          <button type="button" className="btn btn-primary" onClick={() => onClose?.()} ref={closeRef}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
