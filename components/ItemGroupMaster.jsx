'use client';
import React, { useCallback, useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Notice, useNotice } from '@/components/ui/notice';
import { NETWORK_ERROR, readResponse } from '@/lib/apiResponse.mjs';
import {
  ITEM_GROUP_DEFAULTS,
  itemGroupProblems,
  normalizeItemGroup,
  parentOptions,
} from '@/lib/itemGroups.mjs';

/**
 * The item group master — Sigfa's `Masters > Item Group`, field for field:
 * Group Name, Main Group, Under Group, Remark.
 *
 * A SEPARATE MASTER from the customer groups beside it. That one files
 * parties and carries the reserved Cash and Bank names an invoice settles
 * into; this one files goods and is a plain tree. lib/itemGroups.mjs records
 * why they were split.
 *
 * The refusals are `itemGroupProblems`, the same function the two routes
 * call, so the screen says what the server would say rather than its own
 * version of it. The screen checks first only so the answer is immediate —
 * the route still checks, because another till may have taken the name in
 * between.
 */
const ItemGroupMaster = ({ open, onClose, selected }) => {
  const [form, setForm] = useState(ITEM_GROUP_DEFAULTS);
  const [groups, setGroups] = useState([]);
  const [saving, setSaving] = useState(false);
  const [notice, notify] = useNotice();

  const id = selected?._id || selected?.id;
  const isEditing = Boolean(id);

  // Every group of the firm, for the Under Group picker. Loaded each time the
  // dialog opens rather than once: a group added from another screen has to
  // be available as a parent straight away.
  const loadGroups = useCallback(() => {
    fetch('/api/get-item-group')
      .then((r) => r.json())
      .then((d) => setGroups(d.itemGroup || []))
      .catch(() => setGroups([]));
  }, []);

  useEffect(() => {
    notify.clear();
    if (!open) {
      setForm(ITEM_GROUP_DEFAULTS);
      return;
    }
    loadGroups();
    // `normalizeItemGroup` rather than field-by-field, so a record missing a
    // field opens with that field's default instead of `undefined`, which
    // React turns into an uncontrolled input half way through a form.
    setForm(normalizeItemGroup(selected || {}));
  }, [open, selected, notify, loadGroups]);

  // The groups this one may sit under: everything except itself and whatever
  // is already beneath it, so a loop cannot be chosen rather than only being
  // refused after Save.
  const parents = parentOptions(isEditing ? selected?.name : '', groups);

  const handleSave = async () => {
    const draft = normalizeItemGroup(form);

    // Itself left out, or re-saving an unchanged group reports it as a
    // duplicate of itself and as its own ancestor.
    const others = groups.filter((g) => String(g._id || g.id) !== String(id));
    const problems = itemGroupProblems(draft, others);
    if (problems.length) {
      notify.error(problems[0]);
      return;
    }

    if (saving) return;
    setSaving(true);
    notify.clear();

    try {
      const res = await fetch(isEditing ? '/api/item-group-update' : '/api/item-group-add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...draft }),
      });
      const { ok, body: result, message } = await readResponse(res);
      if (ok && result.success) {
        onClose(true);
      } else {
        notify.error(`The group was not saved. ${message}`);
      }
    } catch (err) {
      console.error('Error saving item group:', err);
      notify.error(`The group was not saved. ${NETWORK_ERROR}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={() => onClose(false)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold text-foreground">
            {isEditing ? 'Edit Item Group' : 'Add Item Group'}
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-4 py-2">
          <div className="field">
            <label className="field-label mb-1.5 block">Group Name</label>
            <Input
              autoFocus
              placeholder="e.g. Raw Material"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>

          {/* Sigfa's `Main Group  Yes/No`. Ticking it makes this a top of the
              tree, so the Under Group box below goes away -- a group cannot
              be both, and leaving a parent visible invites picking one that
              would then be dropped on save. */}
          <label className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-3 py-2">
            <span className="text-sm font-medium text-foreground">
              Main Group
              <span className="block text-xs font-normal text-muted-foreground">
                A top of the tree, sitting under nothing
              </span>
            </span>
            <input
              type="checkbox"
              className="field-check"
              checked={form.mainGroup}
              onChange={(e) =>
                setForm({ ...form, mainGroup: e.target.checked, underGroup: '' })
              }
            />
          </label>

          {!form.mainGroup && (
            <div className="field">
              <label className="field-label mb-1.5 block">Under Group</label>
              <select
                className="field-select"
                value={form.underGroup}
                onChange={(e) => setForm({ ...form, underGroup: e.target.value })}
              >
                <option value="">Select…</option>
                {parents.map((option) => (
                  <option key={option.code} value={option.code}>
                    {/* Indented by depth, so a child reads as a child. The
                        full path is the title, for the two "Loose" groups
                        that sit under different parents. */}
                    {`${'  '.repeat(option.depth)}${option.name}`}
                  </option>
                ))}
              </select>
              {parents.length === 0 && (
                <p className="field-hint mt-1.5">
                  There is no other group yet — tick Main Group for this one.
                </p>
              )}
            </div>
          )}

          <div className="field">
            <label className="field-label mb-1.5 block">Remark</label>
            <Input
              placeholder="Optional"
              value={form.remark}
              onChange={(e) => setForm({ ...form, remark: e.target.value })}
            />
          </div>
        </div>

        <Notice notice={notice} onClose={notify.clear} className="mb-0" />
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

export default ItemGroupMaster;
