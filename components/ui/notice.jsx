'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * The inline message banner, as a component.
 *
 * This is the box the app already draws by hand on most screens --
 * `rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm
 * text-destructive` for a problem, the `success` colours for a confirmation --
 * so swapping a browser `alert()` for it changes where the message appears,
 * not what the app looks like.
 *
 * Why not alert(): it freezes the whole tab until it is dismissed, cannot be
 * styled, reads as a browser error rather than the app speaking, and in a
 * desktop (Electron) or phone (Capacitor) shell it shows the page's URL as
 * its title. A banner sits next to the thing it is about and goes away on
 * its own when the person moves on.
 *
 *   const [notice, notify] = useNotice();
 *   notify.error('Could not save the item.');
 *   notify.success('Item saved.');          // clears itself after a few seconds
 *   notify.clear();
 *   ...
 *   <Notice notice={notice} onClose={notify.clear} />
 */

const STYLES = {
  error: 'border-destructive/40 bg-destructive/10 text-destructive',
  success: 'border-success/40 bg-success/10',
  info: 'border-border bg-muted/40',
};

/** How long a success message stays up. Errors stay until replaced or closed. */
export const SUCCESS_MS = 4000;

export function useNotice() {
  const [notice, setNotice] = useState(null);
  const timer = useRef(null);

  const stopTimer = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  // Never leave a timer firing into a screen that has gone.
  useEffect(() => stopTimer, []);

  const show = useCallback((kind, message) => {
    stopTimer();
    const text = String(message ?? '').trim();
    if (!text) {
      setNotice(null);
      return;
    }
    // A fresh object every time, so the same message twice still re-renders
    // (and is re-announced to a screen reader).
    setNotice({ kind, message: text, at: Date.now() });
    if (kind === 'success') {
      timer.current = setTimeout(() => setNotice(null), SUCCESS_MS);
    }
  }, []);

  const clear = useCallback(() => {
    stopTimer();
    setNotice(null);
  }, []);

  // Stable identity, so `notify` is safe in effect dependency lists: `show`
  // and `clear` never change, so neither does this. A memo rather than a ref
  // read during render, which React does not guarantee.
  const notify = useMemo(
    () => ({
      error: (m) => show('error', m),
      success: (m) => show('success', m),
      info: (m) => show('info', m),
      clear,
    }),
    [show, clear]
  );

  return [notice, notify];
}

export function Notice({ notice, onClose, className = 'mb-4' }) {
  if (!notice?.message) return null;
  const kind = STYLES[notice.kind] ? notice.kind : 'info';
  return (
    <div
      role={kind === 'error' ? 'alert' : 'status'}
      aria-live={kind === 'error' ? 'assertive' : 'polite'}
      className={`${className} flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-sm ${STYLES[kind]}`}
    >
      <span className='whitespace-pre-line'>{notice.message}</span>
      {onClose && (
        <button
          type='button'
          onClick={onClose}
          className='shrink-0 leading-none opacity-70 hover:opacity-100'
          aria-label='Dismiss message'
        >
          ×
        </button>
      )}
    </div>
  );
}

export default Notice;
