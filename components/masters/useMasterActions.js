'use client';
import { useCallback, useState } from 'react';
import {
  deletePrompt,
  deleteUrl,
  findMaster,
  masterActionProblem,
  masterKindFor,
  masterSpec,
} from '@/lib/masterActions.mjs';

/**
 * Sigfa's three master keys, for whatever field has focus.
 *
 *     Create [ Alt + A ]     Alter [ Alt + M ]     Delete [ Alt + D ]
 *
 * ONE HOOK FOR EVERY SCREEN. The point of the keys is that they work wherever
 * there is a field with a master behind it -- an item column on a bill, the
 * HSN box on the item master, the state box on the party master. A copy per
 * screen is how they came to work on one screen out of four.
 *
 * WHAT IT READS: `document.activeElement`'s `data-master-field`, which
 * lib/masterActions.mjs maps to a kind. A field without that attribute has no
 * master and the keys say so rather than doing nothing -- a shortcut that is
 * silent is indistinguishable from one that is broken.
 *
 * WHAT IT DOES NOT DO: decide anything. Which master a field belongs to,
 * which endpoints each has, what an alter must send so it does not destroy
 * the record, and what the delete confirmation says are all in
 * lib/masterActions.mjs, pure and swept against the routes' own source.
 *
 * `lists` is what the page already has in memory, keyed by kind -- a bill
 * holds the item and party masters for its own dropdowns. Anything not in
 * there is fetched on the keystroke, which is one request for a key somebody
 * pressed deliberately.
 */
export function useMasterActions({ lists = {}, onChanged } = {}) {
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  /**
   * The field under the caret, and which record it refers to.
   *
   * `data-master-value` exists because a field's own contents are not always
   * the record's name: standing in a line's QUANTITY box, the master in
   * question is that line's ITEM, and the box contains "10". Without it the
   * keys would answer "there is no master behind this field" in the three
   * places a clerk stands most of the time.
   *
   * `data-billing-field` is honoured as a fallback so the line inputs, which
   * were tagged for Enter-navigation before any of this existed, did not have
   * to be tagged twice.
   */
  const focused = () => {
    const el = typeof document === 'undefined' ? null : document.activeElement;
    const field = el?.dataset?.masterField || el?.dataset?.billingField || '';
    const value = el?.dataset?.masterValue ?? el?.value ?? '';
    return { field, kind: masterKindFor(field), value };
  };

  /**
   * The records for a kind: the page's own copy, or fetched.
   *
   * Fetched rather than required, so a screen does not have to load the HSN
   * master on mount just in case somebody presses Alt+M in an HSN box.
   */
  const recordsFor = useCallback(
    async (kind) => {
      if (Array.isArray(lists?.[kind]) && lists[kind].length) return lists[kind];
      const spec = masterSpec(kind);
      if (!spec?.listEndpoint) return [];
      const res = await fetch(spec.listEndpoint);
      const data = await res.json();
      const rows = data?.[spec.listKey];
      return Array.isArray(rows) ? rows : [];
    },
    [lists]
  );

  /** Resolve the focused field to a kind, a value and a record. */
  const resolve = useCallback(
    async (action) => {
      const { field, kind, value } = focused();
      const why = masterActionProblem({ field, kind, value, action });
      if (why) {
        setProblem(why);
        return null;
      }
      if (action === 'create') return { kind, value, record: null };

      const records = await recordsFor(kind);
      const record = findMaster(records, kind, value);
      if (!record) {
        const spec = masterSpec(kind);
        setProblem(`"${value}" is not in the ${spec?.label || kind} master.`);
        return null;
      }
      return { kind, value, record };
    },
    [recordsFor]
  );

  const create = useCallback(async () => {
    setProblem('');
    const at = await resolve('create');
    if (!at) return;
    // Whatever was typed into the field carries across, so the name is not
    // asked for twice.
    const spec = masterSpec(at.kind);
    const prefill = at.value && spec?.matchField ? { [spec.matchField]: at.value } : null;
    setDialog({ mode: 'create', kind: at.kind, prefill });
  }, [resolve]);

  const alter = useCallback(async () => {
    setProblem('');
    const at = await resolve('alter');
    if (!at) return;
    // In place, not by navigating: Alt+M used to push the master screen and
    // throw away a half-typed bill.
    setDialog({ mode: 'alter', kind: at.kind, record: at.record });
  }, [resolve]);

  /**
   * Delete the focused field's record, after asking.
   *
   * Asked because a mis-keyed Alt+D on a master nobody has used yet is gone
   * with no undo. The routes refuse with 409 when invoices, vouchers or stock
   * reference the record, so a USED master cannot be deleted either way --
   * this guards the unused ones, which are the ones that vanish unnoticed.
   */
  const remove = useCallback(async () => {
    setProblem('');
    const at = await resolve('delete');
    if (!at) return;

    const ask = deletePrompt(at.kind, at.record);
    if (ask && typeof window !== 'undefined' && !window.confirm(ask)) return;

    const url = deleteUrl(at.kind, at.record);
    if (!url) {
      setProblem('That record cannot be deleted from here.');
      return;
    }

    setBusy(true);
    try {
      const res = await fetch(url, { method: 'POST' });
      const data = await res.json();
      if (!res.ok || data?.error) {
        // The 409 the routes answer when history references the record. Shown
        // as-is: it names what is in the way, which is the useful part.
        setProblem(data?.error || 'Could not delete.');
        return;
      }
      onChanged?.({ kind: at.kind, mode: 'delete', record: at.record });
    } catch (err) {
      setProblem(err.message || 'Could not delete.');
    } finally {
      setBusy(false);
    }
  }, [resolve, onChanged]);

  return {
    dialog,
    setDialog,
    closeDialog: () => setDialog(null),
    problem,
    clearProblem: () => setProblem(''),
    busy,
    create,
    alter,
    remove,
  };
}

export default useMasterActions;
