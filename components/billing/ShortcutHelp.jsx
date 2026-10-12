'use client';
import React, { useEffect, useRef } from 'react';
import { shortcutHelp } from '@/lib/billingKeys.mjs';

/**
 * Sigfa's "Alt + H -- Miscellaneous Help Window".
 *
 * Sigfa printed its keys along the bottom of every screen and gave them a
 * help window of their own, which is how a shop learns them. A shortcut
 * nobody can find is a shortcut nobody uses, so the keys are listed from the
 * same table that binds them -- a shortcut cannot exist without appearing
 * here.
 *
 * The third column is the point of including Sigfa's own wording: somebody
 * whose fingers know Alt+F12 can see at a glance that it moved and why,
 * instead of concluding the feature is missing.
 *
 * `bound` is the set of actions the screen can actually fire, from
 * useBillingKeys. A key the screen does not handle is shown greyed and
 * labelled, NOT advertised: this overlay once listed all nineteen while ten
 * were wired, and a table that promises nine keys that do nothing is worse
 * than a shorter table -- it costs the reader their trust in the other ten.
 */
export default function ShortcutHelp({ open, bound = null, onClose }) {
  const closeRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const rows = shortcutHelp(bound);
  const missing = rows.filter((row) => !row.bound).length;

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <div
        className="modal-card max-w-2xl"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose?.();
          }
        }}
      >
        <div className="modal-title">
          Keyboard shortcuts
          <span className="block text-sm font-normal text-muted-foreground">
            The same keys as the old software, where the browser allows them.
          </span>
        </div>

        <div className="table-wrap max-h-[60vh] overflow-y-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Press</th>
                <th>Does</th>
                <th>Needs</th>
                <th>In the old software</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.keys} className={row.bound ? undefined : 'opacity-50'}>
                  <td className="whitespace-nowrap font-medium">{row.keys}</td>
                  <td>
                    {row.label}
                    {!row.bound && (
                      <span className="chip ml-2">not on this screen</span>
                    )}
                  </td>
                  <td className="field-hint">
                    {row.scope === 'row' ? 'a chosen line' : 'anywhere'}
                  </td>
                  <td className="field-hint">{row.sigfa || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="field-hint mt-3">
          Enter moves along a line and never saves the bill. Three keys delete a line because a
          browser may claim one of them: Alt+E is the old key, Alt+D and Delete do the same.
          {missing > 0 && (
            <>
              {' '}
              {missing} key{missing === 1 ? '' : 's'} above {missing === 1 ? 'is' : 'are'} greyed
              out — {missing === 1 ? 'it is' : 'they are'} not wired on this screen yet, so
              pressing {missing === 1 ? 'it' : 'them'} does nothing.
            </>
          )}
        </p>

        <div className="mt-4 flex justify-end">
          <button type="button" className="btn btn-primary" onClick={() => onClose?.()} ref={closeRef}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
