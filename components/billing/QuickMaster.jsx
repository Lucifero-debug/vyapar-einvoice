'use client';
import React, { useEffect, useRef, useState } from 'react';

/**
 * Sigfa's "Alt + A -- Create New Masters In Transaction".
 *
 * The one shortcut worth the whole exercise. A walk-in customer or an item
 * nobody has entered yet currently stops a bill dead: you abandon the form,
 * open the master screen, come back and start again. Sigfa lets you create it
 * from the field you are standing in and carry on.
 *
 * CONTEXT-SENSITIVE, as Sigfa's is: which master it offers comes from
 * `masterForField` in lib/billingKeys.mjs, keyed on the field that had focus.
 * A field with no master behind it does nothing rather than guessing.
 *
 * IT POSTS TO THE EXISTING ENDPOINTS, with the existing field names, and
 * sends only what was filled in. Nothing here is a new contract: item-add
 * whitelists its own fields, customer-add signs its own opening balance,
 * hsn-add demands code and GST, and each one does its own duplicate check
 * against the master. So the dialog can stay small -- the few fields a bill
 * actually needs -- and anything else is filled in later on the real master
 * screen, where it belongs.
 */

/**
 * The masters, their endpoints, and the fields a bill needs from each.
 *
 * Field names are the ENDPOINT'S, not prettier ones: `hsncode`, `gstIn`,
 * `openBal`. Renaming them here would mean the server silently storing
 * undefined, which is the Mongoose-strict-mode mistake this project has made
 * seven times.
 */
export const MASTER_FORMS = {
  item: {
    title: 'New item',
    endpoint: '/api/item-add',
    // What the item master needs for a line to price and tax itself. The
    // order is the order of the fields on the real item screen.
    fields: [
      { name: 'name', label: 'Item name', type: 'text', required: true, autoFocus: true },
      { name: 'short', label: 'Short code', type: 'text', hint: 'What F2 searches on' },
      { name: 'hsn', label: 'HSN', type: 'text' },
      { name: 'gst', label: 'GST %', type: 'number' },
      { name: 'unit', label: 'Unit', type: 'text' },
      { name: 'salePrice', label: 'Sale price', type: 'number' },
      { name: 'purchasePrice', label: 'Purchase price', type: 'number' },
    ],
  },
  customer: {
    title: 'New party',
    endpoint: '/api/customer-add',
    fields: [
      { name: 'name', label: 'Party name', type: 'text', required: true, autoFocus: true },
      { name: 'short', label: 'Short code', type: 'text' },
      { name: 'gstIn', label: 'GSTIN', type: 'text' },
      { name: 'state', label: 'State', type: 'text' },
      { name: 'stateCode', label: 'State code', type: 'text' },
      { name: 'phone', label: 'Phone', type: 'text' },
      { name: 'address', label: 'Address', type: 'text' },
      {
        name: 'group',
        label: 'Group',
        type: 'text',
        hint: 'Left blank it goes in ungrouped, as on the party screen',
      },
    ],
  },
  hsn: {
    title: 'New HSN code',
    endpoint: '/api/hsn-add',
    fields: [
      { name: 'hsncode', label: 'HSN code', type: 'text', required: true, autoFocus: true },
      { name: 'hsnname', label: 'Description', type: 'text' },
      { name: 'gst', label: 'GST %', type: 'number', required: true },
      { name: 'gstunit', label: 'Unit', type: 'text' },
    ],
  },
  group: {
    title: 'New group',
    endpoint: '/api/group-add',
    fields: [
      { name: 'name', label: 'Group name', type: 'text', required: true, autoFocus: true },
      { name: 'note', label: 'Note', type: 'text' },
    ],
  },
  state: {
    title: 'New state',
    endpoint: '/api/state-add',
    fields: [
      { name: 'name', label: 'State', type: 'text', required: true, autoFocus: true },
      { name: 'code', label: 'GST state code', type: 'text', required: true },
    ],
  },
  unit: {
    title: 'New unit',
    endpoint: '/api/group-add',
    // There is no unit master endpoint in this project -- units are a free
    // text field on the item. Rather than pretend, the dialog says so and
    // points at the field. Listed here so Alt+A in a unit field answers
    // rather than doing nothing.
    unavailable:
      'Units are typed straight onto an item in this app — there is no unit master to add to. Put it in the item’s Unit field.',
    fields: [],
  },
};

export const masterKinds = () => Object.keys(MASTER_FORMS);

/** Only what was filled in, so a blank box is not stored as an empty string. */
export const filledOnly = (values, fields) => {
  const out = {};
  for (const field of fields) {
    const value = values[field.name];
    if (value === undefined || value === null || String(value).trim() === '') continue;
    out[field.name] = field.type === 'number' ? Number(value) : String(value).trim();
  }
  return out;
};

/** What is missing, in words. [] when it can be saved. */
export const missingRequired = (values, fields) =>
  fields
    .filter((f) => f.required && String(values[f.name] ?? '').trim() === '')
    .map((f) => `${f.label} is needed.`);

export default function QuickMaster({ kind, prefill, onClose, onCreated }) {
  const spec = kind ? MASTER_FORMS[kind] : null;
  const [values, setValues] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const first = useRef(null);

  useEffect(() => {
    if (!spec) return;
    setError('');
    // The name already typed into the billing field carries across, so Alt+A
    // after typing an unknown item does not ask for it again.
    setValues(prefill ? { ...prefill } : {});
    // Focus the first field, and only then -- never on a render where the
    // dialog is already open, which would yank the caret mid-typing.
    const id = setTimeout(() => first.current?.focus(), 0);
    return () => clearTimeout(id);
  }, [kind, prefill, spec]);

  if (!spec) return null;

  const problems = missingRequired(values, spec.fields);

  const submit = async (e) => {
    e.preventDefault();
    if (problems.length) {
      setError(problems[0]);
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res = await fetch(spec.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(filledOnly(values, spec.fields)),
      });
      const data = await res.json();
      // These endpoints answer in two shapes: some send { success }, some
      // only an { error }. Treat the absence of an error on a 2xx as success
      // rather than demanding a flag that half of them do not send.
      if (!res.ok || data?.error) {
        setError(data?.error || 'Could not save.');
        return;
      }
      onCreated?.({ kind, created: data?.item || data?.customer || data?.data || data, values });
      onClose?.();
    } catch (err) {
      setError(err.message || 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  if (spec.unavailable) {
    return (
      <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={spec.title}>
        <div className="modal-card max-w-md">
          <div className="modal-title">{spec.title}</div>
          <p className="text-sm text-muted-foreground">{spec.unavailable}</p>
          <div className="mt-5 flex justify-end">
            <button type="button" className="btn btn-primary" onClick={() => onClose?.()} ref={first}>
              Right
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={spec.title}>
      <form
        className="modal-card max-w-lg"
        onSubmit={submit}
        // Escape closes, as it does everywhere else in the app, and the
        // keystroke stops here rather than reaching the billing screen behind.
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose?.();
          }
        }}
      >
        <div className="modal-title">
          {spec.title}
          <span className="block text-sm font-normal text-muted-foreground">
            Saved straight to the master. You can fill in the rest later on the master screen.
          </span>
        </div>

        {error && (
          <div
            className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
            role="alert"
          >
            {error}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          {spec.fields.map((field, index) => (
            <div key={field.name}>
              <label className="field-label" htmlFor={`qm-${field.name}`}>
                {field.label}
                {field.required && (
                  <span aria-hidden="true" className="ml-1 text-destructive">
                    *
                  </span>
                )}
              </label>
              <input
                id={`qm-${field.name}`}
                ref={index === 0 ? first : undefined}
                type={field.type}
                step={field.type === 'number' ? 'any' : undefined}
                className="field-input mt-1.5"
                value={values[field.name] ?? ''}
                required={field.required}
                autoComplete="off"
                onChange={(e) =>
                  setValues((prev) => ({ ...prev, [field.name]: e.target.value }))
                }
              />
              {field.hint && <p className="field-hint mt-1">{field.hint}</p>}
            </div>
          ))}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn btn-secondary" onClick={() => onClose?.()}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save and use'}
          </button>
        </div>
      </form>
    </div>
  );
}
