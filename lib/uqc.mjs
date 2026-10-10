/**
 * Unit Quantity Codes — the units the IRP will accept.
 *
 * The item master's `unit` is free text ("pcs", "mtr", "bori") and stays that
 * way: it is what the shop calls the unit and what the stock report prints.
 * The IRP accepts only a code from the list below, so the two are kept apart.
 *
 * DO NOT guess the code from the free-text unit. A wrong UQC is a rejected
 * filing, and a silent mapping from "bag" to BAG while "bori" quietly became
 * OTH would be worse than asking once. New items default to OTH, which is a
 * valid code meaning "others", and the owner picks the right one when it
 * matters.
 *
 * There is no code for plain litres. One litre is 1000 MLT, or use KLR for
 * kilolitres -- the official list genuinely has no LTR, which is the first
 * thing anybody trips over.
 *
 * Checked against three published copies of the list on 8 October 2026; all
 * 44 codes agreed. Only the code travels, never the label.
 */

/** The complete list, in the order the GST portal publishes it. */
export const UQC_CODES = [
  { code: "BAG", label: "Bags" },
  { code: "BAL", label: "Bale" },
  { code: "BDL", label: "Bundles" },
  { code: "BKL", label: "Buckles" },
  { code: "BOU", label: "Billions of units" },
  { code: "BOX", label: "Box" },
  { code: "BTL", label: "Bottles" },
  { code: "BUN", label: "Bunches" },
  { code: "CAN", label: "Cans" },
  { code: "CBM", label: "Cubic metre" },
  { code: "CCM", label: "Cubic centimetre" },
  { code: "CMS", label: "Centimetre" },
  { code: "CTN", label: "Cartons" },
  { code: "DOZ", label: "Dozen" },
  { code: "DRM", label: "Drum" },
  { code: "GGR", label: "Great gross" },
  { code: "GMS", label: "Grams" },
  { code: "GRS", label: "Gross" },
  { code: "GYD", label: "Gross yards" },
  { code: "KGS", label: "Kilograms" },
  { code: "KLR", label: "Kilolitre" },
  { code: "KME", label: "Kilometre" },
  { code: "MLT", label: "Millilitre" },
  { code: "MTR", label: "Metres" },
  { code: "MTS", label: "Metric tons" },
  { code: "NOS", label: "Numbers" },
  { code: "PAC", label: "Packs" },
  { code: "PCS", label: "Pieces" },
  { code: "PRS", label: "Pairs" },
  { code: "QTL", label: "Quintal" },
  { code: "ROL", label: "Rolls" },
  { code: "SET", label: "Sets" },
  { code: "SQF", label: "Square feet" },
  { code: "SQM", label: "Square metres" },
  { code: "SQY", label: "Square yards" },
  { code: "TBS", label: "Tablets" },
  // Published as "ten gross" by some sources and "ten grams" by others. The
  // code is what is transmitted, so the ambiguity is cosmetic -- but it is why
  // this label is not to be trusted over the portal's own.
  { code: "TGM", label: "Ten gross" },
  { code: "THD", label: "Thousands" },
  { code: "TON", label: "Tonnes" },
  { code: "TUB", label: "Tubes" },
  { code: "UGS", label: "US gallons" },
  { code: "UNT", label: "Units" },
  { code: "YDS", label: "Yards" },
  { code: "OTH", label: "Others" },
];

/** What an item gets until somebody chooses. A real code, and always valid. */
export const UQC_DEFAULT = "OTH";

const CODES = new Set(UQC_CODES.map((u) => u.code));

/** Is this exactly one of the accepted codes? */
export const isUqc = (value) => CODES.has(String(value || "").trim().toUpperCase());

/**
 * A stored or typed value as a code, or "" when it is not one.
 *
 * Returns "" rather than OTH so a caller can tell "nothing chosen" from
 * "deliberately others". The model's default supplies OTH.
 */
export const normalizeUqc = (value) => {
  const code = String(value || "").trim().toUpperCase();
  return CODES.has(code) ? code : "";
};

/** The label for a code, for a dropdown or a report. */
export const uqcLabel = (code) =>
  UQC_CODES.find((u) => u.code === normalizeUqc(code))?.label || "";

/* ------------------------------------------------------ invoice line items -- */

const key = (name) => String(name || "").trim().toLowerCase();

/**
 * Index item master rows by name, the way everything else in this project
 * joins them.
 */
export const itemIndex = (items = []) => {
  const index = new Map();
  for (const item of items) {
    if (!item?.name) continue;
    index.set(key(item.name), item);
  }
  return index;
};

/**
 * Copy `uqc` and `isService` from the item master onto each invoice line.
 *
 * A SNAPSHOT, for the same reason the buyer is one: the IRN is tied to what
 * was filed, so an item whose UQC is corrected next year must not change the
 * unit on a bill already reported.
 *
 * The master wins over whatever the page sent, because the billing form has no
 * field for either and anything it carries got there by copying the whole
 * master row. A line whose item is not in the master at all -- an AI-imported
 * bill, usually -- keeps what it came with, then falls back to OTH.
 */
export const stampItemLines = (lines, masters = []) => {
  const index = masters instanceof Map ? masters : itemIndex(masters);

  return (lines || []).map((line) => {
    const master = index.get(key(line?.name));
    return {
      ...line,
      uqc: normalizeUqc(master?.uqc) || normalizeUqc(line?.uqc) || UQC_DEFAULT,
      isService: Boolean(master ? master.isService : line?.isService),
    };
  });
};

/** "Y" or "N", as the IRP's IsServc wants it. */
export const isServcFlag = (line) => (line?.isService ? "Y" : "N");
