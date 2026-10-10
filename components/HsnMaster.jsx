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

const HsnMaster = ({ open, onClose, selected }) => {
  const [hsnForm, setHsnForm] = useState({
    hsncode: '',
    hsnname: '',
    gst: '',
    gstunit: '',
  });
  const [isEditing, setIsEditing] = useState(false);


  useEffect(() => {
    if (selected) {
      setHsnForm(selected);
      setIsEditing(true);
    }
  }, [selected]);

  useEffect(() => {
    if (!open) {
      setHsnForm({ hsncode: '', hsnname: '', gst: '', gstunit: '' });
      setIsEditing(false);
    }
  }, [open]);

  const handleSaveHsn = async () => {
    if (!hsnForm.hsncode || !hsnForm.hsnname || hsnForm.gst === '') {
      alert('Please fill HSN Code, HSN Name and GST %');
      return;
    }

    const endpoint = isEditing ? '/api/hsn-update' : '/api/hsn-add';
    console.log("looser",hsnForm)
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(hsnForm),
    });
    const result = await res.json();
    if (result.success) {
      setHsnForm({ hsncode: '', hsnname: '', gst: '', gstunit: '' });
      setIsEditing(false);
      onClose(true);
    } else {
      alert(result.error || result.message || 'Could not save HSN');
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
          <div className="field">
            <label className="field-label mb-1.5 block">GST Unit</label>
            <Input
              placeholder="Enter Gst Unit"
              value={hsnForm.gstunit}
              onChange={(e) =>
                setHsnForm({ ...hsnForm, gstunit: e.target.value })
              }
            />
          </div>
        </div>

        <Button
          onClick={handleSaveHsn}
          className="w-full"
        >
          {isEditing ? 'Update HSN' : 'Save HSN'}
        </Button>
      </DialogContent>
    </Dialog>
  );
};

export default HsnMaster;
