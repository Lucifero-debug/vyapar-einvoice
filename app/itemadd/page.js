'use client'
import React, { useCallback, useEffect, useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { formatQuantity, stockOf } from '@/lib/itemStock.mjs'
import { Button } from '../../components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../../components/ui/card'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '../../components/ui/tabs'
import { UQC_CODES, UQC_DEFAULT, normalizeUqc } from '@/lib/uqc.mjs'
import MasterShortcuts from '@/components/masters/MasterShortcuts'
import { Notice, useNotice } from '@/components/ui/notice';
import { NETWORK_ERROR, readResponse } from '@/lib/apiResponse.mjs';
import { levelProblem } from '@/lib/inventory.mjs';
import { itemGroupOptions } from '@/lib/itemGroups.mjs';

const PageContent = () => {
  const searchParams = useSearchParams();
  const value = searchParams.get('value'); // `value` = item ID for edit mode

  const [hsn, setHsn] = useState('')
  const [name, setName] = useState('')
  const [short, setShort] = useState('')
  const [group, setGroup] = useState('')
  const [openBal, setOpenBal] = useState('')
  const [minBal, setMinBal] = useState('')
  // Sigfa's other two levels (ITMAST's ORDLVL and MAXLVL). Blank means not
  // set, exactly like the minimum.
  const [reorderBal, setReorderBal] = useState('')
  const [maxBal, setMaxBal] = useState('')
  const [lastBal, setLastBal] = useState('')
  // Read-only: what is on the shelf now. Shown when editing an item.
  const [currentStock, setCurrentStock] = useState('')
  const [cost, setCost] = useState('')
  // Free text ("pcs", "mtr", "bori"), and empty until something fills it --
  // normally the HSN. It was `0`, which put a literal zero in a text box and
  // saved "0" as the unit of every item nobody retyped.
  const [unit, setUnit] = useState('')
  // The code the IRP accepts, which is NOT the free-text unit above and is
  // deliberately not guessed from it. lib/uqc.mjs.
  const [uqc, setUqc] = useState(UQC_DEFAULT)
  const [isService, setIsService] = useState(false)
  const [salePrice, setSalePrice] = useState('')
  const [itemType, setItemType] = useState('')
  const [weight, setWeight] = useState('')
  const [mrp, setMrp] = useState('')
  const [purchasePrice, setPurchasePrice] = useState('')
  const [gst, setGst] = useState('')
  const [discount, setDiscount] = useState('')
  const [id, setId] = useState('')
  const [hsnList, setHsnList] = useState([])
  // Sigfa's Item Group master. Its OWN list -- /api/get-group is the accounts
  // groups, which this box used to read, so "Sundry Debtors" was offered as
  // a category of goods. lib/itemGroups.mjs records the split.
  const [groupList, setGroupList] = useState([])
  const [notice, notify] = useNotice()
  const [saving, setSaving] = useState(false)

  // 🔄 Fetch HSN list
  useEffect(() => {
    const fetchHsn = async () => {
      try {
        const res = await fetch('/api/get-hsn');
        const data = await res.json();
        setHsnList(data.hsn || []);
      } catch (error) {
        console.error('Failed to fetch HSN:', error);
      }
    }
    fetchHsn();
  }, []);

  // 🔄 Fetch the ITEM groups -- /api/get-item-group, not /api/get-group,
  // which is the accounts groups a party belongs to.
  const fetchGroups = useCallback(async () => {
    try {
      const res = await fetch('/api/get-item-group');
      const data = await res.json();
      setGroupList(data.itemGroup || []);
    } catch (error) {
      console.error('Failed to fetch item groups:', error);
    }
  }, []);

  useEffect(() => {
    fetchGroups();
  }, [fetchGroups]);

  // ✏️ If editing existing item
  useEffect(() => {
    if (value) {
      fetch('/api/item', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      })
        .then(response => response.json())
        .then(res => {
          const data = res.final;
          setHsn(data.hsn || '')
          setName(data.name || '')
          setShort(data.short || '')
          setGroup(data.group || '')
          setOpenBal(data.openingQuantity ?? '')
          setMinBal(data.minQuantity ?? '')
          setReorderBal(data.reorderLevel ?? '')
          setMaxBal(data.maxLevel ?? '')
          setLastBal(data.lastQuantity ?? '')
          setCost(data.cost ?? '')
          setUnit(data.unit || '')
          setUqc(normalizeUqc(data.uqc) || UQC_DEFAULT)
          setIsService(Boolean(data.isService))
          setSalePrice(data.salePrice ?? '')
          setItemType(data.itemType || '')
          setWeight(data.weight ?? '')
          setMrp(data.mrp ?? '')
          setPurchasePrice(data.purchasePrice ?? '')
          setGst(data.gst ?? '')
          setDiscount(data.discount ?? '')
          setId(data._id)
          // Current stock, from the same summed stock ledger the dashboard,
          // the billing screens and the stock reports use -- never from
          // "Last Year Stock", which is a hand-typed figure nothing updates.
          fetch('/api/item-stock')
            .then((r) => r.json())
            .then((body) => {
              const entry = stockOf(body.stock || [], data.name)
              setCurrentStock(entry ? formatQuantity(entry.quantity, entry.unit) : '0')
            })
            .catch(() => setCurrentStock(''))
        })
        .catch(error => {
          console.error('Error fetching item data:', error);
          notify.error('Could not load this item. Reload the page to try again.');
        });
    }
  }, [value, notify]);

  // 💾 Save (add or alter)
  const handleSave = async () => {
    if (saving) return;
    // Blank means "not set", and must stay that way: sending 0 is what put a
    // zero price on every item nobody had got round to pricing. The schema
    // keeps these as Numbers -- every calculation in the app multiplies them.
    const numOrNull = (v) => {
      if (v === '' || v === null || v === undefined) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    const itemData = {
      name,
      group,
      hsn,
      cost: numOrNull(cost),
      short,
      unit,
      uqc,
      isService,
      salePrice: numOrNull(salePrice),
      itemType,
      weight: numOrNull(weight),
      mrp: numOrNull(mrp),
      purchasePrice: numOrNull(purchasePrice),
      gst: numOrNull(gst),
      discount: numOrNull(discount),
      openBal: numOrNull(openBal),
      minBal: numOrNull(minBal),
      reorderBal: numOrNull(reorderBal),
      maxBal: numOrNull(maxBal),
      lastBal: numOrNull(lastBal),
      id,
    };

    // A maximum under a minimum is the two boxes swapped, and saving it would
    // make the Short List report an item as both. lib/inventory.mjs holds the
    // rule so the form and the report agree.
    const levels = levelProblem({
      minQuantity: itemData.minBal,
      reorderLevel: itemData.reorderBal,
      maxLevel: itemData.maxBal,
    });
    if (levels) {
      notify.error(levels);
      return;
    }

    const endpoint = value ? '/api/item-alter' : '/api/item-add';

    setSaving(true);
    notify.clear();
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(itemData),
      });

      // The route's own reason (a duplicate name, a blank field) is shown;
      // it used to be thrown away for "Failed to save item data."
      const { ok, message } = await readResponse(response);
      if (!ok) {
        notify.error(`The item was not saved. ${message}`);
        return;
      }
      notify.success(`Item ${value ? 'updated' : 'added'}.`);
    } catch (error) {
      console.error('Save error:', error);
      notify.error(`The item was not saved. ${NETWORK_ERROR}`);
    } finally {
      setSaving(false);
    }
  };

  // The groups this box may offer, as a tree: a child indented under its
  // parent rather than wherever the alphabet puts it. lib/itemGroups.mjs owns
  // that ordering, so the master screen's picker and this one agree.
  const groupOptions = itemGroupOptions(groupList)
  // An item filed under a group the master no longer holds would otherwise
  // show a BLANK -- and because onChange never fires for an option that is
  // not there, it would look cleared while still being saved that way. Kept
  // as an option of its own instead, the same as the Series box on a bill.
  const groupChoices =
    group && !groupOptions.some((o) => o.name.toLowerCase() === group.trim().toLowerCase())
      ? [...groupOptions, { code: group, name: group, depth: 0, path: group }]
      : groupOptions

  // What the chosen HSN says the unit is. The HSN master carries a GST Unit
  // beside the rate, so an item's unit is filled from there rather than
  // retyped per item -- which is how two items on one HSN ended up as "pcs"
  // and "Pcs" and printed differently on the same bill.
  //
  // Only a HINT here, not a lock. The rate is read-only because the rate
  // legally follows the HSN; a unit does not. One HSN can be sold loose and
  // by the box, so the box stays typable and keeps whatever is in it.
  const unitFromHsn = (hsnList.find((h) => h.hsncode === hsn)?.gstunit || '').trim()

  return (
    <div className="page-shell">
      {/* Sigfa's Create [Alt+A] / Alter [Alt+M] / Delete [Alt+D], acting on
          whichever master is behind the focused field -- the HSN box and the
          Group box here. The HSN master is already in memory for the
          dropdown, so Alt+M on it costs no request. */}
      <MasterShortcuts
        lists={{ hsn: hsnList, itemGroup: groupList }}
        onChanged={({ kind }) => {
          // A created or renamed record has to appear in its dropdown, or the
          // form goes on offering the old list.
          if (kind === 'hsn') {
            fetch('/api/get-hsn')
              .then((r) => r.json())
              .then((d) => setHsnList(d.hsn || []))
              .catch(() => {});
          }
          if (kind === 'itemGroup') fetchGroups();
        }}
      />
      <header className="page-header">
        <div>
          <h1 className="page-title">Item</h1>
          <p className="page-subtitle">Item details, HSN and stock.</p>
        </div>
      </header>
      <Notice notice={notice} onClose={notify.clear} />
      <Tabs defaultValue="account" className="panel flex w-full flex-col overflow-hidden md:flex-row">
        {/* LEFT SIDE (Tabs List) */}
        <TabsList className="flex h-auto w-full shrink-0 flex-row gap-1 overflow-x-auto rounded-none border-b border-border bg-transparent p-2 md:w-[210px] md:flex-col md:border-b-0 md:border-r">
          <TabsTrigger
            value="account"
        className="flex-1 justify-center whitespace-nowrap rounded-lg px-4 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground data-[state=active]:bg-accent data-[state=active]:text-accent-foreground data-[state=active]:shadow-none md:w-full md:flex-none md:justify-start"
      >
            Standard
          </TabsTrigger>
          <TabsTrigger
            value="password"
        className="flex-1 justify-center whitespace-nowrap rounded-lg px-4 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground data-[state=active]:bg-accent data-[state=active]:text-accent-foreground data-[state=active]:shadow-none md:w-full md:flex-none md:justify-start"
      >
            Advance
          </TabsTrigger>
        </TabsList>

        {/* RIGHT SIDE (Tab Content) */}
        <div className="flex-1 overflow-auto p-4 md:p-6">
          {/* Standard */}
          <TabsContent value="account" className="h-full">
            <Card className="border-0 shadow-none">
              <CardHeader className="px-0 pt-0">
                <CardTitle>Standard</CardTitle>
                <CardDescription>Basic details of the item.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 px-0">
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                  <InputField label="Name" value={name} onChange={setName} />
                  <InputField label="Short Name" value={short} onChange={setShort} />
                  <div className="space-y-1">
                    <Label htmlFor="group">Group</Label>
                    <select
                      id="group"
                      className="field-select"
                      /* Sigfa's Alt+A / Alt+M / Alt+D act on whatever master
                         is behind the focused field. lib/masterActions.mjs
                         maps this name to the ITEM group master. */
                      data-master-field="itemGroup"
                      value={group}
                      onChange={(e) => setGroup(e.target.value)}
                    >
                      <option value="">Ungrouped</option>
                      {groupChoices.map((option) => (
                        <option key={option.code} value={option.code}>
                          {`${'  '.repeat(option.depth)}${option.name}`}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-muted-foreground">
                      {groupChoices.length === 0
                        ? 'Alt+A adds one'
                        : 'Set up under Masters › Item Group'}
                    </p>
                  </div>

                  <div className="space-y-1">
                    <Label htmlFor="hsn">HSN Code</Label>
                    <select
                      id="hsn"
                      className="field-select"
                      data-master-field="hsncode"
                      value={hsn}
                      onChange={(e) => {
                        const selectedHsn = hsnList.find(h => h.hsncode === e.target.value);
                        setHsn(selectedHsn?.hsncode || '');
                        setGst(selectedHsn?.gst || 0);
                        // The unit comes down with the rate -- but only when
                        // that HSN actually carries one. An HSN saved before
                        // GST Unit was filled in would otherwise wipe a unit
                        // the item already had.
                        const fromHsn = (selectedHsn?.gstunit || '').trim();
                        if (fromHsn) setUnit(fromHsn);
                      }}
                    >
                      <option value="">Select HSN</option>
                      {hsnList.map((item) => (
                        <option key={item._id} value={item.hsncode}>{item.hsncode}</option>
                      ))}
                    </select>
                  </div>

                  <InputField
                    label="Unit"
                    value={unit}
                    onChange={setUnit}
                    hint={
                      unitFromHsn
                        ? `From HSN ${hsn} — change it here if this item is sold differently`
                        : 'Fill GST Unit on the HSN to have this filled in'
                    }
                  />

                  {/* The unit the IRP accepts. Separate from "Unit" above,
                      which is whatever the shop calls it. */}
                  <div className="space-y-1">
                    <Label htmlFor="uqc">Unit code (GST)</Label>
                    <select
                      id="uqc"
                      className="field-select"
                      value={uqc}
                      onChange={(e) => setUqc(e.target.value)}
                    >
                      {UQC_CODES.map((u) => (
                        <option key={u.code} value={u.code}>
                          {u.code} — {u.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <label className="flex items-center justify-between gap-4 rounded-lg border border-border bg-card px-3 py-2">
                    <span className="text-sm font-medium text-foreground">This is a service</span>
                    <input
                      type="checkbox"
                      className="field-check"
                      checked={isService}
                      onChange={(e) => setIsService(e.target.checked)}
                    />
                  </label>
                  <InputField label="Sale Price" type="number" value={salePrice} onChange={setSalePrice} />
                  <InputField label="Item Type" value={itemType} onChange={setItemType} />
                  <InputField label="MRP" type="number" value={mrp} onChange={setMrp} />
                  <InputField label="Cost" type="number" value={cost} onChange={setCost} />
                  <InputField label="Discount" type="number" value={discount} onChange={setDiscount} />
                  <InputField label="GST%" type="number" value={gst} readOnly />
                </div>
              </CardContent>
              <CardFooter className="justify-end px-0 pb-0">
                <Button onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
              </CardFooter>
            </Card>
          </TabsContent>

          {/* Advance */}
          <TabsContent value="password" className="h-full">
            <Card className="border-0 shadow-none">
              <CardHeader className="px-0 pt-0">
                <CardTitle>Advance</CardTitle>
                <CardDescription>Financial details of the item.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4 px-0">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label>Opening Stock</Label>
                    <Input type="number" onChange={e => setOpenBal(e.target.value)} value={openBal} />
                    {currentStock !== '' && (
                      <p className="field-hint">
                        In stock now: <span className="font-medium">{currentStock}</span> (opening plus
                        every receipt, less every issue)
                      </p>
                    )}
                  </div>
       
                  <div className="space-y-1">
                    <Label>Last Year Stock</Label>
                    <Input type="number" onChange={e => setLastBal(e.target.value)} value={lastBal} />
                  </div>

                  <div className="space-y-1">
                    <Label>Minimum Level</Label>
                    <Input type="number" onChange={e => setMinBal(e.target.value)} value={minBal} />
                    {/* Left blank on purpose by default: an item with no
                        minimum is not compared against a made-up one. It is
                        still flagged when it runs out. */}
                    <p className="field-hint">
                      Leave blank and this item is only flagged when it runs out.
                    </p>
                  </div>

                  <div className="space-y-1">
                    <Label>Re-Order Level</Label>
                    <Input type="number" onChange={e => setReorderBal(e.target.value)} value={reorderBal} />
                    <p className="field-hint">
                      Usually above the minimum — when to order again, not when you have run out.
                    </p>
                  </div>

                  <div className="space-y-1">
                    <Label>Maximum Level</Label>
                    <Input type="number" onChange={e => setMaxBal(e.target.value)} value={maxBal} />
                    <p className="field-hint">
                      Over this and the item shows on the Short List as overstocked.
                    </p>
                  </div>
                </div>
              </CardContent>
              <CardFooter className="justify-end px-0 pb-0">
                <Button onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
              </CardFooter>
            </Card>
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
};

// 🔧 Reusable input field component
const InputField = ({ label, value, onChange, type = "text", readOnly = false, masterField, hint }) => (
  <div className="space-y-1">
    <Label>{label}</Label>
    <Input
      type={type}
      value={value}
      readOnly={readOnly}
      /* Sigfa's Alt+A / Alt+M / Alt+D act on whatever master is behind the
         focused field. lib/masterActions.mjs maps the name to a kind. */
      data-master-field={masterField}
      /* The raw text is kept in state, including "" for an empty box. Coercing
         here with `parseFloat(...) || 0` meant clearing a price snapped it
         straight back to 0, so every unfilled field was saved as a real zero.
         The figures are converted once, on save. */
      onChange={e => onChange(e.target.value)}
    />
    {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
  </div>
);

const page = () => (
  <Suspense fallback={<div className="page-shell text-sm text-muted-foreground">Loading...</div>}>
    <PageContent />
  </Suspense>
);

export default page;
