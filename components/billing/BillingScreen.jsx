'use client'
import { useRouter, useSearchParams} from 'next/navigation'
import React, { Suspense, useEffect, useRef, useState } from 'react'
import AddIcon from '@mui/icons-material/Add';
import InvoiceSearchParams from '@/components/suspense';
import { useSaleOptions } from '@/context/SaleOptionContext';
import { useCompany } from '@/context/CompanyContext';
import { taxTypeFor } from '@/lib/gst.mjs';
import { resolveItemPricing, latestPriceListFor } from '@/lib/priceList.mjs';
import { placeOfSupply, placeOfSupplyLabel } from '@/lib/buyerSnapshot.mjs';
import PartyBalance from '@/components/PartyBalance';
import ItemStock from '@/components/ItemStock';
import EinvoiceLockNotice from '@/components/EinvoiceLockNotice';
import { Notice, useNotice } from '@/components/ui/notice';
import { NETWORK_ERROR, readResponse } from '@/lib/apiResponse.mjs';
import { editBlockedReason } from '@/lib/einvoiceLock.mjs';
import { prefillFromOrder, pickFromOrder } from '@/lib/orderPrefill.mjs';
import {
    IMPORT_DRAFT_KEY,
    MATCH_APPLIED,
    importParcelVerdict,
    importScopeOf,
} from '@/lib/invoiceImport.mjs';
import { istToday } from '@/lib/istDate.mjs';

// Why a read-in bill was not filled in. See `importParcelVerdict`.
const IMPORT_REFUSED = {
    missing: 'That read-in bill has gone. Read the photo again.',
    'wrong-screen': 'That read-in bill is for a different billing screen (the one it was read as), not this one. It is still waiting there.',
    'wrong-owner': 'That read-in bill was read for a different company or user, so it was not filled in. Read the photo again.',
    unverified: 'Could not confirm who is signed in, so the read-in bill was not filled in. Reload to try again.',
};
import { trim as trimQty } from '@/lib/orderStatus.mjs';
import { billingType, canBillFromOrder } from '@/lib/billingTypes.mjs';
import {
    defaultSeries,
    docTypeForBilling,
    normalizeSeriesCode,
    seriesFor,
} from '@/lib/series.mjs';
import { buildHsnTotals, buildInvoicePayload, recalcItem, saveEndpoint } from '@/lib/billingMath.mjs';
import { hsnKey } from '@/lib/hsnTotals.mjs';
import ItemSearch from '@/components/billing/ItemSearch';
import ChallanPicker from '@/components/billing/ChallanPicker';
import MriPanel from '@/components/billing/MriPanel';
import { isMriSide, rejectedQty } from '@/lib/mri.mjs';
import { CHALLAN_KINDS } from '@/lib/challanStatus.mjs';
import QuickMaster from '@/components/billing/QuickMaster';
import ShortcutHelp from '@/components/billing/ShortcutHelp';
import { useBillingKeys } from '@/components/billing/useBillingKeys';
import {
    infoPanelFor,
    lookupListFor,
    nextRowField,
    priceSourceFor,
} from '@/lib/billingKeys.mjs';
import InfoPanel from '@/components/billing/InfoPanel';
import useMasterActions from '@/components/masters/useMasterActions';
import LookupList from '@/components/billing/LookupList';
import { resolveGroup } from '@/lib/accountGroups.mjs';

/**
 * One billing screen, for all four transaction types.
 *
 * WHAT THIS FILE IS. It is app/saleadd/page.js, moved here with the four
 * values that differed between the screens replaced by a lookup. Nothing was
 * retyped: the audit found saleadd and purchaseadd differed in 8 lines out of
 * 1,547, and salereturn was saleadd minus the order-billing feature. Rewriting
 * 1,500 lines of working billing code to "clean it up" would have been the
 * riskiest possible way to remove duplication.
 *
 * WHAT DIFFERS BETWEEN THE FOUR lives in lib/billingTypes.mjs and is read,
 * never recomputed: the payload's `type`, the `return` flag, the title, the
 * subtitle, and which side's orders this screen may bill.
 *
 * WHAT THE SERVER OWES is unchanged. The payload is built by
 * buildInvoicePayload (lib/billingMath.mjs) from the same 31 keys the four
 * pages sent, and scripts/billing.test.mjs pins them against a list extracted
 * from those pages before any of this moved.
 */
export default function BillingScreen({ typeKey }) {
    // Throws on an unknown key rather than defaulting. A typo falling back to
    // "sale" would post a purchase return as a sale invoice -- the party sign
    // and the stock direction both inverted.
    const config = billingType(typeKey);
    const billsFromOrder = canBillFromOrder(config);

    const router = useRouter()

    // ── Keyboard and quick-master state ──────────────────────────────────────
    // `activeRow` is the line the row-scoped shortcuts act on: set when a
    // field in that row takes focus, so Alt+E deletes the line you are
    // standing in rather than the last one in the table.
    const itemBoxRef = useRef(null);
    const [activeRow, setActiveRow] = useState(null);
    // Sigfa's Alt+J / Alt+Y information windows, and its Shift+F1..F4 lists.
    const [infoPanel, setInfoPanel] = useState(null);
    const [lookup, setLookup] = useState(null);
    const [showShortcuts, setShowShortcuts] = useState(false);
    const [confirmRemove, setConfirmRemove] = useState(null);

   const [value, setValue] = useState('');
   const [hsnTotals, setHsnTotals] = useState({});
   // Messages for this screen (lib/apiResponse.mjs, components/ui/notice.jsx),
   // in place of the browser alert() boxes it used to raise.
   const [notice, notify] = useNotice();
   const [saving, setSaving] = useState(false);
   const [isValueReady,setIsValueReady]=useState(false)
   // What the IRP holds against the invoice being edited, if anything.
   // Null on a new bill, which is why a new bill is never locked.
   const [einvoice, setEinvoice] = useState(null);
     const { options } = useSaleOptions();
     // Our own state code, for the CGST+SGST / IGST decision further down.
     // Fetched once and shared; BLANK_COMPANY until it arrives, which reads
     // as "state unknown" and leaves the radios alone rather than guessing.
     const { company } = useCompany();
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
    // The OTHER party's own bill number -- on a purchase, the number the
    // supplier printed on the bill they sent. Not `invoiceNo`, which is this
    // firm's own sequence. See models/invoiceModel.js.
    const [partyBillNo, setPartyBillNo] = useState('');
    // Sigfa's Series Master, for this screen's own document type. A label on
    // the bill and nothing more -- it does not choose the invoice number.
    const [series, setSeries] = useState('');
    const [seriesMaster, setSeriesMaster] = useState([]);
    // ─── Purchase M.R.I. (lib/mri.mjs) ───────────────────────────────────────
    // A purchase bill (not a return) may be an MRI: each line then carries
    // what was RECEIVED beside the quantity, which is what was ACCEPTED.
    // `mriNo` is the stored number when editing one; a new one is numbered
    // by the server on save.
    const takesMri = isMriSide({ type: config.type, isReturn: config.isReturn });
    const [mri, setMri] = useState({ on: false, remark: '', againstMriNo: null });
    const [mriNo, setMriNo] = useState(null);
const [ewayBillDate, setEwayBillDate] = useState('');
const [showDispatchPopup, setShowDispatchPopup] = useState(false);
const [dispatchFrom, setDispatchFrom] = useState('');
const [quantityPerPack, setQuantityPerPack] = useState(0);
const [noOfPack, setNoOfPack] = useState(0);
      const [showDescPopup, setShowDescPopup] = useState(false);
      const [showQuantityPack, setShowQuantityPack] = useState(false);
  const [descriptionText, setDescriptionText] = useState('');
    const [invoiceNo, setInvoiceNo] = useState(4)
    // Today in India: the UTC date is yesterday until 05:30 IST. lib/istDate.mjs.
    const [date, setDate] = useState(() => istToday())
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

    // buildHsnTotals and recalcItem now come from lib/billingMath.mjs. They
    // were copied there character for character, because the per-line
    // taxableAmount, gstAmount and total the browser computes are what gets
    // STORED -- the server derives balanceDue and the ledger legs, but takes
    // the line money as sent. The module's header lists the four quirks that
    // had to be preserved, and the test pins each one.


useEffect(() => {
  if (value) return;

  let cancelled = false;

  const fetchInvoiceNo = async () => {
    try {
      const response = await fetch('/api/next-invoice-no');
      const data = await response.json();
      if (!cancelled && data.invoiceNo) {
        // Held in state only. It used to be copied to localStorage under the
        // bare key 'invoiceNo' -- shared by all four screens, every company and
        // every user of this browser -- and never read back.
        setInvoiceNo(data.invoiceNo);
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

                    // An MRI line whose received figure equals the accepted one
                    // was entered blank ("received what was accepted"). Kept
                    // blank, so raising the accepted quantity raises it too
                    // instead of being refused against a stale copy.
                    const { receivedQty, ...rest } = item;
                    const keepReceived =
                        receivedQty !== undefined && receivedQty !== null && Number(receivedQty) !== quantity;
                    return { ...rest, ...(keepReceived ? { receivedQty } : {}), cost, gstRate, taxableAmount, gstAmount, total };
                });

                setGst(data.gst || normalizedItems.reduce((sum, i) => sum + (i.gstAmount || 0), 0));
                setInvoiceNo(data.invoiceNo || 4);
                setDate(data.date ? formatDate(data.date) : istToday());
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

                // Keyed by code AND rate, as lib/hsnTotals.mjs groups them, so
                // two stored rows for one HSN at two rates both survive.
                const hsnTotalsObject = (data.hsnTotals || []).reduce((acc, row) => {
                    acc[hsnKey(row.hsn, row.gstRate)] = {
                        hsn:       row.hsn,
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
                setPartyBillNo(data.partyBillNo || '');
                // Normalized because the box is a <select> and its options
                // are. A bill saved before the master existed carries no
                // series at all and simply comes back on "None".
                setSeries(normalizeSeriesCode(data.series));
                setMriNo(data.mriNo || null);
                setMri({
                    on: Boolean(data.mriNo),
                    remark: data.mriRemark || '',
                    againstMriNo: data.againstMriNo || null,
                });
                setEwayBillDate(data.ewayBillDate ? formatDate(data.ewayBillDate) : '');
            })
            .catch(err => console.error('Error:', err));
        }
    }, [value]);

    // Opened as /purchaseadd?mri=1 -- the "Purchase MRI" entry on the home
    // page -- a new bill starts as an MRI. Read once, in the browser.
    useEffect(() => {
        if (!takesMri || value) return;
        if (new URLSearchParams(window.location.search).get('mri') === '1') {
            setMri((m) => ({ ...m, on: true }));
        }
    }, [takesMri, value]);

    // (A party used to be pre-selected here from localStorage 'selectedCustomer'
    // -- one browser-wide key read by all four screens, for every company and
    // user, and written by nothing in this app. Removed; the party comes from
    // the invoice being edited, an order, or a read-in bill, each checked.)

    // ─── Carrying a sales/purchase order onto this form ──────────────────────
    //
    // Reached as /saleadd?fromOrder=7&orderType=Sale from the order register.
    // Only the REFERENCE travels in the URL: quantities and rates in a query
    // string would be a set of figures nobody had checked against the order.
    //
    // The query string is read from window.location rather than through
    // useSearchParams, so this needs no second Suspense boundary on a page
    // that already has one. It sits in an effect, so it only runs in the
    // browser.
    //
    // Everything downstream then happens by itself: the HSN totals, the GST
    // and the party taxes all recompute off `selectedItem`.
    const ORDER_DOC = config.orderDoc;
    const [orderPrefill, setOrderPrefill] = useState(null);

    // ─── Pending challans (SIGFA's SC / PC) ──────────────────────────────────
    //
    // A sale bills sales challans and a purchase bills purchase challans; a
    // return bills none (lib/challanStatus.mjs). The picker is its own
    // component; the server re-checks every line and decides from the
    // challan whether its stock has already moved.
    const billsFromChallan = !config.isReturn;
    const [showChallanPicker, setShowChallanPicker] = useState(false);
    const [challanPrefill, setChallanPrefill] = useState(null);
    // A bill read off a photograph, handed over by /upload. See the effect.
    const [importPrefill, setImportPrefill] = useState(null);

    // ─── The order-item picker ───────────────────────────────────────────────
    //
    // Measured on MCSFAST's live order book: 29.8% of order lines are billed
    // across more than one invoice (one of them across 93), and 64.6% of
    // bills took only some of their order's lines. So "bill the whole order"
    // is the wrong default for most real lines, and this lets the clerk pick
    // the lines AND the quantity of each. Invoices spanning two orders are
    // 0.1% of theirs, so the picker works within one order at a time.
    const [showPicker, setShowPicker] = useState(false);
    const [pickerOrders, setPickerOrders] = useState(null);
    const [pickerOrderNo, setPickerOrderNo] = useState('');
    const [picks, setPicks] = useState({});
    const [pickerError, setPickerError] = useState('');

    const openPicker = () => {
        setPickerError('');
        setPicks({});
        setPickerOrders(null);
        setShowPicker(true);
        const qs = new URLSearchParams({ type: ORDER_DOC });
        // Scoped to the party already chosen, which is what makes the list
        // short enough to read -- their book has 130 parties with pending
        // orders. With nobody chosen yet it shows everything.
        if (selectedCustomer?.name) qs.set('customer', selectedCustomer.name);
        fetch(`/api/order-pending?${qs.toString()}`)
            .then((r) => r.json())
            .then((d) => {
                if (!d.success) throw new Error(d.error || 'Could not load pending orders.');
                setPickerOrders(d.orders || []);
                if ((d.orders || []).length === 1) setPickerOrderNo(String(d.orders[0].orderNo));
            })
            .catch((e) => {
                setPickerOrders([]);
                setPickerError(e.message);
            });
    };

    const pickerOrder = (pickerOrders || []).find(
        (o) => String(o.orderNo) === String(pickerOrderNo)
    );

    const applyPicks = () => {
        setPickerError('');
        if (!pickerOrder) return setPickerError('Choose an order first.');

        const chosen = Object.entries(picks)
            .map(([orderLineId, quantity]) => ({ orderLineId, quantity: Number(quantity) }))
            .filter((p) => p.quantity > 0);

        if (!chosen.length) return setPickerError('Set a quantity on at least one line.');

        // The rule refuses a quantity above what is pending rather than
        // clamping it: silently billing less than was typed is how a clerk
        // ends up believing they invoiced 500 when the bill says 300.
        const { lines, problems, skipped } = pickFromOrder({
            order: {
                orderNo: pickerOrder.orderNo,
                type: pickerOrder.type,
                date: pickerOrder.date,
                customer: pickerOrder.customer,
                // The picker rows carry their own figures; rebuild the shape
                // the rule expects from them rather than keeping a second copy.
                items: (pickerOrder.pickable || []).map((r) => ({
                    _id: r.orderLineId,
                    name: r.item,
                    hsn: r.hsn,
                    uqc: r.uqc,
                    quantity: r.ordered,
                    invoicedQty: r.billed,
                    cancelledQty: r.cancelled,
                    cost: r.rate,
                    discount: r.discount,
                    deliveryDate: r.promised,
                })),
            },
            items: item,
            recalc: recalcItem,
            picks: chosen,
        });

        if (problems.length) return setPickerError(problems.join(' '));

        const party = customer.find((c) => c.name === pickerOrder.customer?.name);
        if (party) setSelectedCustomer(party);
        setSelectedItem((prev) => [...prev, ...lines]);
        if (pickerOrder.orderNo) setOrderNo(pickerOrder.orderNo);
        if (pickerOrder.date) setOrderDate(formatDate(pickerOrder.date));

        setShowPicker(false);
        setOrderPrefill({
            orderNo: pickerOrder.orderNo,
            orderType: pickerOrder.type,
            count: lines.length,
            note: skipped.length
                ? `Check the GST on: ${skipped.join(', ')} -- no longer in the item master.`
                : '',
        });
    };

    useEffect(() => {
        // A return screen cannot bill from an order and never could: the old
        // salereturn and purchasereturn pages did not contain this effect at
        // all. The flag is what deletes it for them.
        if (!billsFromOrder) return;
        if (typeof window === 'undefined') return;
        if (orderPrefill) return;
        // Wait for both masters. The rate comes from the order, but the GST
        // rate comes from the item master -- prefilling before that has
        // loaded would bill the whole order at zero per cent.
        if (!customerLoaded || !item?.length) return;

        const params = new URLSearchParams(window.location.search);
        const fromOrder = Number(params.get('fromOrder'));
        const orderType = params.get('orderType') || '';
        if (!Number.isFinite(fromOrder) || fromOrder <= 0 || !orderType) return;

        setOrderPrefill({ pending: true });

        fetch(`/api/get-order?orderNo=${fromOrder}&type=${encodeURIComponent(orderType)}`)
            .then((res) => res.json())
            .then((data) => {
                if (!data.success) throw new Error(data.error || 'Order not found.');
                const { lines, customerName, skipped, header } = prefillFromOrder({
                    order: data.order,
                    items: item,
                    recalc: recalcItem,
                });
                if (!lines.length) {
                    setOrderPrefill({ note: `Order ${fromOrder} has nothing left to bill.` });
                    return;
                }
                const party = customer.find((c) => c.name === customerName);
                if (party) setSelectedCustomer(party);
                setSelectedItem(lines);
                // The HEADER too, not just the lines. These two already print
                // on the bill (components/InvoiceDocument.jsx), and leaving
                // them blank is why a bill raised from an order carried no
                // visible reference to it.
                if (header?.orderNo) setOrderNo(header.orderNo);
                if (header?.orderDate) setOrderDate(header.orderDate);
                setOrderPrefill({
                    orderNo: fromOrder,
                    orderType,
                    count: lines.length,
                    note: skipped.length
                        ? `Check the GST on: ${skipped.join(', ')} -- no longer in the item master.`
                        : '',
                });
            })
            .catch((err) => setOrderPrefill({ note: err.message }));
    }, [customerLoaded, item, customer, orderPrefill]);

    /**
     * A bill read off a photograph (app/upload/page.js).
     *
     * The draft comes through sessionStorage, not the URL -- the old import
     * put the whole items array through encodeURIComponent into a query
     * string. It is READ ONCE AND REMOVED: a refresh must not re-apply it
     * over whatever the person has since typed, and an abandoned import must
     * not be sitting there tomorrow waiting to land on a different bill.
     *
     * Everything applied here has already been matched and recomputed by
     * lib/invoiceImport.mjs. Nothing is saved: this is the ordinary billing
     * screen with its fields filled in, and the save is the same one a typed
     * bill takes. The blocking warnings are carried onto the strip so the
     * person can see what still needs settling without going back.
     */
    useEffect(() => {
        if (!customerLoaded || importPrefill) return;
        const params = new URLSearchParams(window.location.search);
        if (params.get('import') !== '1') return;

        let cancelled = false;
        (async () => {
        // Whose screen is this? The parcel names the screen it is for and
        // the firm and user who read the photo; it is applied only when all
        // three match (lib/invoiceImport.mjs `importParcelVerdict`).
        let scope = null;
        try {
            const res = await fetch('/api/auth/me');
            scope = res.ok ? importScopeOf(await res.json()) : null;
        } catch {
            scope = null;
        }
        if (cancelled) return;

        let parcel = null;
        try {
            parcel = JSON.parse(sessionStorage.getItem(IMPORT_DRAFT_KEY) || 'null');
        } catch {
            parcel = null;
        }

        const verdict = importParcelVerdict(parcel, {
            type: config.type,
            isReturn: config.isReturn,
            scope,
        });

        // Read once and removed -- except when it is still good for its
        // owner: opened on the wrong screen, or the sign-in lookup failed.
        if (verdict === 'ok' || verdict === 'wrong-owner' || verdict === 'missing') {
            try {
                sessionStorage.removeItem(IMPORT_DRAFT_KEY);
            } catch {
                // Storage refused; nothing was applied, nothing to undo.
            }
        }

        if (verdict !== 'ok') {
            setImportPrefill({ note: IMPORT_REFUSED[verdict] || IMPORT_REFUSED.missing });
            return;
        }

        const draft = parcel.draft;

        // The party, only when it was an EXACT match. A near-miss is left for
        // the person to pick from the dropdown -- see the note about
        // MATCH_APPLIED atop lib/invoiceImport.mjs. Note the place of supply
        // follows from whoever is picked, through lib/placeOfSupply.mjs, so
        // nothing here sets a state or a tax type.
        if (draft.party?.how === MATCH_APPLIED && draft.party.name) {
            const party = customer.find((c) => c.name === draft.party.name);
            if (party) setSelectedCustomer(party);
        }

        if (draft.lines?.length) setSelectedItem(draft.lines);
        if (draft.date) setDate(draft.date);
        if (draft.partyBillNo) setPartyBillNo(draft.partyBillNo);
        if (draft.paymentType) setPaymentType(draft.paymentType);
        if (draft.transport) setTransport(draft.transport);
        if (draft.grNo) setGrNo(draft.grNo);
        if (draft.ewayBillNo) setEwayBillNo(draft.ewayBillNo);
        if (draft.freight) setFreight(String(draft.freight));
        // CGST+SGST or IGST, from the two GSTINs on the bill (or our profile
        // and the party's master) -- lib/invoiceImport.mjs taxTypeFor. The
        // radio below is otherwise left at its default, and an inter-state
        // bill saved as local posts the wrong tax heads. Null when either
        // state is unknown: then the radio is the person's to set.
        if (draft.taxType === 'local' || draft.taxType === 'central') setTaxType(draft.taxType);

        setImportPrefill({
            count: draft.lines?.length || 0,
            supplier: draft.party?.how === MATCH_APPLIED ? draft.party.name : '',
            blocking: (parcel.warnings || []).filter((w) => w.severity === 'blocking'),
            checks: (parcel.warnings || []).filter((w) => w.severity === 'check'),
        });
        })();
        return () => {
            cancelled = true;
        };
    }, [customerLoaded, customer, importPrefill]);

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
    notify.error("Enter a tax name and either a rate or an amount.");
    return;
  }

  if (newTaxRate && newTaxAmount) {
    notify.error("Use either a rate or an amount, not both.");
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
                setItem(result.item || [])
            } catch (error) {
                console.error('Error fetching Item data:', error);
                notify.error('Could not load the item list. Reload the page to try again.');
            }
        }
        
        const fetchSeries = async () => {
            try {
                const response = await fetch('/api/get-series')
                const result = await response.json()
                setSeriesMaster(result.series || [])
            } catch (error) {
                // The Series box is optional on every bill, so a firm that has
                // defined none is the normal case and this is not worth a
                // notice the clerk has to dismiss.
                console.error('Error fetching series data:', error);
            }
        }

        const fetchCust = async () => {
            try {
                const response = await fetch('/api/get-customer')
                const result = await response.json()
                setCustomer(result.customer || [])
                setCustomerLoaded(true);
            } catch (error) {
                console.error('Error fetching Customer data:', error);
                notify.error('Could not load the party list. Reload the page to try again.');
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
        fetchSeries()
    }, [])

    /**
     * Which series this screen may offer, and which it starts on.
     *
     * `docTypeForBilling` turns this screen's own key -- sale, purchase,
     * salereturn, purchasereturn -- into the document Sigfa's Series Master
     * files a series under, so a sales-invoice series is never offered on a
     * purchase return.
     */
    const seriesDocType = docTypeForBilling(config.key);
    const chosenSeries = normalizeSeriesCode(series);
    const offeredSeries = seriesFor(seriesMaster, seriesDocType);
    // A bill whose series has since been switched off would otherwise show a
    // BLANK box -- and because onChange never fires for an option that is not
    // there, it would look cleared while still being saved. Kept as an option
    // of its own instead.
    const seriesChoices =
        chosenSeries && !offeredSeries.some((s) => normalizeSeriesCode(s.code) === chosenSeries)
            ? [...offeredSeries, { code: chosenSeries, name: '' }]
            : offeredSeries;

    // The default, on a BLANK bill only. Never over one being edited -- that
    // would relabel a document already in the book -- and never over a choice
    // already made.
    useEffect(() => {
        if (value) return;
        setSeries((prev) => prev || defaultSeries(seriesMaster, seriesDocType));
    }, [seriesMaster, seriesDocType, value]);

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
    //
    // `side` makes a purchase line start from the master's PURCHASE price
    // (falling back to the sale price when none is set); it used to start
    // every purchase from the sale price.
    const defaultPricing = (sourceItem) =>
        resolveItemPricing(
            sourceItem,
            options.usePriceList ? latestPriceListFor(priceLists, selectedCustomer?._id) : null,
            { side: config.type }
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

    /*
      CGST+SGST or IGST, worked out rather than picked.

      Our state against the place of supply: same state is local (CGST+SGST),
      different is central (IGST). A Delhi firm billing a Haryana party is
      central; billing a Delhi party is local; and it reads the same way for
      every pair of states, because the rule is just whether the two codes
      match -- lib/gst.mjs taxTypeFor.

      It was two radio buttons, defaulting to local. Nothing checked them
      against the party, so an inter-state bill left alone posted CGST and
      SGST (lib/invoiceGl.mjs) and filed in the wrong GSTR-1 table
      (lib/gstReturns.mjs). save-invoice and sale-alter now derive this by the
      same rule and the derived answer is what gets stored, so the radios show
      it rather than offering a choice the server would overrule.

      Null when either state is unknown -- a firm whose profile predates the
      state fields, or a party with no state on their master. The radios are
      the person's to set then, which is also what the server falls back to.

      On a bill being EDITED this reads the invoice's own buyer block, so it
      follows the place of supply written on that document.
    */
    const derivedTaxType = taxTypeFor(company?.stateCode, place.stateCode);
    const effectiveTaxType = derivedTaxType ?? taxType;

    // Save invoice function
    const submitInvoice = async () => {
        // sale-alter refuses this with a 409 as well. Stopping here is so the
        // user is told before retyping a bill, not after.
        // The reason is already on screen, right above the (disabled) Save
        // button, in EinvoiceLockNotice; reached here only by the keyboard
        // shortcut. Saying it twice is noise.
        if (einvoiceLock) return;
        // One save at a time. A double click (or Enter held down) used to
        // post the bill twice.
        if (saving) return;


        // === The request body ===
        //
        // Built by lib/billingMath.mjs from the same 31 keys all four pages
        // sent, with `type` and `return` taken off the config. Those two are
        // the whole of the accounting difference between the four screens:
        // the server turns them into a party-balance sign and a stock
        // direction (lib/invoicePosting.mjs, lib/invoiceGl.mjs). Nothing here
        // computes a sign, and nothing here should.
        //
        // The customer object is passed whole; the builder flattens it to the
        // four fields the server reads, as the pages did inline.
        const invoiceData = buildInvoicePayload(
            {
                invoiceNo,
                originalInvoiceNo: value,
                date,
                customer: selectedCustomer,
                paymentType,
                balanceDue,
                stateOfSupply: place.stateOfSupply,
                stateCode: place.stateCode,
                // The screen shows what the server derives -- the form must
                // not send one thing and store another. (No commas in this
                // comment: formObjectKeys in the test splits this literal on
                // them and would lose the key behind one.)
                taxType: effectiveTaxType,
                gst,
                totalAmount,
                finalAmount,
                received,
                // A received quantity belongs to an MRI only; switching the
                // MRI off drops them rather than sending figures nobody sees.
                items: takesMri && mri.on
                    ? selectedItem
                    : selectedItem.map(({ receivedQty: _received, ...line }) => line),
                partyTaxes,
                shippedTo,
                dispatchFrom,
                transport,
                grNo,
                grDate,
                pvtMark,
                hsnTotals,
                caseDetails,
                freight,
                weight,
                ewayBillNo,
                ewayBillDate,
                orderDate,
                orderNo,
                partyBillNo,
                mri: takesMri ? mri : undefined,
                series: chosenSeries,
            },
            config
        );

        setSaving(true);
        notify.clear();
        try {
            const apiRoute = saveEndpoint(Boolean(value));
            const response = await fetch(apiRoute, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(invoiceData),
            });

            // Never throws, and reads `error` or `message` -- a timed-out
            // session used to report "Failed to save invoice: undefined".
            const { ok, body: result, message } = await readResponse(response);

            if (ok && result.success) {
                setSelectedItem([]);
                setPartyTaxes([]);
                setChallanPrefill(null);
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
                notify.error(`The invoice was not saved. ${message || 'Try again.'}`);
            }
        } catch (err) {
            console.error('Error saving invoice:', err);
            notify.error(`The invoice was not saved. ${NETWORK_ERROR}`);
        } finally {
            setSaving(false);
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
    /**
     * Enter inside a line.
     *
     * Walks quantity -> rate -> discount and, at the end of the line, goes
     * back to the item box for the next one. That is Sigfa's rhythm, and it
     * is why ten lines can be entered without touching the mouse.
     *
     * ALWAYS prevented. A bare Enter in a number box submits the surrounding
     * form, which here would post the invoice -- the single worst thing a
     * stray keystroke could do on this screen.
     */
    const onRowKeyDown = (e, index, field) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const next = nextRowField(field);
        if (next) {
            const box = document.querySelectorAll(`[data-billing-field="${next}"]`)[index];
            box?.focus();
            box?.select?.();
            return;
        }
        // End of the line: back to the item box, which is where the next item
        // is typed. Nothing is added by itself -- a row appears only when an
        // item is actually chosen, so Enter cannot create a blank line.
        itemBoxRef.current?.focus();
    };

    // The received quantity on an MRI line. Blank stays blank -- "received
    // what was accepted" -- rather than turning into a zero.
    const handleReceivedChange = (index, rawValue) => {
        setSelectedItem(prev =>
            prev.map((item, idx) => {
                if (idx !== index) return item;
                if (rawValue === '' || rawValue === null) {
                    const { receivedQty: _received, ...rest } = item;
                    return rest;
                }
                const n = parseFloat(rawValue);
                return { ...item, receivedQty: Number.isFinite(n) ? n : 0 };
            })
        );
    };

    const handleItemFieldChange = (index, field, rawValue) => {
        setSelectedItem(prev =>
            prev.map((item, idx) => {
                if (idx !== index) return item;
                const updated = { ...item, [field]: parseFloat(rawValue) || 0 };
                return recalcItem(updated);
            })
        );
    };

    /**
     * Refetch one master after it was created, altered or deleted.
     *
     * Only the one that changed. A bill that went on showing a record which
     * has just been renamed would bill under the old name, and the join in
     * this app is BY NAME -- so a stale dropdown is a posting error, not a
     * cosmetic one.
     */
    const reloadMaster = (kind) => {
        if (kind === 'item') {
            fetch('/api/get-item')
                .then((r) => r.json())
                .then((d) => setItem(d.item || []))
                .catch(() => {});
        }
        if (kind === 'customer') {
            fetch('/api/get-customer')
                .then((r) => r.json())
                .then((d) => setCustomer(d.customer || []))
                .catch(() => {});
        }
        if (kind === 'series') {
            fetch('/api/get-series')
                .then((r) => r.json())
                .then((d) => setSeriesMaster(d.series || []))
                .catch(() => {});
        }
    };

    /**
     * Sigfa's three master keys, for whatever field has focus.
     *
     * The item and party masters are already in memory for the dropdowns, so
     * Alt+M on either costs no request; HSN, group and state are fetched on
     * the keystroke. `onChanged` reloads the lists so a bill does not go on
     * showing a record that has just been renamed or deleted.
     */
    const masters = useMasterActions({
        lists: { item, customer, series: seriesMaster },
        onChanged: ({ kind, mode, record }) => {
            reloadMaster(kind);
            // A deleted or renamed party is still sitting in `selectedCustomer`
            // and on every line. Cleared rather than left pointing at a record
            // that no longer exists under that name.
            if (kind === 'customer' && mode === 'delete' && record?.name === selectedCustomer?.name) {
                setSelectedCustomer({});
            }
        },
    });

    /**
     * Choose the bill's party, by name.
     *
     * Extracted from the dropdown's inline handler so Shift+F1 and Shift+F2
     * go through the SAME path: the price list, the place of supply and the
     * balance strip all hang off `selectedCustomer`, and a second way of
     * setting it is a second chance for one of them to be missed.
     */
    const pickCustomer = (name) => {
        const match = customer.find((cust) => cust.name === name);
        setSelectedCustomer(match || {});
    };

    /**
     * Put one of the item master's stored prices into the focused line's rate.
     *
     * Needs a chosen line and does nothing without one, rather than guessing
     * the last. Routed through recalcItem so the taxable value, the GST and
     * the total cascade exactly as a typed rate would -- a price written
     * straight onto `cost` would leave the line's total stale.
     *
     * A price the master does not carry is refused with a word, not applied
     * as zero: silently rewriting a rate to 0 on Alt+F1 would be the worst
     * kind of shortcut.
     */
    const applyPriceSource = (action) => {
        const source = priceSourceFor(action);
        if (!source) return;
        if (activeRow === null || !selectedItem[activeRow]) {
            notify.error('Choose a line first — click into its quantity or rate.');
            return;
        }
        const line = selectedItem[activeRow];
        const master = item.find((i) => i.name === line.name);
        const price = Number(master?.[source.field]);
        if (!master || !Number.isFinite(price) || price <= 0) {
            notify.error(`No ${source.label} is set on "${line.name}" in the item master.`);
            return;
        }
        // Sigfa warns rather than refuses: "Sale Price Is More Than MRP".
        const mrp = Number(master?.mrp);
        if (source.field !== 'mrp' && Number.isFinite(mrp) && mrp > 0 && price > mrp) {
            notify.info(`Note: that ${source.label} (${price}) is more than the MRP (${mrp}).`);
        } else {
            notify.clear();
        }
        handleItemFieldChange(activeRow, 'cost', String(price));
    };

    /**
     * Open one of Sigfa's four "Help Window" lists.
     *
     * The filter is the account GROUP, through lib/accountGroups.mjs, so the
     * legacy spellings ("customer", "supplier") land in the right list -- and
     * so the sale/purchase heads are found by the statement they sit on
     * rather than by matching names.
     */
    const openLookup = (action) => {
        const spec = lookupListFor(action);
        if (!spec) return;
        const rows = (customer || [])
            .filter((party) => {
                const group = resolveGroup(party?.group);
                if (spec.group) return group?.name === spec.group;
                if (spec.statement) return group?.statement === spec.statement;
                return true;
            })
            .map((party) => ({
                name: party?.name,
                city: party?.city,
                group: resolveGroup(party?.group)?.name || party?.group,
                lastBal: party?.lastBal,
            }))
            .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
        setLookup({ ...spec, rows });
    };

    // ═══ KEYBOARD ═══════════════════════════════════════════════════════════
    //
    // Sigfa's keys, bound through one listener. The TABLE is in
    // lib/billingKeys.mjs and the listener in useBillingKeys; this is only the
    // wiring, so a shortcut's meaning and its guard against firing mid-typing
    // are both tested away from React.
    //
    // An action with no handler below is simply not bound -- the key is left
    // to the browser rather than swallowed.
    const boundKeys = useBillingKeys({
        itemSearch: () => itemBoxRef.current?.focus(),

        // Sigfa's three, all on the FOCUSED FIELD and all through one hook,
        // so they behave identically here and on a master screen:
        //
        //   Create [ Alt + A ]   Alter [ Alt + M ]   Delete [ Alt + D ]
        //
        // Alter edits IN PLACE. It used to push the master screen, which
        // threw away a half-typed bill -- and it only knew about items and
        // parties, so Alt+M in an HSN or state box did nothing at all.
        pendingChallan: billsFromChallan ? () => setShowChallanPicker(true) : undefined,

        newMaster: () => masters.create(),
        alterMaster: () => masters.alter(),
        deleteMaster: () => masters.remove(),

        addRow: () => itemBoxRef.current?.focus(),

        deleteRow: () => {
            // Needs a chosen line, and says so rather than deleting the last
            // one as a guess. Confirmed, because a mis-keyed Alt+E on a
            // finished bill would silently drop a line.
            if (activeRow === null || !selectedItem[activeRow]) return;
            setConfirmRemove(activeRow);
        },

        save: () => handleSave(),

        itemLedger: () => {
            if (activeRow !== null && selectedItem[activeRow]?.name) {
                router.push(`/item-ledger?item=${encodeURIComponent(selectedItem[activeRow].name)}`);
            }
        },
        partyLedger: () => {
            if (selectedCustomer?.name) {
                router.push(`/ledger?customer=${encodeURIComponent(selectedCustomer.name)}`);
            }
        },

        // ── Alt+J and Alt+Y: Sigfa's information windows ────────────────
        //
        // Read-only on purpose. Alt+M is the key that goes to the master to
        // CHANGE a record; a window that both shows and edits is one somebody
        // edits by accident with a bill half typed.
        itemInfo: () => {
            const kind = infoPanelFor('itemInfo');
            const line = activeRow !== null ? selectedItem[activeRow] : null;
            if (!line?.name) return;
            const master = item.find((i) => i.name === line.name);
            setInfoPanel({
                title: kind.title,
                subtitle: line.name,
                rows: master
                    ? [
                        { label: 'HSN', value: master.hsn },
                        { label: 'Unit', value: master.unit },
                        { label: 'UQC', value: master.uqc },
                        { label: 'GST %', value: master.gst },
                        { label: 'Sale price', value: master.salePrice },
                        { label: 'Purchase price', value: master.purchasePrice },
                        { label: 'MRP', value: master.mrp },
                        { label: 'Discount %', value: master.discount },
                        { label: 'Group', value: master.group },
                        // Sigfa's own stock warning prints all three levels
                        // beside the current stock, under these names.
                        { label: 'Minimum Level', value: master.minQuantity },
                        { label: 'Re-Order Level', value: master.reorderLevel },
                        { label: 'Maximum Level', value: master.maxLevel },
                        // The rate ON THIS LINE, which may have been edited
                        // or come off a price list, beside the master's.
                        { label: 'Rate on this line', value: line.cost },
                    ]
                    : [],
            });
        },

        partyInfo: () => {
            const kind = infoPanelFor('partyInfo');
            if (!selectedCustomer?.name) return;
            // From the MASTER, not from the invoice's embedded buyer block --
            // the same rule PartyBalance follows, and for the same reason: the
            // snapshot on a saved bill is deliberately frozen.
            const master = customer.find((c) => c.name === selectedCustomer.name) || selectedCustomer;
            setInfoPanel({
                title: kind.title,
                subtitle: master.name,
                rows: [
                    { label: 'GSTIN', value: master.gstIn },
                    { label: 'Group', value: resolveGroup(master.group)?.name || master.group },
                    { label: 'City', value: master.city },
                    { label: 'State', value: master.state },
                    { label: 'State code', value: master.stateCode },
                    { label: 'Pincode', value: master.pincode },
                    { label: 'Phone', value: master.phone },
                    { label: 'Email', value: master.email },
                    { label: 'PAN', value: master.pan },
                    {
                        label: 'Current balance',
                        value:
                            master.lastBal === undefined
                                ? ''
                                : `${Number(master.lastBal || 0).toFixed(2)} ${
                                      Number(master.lastBal || 0) >= 0 ? 'Dr' : 'Cr'
                                  }`,
                    },
                    { label: 'Opening balance', value: master.openingBal },
                ],
            });
        },

        // ── Alt+F1 / Alt+F2 / Alt+F3: pull a stored price into the rate ──
        //
        // One mechanism, three keys -- Sigfa's own rate sources read
        // "6=Pur.Price, 7=CostPrice, 8=MRP", so "Cal MRP" puts the MRP in the
        // rate box rather than back-computing anything. lib/billingKeys.mjs
        // holds the mapping and says why.
        purchasePrice: () => applyPriceSource('purchasePrice'),
        salePrice: () => applyPriceSource('salePrice'),
        calcMrp: () => applyPriceSource('calcMrp'),

        // ── Shift+F1 to Shift+F4: Sigfa's "Help Window" lists ───────────
        customerList: () => openLookup('customerList'),
        supplierList: () => openLookup('supplierList'),
        accountList: () => openLookup('accountList'),
        salePurchaseList: () => openLookup('salePurchaseList'),

        help: () => setShowShortcuts(true),

        back: () => {
            // Esc closes whatever is open, innermost first, and only leaves
            // the screen when nothing is. Leaving a half-typed bill on a
            // stray Escape would be its own bug report.
            if (showShortcuts) return setShowShortcuts(false);
            if (masters.problem) return masters.clearProblem();
            if (masters.dialog) return masters.closeDialog();
            if (infoPanel) return setInfoPanel(null);
            if (lookup) return setLookup(null);
            if (confirmRemove !== null) return setConfirmRemove(null);
        },
    });

    return (
        <>
            <Suspense fallback={null}>
                <InvoiceSearchParams onValue={setValue} onReady={setIsValueReady} />
            </Suspense>
            <div className='page-shell-wide flex flex-col gap-6'>
                <header className='page-header mb-0'>
                    <div>
                        <h1 className='page-title'>{config.title}</h1>
                        <p className='page-subtitle'>{config.subtitle}</p>
                    </div>
                </header>

                {/* Brought across from an order */}
                {/* A bill read off a photograph. Amber rather than green:
                    this is a draft somebody has to check, not a confirmed
                    prefill from the firm's own order. */}
                {importPrefill && (
                    <div className='mb-1 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm'>
                        {importPrefill.count ? (
                            <div className='font-medium'>
                                Read off a photo: {importPrefill.count} line
                                {importPrefill.count === 1 ? '' : 's'}
                                {importPrefill.supplier ? `, ${importPrefill.supplier}` : ''}. Nothing is
                                saved yet — check it and save as usual.
                            </div>
                        ) : (
                            <div className='font-medium'>{importPrefill.note}</div>
                        )}
                        {importPrefill.blocking?.length ? (
                            <ul className='mt-1.5 list-disc pl-5'>
                                {importPrefill.blocking.map((w) => (
                                    <li key={`${w.field}-${w.message}`}>{w.message}</li>
                                ))}
                            </ul>
                        ) : null}
                        {importPrefill.checks?.length ? (
                            <ul className='mt-1.5 list-disc pl-5 text-muted-foreground'>
                                {importPrefill.checks.map((w) => (
                                    <li key={`${w.field}-${w.message}`}>{w.message}</li>
                                ))}
                            </ul>
                        ) : null}
                    </div>
                )}

                {orderPrefill?.orderNo && (
                    <div className='mb-1 rounded-lg border border-success/40 bg-success/10 px-4 py-3 text-sm'>
                        Billing {orderPrefill.orderType} order {orderPrefill.orderNo} —{' '}
                        {orderPrefill.count} pending line{orderPrefill.count === 1 ? '' : 's'} brought across.
                        {orderPrefill.note && <div className='mt-1'>{orderPrefill.note}</div>}
                    </div>
                )}
                {orderPrefill?.note && !orderPrefill?.orderNo && (
                    <div className='mb-1 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm'>
                        {orderPrefill.note}
                    </div>
                )}

                {challanPrefill && (
                    <div className='mb-1 rounded-lg border border-border bg-muted/50 px-4 py-3 text-sm'>
                        <div className='font-medium'>{challanPrefill.title}</div>
                        <div className='mt-1'>{challanPrefill.note}</div>
                    </div>
                )}

                {takesMri && (
                    <MriPanel mri={mri} onChange={setMri} mriNo={mriNo} party={selectedCustomer?.name || ''} />
                )}

                {(billsFromOrder || billsFromChallan) && (
                    <div className="no-print flex justify-end gap-2">
                        {billsFromChallan && (
                            <button type="button" className="btn btn-secondary" onClick={() => setShowChallanPicker(true)}>
                                Pending challan [Alt+L]
                            </button>
                        )}
                        {billsFromOrder && (
                            <button type="button" className="btn btn-secondary" onClick={openPicker}>
                                Bill from order
                            </button>
                        )}
                    </div>
                )}

                {/* Series, Invoice & Date -- Sigfa's own order, series first. */}
                <div className='panel panel-body flex flex-wrap gap-5'>
                    {/* Hidden until a series exists for this document: a box
                        whose only entry is "None" is a question with no answer.
                        Alt+A creates one from here once it is shown. */}
                    {seriesChoices.length > 0 && (
                        <div className='field w-40'>
                            <label className='field-label mb-1'>Series</label>
                            <select
                                className='field-select'
                                data-master-field='series'
                                value={chosenSeries}
                                onChange={(e) => setSeries(e.target.value)}
                            >
                                <option value=''>None</option>
                                {seriesChoices.map((option) => (
                                    <option key={option._id || option.code} value={option.code}>
                                        {option.name ? `${option.code} — ${option.name}` : option.code}
                                    </option>
                                ))}
                            </select>
                        </div>
                    )}
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
                            onChange={(e) => pickCustomer(e.target.value)} 
                            className='field-select'
                            /* Alt+A / Alt+M / Alt+D act on the party master
                               from here. Its own value IS the party's name. */
                            data-master-field='customer'
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
                                <p className='field-hint'>From the party&apos;s master.</p>
                            )}
                        </div>
                    </div>

                    <div>
                        <div className='flex justify-between items-center'>
                            <div className='flex items-center gap-2'>
                                <label htmlFor='local' className='text-sm font-medium text-foreground'>Local</label>
                                <input 
                                    type='radio' 
                                    id='local' 
                                    name='location' 
                                    value='local'
                                    className='field-check' 
                                    checked={effectiveTaxType === 'local'} 
                                    /* Settled by the two states whenever both
                                       are known: the server derives the same
                                       answer and stores that, so offering a
                                       choice here would be offering one the
                                       save would overrule. */
                                    disabled={Boolean(derivedTaxType)}
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
                                    checked={effectiveTaxType === 'central'} 
                                    disabled={Boolean(derivedTaxType)}
                                    onChange={handleTaxTypeChange} 
                                />
                            </div>
                        </div>

                        {/* Why it says what it says. A disabled pair of radios
                            with no explanation is the kind of thing that gets
                            reported as a bug. */}
                        {derivedTaxType && (
                            <p className='field-hint mt-1'>
                                {derivedTaxType === 'local'
                                    ? `Both in ${place.stateOfSupply || 'the same state'}, so CGST + SGST.`
                                    : `${company?.state || `State ${company?.stateCode}`} to ${place.stateOfSupply || `state ${place.stateCode}`}, so IGST.`}
                            </p>
                        )}
                        {!derivedTaxType && selectedCustomer?.name && (
                            <p className='field-hint mt-1'>
                                {company?.stateCode
                                    ? 'This party has no state on their master, so pick the tax type yourself.'
                                    : 'Your firm has no state code in Company setup, so pick the tax type yourself.'}
                            </p>
                        )}
                    </div>

                    {/* Item search. Was a <select> listing the whole master in
                        master order -- workable at forty items, not at four
                        hundred, and it forced the mouse for every line. The
                        list is already in the browser (/api/get-item does
                        find({})), so this needs no request and no debounce. */}
                    <ItemSearch
                        items={item}
                        inputRef={itemBoxRef}
                        priceOf={(sourceItem) => defaultPricing(sourceItem).rate}
                        stockOf={(sourceItem) => Number(sourceItem.lastQuantity)}
                        onPick={(sourceItem) => {
                            // Routed through the SAME handler the <select>
                            // used, so the description and per-pack popups,
                            // the price-list rate and the GST all behave as
                            // before. Only the way an item is chosen changed.
                            saveItem({ target: { value: sourceItem.name } });
                            // Focus follows the clerk: the new line's quantity
                            // is where they are going next. Deferred a tick
                            // because the row does not exist until React has
                            // rendered it.
                            setTimeout(() => {
                                const rows = document.querySelectorAll('[data-billing-field="quantity"]');
                                rows[rows.length - 1]?.focus();
                                rows[rows.length - 1]?.select?.();
                            }, 0);
                        }}
                    />
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
                                        {mri.on && takesMri && <th className='text-right'>Received</th>}
                                        <th className='text-right'>{mri.on && takesMri ? 'Accepted' : 'Quantity'}</th>
                                        {mri.on && takesMri && <th className='text-right'>Rejected</th>}
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
                                            {mri.on && takesMri && (
                                                <td>
                                                    <input
                                                        type='number'
                                                        min='0'
                                                        className='field-input field-input-sm num w-20'
                                                        value={items.receivedQty ?? ''}
                                                        placeholder={String(items.quantity ?? '')}
                                                        onChange={(e) => handleReceivedChange(index, e.target.value)}
                                                        onFocus={() => setActiveRow(index)}
                                                        title='Received. Blank means everything received was accepted.'
                                                    />
                                                </td>
                                            )}
                                            <td>
                                                <input 
                                                    type='number' 
                                                    min={mri.on && takesMri ? '0' : '1'} 
                                                    className='field-input field-input-sm num w-20' 
                                                    value={items.quantity} 
                                                    onChange={(e) => handleItemFieldChange(index, 'quantity', e.target.value)}
                                                    data-billing-field='quantity'
                                                    /* The master behind a line is its ITEM --
                                                       the box itself holds a number. */
                                                    data-master-field='item'
                                                    data-master-value={items.name}
                                                    onFocus={() => setActiveRow(index)}
                                                    onKeyDown={(e) => onRowKeyDown(e, index, 'quantity')}
                                                />
                                            </td>
                                            {mri.on && takesMri && (
                                                <td className='num'>
                                                    {rejectedQty(items) > 0 ? (
                                                        <span className='font-medium text-destructive'>{trimQty(rejectedQty(items))}</span>
                                                    ) : (
                                                        '—'
                                                    )}
                                                </td>
                                            )}
                                            <td>
                                                <input 
                                                    type='number' 
                                                    min='0' 
                                                    className='field-input field-input-sm num w-24' 
                                                    value={items.cost} 
                                                    onChange={(e) => handleItemFieldChange(index, 'cost', e.target.value)}
                                                    data-billing-field='cost'
                                                    /* The master behind a line is its ITEM --
                                                       the box itself holds a number. */
                                                    data-master-field='item'
                                                    data-master-value={items.name}
                                                    onFocus={() => setActiveRow(index)}
                                                    onKeyDown={(e) => onRowKeyDown(e, index, 'cost')}
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
                                                    data-billing-field='discount'
                                                    /* The master behind a line is its ITEM --
                                                       the box itself holds a number. */
                                                    data-master-field='item'
                                                    data-master-value={items.name}
                                                    onFocus={() => setActiveRow(index)}
                                                    onKeyDown={(e) => onRowKeyDown(e, index, 'discount')}
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
                        <label className="field-label mb-1">
                            {config.type === 'Purchase' ? 'Supplier Bill No' : 'Their Bill No'}
                        </label>
                        <input
                            type="text"
                            className="field-input"
                            value={partyBillNo}
                            onChange={(e) => setPartyBillNo(e.target.value)}
                            placeholder="BS/2026-27/4417"
                        />
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
                                {Object.entries(hsnTotals).map(([key, data]) => (
                                    <tr key={key}>
                                        <td>{data.hsn ?? key}</td>
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

                {billsFromChallan && showChallanPicker && (
                    <ChallanPicker
                        type={config.type}
                        partyName={selectedCustomer?.name || ''}
                        items={item}
                        recalc={recalcItem}
                        onClose={() => setShowChallanPicker(false)}
                        onPick={({ lines, used }) => {
                            // The party, when none was chosen yet: every picked
                            // challan is for the same one (the rule refuses a mix).
                            if (!selectedCustomer?.name && used[0]?.party) {
                                const party = customer.find((c) => c.name === used[0].party);
                                if (party) setSelectedCustomer(party);
                            }
                            setSelectedItem((prev) => [...prev, ...lines]);
                            setShowChallanPicker(false);
                            const label = CHALLAN_KINDS[config.type]?.label || 'Challan';
                            const moved = used.some((u) => u.stockEffect);
                            setChallanPrefill({
                                title: `From ${label} ${used.map((u) => u.challanNo).join(', ')}: ${lines.length} line${lines.length === 1 ? '' : 's'}.`,
                                note: moved
                                    ? 'Those challans already moved the stock, so this bill will not move it again.'
                                    : 'Those challans did not move stock, so this bill moves it as usual.',
                            });
                        }}
                    />
                )}

                {billsFromOrder && showPicker && (
                    <div className="modal-overlay no-print" role="dialog" aria-modal="true">
                        <div className="modal-card max-w-3xl">
                            <h2 className="modal-title mb-1">Bill from a pending order</h2>
                            <p className="field-hint mb-4">
                                Pick the lines and how much of each to bill now. The rest stays
                                pending on the order.
                            </p>

                            {pickerError && (
                                <div className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                                    {pickerError}
                                </div>
                            )}

                            {pickerOrders === null ? (
                                <div className="empty-state">Loading pending orders…</div>
                            ) : pickerOrders.length === 0 ? (
                                <div className="empty-state">
                                    No pending {ORDER_DOC.toLowerCase()} orders
                                    {selectedCustomer?.name ? ` for ${selectedCustomer.name}` : ''}.
                                </div>
                            ) : (
                                <>
                                    <div className="field mb-3">
                                        <label className="field-label">Order</label>
                                        <select
                                            className="field-select"
                                            value={pickerOrderNo}
                                            onChange={(e) => {
                                                setPickerOrderNo(e.target.value);
                                                setPicks({});
                                                setPickerError('');
                                            }}
                                        >
                                            <option value="">Select…</option>
                                            {pickerOrders.map((o) => (
                                                <option key={o.orderNo} value={o.orderNo}>
                                                    {o.orderNo} · {o.customer?.name}
                                                    {o.reference ? ` · ${o.reference}` : ''}
                                                </option>
                                            ))}
                                        </select>
                                    </div>

                                    {pickerOrder && (
                                        <div className="table-wrap mb-4">
                                            <table className="data-table">
                                                <thead>
                                                    <tr>
                                                        <th>Item</th>
                                                        <th className="num">Ordered</th>
                                                        <th className="num">Billed</th>
                                                        <th className="num">Pending</th>
                                                        <th className="num">Rate</th>
                                                        <th className="num">Bill now</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {(pickerOrder.pickable || []).map((r) => (
                                                        <tr key={r.orderLineId}>
                                                            <td>{r.item}</td>
                                                            <td className="num">{trimQty(r.ordered)}</td>
                                                            <td className="num">{trimQty(r.billed)}</td>
                                                            <td className="num font-medium">{trimQty(r.pending)}</td>
                                                            <td className="num">{r.rate}</td>
                                                            <td className="num">
                                                                <input
                                                                    type="number"
                                                                    step="0.001"
                                                                    min="0"
                                                                    max={r.pending}
                                                                    className="field-input field-input-sm num w-24"
                                                                    value={picks[r.orderLineId] ?? ''}
                                                                    placeholder="0"
                                                                    onChange={(e) =>
                                                                        setPicks((p) => ({
                                                                            ...p,
                                                                            [r.orderLineId]: e.target.value,
                                                                        }))
                                                                    }
                                                                />
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    )}

                                    {pickerOrder && (
                                        <div className="mb-4 flex gap-2">
                                            <button
                                                type="button"
                                                className="btn btn-sm btn-secondary"
                                                onClick={() =>
                                                    setPicks(
                                                        Object.fromEntries(
                                                            (pickerOrder.pickable || []).map((r) => [
                                                                r.orderLineId,
                                                                r.pending,
                                                            ])
                                                        )
                                                    )
                                                }
                                            >
                                                Take everything pending
                                            </button>
                                            <button
                                                type="button"
                                                className="btn btn-sm btn-ghost"
                                                onClick={() => setPicks({})}
                                            >
                                                Clear
                                            </button>
                                        </div>
                                    )}
                                </>
                            )}

                            <div className="flex justify-end gap-2">
                                <button
                                    type="button"
                                    className="btn btn-secondary"
                                    onClick={() => setShowPicker(false)}
                                >
                                    Close
                                </button>
                                <button
                                    type="button"
                                    className="btn btn-primary"
                                    onClick={applyPicks}
                                    disabled={!pickerOrder}
                                >
                                    Add to the bill
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Save Button */}
                <div className='sticky bottom-0 -mx-4 mt-2 flex flex-col border-t border-border bg-card/90 px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur sm:-mx-6 sm:px-6'>
                <EinvoiceLockNotice reason={einvoiceLock} />
                <Notice notice={notice} onClose={notify.clear} className='mb-2' />
                <button 
                    className='btn btn-primary mx-auto h-11 w-fit px-8 text-base' 
                    onClick={handleSave}
                    disabled={Boolean(einvoiceLock) || saving}
                    aria-busy={saving}
                    title={einvoiceLock || undefined}
                >
                    {saving ? 'Saving…' : 'Save Invoice'}
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

                {/* Sigfa's Alt+A: create the master the focused field needs,
                    without abandoning the bill. */}
                {/* Create (Alt+A) and Alter (Alt+M), both through one dialog
                    and one hook -- see components/masters/useMasterActions.js.
                    An ALTER posts the whole loaded record with the edits over
                    it; a partial body would reset `uqc` and `isService`. */}
                <QuickMaster
                    kind={masters.dialog?.kind}
                    mode={masters.dialog?.mode}
                    record={masters.dialog?.record}
                    prefill={masters.dialog?.prefill}
                    onClose={masters.closeDialog}
                    onSaved={({ kind }) => reloadMaster(kind)}
                />

                {/* Why a master key did nothing, in a sentence. Silence is
                    indistinguishable from a broken shortcut -- which is how
                    nine of these came to be reported as not working. */}
                {masters.problem && (
                    <div className="modal-overlay" role="dialog" aria-modal="true">
                        <div className="modal-card max-w-md">
                            <div className="modal-title">Nothing to do here</div>
                            <p className="text-sm text-muted-foreground">{masters.problem}</p>
                            <div className="mt-5 flex justify-end">
                                <button
                                    type="button"
                                    className="btn btn-primary"
                                    onClick={masters.clearProblem}
                                    autoFocus
                                >
                                    Right
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {/* Sigfa's Alt+H. */}
                {/* `bound` comes from the hook, not from the shortcut table:
                    the overlay once advertised all nineteen keys while ten
                    were wired. */}
                <ShortcutHelp
                    open={showShortcuts}
                    bound={boundKeys}
                    onClose={() => setShowShortcuts(false)}
                />

                <InfoPanel
                    open={Boolean(infoPanel)}
                    title={infoPanel?.title}
                    subtitle={infoPanel?.subtitle}
                    rows={infoPanel?.rows}
                    onClose={() => setInfoPanel(null)}
                />

                <LookupList
                    open={Boolean(lookup)}
                    title={lookup?.title}
                    rows={lookup?.rows}
                    picks={Boolean(lookup?.picks)}
                    onPick={(row) => {
                        // Routed through the same change handler the dropdown
                        // uses, so the price list, the place of supply and the
                        // balance strip all behave as they always did.
                        if (row?.name) pickCustomer(row.name);
                    }}
                    onClose={() => setLookup(null)}
                />

                {/* Deleting a line by keyboard is confirmed. A mis-keyed Alt+E
                    on a finished bill would otherwise drop a line in silence. */}
                {confirmRemove !== null && selectedItem[confirmRemove] && (
                    <div className='modal-overlay' role='dialog' aria-modal='true'>
                        <div className='modal-card max-w-sm'>
                            <div className='modal-title'>Remove this line?</div>
                            <p className='text-sm text-muted-foreground'>
                                {selectedItem[confirmRemove].name} &mdash; the other lines are
                                untouched.
                            </p>
                            <div className='mt-5 flex justify-end gap-2'>
                                <button
                                    type='button'
                                    className='btn btn-secondary'
                                    onClick={() => setConfirmRemove(null)}
                                >
                                    Cancel
                                </button>
                                <button
                                    type='button'
                                    className='btn btn-danger'
                                    onClick={() => {
                                        handleRemove(confirmRemove);
                                        setConfirmRemove(null);
                                        setActiveRow(null);
                                        itemBoxRef.current?.focus();
                                    }}
                                >
                                    Remove
                                </button>
                            </div>
                        </div>
                    </div>
                )}

            </div>
        </>
    )
}
