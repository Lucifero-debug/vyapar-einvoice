'use client'
import { useRouter, useSearchParams} from 'next/navigation'
import React, { Suspense, useEffect, useState } from 'react'
import AddIcon from '@mui/icons-material/Add';
import { saveToLocal, getFromLocal, clearInvoiceDraft } from '@/lib/localStorageHelper'
import InvoiceSearchParams from '@/components/suspense';
import { useSaleOptions } from '@/context/SaleOptionContext';
import { resolveItemPricing, latestPriceListFor } from '@/lib/priceList.mjs';
import { placeOfSupply, placeOfSupplyLabel } from '@/lib/buyerSnapshot.mjs';
import PartyBalance from '@/components/PartyBalance';
import ItemStock from '@/components/ItemStock';
import EinvoiceLockNotice from '@/components/EinvoiceLockNotice';
import { editBlockedReason } from '@/lib/einvoiceLock.mjs';

export const dynamic = 'force-dynamic';

const page = () => {
    const router = useRouter()

   const [value, setValue] = useState('');
   const [hsnTotals, setHsnTotals] = useState({});
   const [isValueReady,setIsValueReady]=useState(false)
   // What the IRP holds against the invoice being edited, if anything.
   // Null on a new bill, which is why a new bill is never locked.
   const [einvoice, setEinvoice] = useState(null);
     const { options } = useSaleOptions();
     const [showShippedPopup, setShowShippedPopup] = useState(false);
const [shippedTo, setShippedTo] = useState('');
const [hsn,setHsn]=useState('')
const [transport, setTransport] = useState('');
const [grNo, setGrNo] = useState('');
const [orderNo, setOrderNo] = useState('');
const [orderDate, setOrderDate] = useState('');
const [grDate, setGrDate] = useState('');
const [pvtMark, setPvtMark] = useState('');
const [caseDetails, setCaseDetails] = useState('');
const [freight, setFreight] = useState('');
const [weight, setWeight] = useState(0);
const [ewayBillNo, setEwayBillNo] = useState('');
const [ewayBillDate, setEwayBillDate] = useState('');
const [showDispatchPopup, setShowDispatchPopup] = useState(false);
const [dispatchFrom, setDispatchFrom] = useState('');
const [quantityPerPack, setQuantityPerPack] = useState(0);
const [noOfPack, setNoOfPack] = useState(0);
      const [showDescPopup, setShowDescPopup] = useState(false);
      const [showQuantityPack, setShowQuantityPack] = useState(false);
  const [descriptionText, setDescriptionText] = useState('');
    const [invoiceNo, setInvoiceNo] = useState(4)
    const [date, setDate] = useState(new Date().toISOString().substring(0, 10))
    const [customer, setCustomer] = useState([])
    const [customerLoaded, setCustomerLoaded] = useState(false)
    const [selectedCustomer, setSelectedCustomer] = useState({})
    const [phone, setPhone] = useState('')
    const [totalAmount, setTotalAmount] = useState(0)
    const [finalAmount, setFinalAmount] = useState(0)
    const [received, setReceived] = useState(0)
    const [balanceDue, setBalanceDue] = useState(0)
    const [paymentType, setPaymentType] = useState('Cash')
    const [newTaxAmount, setNewTaxAmount] = useState('')
    const [stateOfSupply, setStateOfSupply] = useState('')
    const [states, setStates] = useState([])
    const [item, setItem] = useState([])
    const [gst, setGst] = useState(0)
    const [selectedItem, setSelectedItem] = useState([])
    const [itemName, setItemName] = useState('')
    const [stock, setStock] = useState([])
    const [quantity, setQuantity] = useState('')
    const [rate, setRate] = useState('')
    const [discount, setDiscount] = useState(0)
    const [taxType, setTaxType] = useState('local')
    const [id, setId] = useState('')
    
    const [partyTaxes, setPartyTaxes] = useState([])
    const [newTaxName, setNewTaxName] = useState('')
    const [newTaxRate, setNewTaxRate] = useState('')
    const [priceLists, setPriceLists] = useState([])

    // The state master carries the GST state code. The invoice stores both,
    // so the bill can print the code without looking it up again.
    useEffect(() => {
        fetch('/api/get-state')
            .then((res) => res.json())
            .then((data) => setStates(data.state || []))
            .catch((err) => console.error('Error fetching states:', err));
    }, []);

    const formatDate = (dateString) => {
        return new Date(dateString).toISOString().substring(0, 10)
    }

    // ─── Helper: rebuild HSN totals from an items array ───────────────────────
    const buildHsnTotals = (items) => {
        const grouped = {};
        items.forEach(item => {
            const hsn = item.hsn || 'N/A';
            if (!grouped[hsn]) {
                grouped[hsn] = { gstRate: item.gstRate, gstAmount: 0, total: 0 };
            }
            grouped[hsn].gstAmount += Number(item.gstAmount) || 0;
            grouped[hsn].total     += Number(item.total)     || 0;
        });
        return grouped;
    };

    // ─── Helper: recalculate a single item's derived fields ───────────────────
    const recalcItem = (item) => {
        // FIX 1: always prefer item.cost over item.salePrice so edited values are respected
        const cost        = Number(item.cost || item.salePrice || 0);
        const qty         = Number(item.quantity) || 0;
        const discountPct = Number(item.discount)  || 0;
        const gstRate     = Number(item.gstRate)   || 0;

        const baseAmount      = cost * qty;
        const discountAmount  = (baseAmount * discountPct) / 100;
        const taxableAmount   = baseAmount - discountAmount;
        const gstAmount       = (taxableAmount * gstRate) / 100;
        const total           = taxableAmount + gstAmount;

        return { ...item, cost, taxableAmount, gstAmount, total };
    };


useEffect(() => {
  if (value) return;

  let cancelled = false;

  const fetchInvoiceNo = async () => {
    try {
      const response = await fetch('/api/next-invoice-no');
      const data = await response.json();
      if (!cancelled && data.invoiceNo) {
        setInvoiceNo(data.invoiceNo);
        console.log("✅ New Invoice:", data.invoiceNo);
        localStorage.setItem('invoiceNo', data.invoiceNo);
      }
    } catch (err) {
      console.error('Failed to fetch invoice number:', err);
    }
  };

  fetchInvoiceNo();

  return () => {
    cancelled = true;
  };
}, [isValueReady, value]);


    // Load existing invoice data if value parameter exists
    useEffect(() => {
        if (value) {
            fetch('/api/invoice', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ value }),
            })
            .then(res => res.json())
            .then(res => {
                const data = res.final;
                console.log("transformer", data)

                const normalizedItems = (data.items || []).map((item) => {
                    const cost      = Number(item.cost || item.salePrice || 0);
                    const quantity  = Number(item.quantity || 0);
                    const discount  = Number(item.discount || 0);
                    const gstRate   = Number(item.gstRate || item.gst || 0);

                    const baseAmount      = cost * quantity;
                    const discountAmount  = (baseAmount * discount) / 100;
                    const taxableAmount   = item.taxableAmount ?? (baseAmount - discountAmount);
                    const gstAmount       = item.gstAmount     ?? (taxableAmount * gstRate) / 100;
                    const total           = item.total         ?? (taxableAmount + gstAmount);

                    return { ...item, cost, gstRate, taxableAmount, gstAmount, total };
                });

                setGst(data.gst || normalizedItems.reduce((sum, i) => sum + (i.gstAmount || 0), 0));
                setInvoiceNo(data.invoiceNo || 4);
                setDate(data.date ? formatDate(data.date) : new Date().toISOString().substring(0, 10));
                setId(data._id);
                // Carried on the invoice itself, so an edit opened from
                // any list knows straight away that it is read only.
                setEinvoice({
                    invoiceNo:       data.invoiceNo,
                    irn:             data.irn,
                    ackNo:           data.ackNo,
                    ackDt:           data.ackDt,
                    einvoiceStatus:  data.einvoiceStatus,
                });
                setSelectedCustomer(data.customer || {});
                setPhone(data.customer?.phone || '');
                setTotalAmount(data.totalAmount || 0);
                setReceived(data.received || 0);
                setBalanceDue(data.balanceDue || '');
                setPaymentType(data.paymentType || 'Cash');
                setStateOfSupply(data.stateOfSupply || '');
                setSelectedItem(normalizedItems);
                setItemName(data.items?.name || '');
                setQuantity(data.items?.quantity || '');
                setRate(data.rate || '');
                setDiscount(data.items?.discount || 0);
                setTaxType(data.taxType || 'local');

                const parsedPartyTaxes =
                    typeof data.partyTaxes === "string"
                        ? JSON.parse(data.partyTaxes || "[]")
                        : (data.partyTaxes || []);

                const normalizedPartyTaxes = parsedPartyTaxes.map((tax) => {
                    const base = (data.items || []).reduce(
                        (sum, item) => sum + Number(item.total || 0),
                        0
                    );
                    const taxRate  = Number(tax.rate || 0);
                    const total    = tax.total ?? (taxRate ? (base * taxRate) / 100 : Number(tax.amount || 0));
                    const amount   = taxRate ? "" : tax.total;

                    return { ...tax, amount, total: Number(total).toFixed(2) };
                });

                setPartyTaxes(normalizedPartyTaxes);

                const hsnTotalsObject = (data.hsnTotals || []).reduce((acc, row) => {
                    acc[row.hsn] = {
                        gstRate:   Number(row.gstRate || 0),
                        gstAmount: Number(row.amount  || 0),
                        total:     Number(row.total   || 0),
                    };
                    return acc;
                }, {});

                setHsnTotals(hsnTotalsObject || {});
                setHsn(data.items?.hsn || '')
                setTransport(data.transport || '');
                setGrNo(data.grNo || '');
                setGrDate(data.grDate ? formatDate(data.grDate) : '');
                setPvtMark(data.pvtMark || '');
                setCaseDetails(data.caseDetails || '');
                setFreight(data.freight || '');
                setOrderNo(data.orderNo || '')
                setOrderDate(data.orderDate ? formatDate(data.orderDate) : '');
                setWeight(data.weight || '');
                setEwayBillNo(data.ewayBillNo || '');
                setEwayBillDate(data.ewayBillDate ? formatDate(data.ewayBillDate) : '');
            })
            .catch(err => console.error('Error:', err));
        }
    }, [value]);

    // Load customer data from localStorage after customers are loaded
    useEffect(() => {
        if (customerLoaded && customer.length > 0) {
            const savedCustomer = getFromLocal('selectedCustomer');
            if (savedCustomer && savedCustomer.id) {
                const match = customer.find((c) => c.id === savedCustomer.id);
                if (match) {
                    setSelectedCustomer(match);
                }
            }
        }
    }, [customerLoaded, customer]);

    // ─── FIX 2: Rebuild HSN totals from selectedItem whenever it changes ──────
    // This replaces the old useEffect that used item.salePrice instead of item.cost
    useEffect(() => {
        const grouped = buildHsnTotals(selectedItem);
        setHsnTotals(grouped);

        const totalGst = selectedItem.reduce((sum, i) => sum + (Number(i.gstAmount) || 0), 0);
        setGst(totalGst);
    }, [selectedItem]);

    // ─── FIX 3: Recalculate rate-based party taxes when items change ──────────
useEffect(() => {
    if (partyTaxes.length === 0) return;

    const base = selectedItem.reduce(
        (sum, i) => sum + Number(i.total || 0),
        0
    );

    let changed = false;

    const updatedTaxes = partyTaxes.map((tax) => {
        if (!tax.rate) return tax;

        const total = ((base * Number(tax.rate)) / 100).toFixed(2);

        if (tax.total !== total) {
            changed = true;
            return {
                ...tax,
                total,
            };
        }

        return tax;
    });

    if (changed) {
        setPartyTaxes(updatedTaxes);
    }
}, [selectedItem]);

const addPartyTax = () => {
  if (!newTaxName || (!newTaxRate && !newTaxAmount)) {
    alert("Enter Tax Name and either Rate or Amount");
    return;
  }

  if (newTaxRate && newTaxAmount) {
    alert("Use either Rate or Amount, not both");
    return;
  }

  // DELIBERATE: overheads are charged AFTER tax, on the GST-inclusive value,
  // and are not themselves taxed. This was reviewed and chosen; it is not an
  // oversight, so please do not "correct" it to a pre-GST base without asking.
  const base = selectedItem.reduce(
    (sum, item) => sum + Number(item.total || 0),
    0
  );

  const taxTotal = newTaxRate
    ? (base * Number(newTaxRate)) / 100
    : Number(newTaxAmount || 0);

  const newTax = {
    name: newTaxName,
    rate: newTaxRate || "",
    amount: newTaxRate ? "" : taxTotal.toFixed(2),
    total: taxTotal.toFixed(2),
  };

  setPartyTaxes((prev) => [...prev, newTax]);

  setNewTaxName("");
  setNewTaxRate("");
  setNewTaxAmount("");
};


    // ─── FIX 4: handleRemove now properly rebuilds HSN totals ─────────────────
    const handleRemove = (indexToRemove) => {
        const updatedItems = selectedItem.filter((_, index) => index !== indexToRemove);
        setSelectedItem(updatedItems);
        // totalAmount, hsnTotals and gst will update via their respective useEffects above
    };

    // Fetch items and customers
    useEffect(() => {
        // Stock is summed from the stock ledger, not read off
        // Item.lastQuantity -- nothing in the posting path maintains that field.
        const fetchStock = async () => {
            try {
                const response = await fetch('/api/item-stock')
                const result = await response.json()
                setStock(result.stock || [])
            } catch (error) {
                // A stock figure is worth having but not worth blocking a bill
                // over, so this one stays quiet and the line simply hides.
                console.error('Error fetching item stock:', error);
            }
        }

        const fetchItem = async () => {
            try {
                const response = await fetch('/api/get-item')
                const result = await response.json()
                setItem(result.item)
                console.log("Fetched Items:", result.item);
            } catch (error) {
                console.error('Error fetching Item data:', error);
                alert('Failed to fetch item.');
            }
        }
        
        const fetchCust = async () => {
            try {
                const response = await fetch('/api/get-customer')
                const result = await response.json()
                setCustomer(result.customer)
                setCustomerLoaded(true);
            } catch (error) {
                console.error('Error fetching Customer data:', error);
                alert('Failed to fetch customer.');
            }
        }
        
        const fetchPriceLists = async () => {
            try {
                const response = await fetch('/api/get-price-list')
                const result = await response.json()
                setPriceLists(result.priceList || [])
            } catch (error) {
                console.error('Error fetching price lists:', error);
            }
        }

        fetchCust()
        fetchItem()
        fetchStock()
        fetchPriceLists()
    }, [])

    // Calculate totals
    useEffect(() => {
        const newTotal = selectedItem.reduce((acc, item) => acc + (parseFloat(item.total) || 0), 0);
        setTotalAmount(newTotal.toFixed(2));
    }, [selectedItem]);

    // GST and Final Amount
    useEffect(() => {
        const baseAmount     = parseFloat(totalAmount) || 0;
        const partyTaxTotal  = partyTaxes.reduce((acc, tax) => acc + parseFloat(tax.total || 0), 0);
        // Freight was collected, stored and printed under Order Details, and
        // then left out of the amount actually charged. Added after tax, the
        // same way overheads are -- see addPartyTax.
        const freightAmount  = parseFloat(freight) || 0;
        const finalAmt       = baseAmount + partyTaxTotal + freightAmount;

        setFinalAmount(finalAmt.toFixed(2));

        const receivedAmt = parseFloat(received) || 0;
        const balance     = parseFloat((finalAmt - receivedAmt).toFixed(2));
        setBalanceDue(balance);
    }, [totalAmount, gst, partyTaxes, received, freight]);

    const handleTaxTypeChange = (e) => {
        setTaxType(e.target.value);
    };

    // ─── Helper: build a new item object from source item + overrides ─────────
    // Rate AND discount for a newly added line. When Setup turns price lists
    // on, the party's latest price list wins where it has a figure, the item
    // master fills the rest. Its three discount columns apply one after
    // another, and reach the line as the single
    // percentage an invoice carries -- see lib/priceList.mjs.
    const defaultPricing = (sourceItem) =>
        resolveItemPricing(
            sourceItem,
            options.usePriceList ? latestPriceListFor(priceLists, selectedCustomer?._id) : null
        );

    const buildNewItem = (sourceItem, overrides = {}) => {
        const merged = { ...sourceItem, ...overrides };
        return recalcItem(merged);
    };

const saveItem = (e) => {
    const selectedName  = e.target.value;
    const selectedItems = item.find((i) => i.name === selectedName);
    if (!selectedItems) return;

    setItemName(selectedName);

    if (options.description) {
        setShowDescPopup(true);
        return;
    }

    if (options.calculateByPack) {
        setShowQuantityPack(true);
        return;
    }

    const newItem = buildNewItem(selectedItems, {
        quantity: Number(quantity || 1),
        cost:     Number(rate || defaultPricing(selectedItems).rate),
        discount: Number(discount || defaultPricing(selectedItems).discount),
        gstRate:  Number(selectedItems.gst || selectedItems.gstRate || 0),
    });

    setSelectedItem(prev => [...prev, newItem]);

    setItemName('');
    setQuantity('');
    setRate('');
    setDiscount(0);
};

   const handleSaveDescription = () => {
    const selectedItems = item.find((i) => i.name === itemName);
    if (!selectedItems) return;

    const newItem = buildNewItem(selectedItems, {
        description: descriptionText,
        quantity:    Number(quantity || 1),
        cost:        Number(rate || defaultPricing(selectedItems).rate),
        discount:    Number(discount || defaultPricing(selectedItems).discount),
        gstRate:     Number(selectedItems.gst || selectedItems.gstRate || 0),
    });

    setSelectedItem(prev => [...prev, newItem]);

    setShowDescPopup(false);
    setItemName('');
    setQuantity('');
    setRate('');
    setDiscount(0);
    setDescriptionText('');
};

   const handleQuantityPackSave = () => {
    const selectedItems = item.find((i) => i.name === itemName);
    if (!selectedItems) return;

    const newItem = buildNewItem(selectedItems, {
        description: descriptionText,
        quantity:    Number(noOfPack) * Number(quantityPerPack),
        cost:        Number(rate || defaultPricing(selectedItems).rate),
        discount:    Number(discount || defaultPricing(selectedItems).discount),
        gstRate:     Number(selectedItems.gst || selectedItems.gstRate || 0),
    });

    setSelectedItem(prev => [...prev, newItem]);

    setShowQuantityPack(false);
    setNoOfPack(0);
    setQuantityPerPack(0);
};

    // Why this invoice may not be saved, or null when it may. Recomputed every
    // render on purpose: the 24-hour cancellation window shuts while the page
    // is open, and the wording has to follow it.
    const einvoiceLock = editBlockedReason(einvoice);

    // The place of supply is the party's own state, taken from their master.
    // It used to be a dropdown picked per bill: one more thing to get right on
    // every invoice, and the state code is what decides CGST+SGST against
    // IGST, so a slip there is not cosmetic. The server derives it again from
    // the master when the invoice is saved -- this is the same rule, so that
    // what is shown here is what gets stored.
    //
    // The fallback is for an invoice saved before the party's master carried a
    // state: it keeps showing whatever that invoice holds.
    const place = placeOfSupply(
        selectedCustomer?.state || selectedCustomer?.stateCode
            ? selectedCustomer
            : { state: stateOfSupply },
        states
    );

    // Save invoice function
    const submitInvoice = async () => {
        // sale-alter refuses this with a 409 as well. Stopping here is so the
        // user is told before retyping a bill, not after.
        if (einvoiceLock) {
            alert(einvoiceLock);
            return;
        }

        const phone            = selectedCustomer.phone;
        const hsnTotalsArray   = Object.entries(hsnTotals).map(([hsn, data]) => ({
            hsn,
            gstRate: data.gstRate,
            amount:  data.gstAmount,
            total:   data.total
        }));

        const invoiceData = {
            invoiceNo,
            // The number the page opened with. It identifies the row on an
            // edit, because invoiceNo itself is editable on this form.
            originalInvoiceNo: value || undefined,
            date,
            customer: {
                name:   selectedCustomer.name,
                phone:  phone,
                email:  selectedCustomer.email,
                custId: selectedCustomer._id
            },
            'return': true,
            paymentType,
            balanceDue,
            stateOfSupply: place.stateOfSupply,
            stateCode: place.stateCode,
            taxType,
            gst,
            totalAmount:  Number(totalAmount),
            finalAmount:  Number(finalAmount),
            received:     Number(received) || 0,
            items:        selectedItem,
            partyTaxes:   partyTaxes,
            shippedTo,
            dispatchFrom,
            type:         "Sale",
            transport,
            grNo,
            grDate,
            pvtMark,
            hsnTotals:    hsnTotalsArray,
            caseDetails,
            freight,
            weight,
            ewayBillNo,
            ewayBillDate,
            orderDate,
            orderNo
        };

        try {
            const apiRoute = value ? '/api/sale-alter' : '/api/save-invoice';
            const response = await fetch(apiRoute, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(invoiceData),
            });

            const result = await response.json();

            if (result.success) {
                setSelectedItem([]);
                setPartyTaxes([]);
                // The server settles the number -- a clash with a concurrent
                // invoice means the one it assigned differs from the one typed.
                const savedNo =
                    result.invoice?.invoiceNo ??
                    result.updatedInvoice?.invoiceNo ??
                    invoiceNo;
                if (savedNo !== invoiceNo) setInvoiceNo(savedNo);

                // Only the number travels. The print page reads the saved
                // invoice back by it, so what gets printed is what was stored.
                // Packing the whole document into the query string put a
                // twenty-line bill past the request-header limit, and printing
                // or reloading it failed.
                router.push(`/invoice?invoiceNo=${savedNo}`);
            } else {
                alert('Failed to save invoice: ' + result.error);
            }
        } catch (err) {
            console.error('Error saving invoice:', err);
            alert('Error saving invoice');
        }
    };

    const handleSave = () => {
        if (options.shipped) {
            setShowShippedPopup(true);
            return;
        }
        if (options.dispatch) {
            setShowDispatchPopup(true);
            return;
        }
        submitInvoice();
    };

const handleShippedSave = () => {
    setShowShippedPopup(false);
    if (options.dispatch) {
        setShowDispatchPopup(true);
    } else {
        submitInvoice();
    }
};

const handleDispatchSave = () => {
    setShowDispatchPopup(false);
    submitInvoice();
};

    // ─── Inline item field change handler (quantity / cost / discount) ────────
    // FIX 5: single handler that always uses recalcItem so all three fields
    //        cascade correctly through taxableAmount → gstAmount → total
    const handleItemFieldChange = (index, field, rawValue) => {
        setSelectedItem(prev =>
            prev.map((item, idx) => {
                if (idx !== index) return item;
                const updated = { ...item, [field]: parseFloat(rawValue) || 0 };
                return recalcItem(updated);
            })
        );
    };

    return (
        <>
            <Suspense fallback={null}>
                <InvoiceSearchParams onValue={setValue} onReady={setIsValueReady} />
            </Suspense>
            <div className='page-shell-wide flex flex-col gap-6'>
                <header className='page-header mb-0'>
                    <div>
                        <h1 className='page-title'>Sale Return</h1>
                        <p className='page-subtitle'>Take goods back from a customer.</p>
                    </div>
                </header>

                {/* Invoice & Date */}
                <div className='panel panel-body flex flex-wrap gap-5'>
                    <div className='field w-40'>
                        <label className='field-label mb-1'>Invoice No</label>
                        <input 
                            type='number' 
                            className='field-input' 
                            value={invoiceNo} 
                            onChange={(e) => setInvoiceNo(e.target.value)} 
                        />
                    </div>
                    <div className='field w-48'>
                        <label className='field-label mb-1'>Date</label>
                        <input 
                            type='date' 
                            className='field-input' 
                            value={date} 
                            onChange={(e) => setDate(e.target.value)} 
                        />
                    </div>
                </div>

                {/* Customer & Item Selection */}
                <div className='panel panel-body grid grid-cols-1 gap-5 sm:grid-cols-2'>
                    {/* Customer Dropdown */}
                    <div className='flex flex-col'>
                        <label className='field-label mb-1'>Customer</label>
                        <select 
                            value={selectedCustomer.name || ''} 
                            onChange={(e) => {
                                const selectedName = e.target.value;
                                const customers = customer.find(cust => cust.name === selectedName);
                                setSelectedCustomer(customers || {});
                            }} 
                            className='field-select'
                        >
                            <option value=''>Select Customer</option>
                            {customer.map((cust) => (
                                <option value={cust.name} key={cust.id}>{cust.name}</option>
                            ))}
                        </select>
                        {/* What this party already owes, read off the master --
                            not off `selectedCustomer`, which is only a snapshot
                            when an existing invoice is being edited. */}
                        <PartyBalance selected={selectedCustomer} customers={customer} />
                    </div>

                    {/* Read only, because it comes from the party's master.
                        Shown rather than hidden so whoever is billing can see
                        what will print, and notice a party who has no state. */}
                    <div className='flex justify-between items-start'>
                        <h2 className='text-sm font-medium text-foreground'>State Of Supply</h2>
                        <div className='w-48 text-right'>
                            <p className='text-sm font-medium tabular-nums text-foreground'>
                                {placeOfSupplyLabel(place) || '—'}
                            </p>
                            {selectedCustomer?.name && !place.stateOfSupply && (
                                <p className='field-hint text-destructive'>
                                    This party has no state on their master.
                                </p>
                            )}
                            {!selectedCustomer?.name && (
                                <p className='field-hint'>From the party's master.</p>
                            )}
                        </div>
                    </div>

                    <div className='flex justify-between items-center'>
                        <div className='flex items-center gap-2'>
                            <label htmlFor='local' className='text-sm font-medium text-foreground'>Local</label>
                            <input 
                                type='radio' 
                                id='local' 
                                name='location' 
                                value='local'
                                className='field-check' 
                                checked={taxType === 'local'} 
                                onChange={handleTaxTypeChange} 
                            />
                        </div>
                        <div className='flex items-center gap-2'>
                            <label htmlFor='central' className='text-sm font-medium text-foreground'>Central</label>
                            <input 
                                type='radio' 
                                id='central' 
                                name='location' 
                                value='central'
                                className='field-check' 
                                checked={taxType === 'central'} 
                                onChange={handleTaxTypeChange} 
                            />
                        </div>
                    </div>

                    {/* Item Dropdown */}
                    <div className='flex flex-col'>
                        <label className='field-label mb-1'>Add Item</label>
                        <select 
                            value={itemName} 
                            onChange={(e) => { 
                                setItemName(e.target.value); 
                                saveItem(e); 
                            }} 
                            className='field-select'
                        >
                            <option value=''>Select an Item</option>
                            {item.map((items) => (
                                <option value={items.name} key={items.id}>{items.name}</option>
                            ))}
                        </select>
                    </div>
                </div>

                {showDescPopup && (
                    <div className="modal-overlay">
                        <div className="modal-card">
                            <h2 className="modal-title mb-3">Add Product Description</h2>
                            <textarea
                                value={descriptionText}
                                onChange={(e) => setDescriptionText(e.target.value)}
                                rows={4}
                                className="field-input mb-4"
                                placeholder="Enter description here..."
                            />
                            <div className="flex justify-end gap-2">
                                <button
                                    onClick={() => setShowDescPopup(false)}
                                    className="btn btn-secondary"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleSaveDescription}
                                    className="btn btn-primary"
                                >
                                    Save
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {showQuantityPack && (
                    <div className="modal-overlay">
                        <div className="modal-card">
                            <div className='flex'>
                                <h2 className="modal-title mb-3">Enter Quantity Per Pack</h2>
                                <input
                                    type="number"
                                    value={quantityPerPack}
                                    onChange={(e) => setQuantityPerPack(e.target.value)}
                                    placeholder="Quantity per pack"
                                    className="field-input mb-4"
                                />
                            </div>
                            <div className='flex'>
                                <h2 className="modal-title mb-3">Enter No Of Packs</h2>
                                <input
                                    type="number"
                                    value={noOfPack}
                                    onChange={(e) => setNoOfPack(e.target.value)}
                                    placeholder="Number of packs"
                                    className="field-input mb-4"
                                />
                            </div>
                            <div className="flex justify-end gap-2">
                                <button onClick={() => setShowQuantityPack(false)} className="btn btn-secondary">Cancel</button>
                                <button onClick={handleQuantityPackSave} className="btn btn-primary">Save</button>
                            </div>
                        </div>
                    </div>
                )}

                <section className='panel'>
                    <div className='panel-head'>
                        <h2 className='panel-title'>Selected Items</h2>
                    </div>
                    <div className='panel-body flex flex-col gap-3'>

                    {selectedItem && selectedItem.length > 0 ? (
                        <div className='table-wrap'>
                            <table className='data-table min-w-[720px]'>
                                <thead>
                                    <tr>
                                        <th>Name</th>
                                        <th className='text-right'>Quantity</th>
                                        <th className='text-right'>Rate</th>
                                        <th className='text-right'>Discount (%)</th>
                                        <th>HSN Code</th>
                                        <th className='text-right'>Total</th>
                                        <th>Action</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {selectedItem.map((items, index) => (
                                        <tr key={index}>
                                            <td>
                                                {items.name}
                                                {/* Stock before this invoice:
                                                    nothing posts to the stock
                                                    ledger until it is saved. */}
                                                <ItemStock name={items.name} stock={stock} />
                                            </td>
                                            <td>
                                                <input 
                                                    type='number' 
                                                    min='1' 
                                                    className='field-input field-input-sm num w-20' 
                                                    value={items.quantity} 
                                                    onChange={(e) => handleItemFieldChange(index, 'quantity', e.target.value)}
                                                />
                                            </td>
                                            <td>
                                                <input 
                                                    type='number' 
                                                    min='0' 
                                                    className='field-input field-input-sm num w-24' 
                                                    value={items.cost} 
                                                    onChange={(e) => handleItemFieldChange(index, 'cost', e.target.value)}
                                                />
                                            </td>
                                            <td>
                                                <input
                                                    type='number'
                                                    min='0'
                                                    max='100'
                                                    className='field-input field-input-sm num w-20'
                                                    value={items.discount}
                                                    onChange={(e) => handleItemFieldChange(index, 'discount', e.target.value)}
                                                />
                                            </td>
                                            <td>{items.hsn}</td>
                                            <td className='num font-medium'>{Number(items.total).toFixed(2)}</td>
                                            <td>
                                                <button 
                                                    className='btn btn-danger btn-sm' 
                                                    onClick={() => handleRemove(index)}
                                                >
                                                    Remove
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    ) : (
                        <div className='empty-state'>No items added yet.</div>
                    )}
                    </div>
                </section>

                <div className="panel panel-body grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
                    <div className="flex flex-col">
                        <label className="field-label mb-1">GR Date</label>
                        <input type="date" className="field-input" value={grDate} onChange={(e) => setGrDate(e.target.value)} />
                    </div>
                    <div className="flex flex-col">
                        <label className="field-label mb-1">GR No</label>
                        <input type="text" className="field-input" value={grNo} onChange={(e) => setGrNo(e.target.value)} />
                    </div>
                    <div className="flex flex-col">
                        <label className="field-label mb-1">Transport</label>
                        <input type="text" className="field-input" value={transport} onChange={(e) => setTransport(e.target.value)} />
                    </div>
                    <div className="flex flex-col">
                        <label className="field-label mb-1">Pvt Mark</label>
                        <input type="text" className="field-input" value={pvtMark} onChange={(e) => setPvtMark(e.target.value)} />
                    </div>
                    <div className="flex flex-col">
                        <label className="field-label mb-1">Case</label>
                        <input type="text" className="field-input" value={caseDetails} onChange={(e) => setCaseDetails(e.target.value)} />
                    </div>
                    <div className="flex flex-col">
                        <label className="field-label mb-1">Freight</label>
                        <input type="text" className="field-input" value={freight} onChange={(e) => setFreight(e.target.value)} />
                    </div>
                    <div className="flex flex-col">
                        <label className="field-label mb-1">E-Way Bill Date</label>
                        <input type="date" className="field-input" value={ewayBillDate} onChange={(e) => setEwayBillDate(e.target.value)} />
                    </div>
                    <div className="flex flex-col">
                        <label className="field-label mb-1">E-Way Bill No</label>
                        <input type="text" className="field-input" value={ewayBillNo} onChange={(e) => setEwayBillNo(e.target.value)} />
                    </div>
                    <div className="flex flex-col">
                        <label className="field-label mb-1">Order Date</label>
                        <input type="date" className="field-input" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
                    </div>
                    <div className="flex flex-col">
                        <label className="field-label mb-1">Order No</label>
                        <input type="text" className="field-input" value={orderNo} onChange={(e) => setOrderNo(e.target.value)} />
                    </div>
                    <div className="flex flex-col">
                        <label className="field-label mb-1">Weight (kg)</label>
                        <input type="number" className="field-input" value={weight} onChange={(e) => setWeight(e.target.value)} />
                    </div>
                </div>

                {/* Payment & Supply Section */}
                <div className="flex gap-6 flex-wrap">
                    {/* Total Summary Card */}
                    <div className="panel panel-body flex flex-1 flex-col gap-4 min-w-[280px]">
                        <div className="flex justify-between items-center">
                            <h2 className="text-sm font-medium text-foreground">Total Amount</h2>
                            <div className="flex h-10 w-36 items-center justify-end rounded-lg border border-border bg-muted px-3 text-sm font-semibold tabular-nums">
                                ₹{finalAmount}
                            </div>
                        </div>
                        <div className="flex justify-between items-center">
                            <h2 className="text-sm font-medium text-foreground">Received</h2>
                            <input
                                type="number"
                                className="field-input num w-36"
                                value={received || ''}
                                onChange={(e) => setReceived(parseFloat(e.target.value) || 0)}
                                placeholder="0"
                            />
                        </div>
                        <div className="flex justify-between items-center border-t pt-2">
                            <h2 className="text-sm font-semibold text-foreground">Balance Due</h2>
                            <div className="flex h-10 w-36 items-center justify-end rounded-lg border border-destructive/30 bg-destructive/10 px-3 text-sm font-semibold tabular-nums text-destructive">
                                ₹{balanceDue}
                            </div>
                        </div>
                    </div>

                    {/* Tax Type + GST Card */}
                    <div className='panel panel-body flex flex-1 flex-col gap-4 min-w-[280px]'>
                        <div className='flex justify-between items-center'>
                            <h2 className='text-sm font-medium text-foreground'>Payment Type</h2>
                            <select 
                                className='field-select w-36' 
                                value={paymentType} 
                                onChange={(e) => setPaymentType(e.target.value)}
                            >
                                <option value='Cash'>Cash</option>
                                <option value='Cheque'>Cheque</option>
                            </select>
                        </div>
                        <div className='flex flex-col'>
                            <label className='field-label mb-1'>Phone</label>
                            <input 
                                className='field-input' 
                                value={selectedCustomer.phone || ''} 
                                readOnly 
                            />
                        </div>
                        <div className='flex flex-col'>
                            <label className='field-label mb-1'>Email</label>
                            <input 
                                className='field-input' 
                                value={selectedCustomer.email || ''} 
                                readOnly 
                            />
                        </div>
                    </div>
                </div>

                <section className='panel'>
                    <div className='panel-head'>
                        <h2 className='panel-title'>HSN Code-wise Totals</h2>
                    </div>
                    <div className='panel-body'>
                    <div className='table-wrap'>
                        <table className='data-table'>
                            <thead>
                                <tr>
                                    <th>HSN Code</th>
                                    <th className='text-right'>Taxable Amount</th>
                                    <th className='text-right'>GST (%)</th>
                                    <th className='text-right'>GST Amount</th>
                                    <th className='text-right'>Total</th>
                                </tr>
                            </thead>
                            <tbody>
                                {Object.entries(hsnTotals).map(([hsnCode, data]) => (
                                    <tr key={hsnCode}>
                                        <td>{hsnCode}</td>
                                        <td className='num'>
                                            {((data.total || 0) - (data.gstAmount || 0)).toFixed(2)}
                                        </td>
                                        <td className='num'>{data.gstRate || 0}</td>
                                        <td className='num'>{(data.gstAmount || 0).toFixed(2)}</td>
                                        <td className='num font-medium'>{(data.total || 0).toFixed(2)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    </div>
                </section>

                {/* Party Taxes Section */}
                <section className='panel'>
                    <div className='panel-head'>
                        <h2 className='panel-title'>Overheads</h2>
                    </div>
                    <div className='panel-body flex flex-col gap-3'>

                    <div className='flex flex-wrap items-end gap-2'>
                        <input
                            type='text'
                            placeholder='Overhead Name'
                            className='field-input w-56'
                            value={newTaxName}
                            onChange={(e) => setNewTaxName(e.target.value)}
                        />
                        <input
                            type='number'
                            placeholder='Rate %'
                            className='field-input w-24'
                            value={newTaxRate}
                            onChange={(e) => setNewTaxRate(e.target.value)}
                        />
                        <input
                            type='number'
                            placeholder='Amount'
                            className='field-input w-24'
                            value={newTaxAmount}
                            onChange={(e) => setNewTaxAmount(e.target.value)}
                        />
                        <button
                            className='btn btn-success'
                            onClick={addPartyTax}
                            type='button'
                        >
                            Add Overhead
                        </button>
                    </div>

                    {partyTaxes.length > 0 ? (
                        <div className='table-wrap'><table className='data-table'>
                            <thead>
                                <tr>
                                    <th>Tax Name</th>
                                    <th className='text-right'>Rate %</th>
                                    <th className='text-right'>Amount</th>
                                    <th className='text-right'>Total</th>
                                    <th>Action</th>
                                </tr>
                            </thead>
                            <tbody>
                                {partyTaxes.map((tax, index) => (
                                    <tr key={`${tax.name}-${index}`}>
                                        <td>{tax.name}</td>
                                        <td>
                                            {tax.rate !== '' ? `${tax.rate}%` : 'NA'}
                                        </td>
                                        <td>
                                            {tax.amount !== '' ? `₹${tax.amount}` : 'NA'}
                                        </td>
                                        <td className='num'>{tax.total}</td>
                                        <td>
                                            <button
                                                className='btn btn-danger btn-sm px-2'
                                                onClick={() => {
                                                    const updatedTaxes = partyTaxes.filter((_, idx) => idx !== index);
                                                    setPartyTaxes(updatedTaxes);
                                                }}
                                            >
                                                X
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table></div>
                    ) : (
                        <div className='empty-state'>No overheads added.</div>
                    )}
                    </div>
                </section>

                {/* Save Button */}
                <div className='sticky bottom-0 -mx-4 mt-2 flex flex-col border-t border-border bg-card/90 px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur sm:-mx-6 sm:px-6'>
                <EinvoiceLockNotice reason={einvoiceLock} />
                <button 
                    className='btn btn-primary mx-auto h-11 w-fit px-8 text-base' 
                    onClick={handleSave}
                    disabled={Boolean(einvoiceLock)}
                    title={einvoiceLock || undefined}
                >
                    Save Invoice
                </button>
                </div>

                {showShippedPopup && (
                    <div className="modal-overlay">
                        <div className="modal-card">
                            <h2 className="modal-title mb-3">Enter Shipped To</h2>
                            <input
                                type="text"
                                value={shippedTo}
                                onChange={(e) => setShippedTo(e.target.value)}
                                placeholder="Shipping address"
                                className="field-input mb-4"
                            />
                            <div className="flex justify-end gap-2">
                                <button onClick={() => setShowShippedPopup(false)} className="btn btn-secondary">Cancel</button>
                                <button onClick={handleShippedSave} className="btn btn-primary">Next</button>
                            </div>
                        </div>
                    </div>
                )}

                {showDispatchPopup && (
                    <div className="modal-overlay">
                        <div className="modal-card">
                            <h2 className="modal-title mb-3">Enter Dispatch From</h2>
                            <input
                                type="text"
                                value={dispatchFrom}
                                onChange={(e) => setDispatchFrom(e.target.value)}
                                placeholder="Dispatch location"
                                className="field-input mb-4"
                            />
                            <div className="flex justify-end gap-2">
                                <button onClick={() => setShowDispatchPopup(false)} className="btn btn-secondary">Cancel</button>
                                <button onClick={handleDispatchSave} className="btn btn-primary">Save</button>
                            </div>
                        </div>
                    </div>
                )}

            </div>
        </>
    )
}

export default page