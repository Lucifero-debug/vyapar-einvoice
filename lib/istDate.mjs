/**
 * Dates, read in India.
 *
 * Two things in this app depend on the calendar being India's and not the
 * server's: the 24-hour window for cancelling an e-invoice, and the
 * `dd/mm/yyyy` document date the IRP expects. A host in UTC that formatted its
 * own wall clock would be five and a half hours behind -- which crosses
 * midnight for anything billed after 6:30pm, so an evening invoice would be
 * filed under yesterday's date and a cancellation deadline would be shown
 * five hours early.
 *
 * India has never observed daylight saving and has one zone, so the offset is
 * a constant and this needs no timezone database. Pure, with no imports, so
 * the edge middleware, a 'use client' page and a bare `node` test can all use
 * it.
 */

/** +5:30, in minutes. Fixed since 1945 and not subject to DST. */
export const IST_OFFSET_MINUTES = 330;

/** Date | epoch ms | ISO string -> epoch ms, or null when there is no usable date. */
export const toEpoch = (value) => {
  if (value === null || value === undefined || value === "") return null;
  // Duck-typed rather than `instanceof Date`: Mongoose hands back real Dates,
  // a JSON request body hands back strings, and a Date that crossed a realm
  // boundary fails `instanceof` while still being a Date.
  if (typeof value?.getTime === "function") {
    const ms = value.getTime();
    return Number.isNaN(ms) ? null : ms;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? null : parsed;
};

/**
 * The IST wall clock for an instant, or null.
 *
 * Shift the instant by the offset and read the UTC parts: those ARE the Indian
 * wall clock, with no local-time call anywhere in the path.
 */
export const istParts = (value) => {
  const ms = toEpoch(value);
  if (ms === null) return null;
  const d = new Date(ms + IST_OFFSET_MINUTES * 60 * 1000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1, // 1-12, as a person counts them
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
};

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const pad2 = (n) => String(n).padStart(2, "0");

/** A date and time the way a Delhi shopkeeper reads one, or null. */
export const formatIst = (value) => {
  const p = istParts(value);
  if (!p) return null;
  const hour12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return (
    `${p.day} ${MONTHS[p.month - 1]} ${p.year}, ` +
    `${hour12}:${pad2(p.minute)} ${p.hour < 12 ? "am" : "pm"} IST`
  );
};

/**
 * `dd/mm/yyyy`, which is the only date format the IRP accepts. Not ISO, and
 * not without the leading zeros.
 */
export const formatIrpDate = (value) => {
  const p = istParts(value);
  if (!p) return null;
  return `${pad2(p.day)}/${pad2(p.month)}/${p.year}`;
};

/**
 * The UTC instants that bound one IST calendar day: [from, to).
 *
 * For querying "dated today" against a stored Date. The dates on these
 * documents are stored as UTC MIDNIGHT of the day somebody picked -- see the
 * billing forms and app/api/invoices-by-date -- and that instant always falls
 * inside the IST window for the same calendar day, so one window serves both
 * date-only values and anything stored with a real time.
 *
 * It matters at the edges of the day. At 2am on the 9th in Delhi it is still
 * the 8th in UTC, and the shopkeeper means the 9th.
 */
export const istDayWindow = (value) => {
  const p = istParts(value);
  if (!p) return null;
  // Midnight IST on that day, expressed as a UTC instant.
  const from = Date.UTC(p.year, p.month - 1, p.day) - IST_OFFSET_MINUTES * 60 * 1000;
  return { from: new Date(from), to: new Date(from + 24 * 60 * 60 * 1000) };
};

/** The IST calendar day as a sortable number, for comparing two dates. */
export const istDayNumber = (value) => {
  const p = istParts(value);
  if (!p) return null;
  return p.year * 10000 + p.month * 100 + p.day;
};
