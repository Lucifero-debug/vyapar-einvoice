'use client';
import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Barcode,
  BookOpenText,
  Boxes,
  Check,
  ChevronsUpDown,
  Landmark,
  Package,
  Pencil,
  Plus,
  Printer,
  ReceiptIndianRupee,
  ClipboardList,
  ScrollText,
  Settings,
  Tags,
  ShoppingCart,
  Trash2,
  Undo2,
  Upload,
  UserCog,
  Users,
  Wallet,
  X,
} from 'lucide-react';
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
import PriceListMaster from '@/components/PriceListMaster';
import { priceListLabel } from '@/lib/priceList.mjs';

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
  const [purchaseReturns, setPurchaseReturns] = useState([]);
  const [alterState, setAlterState] = useState('');
  const [deleteState, setDeleteState] = useState('');
  const [item, setItem] = useState([]);
  const [hsn, setHsn] = useState([]);
  const [bank, setBank] = useState([]);
  const [cash, setCash] = useState([]);
  const [alter, setAlter] = useState(false);
  const [del, setDel] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedHsn, setSelectedHsn] = useState(null);
  const [groups, setGroups] = useState([]);
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [states, setStates] = useState([]);
  const [selectedState, setSelectedState] = useState(null);
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
        const [items, customers, invoices, hsnCodes, vouchers, lists, groupList, stateList] =
          await Promise.all([
            loadJson('/api/get-item', (d) => d.item),
            loadJson('/api/get-customer', (d) => d.customer),
            loadJson('/api/get-invoice', (d) => d.invoice),
            loadJson('/api/get-hsn', (d) => d.hsn),
            loadJson('/api/get-voucher', (d) => d.voucher),
            loadJson('/api/get-price-list', (d) => d.priceList),
            loadJson('/api/get-group', (d) => d.group),
            loadJson('/api/get-state', (d) => d.state),
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

        setPriceLists(
          lists.map(pl => ({
            ...pl,
            id: pl._id,
            name: priceListLabel(pl)
          }))
        );

        setBank(
          vouchers.filter(v => v.paymentType === 'Bank').map(v => ({
            id: v._id,
            name: v.acName || v.accountName || v._id
          }))
        );

        setCash(
          vouchers.filter(v => v.paymentType === 'Cash').map(v => ({
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
        alert(`Could not build the dashboard.\n\n${error.message}`);
      } finally {
        setLoading(false);
      }
    };
    fetchData();
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
        default:
          console.warn('Unsupported alterState:', alterState);
          alert(`Navigation not supported for ${alterState}`);
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
      case 'PriceList':
        endpoint = `/api/delete-price-list?id=${currentValue}`;
        break;
      case 'Bank':
        endpoint = `/api/delete-voucher?id=${currentValue}&type=Bank`;
        break;
      case 'Cash':
        endpoint = `/api/delete-voucher?id=${currentValue}&type=Cash`;
        break;
      default:
        alert(`Delete not supported for ${deleteState}`);
        return;
    }

    try {
      const response = await fetch(endpoint, { method: 'POST' });
      const result = await response.json();
      if (result.success) {
        window.location.reload();
      } else {
        const reason = result.error || result.message;
        console.error('Failed to delete:', reason);
        alert(`Failed to delete: ${reason}`);
      }
    } catch (error) {
      console.error('Error during delete request:', error);
      alert('Error during delete');
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
      case 'PriceList': return priceLists;
      case 'Bank': return bank;
      case 'Cash': return cash;
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
        if (isNamed(sectionName)) return e.id === value || e.name === value;
        return e.invoiceNo === value;
      });

      if (!selected) return `Select ${sectionName}`;
      if (sectionName === 'HSN') return selected.hsncode;
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

            <button type="button" className="nav-tile" onClick={() => router.push('/production')}>
              <span className="nav-tile-icon">
                <Package className="h-[18px] w-[18px]" />
              </span>
              <span className="flex-1">
                Production
                <span className="block text-xs font-normal text-muted-foreground">
                  Issue the materials and receive the finished item
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
