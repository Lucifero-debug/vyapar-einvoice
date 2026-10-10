'use client'
import React, { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { toDisplay } from '@/lib/balance.mjs'
import { normalizeStateCode } from '@/lib/gst.mjs'
import { Button } from "../../components/ui/button"
import {
  Card, CardContent, CardDescription,
  CardFooter, CardHeader, CardTitle,
} from "../../components/ui/card"
import { Input } from "../../components/ui/input"
import { Label } from "../../components/ui/label"
import {
  Tabs, TabsContent, TabsList, TabsTrigger,
} from "../../components/ui/tabs"

const PageContent = () => {
  const searchParams = useSearchParams();
  const value = searchParams.get('value');

  const [tab, setTab] = useState('account');
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [short, setShort] = useState('');
  const [group, setGroup] = useState('');
  const [groups, setGroups] = useState([]);
  const [states, setStates] = useState([]);
  // Empty, not 0. A box pre-filled with 0 has to be cleared before anything can
  // be typed into it, and here 0 and "nothing entered" mean the same thing: the
  // schema defaults openingBal to 0 and toSigned() already reads a blank as 0.
  const [openBal, setOpenBal] = useState('');
  const [openingMode,setOpeningMode] = useState('')
  const [lastMode,setLastMode] = useState('')
  // Display only: what the books currently say this party owes.
  const [running, setRunning] = useState(null)
  const [lastBal, setLastBal] = useState('');
  const [address, setAddress] = useState('');
  const [pincode, setPincode] = useState('');
  const [phone, setPhone] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [gstIn, setGstIn] = useState('');
  const [stateCode, setStateCode] = useState('');
  const [email, setEmail] = useState('');
  const [aadhar, setAadhar] = useState('');
  const [pan, setPan] = useState('');
  const [dealerType,setDealerType] =useState("")
  const [bank, setBank] = useState('');
  const [interest, setInterest] = useState('');
  const [discount, setDiscount] = useState('');

  // The Group field picks from the master, so the same group is not typed
  // three slightly different ways -- which matters because customers are filed
  // under the group's NAME and invoices resolve their cash and bank accounts
  // by it.
  // The state master carries the GST state code, so picking a state fills the
  // code in rather than leaving somebody to remember that Delhi is 07.
  useEffect(() => {
    fetch('/api/get-state')
      .then((res) => res.json())
      .then((data) => setStates(data.state || []))
      .catch((err) => console.error('Error fetching states:', err));
  }, []);

  useEffect(() => {
    fetch('/api/get-group')
      .then((res) => res.json())
      .then((data) => setGroups(data.group || []))
      .catch((err) => console.error('Error fetching customer groups:', err));
  }, []);

  useEffect(() => {
    if (value) {
      fetch('/api/customer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      })
        .then(res => res.json())
        .then(data => {
          const d = data.final;
          setId(d._id || '');
          setName(d.name || '');
          setShort(d.short || '');
          setGroup(d.group || '');
          // Stored balances are signed; the form edits magnitude + Dr/Cr.
          const opening  = toDisplay(d.openingBal);
          // The editable field is last year's closing balance (master data),
          // NOT the live running balance -- loading the latter here is what
          // let an unrelated edit write it straight back and clobber it.
          const lastYear = toDisplay(d.lastYearBal);
          // A party with a zero balance loads a blank box, same as a new one.
          setOpenBal(opening.amount || '');
          setLastBal(lastYear.amount || '');
          setRunning(toDisplay(d.lastBal));
          setAddress(d.address || '');
          setPincode(d.pincode ?? '');
          setPhone(d.phone ?? '');
          setCity(d.city || '');
          setState(d.state || '');
          setGstIn(d.gstIn || '');
          setStateCode(normalizeStateCode(d.stateCode));
          setEmail(d.email || '');
          setAadhar(d.aadhar || '');
          setPan(d.pan || '');
          setBank(d.bank || 0);
          setInterest(d.interest ?? '');
          setDiscount(d.discount ?? '');
          setDealerType(d.dealerType || '')
          setOpeningMode(opening.mode);
          setLastMode(lastYear.mode)
        })
        .catch(error => console.error('Error fetching customer data:', error));
    }
  }, [value]);

  const handleSave = async () => {
    // Blank means "not set". Sending 0 is what gave every party a 0% discount
    // and a 0% interest rate they never asked for. The schema keeps these as
    // Numbers -- a rate is arithmetic, not a label.
    const numOrNull = (v) => {
      if (v === '' || v === null || v === undefined) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    const customerData = {
      id: id || undefined,
      name, short, group, openBal, lastBal, address, pincode, phone,
      city, state, gstIn, stateCode, email, aadhar, pan, bank,
      interest: numOrNull(interest), discount: numOrNull(discount),
      openingMode, lastMode, dealerType
    };

    const endpoint = value ? '/api/customer-alter' : '/api/customer-add';

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(customerData),
      });

      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        // e.g. renaming onto a customer that already exists
        alert(result.error || result.message || 'Failed to save customer data.');
        return;
      }

      alert(`Customer data ${value ? 'updated' : 'saved'} successfully!`);
      console.log(result);
    } catch (error) {
      console.error('Error saving customer data:', error);
      alert('Failed to save customer data.');
    }
  }

  return (
<div className="page-shell">
  <header className="page-header">
    <div>
      <h1 className="page-title">Customer</h1>
      <p className="page-subtitle">Name, balances and address.</p>
    </div>
  </header>
  <Tabs value={tab} onValueChange={setTab} className="panel flex w-full flex-col overflow-hidden md:flex-row">
    {/* Tabs List */}
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
        Address
      </TabsTrigger>
    </TabsList>

    {/* Tab Content */}
    <div className="flex-1 overflow-auto p-4 md:p-6">
      {/* Standard Tab */}
      <TabsContent value="account" className="h-full">
        <Card className="border-0 shadow-none">
          <CardHeader className="px-0 pt-0">
            <CardTitle>Standard</CardTitle>
            <CardDescription>
              {value ? "Update customer details" : "Add new customer"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 px-0">
            <div className="space-y-1">
              <Label htmlFor="name">Name</Label>
              <Input id="name" value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="short">Short Name</Label>
              <Input id="short" value={short} onChange={e => setShort(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="group">Group</Label>
              <select
                id="group"
                className="field-select"
                value={group}
                onChange={e => setGroup(e.target.value)}
              >
                <option value="">Select Group</option>
                {groups.map((g) => (
                  <option value={g.name} key={g._id}>{g.name}</option>
                ))}
                {/* A party saved before the master existed may be in a group
                    that is not on the list. Offer it so opening the form does
                    not silently move them out of it. */}
                {group && !groups.some((g) => g.name === group) && (
                  <option value={group}>{group} (not in master)</option>
                )}
              </select>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Opening Balance</Label>
                <Input type='number' placeholder='0' value={openBal} onChange={e => setOpenBal(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>Dr/Cr</Label>
                    <select
      value={openingMode}
      onChange={(e) => setOpeningMode(e.target.value)}
      className="field-select"
    >
      <option value="">Select</option>
      <option value="Dr">Debit</option>
      <option value="Cr">Credit</option>
    </select>
              </div>
              <div className="space-y-1">
                <Label>Last Year Balance</Label>
                <Input type='number' placeholder='0' value={lastBal} onChange={e => setLastBal(e.target.value)} />
                <p className="field-hint">Reference only. Does not affect the running balance.</p>
              </div>
              <div className="space-y-1">
                <Label>Dr/Cr</Label>
                    <select
      value={lastMode}
      onChange={(e) => setLastMode(e.target.value)}
      className="field-select"
    >
      <option value="">Select</option>
      <option value="Dr">Debit</option>
      <option value="Cr">Credit</option>
    </select>
              </div>
            </div>
          </CardContent>
          <CardFooter className="flex-wrap justify-between gap-3 px-0 pb-0">
            {running ? (
              <div className="text-sm">
                <span className="field-label">Current balance</span>
                <p className="font-semibold tabular-nums text-foreground">
                  {running.amount.toFixed(2)} {running.mode}
                </p>
                <p className="field-hint">Maintained by invoices and vouchers.</p>
              </div>
            ) : (
              <span />
            )}
            <Button onClick={() => setTab('password')}>Next</Button>
          </CardFooter>
        </Card>
      </TabsContent>

      {/* Address Tab */}
      <TabsContent value="password" className="h-full">
        <Card className="border-0 shadow-none">
          <CardHeader className="px-0 pt-0">
            <CardTitle>Address</CardTitle>
            <CardDescription>
              {value ? "Edit address and contact" : "Enter address details"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 px-0">
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              {[
                { label: 'Address', val: address, fn: setAddress, type: 'text' },
                { label: 'Pincode', val: pincode, fn: (v) => setPincode(v.replace(/\D/g, '').slice(0, 6)), type: 'text', inputMode: 'numeric', placeholder: 'e.g. 110076' },
                { label: 'City', val: city, fn: setCity, type: 'text' },
                { label: 'Phone', val: phone, fn: setPhone, type: 'tel', inputMode: 'tel', placeholder: 'e.g. +91 98111 22233' },
                { label: 'GSTIN', val: gstIn, fn: setGstIn, type: 'text' },
                { label: 'State', val: state, fn: setState, type: 'state' },
                { label: 'State Code', val: stateCode, fn: setStateCode, type: 'text', readOnly: true, placeholder: 'from the state' },
                { label: 'Email', val: email, fn: setEmail, type: 'text' },
                { label: 'PAN', val: pan, fn: setPan, type: 'text' },
                { label: 'Aadhar', val: aadhar, fn: setAadhar, type: 'text' },
                { label: 'Bank', val: bank, fn: setBank, type: 'text' },
                { label: 'Discount', val: discount, fn: setDiscount, type: 'text', inputMode: 'decimal', placeholder: '%' },
                { label: 'Interest', val: interest, fn: setInterest, type: 'text', inputMode: 'decimal', placeholder: '%' },
                { label: 'Dealer Type', val: dealerType, fn: setDealerType, type: 'text' },
              ].map((field, idx) => (
                <div className="space-y-1" key={idx}>
                  <Label>{field.label}</Label>
                  {field.type === 'state' ? (
                    <select
                      className="field-select"
                      value={field.val}
                      onChange={e => {
                        const name = e.target.value;
                        setState(name);
                        // The code follows the state. It is read-only beside
                        // this, so the two cannot be set to disagree.
                        const picked = states.find(s => s.name === name);
                        setStateCode(picked ? normalizeStateCode(picked.code) : '');
                      }}
                    >
                      <option value="">Select State</option>
                      {states.map(s => (
                        <option value={s.name} key={s._id}>
                          {normalizeStateCode(s.code)} — {s.name}
                        </option>
                      ))}
                      {/* A party saved before the master existed may hold a
                          state that is not on the list. Offer it rather than
                          silently clearing it. */}
                      {field.val && !states.some(s => s.name === field.val) && (
                        <option value={field.val}>{field.val} (not in master)</option>
                      )}
                    </select>
                  ) : (
                    <Input
                      type={field.type}
                      inputMode={field.inputMode}
                      placeholder={field.placeholder}
                      readOnly={field.readOnly}
                      value={field.val}
                      onChange={e => field.fn(field.type === 'number' ? +e.target.value : e.target.value)}
                    />
                  )}
                </div>
              ))}
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

const Page = () => (
  <Suspense fallback={<div className="page-shell text-sm text-muted-foreground">Loading...</div>}>
    <PageContent />
  </Suspense>
);

export default Page;
