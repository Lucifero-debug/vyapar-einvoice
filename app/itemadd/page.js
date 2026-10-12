'use client'
import React, { useEffect, useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
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

const PageContent = () => {
  const searchParams = useSearchParams();
  const value = searchParams.get('value'); // `value` = item ID for edit mode

  const [hsn, setHsn] = useState('')
  const [name, setName] = useState('')
  const [short, setShort] = useState('')
  const [group, setGroup] = useState('')
  const [openBal, setOpenBal] = useState('')
  const [minBal, setMinBal] = useState('')
  const [lastBal, setLastBal] = useState('')
  const [cost, setCost] = useState('')
  const [unit, setUnit] = useState(0)
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
          setLastBal(data.lastQuantity ?? '')
          setCost(data.cost ?? '')
          setUnit(data.unit || 0)
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
        })
        .catch(error => console.error('Error fetching item data:', error));
    }
  }, [value]);

  // 💾 Save (add or alter)
  const handleSave = async () => {
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
      lastBal: numOrNull(lastBal),
      id,
    };

    const endpoint = value ? '/api/item-alter' : '/api/item-add';

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(itemData),
      });

      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

      const result = await response.json();
      console.log('Success:', result);
      alert(`Item ${value ? 'updated' : 'added'} successfully!`);
    } catch (error) {
      console.error('Save error:', error);
      alert('Failed to save item data.');
    }
  };

  return (
    <div className="page-shell">
      {/* Sigfa's Create [Alt+A] / Alter [Alt+M] / Delete [Alt+D], acting on
          whichever master is behind the focused field -- the HSN box and the
          Group box here. The HSN master is already in memory for the
          dropdown, so Alt+M on it costs no request. */}
      <MasterShortcuts
        lists={{ hsn: hsnList }}
        onChanged={({ kind }) => {
          // A created or renamed HSN has to appear in the dropdown, or the
          // form goes on offering the old list.
          if (kind === 'hsn') {
            fetch('/api/get-hsn')
              .then((r) => r.json())
              .then((d) => setHsnList(d.hsn || []))
              .catch(() => {});
          }
        }}
      />
      <header className="page-header">
        <div>
          <h1 className="page-title">Item</h1>
          <p className="page-subtitle">Item details, HSN and stock.</p>
        </div>
      </header>
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
                  <InputField label="Group" value={group} onChange={setGroup} masterField="itemGroup" />

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
                      }}
                    >
                      <option value="">Select HSN</option>
                      {hsnList.map((item) => (
                        <option key={item._id} value={item.hsncode}>{item.hsncode}</option>
                      ))}
                    </select>
                  </div>

                  <InputField label="Unit" value={unit} onChange={setUnit} />

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
                <Button onClick={handleSave}>Save</Button>
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
                  </div>
       
                  <div className="space-y-1">
                    <Label>Last Year Stock</Label>
                    <Input type="number" onChange={e => setLastBal(e.target.value)} value={lastBal} />
                  </div>

                  <div className="space-y-1">
                    <Label>Minimum Stock</Label>
                    <Input type="number" onChange={e => setMinBal(e.target.value)} value={minBal} />
                    {/* Left blank on purpose by default: an item with no
                        minimum is not compared against a made-up one. It is
                        still flagged when it runs out. */}
                    <p className="field-hint">
                      Leave blank and this item is only flagged when it runs out.
                    </p>
                  </div>
                </div>
              </CardContent>
              <CardFooter className="justify-end px-0 pb-0">
                <Button onClick={handleSave}>Save</Button>
              </CardFooter>
            </Card>
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
};

// 🔧 Reusable input field component
const InputField = ({ label, value, onChange, type = "text", readOnly = false, masterField }) => (
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
  </div>
);

const page = () => (
  <Suspense fallback={<div className="page-shell text-sm text-muted-foreground">Loading...</div>}>
    <PageContent />
  </Suspense>
);

export default page;
