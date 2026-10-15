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
import { Notice, useNotice } from '@/components/ui/notice';
import { NETWORK_ERROR, readResponse } from '@/lib/apiResponse.mjs';

const HsnMaster = ({ open, onClose, selected }) => {
  const [hsnForm, setHsnForm] = useState({
    hsncode: '',
    hsnname: '',
    gst: '',
    gstunit: '',
  });
  const [isEditing, setIsEditing] = useState(false);
  const [notice, notify] = useNotice();
  const [saving, setSaving] = useState(false);


  useEffect(() => {
    if (selected) {
      setHsnForm(selected);
      setIsEditing(true);
    }
  }, [selected]);

  useEffect(() => {
    notify.clear();
    if (!open) {
      setHsnForm({ hsncode: '', hsnname: '', gst: '', gstunit: '' });
      setIsEditing(false);
    }
  }, [open, notify]);

  const handleSaveHsn = async () => {
    if (!hsnForm.hsncode || !hsnForm.hsnname || hsnForm.gst === '') {
      notify.error('Fill in the HSN code, the HSN name and the GST %.');
      return;
    }
    if (saving) return;

    const endpoint = isEditing ? '/api/hsn-update' : '/api/hsn-add';
    // There was no try/catch here: a dropped connection rejected silently and
    // the button simply did nothing.
    setSaving(true);
    notify.clear();
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hsnForm),
      });
      const { ok, body: result, message } = await readResponse(res);
      if (ok && result.success) {
        setHsnForm({ hsncode: '', hsnname: '', gst: '', gstunit: '' });
        setIsEditing(false);
        onClose(true);
      } else {
        notify.error(`The HSN code was not saved. ${message}`);
      }
    } catch (err) {
      console.error('Error saving HSN:', err);
      notify.error(`The HSN code was not saved. ${NETWORK_ERROR}`);
    } finally {
      setSaving(false);
    }
  };


  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold text-foreground">
            {isEditing ? 'Edit HSN Code' : 'Add New HSN'}
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-4 py-2 sm:grid-cols-2">
          <div className="field">
            <label className="field-label mb-1.5 block">HSN Code</label>
            <Input
              type="number"
              placeholder="Enter HSN Code"
              value={hsnForm.hsncode}
              onChange={(e) =>
                setHsnForm({ ...hsnForm, hsncode: e.target.value })
              }
            />
          </div>
          <div className="field">
            <label className="field-label mb-1.5 block">HSN Name</label>
            <Input
              placeholder="Enter Group"
              value={hsnForm.hsnname}
              onChange={(e) =>
                setHsnForm({ ...hsnForm, hsnname: e.target.value })
              }
            />
          </div>
          <div className="field">
            <label className="field-label mb-1.5 block">GST (%)</label>
            <Input
              placeholder="Enter GST %"
              type="number"
              value={hsnForm.gst}
              onChange={(e) =>
                setHsnForm({ ...hsnForm, gst: e.target.value })
              }
            />
          </div>
          {/* Named "Unit" to match the quick form (lib/masterActions.mjs) and
              the box it fills: picking this HSN on an item puts this into the
              item's Unit. Free text, like that one -- it is what the shop
              calls the unit, not the IRP's code, which lives on the item as
              its own field. See lib/uqc.mjs. */}
          <div className="field">
            <label className="field-label mb-1.5 block">Unit</label>
            <Input
              placeholder="pcs, mtr, bori…"
              value={hsnForm.gstunit}
              onChange={(e) =>
                setHsnForm({ ...hsnForm, gstunit: e.target.value })
              }
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Items on this HSN take this as their unit.
            </p>
          </div>
        </div>

        <Notice notice={notice} onClose={notify.clear} className='mb-0' />
        <Button
          onClick={handleSaveHsn}
          className="w-full"
          disabled={saving}
        >
          {saving ? 'Saving…' : isEditing ? 'Update HSN' : 'Save HSN'}
        </Button>
      </DialogContent>
    </Dialog>
  );
};

export default HsnMaster;
