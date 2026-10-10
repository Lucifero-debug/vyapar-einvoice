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
import { isReservedGroup } from '@/lib/customerGroups.mjs';

/**
 * The customer group master: the list the Group field on a party is chosen
 * from, so the same group is not typed three slightly different ways.
 *
 * Cash and Bank are reserved. An invoice settles whatever was paid at the
 * counter into the account it finds by those group names, so they can be
 * edited for their note but not renamed, and not deleted.
 */
const CustomerGroupMaster = ({ open, onClose, selected }) => {
  const [form, setForm] = useState({ name: '', note: '' });
  const [saving, setSaving] = useState(false);
  const isEditing = Boolean(selected?._id || selected?.id);
  const reserved = isEditing && isReservedGroup(selected?.name);

  useEffect(() => {
    if (!open) {
      setForm({ name: '', note: '' });
      return;
    }
    setForm({ name: selected?.name || '', note: selected?.note || '' });
  }, [open, selected]);

  const handleSave = async () => {
    const name = form.name.trim();
    if (!name) {
      alert('Please enter a group name.');
      return;
    }

    const endpoint = isEditing ? '/api/group-update' : '/api/group-add';
    setSaving(true);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: selected?._id || selected?.id,
          name,
          note: form.note.trim(),
        }),
      });
      const result = await res.json();
      if (result.success) {
        onClose(true);
      } else {
        alert(result.error || result.message || 'Could not save the group.');
      }
    } catch (err) {
      console.error('Error saving customer group:', err);
      alert('Error saving the group.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={() => onClose(false)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold text-foreground">
            {isEditing ? 'Edit Customer Group' : 'Add Customer Group'}
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-4 py-2">
          <div className="field">
            <label className="field-label mb-1.5 block">Group Name</label>
            <Input
              placeholder="e.g. Sundry Debtors"
              value={form.name}
              readOnly={reserved}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            {reserved && (
              <p className="field-hint mt-1.5">
                {selected?.name} is used by invoices to find the account a receipt
                settles into, so its name is fixed. You can still edit the note.
              </p>
            )}
          </div>

          <div className="field">
            <label className="field-label mb-1.5 block">Note</label>
            <Input
              placeholder="Optional"
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2">
          <button type="button" className="btn btn-secondary" onClick={() => onClose(false)}>
            Cancel
          </button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : isEditing ? 'Update Group' : 'Save Group'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default CustomerGroupMaster;
