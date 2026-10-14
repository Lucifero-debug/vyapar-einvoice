'use client';
import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Barcode,
  BookOpenText,
  Boxes,
  Check,
  ChevronsUpDown,
  ClipboardCheck,
  Landmark,
  Package,
  Pencil,
  Plus,
  Printer,
  ReceiptIndianRupee,
  ClipboardList,
  FileSpreadsheet,
  LineChart,
  ScrollText,
  Settings,
  Tags,
  ShoppingCart,
  Trash2,
  Truck,
  Undo2,
  Upload,
  UserCog,
  Users,
  Wallet,
  X,
  BookOpen,
  ArrowLeftRight,
  Hash,
} from 'lucide-react';
import { kindOf } from '@/lib/voucherKinds.mjs';
import { Button } from '../components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '../components/ui/command';
import { cn } from '../lib/utils';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '../components/ui/popover';
import HsnMaster from '@/components/HsnMaster';
import CustomerGroupMaster from '@/components/CustomerGroupMaster';
import StateMaster from '@/components/StateMaster';
import SeriesMaster from '@/components/SeriesMaster';
import PriceListMaster from '@/components/PriceListMaster';
import { priceListLabel } from '@/lib/priceList.mjs';
import { Notice, useNotice } from '@/components/ui/notice';
import { NETWORK_ERROR, readResponse } from '@/lib/apiResponse.mjs';

const currency = (n) =>
  `₹${Number(n || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const Page = () => {
  const router = useRouter();
  // Only an owner is shown the Staff tile. Tidiness, not security: /staff is
  // mapped to `user:manage` in lib/roles.mjs, so the edge middleware turns
  // anybody else away and /api/staff refuses them again. A hidden link is not
  // a locked door -- it just stops a biller clicking something that bounces.
  const [myRole, setMyRole] = useState('');
  const [showHsnMaster, setShowHsnMaster] = useState(false);
  const [showGroupMaster, setShowGroupMaster] = useState(false);
  const [showStateMaster, setShowStateMaster] = useState(false);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [customer, setCustomer] = useState([]);
  const [totalSalesAmount, setTotalSalesAmount] = useState(0);
  const [saleInvoices, setSaleInvoices] = useState([]);
  const [purchaseInvoices, setPurchaseInvoices] = useState([]);
  const [saleReturns, setSaleReturns] = useState([]);
  // Challans still to bill, per side -- the count on the Sales Challan and
  // Purchase Challan rows. null until loaded.
  const [pendingChallans, setPendingChallans] = useState({ Sale: null, Purchase: null });
  // Purchase MRIs with rejected material and no Re-MRI yet (lib/mri.mjs).
  const [pendingMriCount, setPendingMriCount] = useState(null);
  const [purchaseReturns, setPurchaseReturns] = useState([]);
  const [alterState, setAlterState] = useState('');
  const [deleteState, setDeleteState] = useState('');
  const [item, setItem] = useState([]);
  const [hsn, setHsn] = useState([]);
  const [bank, setBank] = useState([]);
  const [cash, setCash] = useState([]);
  // The two money vouchers the app could not make until the four kinds
  // existed: a journal with no cash leg, and a transfer between our own
  // accounts. lib/voucherKinds.mjs.
  const [journal, setJournal] = useState([]);
  const [contra, setContra] = useState([]);
  const [alter, setAlter] = useState(false);
  const [del, setDel] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, notify] = useNotice();
  const [selectedHsn, setSelectedHsn] = useState(null);
  const [groups, setGroups] = useState([]);
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [states, setStates] = useState([]);
  // The series master -- Sigfa's SubKey, which it keeps under Setup.
  const [series, setSeries] = useState([]);
  const [selectedState, setSelectedState] = useState(null);
  const [showSeriesMaster, setShowSeriesMaster] = useState(false);
  const [selectedSeries, setSelectedSeries] = useState(null);
  const [priceLists, setPriceLists] = useState([]);
  const [showPriceListMaster, setShowPriceListMaster] = useState(false);
  const [selectedPriceList, setSelectedPriceList] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.success) setMyRole(data.user?.role || '');
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    /**
     * Load one endpoint. Never throws.
     *
     * The dashboard used to await all of them together and read the arrays
     * straight off the response — `custData.customer.map(...)`. One endpoint
     * answering with an error payload, or simply not existing yet, therefore
     * took down the ENTIRE home screen with "Failed to fetch data", and the
     * console said only which property was undefined, not which route sent it.
     */
    const loadJson = async (url, pick, fallback = []) => {
      try {
        const res = await fetch(url);
        const data = await res.json();

        if (!res.ok || data?.success === false) {
          console.error(`${url} -> ${res.status}`, data?.error || data?.message || '');
          return fallback;
        }

        const value = pick(data);
        return value === undefined || value === null ? fallback : value;
      } catch (err) {
        console.error(`${url} failed:`, err);
        return fallback;
      }
    };

    const fetchData = async () => {
      try {
        const [
          items,
          customers,
          invoices,
          hsnCodes,
          vouchers,
          lists,
          groupList,
          stateList,
          seriesList,
        ] = await Promise.all([
            loadJson('/api/get-item', (d) => d.item),
            loadJson('/api/get-customer', (d) => d.customer),
            loadJson('/api/get-invoice', (d) => d.invoice),
            loadJson('/api/get-hsn', (d) => d.hsn),
            loadJson('/api/get-voucher', (d) => d.voucher),
            loadJson('/api/get-price-list', (d) => d.priceList),
            loadJson('/api/get-group', (d) => d.group),
            loadJson('/api/get-state', (d) => d.state),
            loadJson('/api/get-series', (d) => d.series),
          ]);

        setCustomer(
          customers.map(cust => ({
            id: cust._id,
            name: cust.name || cust.customerName || cust._id
          }))
        );

        setItem(
          items.map(it => ({
            id: it._id,
            name: it.name || it.itemName || it._id
          }))
        );

        setHsn(hsnCodes.map(hs => ({ ...hs, id: hs._id })));

        setGroups(groupList.map(g => ({ ...g, id: g._id })));

        setStates(stateList.map(s => ({ ...s, id: s._id })));

        setSeries(seriesList.map(s => ({ ...s, id: s._id })));

        setPriceLists(
          lists.map(pl => ({
            ...pl,
            id: pl._id,
            name: priceListLabel(pl)
          }))
        );

        /*
          Split by KIND first, then by instrument.

          A contra carries a cash or bank paymentType exactly as a receipt
          does, so filtering on the instrument alone counted every one of
          them twice -- once under Cash or Bank and again under Contra. An
          entry saved before the kinds existed has none, and `kindOf` reads
          it off the figures as a receipt or a payment, so it still lands
          under its own instrument where it always did.
        */
        const codeOf = (v) => kindOf(v).code;

        setBank(
          vouchers.filter(v => v.paymentType === 'Bank' && codeOf(v) !== 'CONTRA').map(v => ({
            id: v._id,
            name: v.acName || v.accountName || v._id
          }))
        );

        setCash(
          vouchers.filter(v => v.paymentType === 'Cash' && codeOf(v) !== 'CONTRA').map(v => ({
            id: v._id,
            name: v.acName || v.accountName || v._id
          }))
        );

        setJournal(
          vouchers.filter(v => codeOf(v) === 'JOURNAL').map(v => ({
            id: v._id,
            // A journal has no acName to be named after, so it is named by
            // what it was for -- its narration, or the first account it
            // touched.
            name: v.narration || v.customers?.[0]?.name || v._id
          }))
        );

        setContra(
          vouchers.filter(v => codeOf(v) === 'CONTRA').map(v => ({
            id: v._id,
            name: v.acName || v.accountName || v._id
          }))
        );

        // Categorize invoices. `customer` is optional on the invoice schema, so
        // a bill saved without one must not take the whole dashboard down.
        const named = (inv) => inv.customer?.name || '—';

        const saleInv = invoices.filter(inv => inv.type === 'Sale' && !inv.return).map(inv => ({
          invoiceNo: inv.invoiceNo || inv.id,
          totalAmount: inv.totalAmount || 0,
          customer: named(inv)
        }));
        const purchaseInv = invoices.filter(inv => inv.type === 'Purchase' && !inv.return).map(inv => ({
          invoiceNo: inv.invoiceNo || inv.id,
          customer: named(inv)
        }));
        const saleRet = invoices.filter(inv => inv.type === 'Sale' && inv.return).map(inv => ({
          invoiceNo: inv.invoiceNo || inv.id,
          customer: named(inv)
        }));
        const purchaseRet = invoices.filter(inv => inv.type === 'Purchase' && inv.return).map(inv => ({
          invoiceNo: inv.invoiceNo || inv.id,
          customer: named(inv)
        }));
        const totalSales = saleInv.reduce((sum, inv) => sum + (parseFloat(inv.totalAmount) || 0), 0);

        setTotalSalesAmount(totalSales);
        setSaleInvoices(saleInv);
        setPurchaseInvoices(purchaseInv);
        setSaleReturns(saleRet);
        setPurchaseReturns(purchaseRet);
      } catch (error) {
        // Each endpoint already degrades on its own, so reaching here means
        // something in the shaping above broke. Say so, and name it.
        console.error('Error building the dashboard:', error);
        notify.error('Could not build the dashboard. Reload the page; if it keeps happening, report it.');
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, []);

  // Pending challans for the two rows. Best effort: a failure leaves the
  // count blank rather than holding up the page.
  useEffect(() => {
    let live = true;
    for (const type of ['Sale', 'Purchase']) {
      fetch(`/api/challan?type=${type}&status=pending&limit=500`)
        .then((r) => r.json())
        .then((d) => {
          if (live && d?.success) {
            setPendingChallans((p) => ({ ...p, [type]: (d.challans || []).length }));
          }
        })
        .catch(() => {});
    }
    fetch('/api/mri?view=pending')
      .then((r) => r.json())
      .then((d) => {
        if (live && d?.success) setPendingMriCount((d.rows || []).length);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const handleSelect = (currentValue) => {
    const newValue = currentValue;
    setValue(newValue);
    setOpen(false);

    if (newValue) {
      switch (alterState) {
        case 'Customer':
          router.push(`/customeradd?value=${newValue}`);
          break;
        case 'SaleInvoice':
          router.push(`/saleadd?value=${newValue}`);
          break;
        case 'PurchaseInvoice':
          router.push(`/purchaseadd?value=${newValue}`);
          break;
        case 'SaleReturn':
          router.push(`/salereturn?value=${newValue}`);
          break;
        case 'PurchaseReturn':
          router.push(`/purchasereturn?value=${newValue}`);
          break;
        case 'Item':
          router.push(`/itemadd?value=${newValue}`);
          break;
        case 'HSN': {
          const selected = hsn.find(h => h.hsncode === newValue);
          if (selected) {
            setSelectedHsn(selected);
            setShowHsnMaster(true);
          }
          break;
        }
        case 'State': {
          const selected = states.find(s => s.id === newValue);
          if (selected) {
            setSelectedState(selected);
            setShowStateMaster(true);
          }
          break;
        }
        case 'Series': {
          const selected = series.find(s => s.id === newValue);
          if (selected) {
            setSelectedSeries(selected);
            setShowSeriesMaster(true);
          }
          break;
        }
        case 'CustomerGroup': {
          const selected = groups.find(g => g.id === newValue);
          if (selected) {
            setSelectedGroup(selected);
            setShowGroupMaster(true);
          }
          break;
        }
        case 'PriceList': {
          const selected = priceLists.find(pl => pl.id === newValue);
          if (selected) {
            setSelectedPriceList(selected);
            setShowPriceListMaster(true);
          }
          break;
        }
        case 'Bank':
          router.push(`/voucheradd?type=Bank&value=${newValue}`);
          break;
        case 'Cash':
          router.push(`/voucheradd?type=Cash&value=${newValue}`);
          break;
        // No `type` on these two: the form takes the kind and the instrument
        // from the voucher it loads, and a journal has no instrument to
        // name. A ?type= here would be ignored anyway -- the form applies
        // the URL's own only when there is no voucher to read.
        case 'Journal':
        case 'Contra':
          router.push(`/voucheradd?value=${newValue}`);
          break;
        default:
          console.warn('Unsupported alterState:', alterState);
          notify.error(`Editing ${alterState} is not available from here.`);
      }
    }
  };

  const handleDelete = async (currentValue) => {
    let endpoint = '';
    switch (deleteState) {
      case 'Customer':
        endpoint = `/api/delete-cust?id=${currentValue}`;
        break;
      case 'Item':
        endpoint = `/api/delete-item?id=${currentValue}`;
        break;
      case 'SaleInvoice':
      case 'PurchaseInvoice':
      case 'SaleReturn':
      case 'PurchaseReturn':
        endpoint = `/api/delete-invoice?id=${currentValue}`;
        break;
      case 'HSN':
        endpoint = `/api/delete-hsn?id=${currentValue}`;
        break;
      case 'CustomerGroup':
        endpoint = `/api/delete-group?id=${currentValue}`;
        break;
      case 'State':
        endpoint = `/api/delete-state?id=${currentValue}`;
        break;
      // Refused while any slip carries it. Switching the series off is the
      // way to retire one -- the slips keep their label.
      case 'Series':
        endpoint = `/api/delete-series?id=${currentValue}`;
        break;
      case 'PriceList':
        endpoint = `/api/delete-price-list?id=${currentValue}`;
        break;
      case 'Bank':
        endpoint = `/api/delete-voucher?id=${currentValue}&type=Bank`;
        break;
      case 'Cash':
        endpoint = `/api/delete-voucher?id=${currentValue}&type=Cash`;
        break;
      // Same route: it reverses from the voucher's OWN stored kind, which is
      // the only thing that can undo what was posted.
      case 'Journal':
      case 'Contra':
        endpoint = `/api/delete-voucher?id=${currentValue}`;
        break;
      default:
        notify.error(`Deleting ${deleteState} is not available from here.`);
        return;
    }

    notify.info('Deleting…');
    try {
      const response = await fetch(endpoint, { method: 'POST' });
      // `success` is not sent by every delete route (delete-invoice answers
      // with its counts), so a 2xx without `success: false` is a success.
      const { ok, message } = await readResponse(response);
      if (ok) {
        window.location.reload();
      } else {
        console.error('Failed to delete:', response.status);
        notify.error(`Not deleted. ${message}`);
      }
    } catch (error) {
      console.error('Error during delete request:', error);
      notify.error(`Not deleted. ${NETWORK_ERROR}`);
    }
  };

  // One entry point per intent, so the two picker modes can never both be open
  const startAlter = (section) => {
    setValue('');
    setDel(false);
    setDeleteState('');
    setAlterState(section);
    setAlter(true);
  };

  const startDelete = (section) => {
    setValue('');
    setAlter(false);
    setAlterState('');
    setDeleteState(section);
    setDel(true);
  };

  const closePicker = () => {
    setValue('');
    setOpen(false);
    setAlter(false);
    setDel(false);
    setAlterState('');
    setDeleteState('');
  };

  const entitiesFor = (sectionName) => {
    switch (sectionName) {
      case 'Customer': return customer;
      case 'Item': return item;
      case 'HSN': return hsn;
      case 'CustomerGroup': return groups;
      case 'State': return states;
      case 'Series': return series;
      case 'PriceList': return priceLists;
      case 'Bank': return bank;
      case 'Cash': return cash;
      case 'Journal': return journal;
      case 'Contra': return contra;
      case 'SaleInvoice': return saleInvoices;
      case 'PurchaseInvoice': return purchaseInvoices;
      case 'SaleReturn': return saleReturns;
      case 'PurchaseReturn': return purchaseReturns;
      default: return [];
    }
  };

  const isNamed = (sectionName) =>
    sectionName === 'Customer' ||
    sectionName === 'Item' ||
    sectionName === 'CustomerGroup' ||
    sectionName === 'State' ||
    sectionName === 'PriceList' ||
    sectionName === 'Bank' ||
    sectionName === 'Cash';

  const renderAlterDeleteSection = (sectionName) => {
    const isAlter = alter && alterState === sectionName;
    const isDelete = del && deleteState === sectionName;
    if (!isAlter && !isDelete) return null;

    const entities = entitiesFor(sectionName);

    const getDisplayValue = () => {
      if (!value) return isAlter ? `Select ${sectionName} to edit` : `Select ${sectionName} to delete`;

      const selected = entities.find((e) => {
        if (sectionName === 'HSN') return e.hsncode === value;
        // A series is known by its CODE -- `name` on the record is the
        // description, so it is listed under its own branch rather than with
        // the named masters.
        if (sectionName === 'Series') return e.id === value;
        if (isNamed(sectionName)) return e.id === value || e.name === value;
        return e.invoiceNo === value;
      });

      if (!selected) return `Select ${sectionName}`;
      if (sectionName === 'HSN') return selected.hsncode;
      if (sectionName === 'Series') return selected.code;
      if (isNamed(sectionName)) return selected.name;
      return selected.invoiceNo;
    };

    return (
      <div
        className={cn(
          'mt-2 flex items-center gap-2 rounded-lg border p-2',
          isDelete
            ? 'border-destructive/30 bg-destructive/5'
            : 'border-primary/30 bg-accent/60'
        )}
      >
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              className="h-9 flex-1 justify-between bg-card text-sm font-normal"
            >
              <span className="truncate">{getDisplayValue()}</span>
              <ChevronsUpDown className="opacity-50" />
            </Button>
          </PopoverTrigger>

          <PopoverContent className="w-[min(320px,calc(100vw-2rem))] p-0" align="start">
            <Command>
              <CommandInput placeholder={`Search ${sectionName}...`} className="h-9" />
              <CommandList>
                <CommandEmpty>No result found.</CommandEmpty>
                <CommandGroup>
                  {entities.map((entity) => {
                    let label = '';
                    let alterValue = '';
                    let deleteValue = '';

                    if (sectionName === 'HSN') {
                      label = entity.hsncode;
                      alterValue = entity.hsncode;
                      deleteValue = entity.id;
                    } else if (sectionName === 'Series') {
                      // The description alongside the code, because "MI" six
                      // months later is not self-explanatory.
                      label = entity.name ? `${entity.code} — ${entity.name}` : entity.code;
                      alterValue = entity.id;
                      deleteValue = entity.id;
                    } else if (isNamed(sectionName)) {
                      label = entity.name;
                      alterValue = entity.id;
                      deleteValue = entity.id;
                    } else {
                      label = entity.invoiceNo;
                      alterValue = entity.invoiceNo;
                      deleteValue = entity.invoiceNo;
                    }

                    return (
                      <CommandItem
                        key={deleteValue}
                        value={String(label)}
                        onSelect={() => {
                          setValue(isAlter ? alterValue : deleteValue);
                          setOpen(false);

                          if (isAlter) {
                            handleSelect(alterValue);
                          } else if (
                            window.confirm(
                              `Delete ${sectionName} "${label}"? This cannot be undone.`
                            )
                          ) {
                            handleDelete(deleteValue);
                          }
                        }}
                      >
                        <span className="truncate">{label}</span>
                        <Check
                          className={cn(
                            'ml-auto',
                            value === alterValue || value === deleteValue
                              ? 'opacity-100'
                              : 'opacity-0'
                          )}
                        />
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        <button
          type="button"
          onClick={closePicker}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          aria-label="Cancel"
          title="Cancel"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  };

  // A master/document row: name on the left, the three verbs behind one menu
  /**
   * One stock voucher, as a full-width row.
   *
   * The same shape as the Cash and Bank rows below -- icon square, label and
   * a line of subtext, action on the right -- because it sits directly under
   * them. These were a three-across grid of nav-tiles first, which on a wide
   * screen put all three on one line and read as a different kind of thing
   * pasted into the section.
   *
   * No Manage dropdown: Cash and Bank have one because a master can be
   * created, altered and deleted from the dashboard. A stock voucher is
   * altered and deleted from its own register, so there is one action here
   * and it opens the screen.
   */
  const renderStockVoucherRow = ({ label, hint, icon: Icon, href }) => (
    <div
      key={href}
      className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 transition-colors hover:border-primary/30"
    >
      <span className="nav-tile-icon h-8 w-8">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{label}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="shrink-0"
        onClick={() => router.push(href)}
      >
        Open
      </Button>
    </div>
  );

  const renderModuleRow = ({ section, label, icon: Icon, count, onCreate }) => (
    <div>
      <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 transition-colors hover:border-primary/30">
        <span className="nav-tile-icon h-8 w-8">
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{label}</p>
          {typeof count === 'number' && (
            <p className="text-xs text-muted-foreground">
              {count} {count === 1 ? 'record' : 'records'}
            </p>
          )}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="shrink-0">
              Manage
              <ChevronsUpDown className="opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuLabel>{label}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={onCreate}>
                <Plus className="h-4 w-4" /> Create
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => startAlter(section)}>
                <Pencil className="h-4 w-4" /> Alter
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() => startDelete(section)}
              >
                <Trash2 className="h-4 w-4" /> Delete
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {renderAlterDeleteSection(section)}
    </div>
  );

  // A challan row (SIGFA's SC / PC) in the Sales or Purchases panel. Create
  // opens the form; Alter and Delete open the register, where each challan
  // carries its own protections (a billed challan cannot be deleted).
  const renderChallanRow = ({ type, label }) => {
    const pending = pendingChallans[type];
    return (
      <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 transition-colors hover:border-primary/30">
        <span className="nav-tile-icon h-8 w-8">
          <Truck className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{label}</p>
          {typeof pending === 'number' && (
            <p className="text-xs text-muted-foreground">
              {pending} pending to bill
            </p>
          )}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="shrink-0">
              Manage
              <ChevronsUpDown className="opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel>{label}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => router.push(`/challanadd?type=${type}`)}>
                <Plus className="h-4 w-4" /> Create
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => router.push(`/challan?type=${type}&status=`)}>
                <Pencil className="h-4 w-4" /> Alter / Delete
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => router.push(`/challan?type=${type}&status=pending`)}>
                <ScrollText className="h-4 w-4" /> Pending challans
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  };

  // Purchase M.R.I. (SIGFA's material receipt note) in the Purchases panel.
  // An MRI is a purchase bill or a purchase challan with received, accepted
  // and rejected quantities, so Create offers both; the registers are one
  // page with four views. lib/mri.mjs.
  const renderMriRow = () => (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 transition-colors hover:border-primary/30">
      <span className="nav-tile-icon h-8 w-8">
        <ClipboardCheck className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">Purchase M.R.I.</p>
        {typeof pendingMriCount === 'number' && (
          <p className="text-xs text-muted-foreground">
            {pendingMriCount ? `${pendingMriCount} with rejected material pending` : 'Material receipt & inspection'}
          </p>
        )}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="shrink-0">
            Manage
            <ChevronsUpDown className="opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel>Purchase M.R.I.</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => router.push('/purchaseadd?mri=1')}>
              <Plus className="h-4 w-4" /> Create on a purchase bill
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => router.push('/challanadd?type=Purchase&mri=1')}>
              <Plus className="h-4 w-4" /> Create on a purchase challan
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => router.push('/mri?view=register')}>
              <Pencil className="h-4 w-4" /> M.R.I. register (alter)
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => router.push('/mri?view=pending')}>
              <ScrollText className="h-4 w-4" /> Pending M.R.I.
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => router.push('/mri?view=rejected')}>
              <ScrollText className="h-4 w-4" /> Rejected material
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => router.push('/mri?view=party')}>
              <ScrollText className="h-4 w-4" /> Party wise rejected
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  // Ledger / stock-ledger report pickers
  const renderReportPicker = ({ label, icon: Icon, options, emptyText, allLabel, onPick, busyText }) => (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
      <span className="nav-tile-icon h-8 w-8">
        <Icon className="h-4 w-4" />
      </span>
      <p className="flex-1 text-sm font-medium text-foreground">{label}</p>

      {loading ? (
        <span className="text-xs text-muted-foreground">{busyText}</span>
      ) : (
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="w-[190px] justify-between font-normal">
              <span className="truncate">Open report</span>
              <ChevronsUpDown className="opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[min(280px,calc(100vw-2rem))] p-0" align="end">
            <Command>
              <CommandInput placeholder={`Search...`} className="h-9" />
              <CommandList>
                <CommandEmpty>{emptyText}</CommandEmpty>
                <CommandGroup>
                  <CommandItem value="__all__" onSelect={() => onPick('0')}>
                    {allLabel}
                  </CommandItem>
                  {options.map((opt) => (
                    <CommandItem
                      key={opt.id}
                      value={String(opt.name)}
                      onSelect={() => onPick(opt.id)}
                    >
                      <span className="truncate">{opt.name}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );

  const stats = [
    { label: 'Sale invoices', value: saleInvoices.length },
    { label: 'Purchases', value: purchaseInvoices.length },
    { label: 'Customers', value: customer.length },
    { label: 'Items', value: item.length },
  ];

  return (
    <div className="page-shell space-y-6">
      <Notice notice={notice} onClose={notify.clear} className="" />
      {/* Headline figure */}
      <section className="overflow-hidden rounded-xl bg-primary text-primary-foreground shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-6 p-6 sm:p-7">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.12em] text-primary-foreground/70">
              Total sales
            </p>
            <h1 className="mt-2 text-3xl font-semibold tabular-nums sm:text-4xl">
              {loading ? '—' : currency(totalSalesAmount)}
            </h1>
            <p className="mt-2 text-sm text-primary-foreground/80">
              Across {saleInvoices.length} sale {saleInvoices.length === 1 ? 'invoice' : 'invoices'}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => router.push('/saleadd')}
              className="btn btn-sm bg-primary-foreground text-primary hover:bg-primary-foreground/90"
            >
              <Plus className="h-4 w-4" /> New sale
            </button>
            <button
              type="button"
              onClick={() => router.push('/purchaseadd')}
              className="btn btn-sm border border-primary-foreground/30 bg-primary-foreground/10 text-primary-foreground hover:bg-primary-foreground/20"
            >
              <Plus className="h-4 w-4" /> New purchase
            </button>
          </div>
        </div>
      </section>

      {/* At-a-glance counts */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="stat-card">
            <p className="stat-label">{s.label}</p>
            <p className="stat-value">{loading ? '—' : s.value}</p>
          </div>
        ))}
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Sales */}
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">Sales</h2>
            <span className="chip">
              <ReceiptIndianRupee className="h-3.5 w-3.5" />
              {saleInvoices.length + saleReturns.length}
            </span>
          </div>
          <div className="panel-body space-y-3">
            {renderModuleRow({
              section: "SaleInvoice",
              label: "Sale Invoice",
              icon: ReceiptIndianRupee,
              count: saleInvoices.length,
              onCreate: () => router.push('/saleadd'),
            })}
            {renderModuleRow({
              section: "SaleReturn",
              label: "Sale Return",
              icon: Undo2,
              count: saleReturns.length,
              onCreate: () => router.push('/salereturn'),
            })}
            {renderChallanRow({ type: 'Sale', label: 'Sales Challan' })}
          </div>
        </section>

        {/* Purchases */}
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">Purchases</h2>
            <span className="chip">
              <ShoppingCart className="h-3.5 w-3.5" />
              {purchaseInvoices.length + purchaseReturns.length}
            </span>
          </div>
          <div className="panel-body space-y-3">
            {renderModuleRow({
              section: "PurchaseInvoice",
              label: "Purchase Invoice",
              icon: ShoppingCart,
              count: purchaseInvoices.length,
              onCreate: () => router.push('/purchaseadd'),
            })}
            {renderModuleRow({
              section: "PurchaseReturn",
              label: "Purchase Return",
              icon: Undo2,
              count: purchaseReturns.length,
              onCreate: () => router.push('/purchasereturn'),
            })}
            {renderChallanRow({ type: 'Purchase', label: 'Purchase Challan' })}
            {renderMriRow()}
          </div>
        </section>

        {/* Masters */}
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">Masters</h2>
          </div>
          <div className="panel-body space-y-3">
            {renderModuleRow({
              section: "Customer",
              label: "Customers",
              icon: Users,
              count: customer.length,
              onCreate: () => router.push('/customeradd'),
            })}
            {renderModuleRow({
              section: "Item",
              label: "Items",
              icon: Package,
              count: item.length,
              onCreate: () => router.push('/itemadd'),
            })}
            {renderModuleRow({
              section: "HSN",
              label: "HSN Codes",
              icon: Barcode,
              count: hsn.length,
              onCreate: () => {
              setSelectedHsn(null);
              setShowHsnMaster(true);
              },
            })}
            {renderModuleRow({
              section: "CustomerGroup",
              label: "Customer Groups",
              icon: Users,
              count: groups.length,
              onCreate: () => {
                setSelectedGroup(null);
                setShowGroupMaster(true);
              },
            })}
            {renderModuleRow({
              section: "State",
              label: "States",
              icon: Landmark,
              count: states.length,
              onCreate: () => {
                setSelectedState(null);
                setShowStateMaster(true);
              },
            })}
            {/* Sigfa's SubKey, which it seeds with MI, MO and RMI. Labels a
                slip and groups the register; it does not number anything. */}
            {renderModuleRow({
              section: "Series",
              label: "Document Series",
              icon: Hash,
              count: series.length,
              onCreate: () => {
                setSelectedSeries(null);
                setShowSeriesMaster(true);
              },
            })}
            {renderModuleRow({
              section: "PriceList",
              label: "Price Lists",
              icon: Tags,
              count: priceLists.length,
              onCreate: () => {
                setSelectedPriceList(null);
                setShowPriceListMaster(true);
              },
            })}
          </div>
        </section>

        {/* Receipts & payments */}
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">Receipts &amp; Payments</h2>
          </div>
          <div className="panel-body space-y-3">
            {renderModuleRow({
              section: "Bank",
              label: "Bank",
              icon: Landmark,
              count: bank.length,
              onCreate: () => router.push('/voucheradd?type=Bank'),
            })}
            {renderModuleRow({
              section: "Cash",
              label: "Cash",
              icon: Wallet,
              count: cash.length,
              onCreate: () => router.push('/voucheradd?type=Cash'),
            })}
            {/* The two this section could not offer before.

                A JOURNAL has no cash or bank leg at all -- depreciation, a
                bad debt written off, discount allowed, a provision -- and
                was impossible while every voucher required a payment type.
                A CONTRA moves money between our own accounts: cash banked,
                cash drawn. Both reach the same form, which heads itself by
                the kind in the link. lib/voucherKinds.mjs. */}
            {renderModuleRow({
              section: "Journal",
              label: "Journal",
              icon: BookOpen,
              count: journal.length,
              onCreate: () => router.push('/voucheradd?kind=JOURNAL'),
            })}
            {renderModuleRow({
              section: "Contra",
              label: "Contra",
              icon: ArrowLeftRight,
              count: contra.length,
              onCreate: () => router.push('/voucheradd?kind=CONTRA&type=Bank'),
            })}

            {/* The three stock vouchers. Sigfa keeps them in one table,
                RIssue, under three keys -- 'FR' Production, 'IS' Goods
                Issued, 'RS' Goods Received -- separately from the cash and
                bank vouchers above, which live in its JOURNAL. They sit here
                together because they are the same document in three
                directions: goods moving without a bill behind them. */}
            {/* ONE PER ROW, at every width. A three-across grid put all of
                them on a single line on a desktop, which made them read as a
                different kind of control from the Cash and Bank rows directly
                above -- and left three short labels stranded in a wide row. */}
            <div className="space-y-3 border-t border-border pt-3">
              <p className="field-hint">Stock, without a bill</p>
              {renderStockVoucherRow({
                label: 'Production',
                hint: 'Issue the materials, receive the finished item',
                icon: Package,
                href: '/production',
              })}
              {renderStockVoucherRow({
                label: 'Goods Issued',
                hint: 'Stock going out without a sale',
                icon: Undo2,
                href: '/production?kind=IS',
              })}
              {renderStockVoucherRow({
                label: 'Goods Received',
                hint: 'Stock coming in without a purchase',
                icon: Boxes,
                href: '/production?kind=RS',
              })}
            </div>
          </div>
        </section>

        {/* Reports */}
        <section className="panel lg:col-span-2">
          <div className="panel-head">
            <h2 className="panel-title">Reports</h2>
          </div>
          <div className="panel-body grid gap-3 md:grid-cols-2">
            {renderReportPicker({
              label: "Customer Ledger",
              icon: BookOpenText,
              options: customer,
              allLabel: "🧾 All Accounts",
              emptyText: "No customers found.",
              busyText: "Loading customers...",
              onPick: (id) => router.push(`/ledger?customerId=${id}`),
            })}
            {renderReportPicker({
              label: "Stock Ledger",
              icon: Boxes,
              options: item,
              allLabel: "📦 All Items",
              emptyText: "No items found.",
              busyText: "Loading items...",
              onPick: (id) => router.push(`/item-ledger?itemId=${id}`),
            })}

            {/* The hub, first. The tiles below it are shortcuts to the
                reports a shop opens daily; everything -- including the two
                statements and the categories these tiles do not cover -- is
                behind this one. lib/reportCatalogue.mjs holds the list. */}
            <button type="button" className="nav-tile" onClick={() => router.push('/reports')}>
              <span className="nav-tile-icon">
                <FileSpreadsheet className="h-[18px] w-[18px]" />
              </span>
              <span className="flex-1">
                All Reports
                <span className="block text-xs font-normal text-muted-foreground">
                  Every report, by category, with its date range and downloads
                </span>
              </span>
            </button>

            <button type="button" className="nav-tile" onClick={() => router.push('/statement')}>
              <span className="nav-tile-icon">
                <BookOpenText className="h-[18px] w-[18px]" />
              </span>
              <span className="flex-1">
                Customer &amp; Supplier Statements
                <span className="block text-xs font-normal text-muted-foreground">
                  Opening, the period&apos;s entries and what is outstanding &mdash; print or send
                </span>
              </span>
            </button>

            <button type="button" className="nav-tile" onClick={() => router.push('/stock-report')}>
              <span className="nav-tile-icon">
                <Boxes className="h-[18px] w-[18px]" />
              </span>
              <span className="flex-1">
                Stock Reports
                <span className="block text-xs font-normal text-muted-foreground">
                  Summary, value wise, short list, ageing and the day book
                </span>
              </span>
            </button>

            <button type="button" className="nav-tile" onClick={() => router.push('/sales-report')}>
              <span className="nav-tile-icon">
                <ReceiptIndianRupee className="h-[18px] w-[18px]" />
              </span>
              <span className="flex-1">
                Sales &amp; Purchase
                <span className="block text-xs font-normal text-muted-foreground">
                  Book, party-wise and item-wise
                </span>
              </span>
            </button>

            <button type="button" className="nav-tile" onClick={() => router.push('/dashboard')}>
              <span className="nav-tile-icon">
                <LineChart className="h-[18px] w-[18px]" />
              </span>
              <span className="flex-1">
                Business Dashboard
                <span className="block text-xs font-normal text-muted-foreground">
                  Sales trends, dues, stock and month-on-month
                </span>
              </span>
            </button>

            <button type="button" className="nav-tile" onClick={() => router.push('/gst-return')}>
              <span className="nav-tile-icon">
                <FileSpreadsheet className="h-[18px] w-[18px]" />
              </span>
              <span className="flex-1">
                GST Returns
                <span className="block text-xs font-normal text-muted-foreground">
                  GSTR-1, GSTR-3, GSTR-3B and the e-return
                </span>
              </span>
            </button>

            <button type="button" className="nav-tile" onClick={() => router.push('/financials')}>
              <span className="nav-tile-icon">
                <BookOpenText className="h-[18px] w-[18px]" />
              </span>
              <span className="flex-1">
                Trial Balance &amp; Final Accounts
                <span className="block text-xs font-normal text-muted-foreground">
                  Trial balance, trading, profit &amp; loss and balance sheet
                </span>
              </span>
            </button>

            <button type="button" className="nav-tile" onClick={() => router.push('/account-book')}>
              <span className="nav-tile-icon">
                <BookOpenText className="h-[18px] w-[18px]" />
              </span>
              <span className="flex-1">
                Cash / Bank Book, A/C Ledger
                <span className="block text-xs font-normal text-muted-foreground">
                  Any account&apos;s book for a date range, with its opening and closing
                </span>
              </span>
            </button>

            {/* ONE tile for both books. The register itself has a Sale /
                Purchase switch, so a second tile only chose which tab opened
                first -- and it did that by sending ?type=Purchase, which the
                page then lets the user change anyway. No type is passed now:
                the register opens on its own default and the switch does the
                rest. */}
            <button type="button" className="nav-tile" onClick={() => router.push('/order')}>
              <span className="nav-tile-icon">
                <ClipboardList className="h-[18px] w-[18px]" />
              </span>
              <span className="flex-1">
                Sale / Purchase Orders
                <span className="block text-xs font-normal text-muted-foreground">
                  What has been ordered either way, and the pending reports
                </span>
              </span>
            </button>

            <button type="button" className="nav-tile" onClick={() => router.push('/bom')}>
              <span className="nav-tile-icon">
                <Package className="h-[18px] w-[18px]" />
              </span>
              <span className="flex-1">
                Bills of Material
                <span className="block text-xs font-normal text-muted-foreground">
                  What each item is made of, and what a batch costs
                </span>
              </span>
            </button>

            <button type="button" className="nav-tile" onClick={() => router.push('/production-plan')}>
              <span className="nav-tile-icon">
                <Package className="h-[18px] w-[18px]" />
              </span>
              <span className="flex-1">
                Production Plan
                <span className="block text-xs font-normal text-muted-foreground">
                  What to make for the open orders, and what is short to make it
                </span>
              </span>
            </button>

            <button type="button" className="nav-tile" onClick={() => router.push('/voucher')}>
              <span className="nav-tile-icon">
                <ScrollText className="h-[18px] w-[18px]" />
              </span>
              <span className="flex-1">Voucher Register</span>
            </button>

            <button type="button" className="nav-tile" onClick={() => router.push('/invoice-range')}>
              <span className="nav-tile-icon">
                <Printer className="h-[18px] w-[18px]" />
              </span>
              <span className="flex-1">
                Print Invoices
                <span className="block text-xs font-normal text-muted-foreground">
                  All invoices between two dates
                </span>
              </span>
            </button>

            <button type="button" className="nav-tile" onClick={() => router.push('/upload')}>
              <span className="nav-tile-icon">
                <Upload className="h-[18px] w-[18px]" />
              </span>
              <span className="flex-1">
                Upload Invoice
                <span className="block text-xs font-normal text-muted-foreground">
                  Scan a bill and import it
                </span>
              </span>
            </button>

            {myRole === 'owner' && (
              <button type="button" className="nav-tile" onClick={() => router.push('/staff')}>
                <span className="nav-tile-icon">
                  <UserCog className="h-[18px] w-[18px]" />
                </span>
                <span className="flex-1">
                  Staff
                  <span className="block text-xs font-normal text-muted-foreground">
                    Who can sign in, and what they may do
                  </span>
                </span>
              </button>
            )}
          </div>
        </section>
      </div>

      <div className="flex justify-end">
        <button type="button" className="btn btn-secondary" onClick={() => router.push('/setup')}>
          <Settings className="h-4 w-4" /> Setup
        </button>
      </div>

      {showHsnMaster && (
        <HsnMaster
          open={showHsnMaster}
          onClose={(saved) => {
            setShowHsnMaster(false);
            setSelectedHsn(null);
            if (saved === true) window.location.reload();
          }}
          selected={selectedHsn}
        />
      )}

      {showStateMaster && (
        <StateMaster
          open={showStateMaster}
          onClose={(saved) => {
            setShowStateMaster(false);
            setSelectedState(null);
            if (saved === true) window.location.reload();
          }}
          selected={selectedState}
        />
      )}

      {showSeriesMaster && (
        <SeriesMaster
          open={showSeriesMaster}
          onClose={(saved) => {
            setShowSeriesMaster(false);
            setSelectedSeries(null);
            if (saved === true) window.location.reload();
          }}
          selected={selectedSeries}
        />
      )}

      {showGroupMaster && (
        <CustomerGroupMaster
          open={showGroupMaster}
          onClose={(saved) => {
            setShowGroupMaster(false);
            setSelectedGroup(null);
            if (saved === true) window.location.reload();
          }}
          selected={selectedGroup}
        />
      )}

      {showPriceListMaster && (
        <PriceListMaster
          open={showPriceListMaster}
          onClose={(saved) => {
            setShowPriceListMaster(false);
            setSelectedPriceList(null);
            closePicker();
            if (saved) window.location.reload();
          }}
          selected={selectedPriceList}
        />
      )}
    </div>
  );
};

export default Page;
