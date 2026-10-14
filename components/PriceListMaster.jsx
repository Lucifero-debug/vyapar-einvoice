'use client';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { netRate } from '@/lib/priceList.mjs';
import ItemSearch from '@/components/billing/ItemSearch';
import { Notice, useNotice } from '@/components/ui/notice';
import { NETWORK_ERROR, readResponse } from '@/lib/apiResponse.mjs';
import { istToday } from '@/lib/istDate.mjs';

// Today in India, not in UTC (which is yesterday until 05:30 IST).
const today = () => istToday();

const BLANK_ROWS = 10;
const emptyRow = () => ({
  key: Math.random().toString(36).slice(2),
  itemId: '', name: '', unit: '', salePrice: '', mrp: '', discount: '',
});

const padRows = (rows) => {
  const out = [...rows];
  while (out.length < BLANK_ROWS) out.push(emptyRow());
  return out;
};

/**
 * A party's price list, entered the way the shop's old software does it: one
 * row per item, with the unit, the rate, the MRP and the discount side by
 * side, and blank rows waiting at the bottom.
 *
 * A blank Sale Price means "bill at the item master's rate", which is not the
 * same as entering 0 (free). The columns here are the ones the stored row
 * actually has -- see models/priceListModel.js and lib/priceList.mjs.
 */
const PriceListMaster = ({ open, onClose, selected }) => {
  const [party, setParty] = useState('');
  const [date, setDate] = useState(today());
  const [remark, setRemark] = useState('');
  const [parties, setParties] = useState([]);
  const [items, setItems] = useState([]);
  const [rows, setRows] = useState(padRows([]));
  const [activeRow, setActiveRow] = useState(0);
  const [saving, setSaving] = useState(false);
  const [notice, notify] = useNotice();
  const isEditing = Boolean(selected?._id);
  const gridRef = useRef(null);

  const itemsByName = useMemo(() => {
    const map = new Map();
    items.forEach((it) => map.set((it.name || '').toLowerCase(), it));
    return map;
  }, [items]);

  useEffect(() => {
    notify.clear();
    if (!open) return;
    Promise.all([fetch('/api/get-item'), fetch('/api/get-customer')])
      .then((responses) => Promise.all(responses.map((res) => res.json())))
      .then(([itemData, custData]) => {
        setItems(itemData.item || []);
        setParties(custData.customer || []);
      })
      .catch((err) => {
        console.error('Error fetching items or parties:', err);
        notify.error('Could not load the items and parties. Close this and open it again.');
      });
  }, [open, notify]);

  useEffect(() => {
    if (!open) return;

    if (!selected) {
      setParty('');
      setDate(today());
      setRemark('');
      setRows(padRows([]));
      setActiveRow(0);
      return;
    }

    setParty(selected.party ? String(selected.party) : '');
    setDate(selected.date ? new Date(selected.date).toISOString().substring(0, 10) : today());
    setRemark(selected.remark || '');
    setRows(padRows((selected.items || []).map((row) => ({
      key: Math.random().toString(36).slice(2),
      itemId: String(row.itemId || ''),
      name: row.name || '',
      unit: row.unit || '',
      // `price` is what the rate was called before the screen grew its columns.
      salePrice: row.salePrice ?? row.price ?? '',
      mrp: row.mrp ?? '',
      discount: row.discount ?? '',
    }))));
    setActiveRow(0);
  }, [open, selected]);

  const setCell = (index, field, value) => {
    setRows((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  };

  /** Picking an item seeds the row from the item master; the user overrides. */
  const chooseItem = (index, typedName) => {
    const match = itemsByName.get(typedName.trim().toLowerCase());
    setRows((prev) => {
      const next = [...prev];
      const row = { ...next[index], name: typedName };

      if (match) {
        row.itemId = match._id;
        row.unit = row.unit || match.unit || '';
        if (row.salePrice === '') row.salePrice = match.salePrice ?? '';
        if (row.mrp === '') row.mrp = match.mrp ?? '';
        if (row.discount === '' && match.discount) row.discount = String(match.discount);
      } else {
        row.itemId = '';
      }

      next[index] = row;
      return next;
    });
  };

  const addRow = useCallback(() => {
    setRows((prev) => {
      setActiveRow(prev.length);
      return [...prev, emptyRow()];
    });
  }, []);

  const deleteRow = useCallback((index) => {
    setRows((prev) => {
      const next = prev.filter((_, i) => i !== index);
      return padRows(next);
    });
  }, []);

  const filledRows = rows.filter((r) => r.itemId);

  const handleSave = useCallback(async () => {
    if (!party || !date) {
      notify.error('Choose a party and a date.');
      return;
    }

    const unmatched = rows.filter((r) => r.name.trim() && !r.itemId);
    if (unmatched.length) {
      notify.error(
        `These item names are not in the item master:\n\n${unmatched
          .map((r) => `• ${r.name}`)
          .join('\n')}\n\nPick them from the list, or add them under Items first.`
      );
      return;
    }

    if (!filledRows.length) {
      notify.error('Add at least one item.');
      return;
    }

    const payload = {
      id: selected?._id,
      party,
      date,
      remark: remark.trim(),
      items: filledRows.map((r) => ({
        itemId: r.itemId,
        name: r.name,
        unit: r.unit,
        salePrice: r.salePrice,
        mrp: r.mrp,
        discount: r.discount,
      })),
    };

    if (saving) return;
    setSaving(true);
    notify.clear();
    try {
      const res = await fetch(isEditing ? '/api/price-list-update' : '/api/price-list-add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const { ok, body: result, message } = await readResponse(res);
      if (ok && result.success) {
        onClose(true);
      } else {
        notify.error(`The price list was not saved. ${message}`);
      }
    } catch (err) {
      console.error('Error saving price list:', err);
      notify.error(`The price list was not saved. ${NETWORK_ERROR}`);
    } finally {
      setSaving(false);
    }
  }, [party, date, remark, rows, filledRows, isEditing, selected, onClose, saving, notify]);

  // The shortcuts printed along the bottom of the old software's screen, kept
  // so the shop's muscle memory carries over.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (!e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 'a') { e.preventDefault(); addRow(); }
      if (key === 's') { e.preventDefault(); handleSave(); }
      if (key === 'e') { e.preventDefault(); deleteRow(activeRow); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, addRow, deleteRow, handleSave, activeRow]);

  /**
   * Down one row in the same column, like a spreadsheet.
   *
   * Split out of the key handler because the item cell is a combobox now:
   * it swallows Enter unconditionally (a bare Enter must never submit) and
   * hands it back through `onEnter`, so it needs the move without the event.
   */
  const moveDown = (index, field) => {
    if (index === rows.length - 1) addRow();
    requestAnimationFrame(() => {
      gridRef.current?.querySelector(`[data-cell="${index + 1}:${field}"]`)?.focus();
    });
  };

  /** Enter moves down the same column, like a spreadsheet. */
  const onCellKeyDown = (e, index, field) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    moveDown(index, field);
  };

  return (
    <Dialog open={open} onOpenChange={() => onClose(false)}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle className="text-lg font-semibold text-foreground">
            {isEditing ? 'Edit Price List' : 'Price List'}
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-4 py-1 sm:grid-cols-3">
          <div className="field sm:col-span-2">
            <label className="field-label mb-1.5 block">Party</label>
            <select
              className="field-select w-full"
              value={party}
              onChange={(e) => setParty(e.target.value)}
            >
              <option value="">Select Party</option>
              {parties.map((p) => (
                <option value={p._id} key={p._id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field-label mb-1.5 block">Entry Date</label>
            <input
              type="date"
              className="field-input w-full"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="field sm:col-span-3">
            <label className="field-label mb-1.5 block">Remarks</label>
            <input
              className="field-input w-full"
              placeholder="Optional note"
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
            />
          </div>
        </div>

        <div className="table-wrap max-h-[48vh] overflow-auto" ref={gridRef}>
          <table className="data-table text-sm">
            <thead>
              <tr>
                <th className="w-12 text-center">S.No.</th>
                <th className="min-w-[14rem]">Item Name</th>
                <th className="w-24">Unit</th>
                <th className="w-28 text-right">Sale Price</th>
                <th className="w-28 text-right">MRP</th>
                <th className="w-24 text-right">Discount %</th>
                <th className="w-28 text-right">Net Rate</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const priced = row.salePrice !== '';
                const net = netRate(row.salePrice, row.discount);
                return (
                  <tr
                    key={row.key}
                    onFocus={() => setActiveRow(i)}
                    className={i === activeRow ? 'bg-accent/40' : undefined}
                  >
                    <td className="num text-center text-muted-foreground">{i + 1}</td>
                    <td>
                      {/* Was an `<input list>` over a `<datalist>`. This
                          screen WRITES to a master, so a name matching
                          nothing was the worst place for it: chooseItem
                          clears itemId and the row saves unlinked. The cell
                          variant portals its list, because this grid is a
                          max-height overflow-auto box that would clip it.

                          `data-cell` is passed through so Enter still walks
                          down the column -- moveDown finds the next cell by
                          that attribute. */}
                      <ItemSearch
                        variant="cell"
                        items={items}
                        label="Item name"
                        placeholder="Type or pick an item"
                        value={row.name}
                        onQueryChange={(text) => chooseItem(i, text)}
                        onPick={(item) => chooseItem(i, item.name)}
                        priceOf={(item) => Number(item.salePrice) || 0}
                        onEnter={() => moveDown(i, 'name')}
                        inputProps={{ 'data-cell': `${i}:name` }}
                        emptyHint=""
                      />
                    </td>
                    <td>
                      <input
                        data-cell={`${i}:unit`}
                        className="field-input field-input-sm w-full"
                        value={row.unit}
                        onChange={(e) => setCell(i, 'unit', e.target.value)}
                        onKeyDown={(e) => onCellKeyDown(e, i, 'unit')}
                      />
                    </td>
                    {['salePrice', 'mrp', 'discount'].map((field) => (
                      <td key={field}>
                        <input
                          type="number"
                          min="0"
                          max={field === 'discount' ? '100' : undefined}
                          step="0.01"
                          data-cell={`${i}:${field}`}
                          className="field-input field-input-sm num w-full text-right"
                          placeholder={field === 'salePrice' ? 'master' : '—'}
                          value={row[field]}
                          onChange={(e) => setCell(i, field, e.target.value)}
                          onKeyDown={(e) => onCellKeyDown(e, i, field)}
                        />
                      </td>
                    ))}
                    <td className="num text-right font-medium">
                      {row.itemId && priced ? net.toFixed(2) : ''}
                    </td>
                    <td className="text-center">
                      {row.itemId && (
                        <button
                          type="button"
                          title="Delete item (Alt+E)"
                          className="text-destructive hover:opacity-70"
                          onClick={() => deleteRow(i)}
                        >
                          ×
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <Notice notice={notice} onClose={notify.clear} className='mb-0' />
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <p className="text-xs text-muted-foreground">
            {filledRows.length} item{filledRows.length === 1 ? '' : 's'}. A blank Sale Price
            bills at the item master rate; 0 means free.
          </p>
          <div className="flex items-center gap-2">
            <button type="button" className="btn btn-secondary btn-sm" onClick={addRow}>
              Add New <span className="ml-1 opacity-60">Alt+A</span>
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => onClose(false)}>
              Exit
            </button>
            <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save'} <span className="ml-1 opacity-60">Alt+S</span>
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default PriceListMaster;
