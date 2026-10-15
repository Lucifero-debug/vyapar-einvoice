'use client';
import React, { useEffect, useRef, useState } from 'react';
import { alterPayload, masterSpec } from '@/lib/masterActions.mjs';
import { SERIES_DOC_TYPES } from '@/lib/series.mjs';

/**
 * Sigfa's "Create [ Alt + A ]" and "Alter [ Alt + M ]", in one dialog.
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
 *
 *
 * ALTER SENDS THE WHOLE RECORD BACK, AND THAT IS NOT OPTIONAL
 * ----------------------------------------------------------
 * A create may send only what was filled in. An ALTER may not. The alter
 * routes end in `existing.set({...})` with every field assigned, and two of
 * those turn a missing value into a WRONG one rather than leaving it be:
 *
 *     isService: Boolean(itemData.isService)          // undefined -> false
 *     uqc: normalizeUqc(itemData.uqc) || UQC_DEFAULT  // undefined -> "OTH"
 *
 * `uqc` is reported to the IRP, so a partial alter is a wrong e-invoice and
 * not a cosmetic loss. So an alter is handed the LOADED RECORD, shows the
 * same few fields, and posts `alterPayload()` -- the record mapped to the
 * names the route reads, with the edits over it. lib/masterActions.mjs owns
 * that mapping and scripts/master-actions.test.mjs sweeps each route's source
 * to prove no field it reads has been left out.
 *
 * It alters IN PLACE rather than navigating to the master screen, which is
 * what this used to do: Alt+M on a half-typed bill threw the bill away.
 */

/**
 * The masters, their endpoints, and the fields a bill needs from each.
 *
 * Field names are the ENDPOINT'S, not prettier ones: `hsncode`, `gstIn`,
 * `openBal`. Renaming them here would mean the server silently storing
 * undefined, which is the Mongoose-strict-mode mistake this project has made
 * seven times.
 *
 *
 * A FIELD THAT COMES FROM A MASTER IS A PICKER, NOT A BOX
 * -------------------------------------------------------
 * `fromMaster` names the master behind a field, and that field is then
 * rendered as a dropdown of what the master actually holds. Four of them
 * were plain text boxes: a party's State and Group, and an item's HSN.
 *
 * Everything in this app joins BY NAME. So a State typed "Delhi" against a
 * master holding "DELHI" is a party whose state matches nothing, and the
 * place-of-supply rule reads no state code and refuses to decide the tax
 * (lib/gst.mjs). A Group typed "Retail " with a trailing space is a second
 * group on every report that groups parties. Neither shows up as an error --
 * they show up as a figure being slightly wrong somewhere else, months on.
 *
 *   kind    the master, as lib/masterActions.mjs knows it
 *   value   the field on a record that the FIELD stores (a name, a code)
 *   label   what the option reads as; defaults to `value`
 *   fills   other fields on this form to set from the chosen record,
 *           as { formField: recordField } -- picking a state fills its code
 *
 * `derived: true` marks a field that is filled that way: shown, read-only
 * while its source is chosen, so it cannot drift from the record it came
 * from.
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
      {
        name: 'hsn',
        label: 'HSN',
        type: 'text',
        // The rate and the unit come down with it, exactly as they do on the
        // item master screen: an HSN carries both, and retyping them here is
        // how two items on one HSN end up taxed differently.
        fromMaster: {
          kind: 'hsn',
          value: 'hsncode',
          label: 'hsnname',
          fills: { gst: 'gst', unit: 'gstunit' },
        },
      },
      { name: 'gst', label: 'GST %', type: 'number', derived: true, hint: 'From the HSN' },
      {
        name: 'unit',
        label: 'Unit',
        type: 'text',
        derived: true,
        // Free text by design -- there is no unit master (see `unit` below).
        // Filled from the HSN when it has one, and typable when it does not.
        hint: 'From the HSN, or type one',
      },
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
      {
        name: 'state',
        label: 'State',
        type: 'text',
        // The code comes with it. The two have to agree: `taxTypeFor` reads
        // the CODE to decide CGST+SGST against IGST, and a party carrying a
        // state name with the wrong code is a bill taxed the wrong way with
        // nothing on screen saying so.
        fromMaster: { kind: 'state', value: 'name', fills: { stateCode: 'code' } },
      },
      {
        name: 'stateCode',
        label: 'State code',
        type: 'text',
        derived: true,
        hint: 'From the state',
      },
      { name: 'phone', label: 'Phone', type: 'text' },
      { name: 'address', label: 'Address', type: 'text' },
      {
        name: 'group',
        label: 'Group',
        type: 'text',
        // The PARTY groups -- Sundry Debtors, Cash, Bank. Not the item
        // groups, which are their own master (lib/itemGroups.mjs).
        fromMaster: { kind: 'group', value: 'name' },
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
  // Sigfa's Item Group, which is NOT the group above: that one files
  // parties, this one files goods. lib/itemGroups.mjs says why they are two.
  //
  // Created as a MAIN group here, and that is why the box is not offered.
  // Where a new group sits in the tree is a decision with a picker and a loop
  // check behind it (components/ItemGroupMaster.jsx), and Alt+A exists to
  // keep somebody in the item they are half way through typing. Moving it
  // under another group is one visit to the master screen, later.
  itemGroup: {
    title: 'New item group',
    endpoint: '/api/item-group-add',
    fixed: { mainGroup: true },
    fields: [
      { name: 'name', label: 'Group name', type: 'text', required: true, autoFocus: true },
      {
        name: 'remark',
        label: 'Remark',
        type: 'text',
        hint: 'Added as a main group — put it under another on the master screen',
      },
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
  // Sigfa's Series Master. Alt+A in a Series box creates the series whose
  // code is half typed, which is the whole reason the key exists.
  //
  // The document is a SELECT and is required, because a series belongs to
  // exactly one document and this form cannot guess which screen it was
  // opened from. The rest of Sigfa's twenty-odd fields -- the print profile,
  // the headings, the slip size -- are filled in on the real master screen in
  // Setup, which is what this dialog says.
  series: {
    title: 'New series',
    endpoint: '/api/series-add',
    fields: [
      { name: 'code', label: 'Series [Initial]', type: 'text', required: true, autoFocus: true },
      {
        name: 'docType',
        label: 'For',
        type: 'select',
        required: true,
        options: SERIES_DOC_TYPES.map((doc) => ({ value: doc.code, label: doc.label })),
      },
      { name: 'name', label: 'Series Name', type: 'text', hint: 'What the initial stands for' },
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

/**
 * The dialog's own fields, filled from a loaded record.
 *
 * Only the fields on the form: everything else rides along inside
 * `alterPayload` at its stored value, unseen.
 */
export const valuesFromRecord = (record, fields) => {
  const out = {};
  for (const field of fields) {
    const value = record?.[field.name];
    if (value === undefined || value === null) continue;
    out[field.name] = String(value);
  }
  return out;
};

export default function QuickMaster({ kind, mode = 'create', record, prefill, onClose, onSaved, onCreated }) {
  const spec = kind ? MASTER_FORMS[kind] : null;
  const altering = mode === 'alter';
  const [values, setValues] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const first = useRef(null);

  // The rows behind every `fromMaster` field on this form, keyed by master.
  // Loaded when the dialog opens rather than held: a master changed on
  // another screen has to be offered here straight away, and these are two
  // small lists read once per dialog, not per keystroke.
  const [options, setOptions] = useState({});

  useEffect(() => {
    if (!spec) return;
    setError('');
    // Altering: the record's own values, so an untouched box shows what is
    // stored rather than blank -- a blank box on an alter form is how
    // somebody clears a field by not noticing it.
    // Creating: the name already typed into the billing field carries across,
    // so Alt+A after typing an unknown item does not ask for it again.
    setValues(
      altering ? valuesFromRecord(record, spec.fields) : prefill ? { ...prefill } : {}
    );
    // Focus the first field, and only then -- never on a render where the
    // dialog is already open, which would yank the caret mid-typing.
    const id = setTimeout(() => first.current?.focus(), 0);
    return () => clearTimeout(id);
  }, [kind, mode, record, prefill, spec, altering]);

  // === What the pickers offer ===
  //
  // One request per master this form needs, through the SAME spec table the
  // keys use (lib/masterActions.mjs): its endpoint and the key its answer is
  // under. Reading the endpoint from there rather than naming it again is
  // what stops this dialog and Alt+M pointing at different lists.
  //
  // A master that fails to load leaves its picker empty and says so, rather
  // than silently falling back to a free text box -- which would put the
  // mistyped value back exactly where this is meant to stop it.
  useEffect(() => {
    if (!spec) return;

    const kinds = [
      ...new Set(spec.fields.map((f) => f.fromMaster?.kind).filter(Boolean)),
    ];
    if (!kinds.length) return;

    let cancelled = false;

    Promise.all(
      kinds.map(async (name) => {
        const master = masterSpec(name);
        if (!master?.listEndpoint) return [name, []];
        try {
          const res = await fetch(master.listEndpoint);
          const body = await res.json();
          return [name, Array.isArray(body?.[master.listKey]) ? body[master.listKey] : []];
        } catch {
          return [name, []];
        }
      })
    ).then((pairs) => {
      if (!cancelled) setOptions(Object.fromEntries(pairs));
    });

    return () => {
      cancelled = true;
    };
  }, [kind, spec]);

  if (!spec) return null;

  /**
   * Choosing from a master sets the field AND whatever that record fills.
   *
   * Cleared together too: emptying the State must empty its code, or the
   * party keeps a code belonging to a state it no longer names.
   */
  const chooseFromMaster = (field, value) => {
    const rows = options[field.fromMaster.kind] || [];
    const row = rows.find(
      (r) => String(r?.[field.fromMaster.value] ?? '') === String(value)
    );

    setValues((prev) => {
      const next = { ...prev, [field.name]: value };
      for (const [target, source] of Object.entries(field.fromMaster.fills || {})) {
        next[target] = row ? String(row[source] ?? '') : '';
      }
      return next;
    });
  };

  /** Is this derived field currently being filled by a chosen record? */
  const filledBy = (name) =>
    spec.fields.find((f) =>
      Object.prototype.hasOwnProperty.call(f.fromMaster?.fills || {}, name)
    );

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
      // A CREATE posts only what was filled in; an ALTER posts the loaded
      // record with the edits over it. See the header -- a partial alter body
      // resets `uqc` and `isService`.
      const endpoint = altering ? masterSpec(kind)?.alterEndpoint : spec.endpoint;
      // `fixed` is a value this dialog always sends and never shows -- the
      // item group's `mainGroup`, which needs a tree picker this form has no
      // room for. Under what is filled in, so a field could override it if
      // one ever named the same key.
      const body = altering
        ? alterPayload(kind, record, filledOnly(values, spec.fields))
        : { ...(spec.fixed || {}), ...filledOnly(values, spec.fields) };

      if (!endpoint || !body) {
        setError('That record cannot be altered from here.');
        return;
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      // These endpoints answer in two shapes: some send { success }, some
      // only an { error }. Treat the absence of an error on a 2xx as success
      // rather than demanding a flag that half of them do not send.
      if (!res.ok || data?.error) {
        setError(data?.error || 'Could not save.');
        return;
      }
      const saved = data?.item || data?.customer || data?.data || data;
      onSaved?.({ kind, mode, record: saved, values });
      if (!altering) onCreated?.({ kind, created: saved, values });
      onClose?.();
    } catch (err) {
      setError(err.message || 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  // "New item" is wrong on an alter. Derived from the kind's own label so a
  // new master gets both titles for free.
  const heading = altering
    ? `Alter ${masterSpec(kind)?.label || kind}`
    : spec.title;

  if (spec.unavailable) {
    return (
      <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={heading}>
        <div className="modal-card max-w-md">
          <div className="modal-title">{heading}</div>
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
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={heading}>
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
          {heading}
          <span className="block text-sm font-normal text-muted-foreground">
            {altering
              ? 'Only these fields change. Everything else on the record is kept exactly as it is.'
              : 'Saved straight to the master. You can fill in the rest later on the master screen.'}
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
              {field.fromMaster ? (
                // A picker of what the master actually holds. Not a free text
                // box with suggestions: everything joins by name, so a value
                // the master does not have is a join that silently misses.
                <select
                  id={`qm-${field.name}`}
                  ref={index === 0 ? first : undefined}
                  className="field-select mt-1.5"
                  value={values[field.name] ?? ''}
                  required={field.required}
                  onChange={(e) => chooseFromMaster(field, e.target.value)}
                >
                  <option value="">Choose…</option>
                  {(options[field.fromMaster.kind] || []).map((row) => {
                    const value = String(row?.[field.fromMaster.value] ?? '');
                    const extra = field.fromMaster.label
                      ? String(row?.[field.fromMaster.label] ?? '')
                      : '';
                    return (
                      <option key={row._id || value} value={value}>
                        {extra ? `${value} — ${extra}` : value}
                      </option>
                    );
                  })}
                </select>
              ) : field.type === 'select' ? (
                <select
                  id={`qm-${field.name}`}
                  ref={index === 0 ? first : undefined}
                  className="field-select mt-1.5"
                  value={values[field.name] ?? ''}
                  required={field.required}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, [field.name]: e.target.value }))
                  }
                >
                  <option value="">Choose…</option>
                  {(field.options || []).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={`qm-${field.name}`}
                  ref={index === 0 ? first : undefined}
                  type={field.type}
                  step={field.type === 'number' ? 'any' : undefined}
                  className="field-input mt-1.5"
                  value={values[field.name] ?? ''}
                  required={field.required}
                  autoComplete="off"
                  /* Read-only ONLY while the record filling it is chosen.
                     With nothing chosen it is typable, so a party whose
                     state is not in the master can still carry a code. */
                  readOnly={Boolean(
                    field.derived &&
                      filledBy(field.name) &&
                      String(values[filledBy(field.name).name] ?? '') !== ''
                  )}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, [field.name]: e.target.value }))
                  }
                />
              )}
              {/* An empty picker is said out loud. Silence would read as a
                  master with nothing in it being a broken dialog. */}
              {field.fromMaster && (options[field.fromMaster.kind] || []).length === 0 ? (
                <p className="field-hint mt-1">
                  Nothing in the {masterSpec(field.fromMaster.kind)?.label || 'master'} yet.
                </p>
              ) : (
                field.hint && <p className="field-hint mt-1">{field.hint}</p>
              )}
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
