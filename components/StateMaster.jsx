'use client';
import React, { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { INDIAN_STATES, findStateByName, normalizeStateCode } from '@/lib/states.mjs';

/**
 * The state master: a state or union territory and its GST state code.
 *
 * The code is the first two digits of a GSTIN, so it decides whether a supply
 * is intra-state or inter-state. Typing a known state name fills the code in
 * automatically — the whole point of the master is that nobody has to remember
 * that Delhi is 07.
 */
const StateMaster = ({ open, onClose, selected }) => {
  const [form, setForm] = useState({ name: '', code: '' });
  const [saving, setSaving] = useState(false);
  const isEditing = Boolean(selected?._id || selected?.id);

  useEffect(() => {
    if (!open) {
      setForm({ name: '', code: '' });
      return;
    }
    setForm({
      name: selected?.name || '',
      code: normalizeStateCode(selected?.code) || '',
    });
  }, [open, selected]);

  /** Typing a state we know fills its code, unless one is already entered. */
  const onName = (name) => {
    setForm((prev) => {
      const known = findStateByName(INDIAN_STATES, name);
      return {
        name,
        code: prev.code || (known ? known.code : ''),
      };
    });
  };

  const handleSave = async () => {
    const name = form.name.trim();
    const code = normalizeStateCode(form.code);

    if (!name) { alert('Please enter a state name.'); return; }
    if (!code) { alert('Please enter a two-digit GST state code, e.g. 07.'); return; }

    setSaving(true);
    try {
      const res = await fetch(isEditing ? '/api/state-update' : '/api/state-add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: selected?._id || selected?.id, name, code }),
      });
      const result = await res.json();
      if (result.success) {
        onClose(true);
      } else {
        alert(result.error || result.message || 'Could not save the state.');
      }
    } catch (err) {
      console.error('Error saving state:', err);
      alert('Error saving the state.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={() => onClose(false)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold text-foreground">
            {isEditing ? 'Edit State' : 'Add State'}
          </DialogTitle>
        </DialogHeader>

        <datalist id="known-states">
          {INDIAN_STATES.map((s) => (
            <option value={s.name} key={s.code} />
          ))}
        </datalist>

        <div className="grid grid-cols-1 gap-4 py-2 sm:grid-cols-3">
          <div className="field sm:col-span-2">
            <label className="field-label mb-1.5 block">State / UT</label>
            <Input
              list="known-states"
              placeholder="e.g. Delhi"
              value={form.name}
              onChange={(e) => onName(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="field-label mb-1.5 block">GST Code</label>
            <Input
              inputMode="numeric"
              placeholder="07"
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value.replace(/\D/g, '').slice(0, 2) })}
            />
          </div>
        </div>

        <p className="field-hint">
          The code is the first two digits of a GSTIN — Delhi is 07, not 7. Picking a
          known state fills it in for you.
        </p>

        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="button" className="btn btn-secondary" onClick={() => onClose(false)}>
            Cancel
          </button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : isEditing ? 'Update State' : 'Save State'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default StateMaster;
