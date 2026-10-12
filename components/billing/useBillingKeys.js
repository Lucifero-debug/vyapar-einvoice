'use client';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { isTypingTarget, shortcutFor } from '@/lib/billingKeys.mjs';

/**
 * One keydown listener for the whole billing screen.
 *
 * ONE listener, not one per control. A handler on every input is how a
 * shortcut ends up working in four boxes and not the fifth, and how two
 * handlers end up both firing on the same key.
 *
 * WHAT IS AND IS NOT DECIDED HERE: nothing. Which action a keystroke means,
 * and whether it may fire while somebody is typing, both come from
 * lib/billingKeys.mjs, which is pure and tested. This hook reads the DOM --
 * what has focus -- and calls the handler. That split is deliberate: the rule
 * that plain Delete must not eat a row while a quantity is being corrected is
 * the kind of thing that rots inside an event handler and holds still inside
 * a tested function.
 *
 * `handlers` is an object keyed by action name. A key with no handler does
 * nothing at all -- no preventDefault either, so the browser keeps it. That
 * matters for Delete: with no row focused there is nothing to delete, and
 * swallowing the key would stop it deleting a character.
 *
 * RETURNS THE SET OF ACTIONS IT CAN ACTUALLY FIRE, so the help overlay can
 * say so. This shipped with nineteen keys in the table and ten of them wired,
 * and the overlay advertised all nineteen -- somebody presses Alt+J, nothing
 * happens, and they stop trusting the whole table. The honest list is now
 * derived from the handlers rather than from the table, and
 * scripts/billing.test.mjs fails if the screen leaves one unbound.
 */
export function useBillingKeys(handlers) {
  // Held in a ref so the listener is installed once rather than torn down and
  // rebuilt on every render. A listener that re-registers on each keystroke
  // loses keys pressed during the gap.
  // Updated after each commit rather than during render: React may render
  // without committing, and a ref written mid-render can then point at
  // handlers that never reached the screen. Layout effect, so it is current
  // before the browser can deliver the next key.
  const latest = useRef(handlers);
  useLayoutEffect(() => {
    latest.current = handlers;
  });

  // Recomputed per render rather than memoised: it is a handful of keys, and
  // a stale `bound` set would put the overlay back to lying.
  const bound = new Set(
    Object.entries(handlers || {})
      .filter(([, fn]) => typeof fn === "function")
      .map(([action]) => action)
  );

  useEffect(() => {
    const onKeyDown = (event) => {
      // `repeat` is a held-down key. Acting on every repeat would add forty
      // rows from one lean on Ctrl+Enter -- the accidental duplicate-row
      // creation the brief asks to prevent.
      if (event.repeat) return;

      const typing = isTypingTarget(event.target) || isTypingTarget(document.activeElement);
      const action = shortcutFor(event, { typing });
      if (!action) return;

      const handler = latest.current?.[action];
      if (typeof handler !== 'function') return;

      // Only once we know something will handle it. preventDefault on a key
      // nothing listens for is how an app breaks copy and paste.
      event.preventDefault();
      handler(event);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return bound;
}

export default useBillingKeys;
