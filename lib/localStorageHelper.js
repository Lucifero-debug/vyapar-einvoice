export const saveToLocal = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
};

export const getFromLocal = (key, fallback = null) => {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};

export const removeFromLocal = (key) => {
  try {
    localStorage.removeItem(key);
  } catch {}
};

export const clearInvoiceDraft = () => {
  const keys = [
    'invoiceItems',
    'invoiceNo',
    'date',
    'gst',
    'stateOfSupply',
    'taxType',
    'selectedCustomer',
    'partyTaxes',
    'received',
    'paymentType',
  ];
  keys.forEach(removeFromLocal);
};
