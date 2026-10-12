'use client';
import React, { useEffect, useRef } from 'react';
import QuickMaster from '@/components/billing/QuickMaster';
import useMasterActions from '@/components/masters/useMasterActions';
import { isTypingTarget, shortcutFor } from '@/lib/billingKeys.mjs';

/**
 * Sigfa's three master keys, on any screen, in one line.
 *
 *     Create [ Alt + A ]     Alter [ Alt + M ]     Delete [ Alt + D ]
 *
 * Drop `<MasterShortcuts />` on a page and every field carrying
 * `data-master-field` gets them. That is the whole of the ergonomics: the
 * keys were useless because they lived on one screen, and a rollout that
 * needed twenty lines per screen would have stayed on one screen.
 *
 * NOT FOR THE BILLING SCREEN. That one has its own listener for the full key
 * table (F2, Ctrl+Enter, the Shift+F lists, Alt+S and the rest) and calls
 * `useMasterActions` directly. Two listeners would both fire on Alt+A.
 *
 * `lists` is whatever the page already holds, keyed by kind, so a screen that
 * has the HSN master in memory does not refetch it on the keystroke.
 * `onChanged` is called after a create, alter or delete so the page can
 * refresh the list the record came from.
 */
export default function MasterShortcuts({ lists = {}, onChanged }) {
  const masters = useMasterActions({ lists, onChanged });

  // Held in a ref so the listener installs once rather than being torn down
  // and rebuilt on every render -- a listener that re-registers on each
  // keystroke loses keys pressed during the gap.
  const latest = useRef(masters);
  latest.current = masters;

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.repeat) return;
      const typing = isTypingTarget(event.target) || isTypingTarget(document.activeElement);
      // The SAME resolution the billing screen uses, so Alt+A means the same
      // thing on both and neither can drift.
      const action = shortcutFor(event, { typing });
      const handler = {
        newMaster: latest.current.create,
        alterMaster: latest.current.alter,
        deleteMaster: latest.current.remove,
      }[action];
      if (typeof handler !== 'function') return;
      // Only once something will handle it: preventDefault on a key nothing
      // listens for is how an app breaks copy and paste.
      event.preventDefault();
      handler();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <>
      <QuickMaster
        kind={masters.dialog?.kind}
        mode={masters.dialog?.mode}
        record={masters.dialog?.record}
        prefill={masters.dialog?.prefill}
        onClose={masters.closeDialog}
        onSaved={({ kind }) => onChanged?.({ kind, mode: masters.dialog?.mode })}
      />

      {/* Why a key did nothing, in a sentence. Silence is indistinguishable
          from a broken shortcut. */}
      {masters.problem && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card max-w-md">
            <div className="modal-title">Nothing to do here</div>
            <p className="text-sm text-muted-foreground">{masters.problem}</p>
            <div className="mt-5 flex justify-end">
              <button
                type="button"
                className="btn btn-primary"
                onClick={masters.clearProblem}
                autoFocus
              >
                Right
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
