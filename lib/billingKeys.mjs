/**
 * Sigfa's keyboard shortcuts, as far as a browser will allow them.
 *
 * Pure and dependency-free, so `node` can run the test directly. It decides
 * WHICH action a keystroke means; the components do it.
 *
 *
 * WHERE THESE CAME FROM
 * ---------------------
 * Sigfa's own help window, read out of SIGFA105.exe. Its wording, verbatim:
 *
 *   Alt + A    Create New Masters In Transaction
 *   Alt + M    Alter Masters In Transaction
 *   Alt + I    Item Ledger In Transaction
 *   Alt + P    Party Ledger In Transaction
 *   Alt + J    Show Item Information
 *   Alt + Y    Show Party Information
 *   Alt + T    Show Sale Invoice Information
 *   Alt + S    Save Record
 *   Alt + E    Delete Record            (also "Delete Row (Alt + E)")
 *   Alt + B    Back Screen
 *   Alt + N    Next Screen
 *   Alt + R    ReCall Record
 *   Alt + H    Miscellaneous Help Window
 *   F2         Item Search / Show List
 *   Shift + F1 Customer List In Help Window
 *   Shift + F2 Supplier List In Help Window
 *   Shift + F3 Account List In Help Window
 *   Shift + F5 Fixed A/C And Sale/Purchase A/C List In Help Window
 *   Alt + F1   Pur. Price     Alt + F2  Sale Price     Alt + F12  Cal MRP
 *   Esc        Exit
 *
 * The shop's muscle memory is the whole reason to copy them, so the letters
 * are kept wherever a browser permits. components/PriceListMaster.jsx already
 * uses Alt+A, Alt+S and Alt+E with Sigfa's meanings, so this matches a
 * precedent rather than inventing one.
 *
 *
 * THE THREE THAT A BROWSER WILL NOT GIVE UP
 * -----------------------------------------
 * Said plainly, because shipping a shortcut that fights the browser is worse
 * than not shipping it:
 *
 *   Alt+F12   impossible. Devtools. Moved to Alt+F3 for Calculate MRP.
 *   Shift+F5  hard reload in Chrome -- it would discard a half-typed invoice.
 *             The Sale/Purchase A/C list moved to Shift+F4.
 *   Alt+E     opens the Chrome menu. preventDefault() usually suppresses it,
 *             but not dependably in Edge and Firefox. KEPT, because it is
 *             Sigfa's key and the muscle memory is the point -- with Alt+D
 *             and plain Delete as aliases, which is what Sigfa itself offers
 *             ("Delete [Alt + D]", "Delete Item (Del)"). If the browser eats
 *             one, two others do the job.
 *
 * Nothing here uses Ctrl+<letter>: Ctrl+N, Ctrl+T and Ctrl+W cannot be
 * intercepted at all, and the ones that can are the browser's own verbs.
 * Ctrl+Enter is free, and is the new-row key.
 */

/**
 * What a keystroke can mean on a billing screen.
 *
 * `keys` lists every accepted spelling, the first being the one shown on
 * screen. `scope` is "screen" for a shortcut that works anywhere on the form
 * and "row" for one that needs a focused line.
 */
const text = (value) => String(value ?? "").trim();

export const BILLING_SHORTCUTS = [
  {
    action: "itemSearch",
    keys: ["F2"],
    label: "Item search",
    sigfa: "F2 Item Search",
    scope: "screen",
    // The one shortcut that must fire even while typing: the item box is a
    // text field, and F2 inside it is how Sigfa opens the list.
    whileTyping: true,
  },
  {
    action: "newMaster",
    keys: ["Alt+A"],
    label: "New master",
    sigfa: "Alt + A  Create New Masters In Transaction",
    scope: "screen",
    whileTyping: true,
  },
  {
    action: "alterMaster",
    keys: ["Alt+M"],
    label: "Alter master",
    sigfa: "Alt + M  Alter Masters In Transaction",
    scope: "screen",
    whileTyping: true,
  },
  {
    action: "addRow",
    keys: ["Ctrl+Enter"],
    label: "Add a row",
    // Not Sigfa's: its Alt+A does double duty as "add a row" in a grid and
    // "create a master" on a transaction, and a billing screen is both. Alt+A
    // keeps the transaction meaning, which is the one asked for, and the row
    // gets a key of its own.
    sigfa: null,
    scope: "screen",
    whileTyping: true,
  },
  {
    action: "deleteRow",
    // Alt+D was an alias here once. It is NOT: Sigfa carries both keys side
    // by side -- "Delete Row (Alt + E)" and "Delete (Alt + D)" -- and
    // conflating them left no way to delete a master at all while making a
    // mis-keyed Alt+D silently drop an invoice line.
    keys: ["Alt+E", "Delete"],
    label: "Delete row",
    sigfa: "Alt + E  Delete Row",
    scope: "row",
    // Delete alone must NOT fire while typing -- it is the key that erases a
    // character. Alt+E and Alt+D are safe, and the guard below sorts them out
    // per spelling rather than per action.
    whileTyping: false,
  },
  {
    action: "deleteMaster",
    keys: ["Alt+D"],
    label: "Delete master record",
    sigfa: "Alt + D  Delete",
    // The record behind the FOCUSED FIELD, wherever that field is -- which is
    // why its scope is neither the screen nor a line.
    scope: "field",
    // Pressed with a half-typed name in the box, like its two siblings.
    whileTyping: true,
  },
  {
    action: "save",
    keys: ["Alt+S"],
    label: "Save",
    sigfa: "Alt + S  Save Record",
    scope: "screen",
    whileTyping: true,
  },
  {
    action: "itemLedger",
    keys: ["Alt+I"],
    label: "Item ledger",
    sigfa: "Alt + I  Item Ledger In Transaction",
    scope: "row",
    whileTyping: true,
  },
  {
    action: "partyLedger",
    keys: ["Alt+P"],
    label: "Party ledger",
    sigfa: "Alt + P  Party Ledger In Transaction",
    scope: "screen",
    whileTyping: true,
  },
  {
    action: "itemInfo",
    keys: ["Alt+J"],
    label: "Item information",
    sigfa: "Alt + J  Show Item Information",
    scope: "row",
    whileTyping: true,
  },
  {
    action: "partyInfo",
    keys: ["Alt+Y"],
    label: "Party information",
    sigfa: "Alt + Y  Show Party Information",
    scope: "screen",
    whileTyping: true,
  },
  {
    action: "purchasePrice",
    keys: ["Alt+F1"],
    label: "Purchase price",
    sigfa: "Alt + F1  Pur. Price",
    scope: "row",
    whileTyping: true,
  },
  {
    action: "salePrice",
    keys: ["Alt+F2"],
    label: "Sale price",
    sigfa: "Alt + F2  Sale Price",
    scope: "row",
    whileTyping: true,
  },
  {
    action: "calcMrp",
    keys: ["Alt+F3"],
    label: "Calculate MRP",
    // Sigfa's Alt+F12. F12 is devtools and cannot be taken.
    sigfa: "Alt + F12  Cal MRP (moved: F12 is devtools)",
    scope: "row",
    whileTyping: true,
  },
  {
    action: "customerList",
    keys: ["Shift+F1"],
    label: "Customer list",
    sigfa: "Shift + F1  Customer List In Help Window",
    scope: "screen",
    whileTyping: true,
  },
  {
    action: "supplierList",
    keys: ["Shift+F2"],
    label: "Supplier list",
    sigfa: "Shift + F2  Supplier List In Help Window",
    scope: "screen",
    whileTyping: true,
  },
  {
    action: "accountList",
    keys: ["Shift+F3"],
    label: "Account list",
    sigfa: "Shift + F3  Account List In Help Window",
    scope: "screen",
    whileTyping: true,
  },
  {
    action: "salePurchaseList",
    keys: ["Shift+F4"],
    label: "Sale / purchase A/c list",
    // Sigfa's Shift+F5. Shift+F5 is a hard reload in Chrome and would throw
    // away a half-typed invoice.
    sigfa: "Shift + F5 (moved: Shift+F5 hard-reloads Chrome)",
    scope: "screen",
    whileTyping: true,
  },
  {
    action: "pendingChallan",
    keys: ["Alt+L"],
    label: "Pending challans",
    // SIGFA's own key for this is Alt+H, which is the help window here.
    sigfa: "Pending Challan [ Alt + H ] (moved: Alt+H is shortcut help here)",
    scope: "screen",
    whileTyping: true,
  },
  {
    action: "help",
    keys: ["Alt+H"],
    label: "Shortcut help",
    sigfa: "Alt + H  Miscellaneous Help Window",
    scope: "screen",
    whileTyping: true,
  },
  {
    action: "back",
    keys: ["Escape"],
    label: "Close / back",
    sigfa: "Esc To Exit",
    scope: "screen",
    whileTyping: true,
  },
];

/** Keys a browser or OS will not surrender, and so must never be bound. */
export const FORBIDDEN_KEYS = [
  "F12",
  "Alt+F12",
  "Shift+F5",
  "Ctrl+N",
  "Ctrl+T",
  "Ctrl+W",
  "Ctrl+Shift+R",
  "Alt+F4",
  "F5",
  "F11",
];

/**
 * A keystroke as this module names it: "Alt+A", "Shift+F1", "Ctrl+Enter",
 * "F2", "Delete", "Escape".
 *
 * Modifier order is fixed -- Ctrl, Alt, Shift -- so a table lookup is exact
 * rather than a set comparison. A single letter is upper-cased; a named key
 * keeps the browser's own spelling ("Escape", "Delete", "Enter", "F2").
 */
export const keyName = (event) => {
  if (!event || !event.key) return "";
  const parts = [];
  if (event.ctrlKey || event.metaKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");

  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  // Shift is implied by the character on a shifted letter, and listing it
  // would make "Shift+A" out of a capital A.
  if (key.length === 1 && parts[parts.length - 1] === "Shift") parts.pop();

  parts.push(key);
  return parts.join("+");
};

/** Is this element one that swallows ordinary typing? */
export const isTypingTarget = (target) => {
  if (!target) return false;
  const tag = String(target.tagName || "").toUpperCase();
  if (tag === "TEXTAREA") return true;
  if (target.isContentEditable === true) return true;
  if (tag !== "INPUT") return false;
  // A checkbox, radio or button is an input that does not swallow keys.
  const type = String(target.type || "text").toLowerCase();
  return !["checkbox", "radio", "button", "submit", "reset", "file"].includes(type);
};

const BY_KEY = new Map();
for (const shortcut of BILLING_SHORTCUTS) {
  for (const key of shortcut.keys) BY_KEY.set(key, shortcut);
}

/**
 * Which action this keystroke means, or null.
 *
 * `typing` says the caret is in a text field. A shortcut whose `whileTyping`
 * is false is refused there, which is the rule that stops Delete eating a row
 * while somebody is correcting a quantity -- the exact failure the brief asks
 * to avoid, and the reason the decision lives in a tested module rather than
 * in an `if` inside a keydown handler.
 *
 * Every modified shortcut still fires while typing, because Alt+A with the
 * caret in the item box is precisely how Sigfa is used: you type a name that
 * is not in the master, and Alt+A creates it.
 */
export const shortcutFor = (event, { typing = false } = {}) => {
  const name = keyName(event);
  if (!name) return null;

  const shortcut = BY_KEY.get(name);
  if (!shortcut) return null;

  // Per SPELLING, not per action: Alt+E and Alt+D delete a row while typing,
  // plain Delete does not.
  if (typing && !shortcut.whileTyping) {
    const bare = !event.altKey && !event.ctrlKey && !event.metaKey;
    if (bare) return null;
  }

  return shortcut.action;
};

/** Every action the table names. The screen must bind all of them. */
export const ALL_ACTIONS = BILLING_SHORTCUTS.map((s) => s.action);

/**
 * Which stored price Alt+F1 / Alt+F2 / Alt+F3 pull into the line's rate.
 *
 * All three are one mechanism in Sigfa, not three features: its own rate
 * sources read
 *
 *     @Rate, @Sale Price, @MRP, @Sale Price 2 …
 *     1=SPrice1, 2=Sprice2, … 6=Pur.Price, 7=CostPrice, 8=MRP
 *
 * so "Cal MRP" puts the MRP in the rate box. It does NOT back-compute a rate
 * from a GST-inclusive MRP — nothing in the binary suggests that, and
 * inventing the arithmetic would quietly change what a bill charges.
 */
export const PRICE_SOURCES = {
  purchasePrice: { field: "purchasePrice", label: "purchase price" },
  salePrice: { field: "salePrice", label: "sale price" },
  calcMrp: { field: "mrp", label: "MRP" },
};

export const priceSourceFor = (action) => PRICE_SOURCES[text(action)] ?? null;

/**
 * Sigfa's "Help Window" lists — Shift+F1 to Shift+F4.
 *
 * `group` is the account group to filter on (null = every account), and
 * `picks` says whether choosing a row sets the bill's party. The two party
 * lists do; the two account lists are reference only, which is what Sigfa's
 * help window is for — you read a code off it.
 *
 * `statement: "T"` is how the sale/purchase heads are identified: they are the
 * groups that sit on the Trading account (lib/accountGroups.mjs).
 */
export const LOOKUP_LISTS = {
  customerList: { title: "Customer list", group: "Sundry Debtors", picks: true },
  supplierList: { title: "Supplier list", group: "Sundry Creditors", picks: true },
  accountList: { title: "Account list", group: null, picks: false },
  salePurchaseList: { title: "Sale / purchase A/c list", statement: "T", picks: false },
};

export const lookupListFor = (action) => LOOKUP_LISTS[text(action)] ?? null;

/**
 * Which record Alt+J and Alt+Y show.
 *
 * Sigfa: "Show Item Information" and "Show Party Information" — a read-only
 * window on the master record behind what is in hand, so a clerk can check a
 * rate or a GSTIN without losing the half-typed bill.
 */
export const INFO_PANELS = {
  itemInfo: { kind: "item", title: "Item information" },
  partyInfo: { kind: "party", title: "Party information" },
};

export const infoPanelFor = (action) => INFO_PANELS[text(action)] ?? null;

/**
 * The help overlay's contents: what to press, what it does, Sigfa's wording.
 *
 * `bound` is the set of actions the screen actually handles. A key the screen
 * does not bind is listed as unavailable rather than advertised — the overlay
 * used to promise all nineteen while ten were wired, which is worse than not
 * listing them: somebody presses Alt+J, nothing happens, and they stop
 * trusting the whole table.
 */
export const shortcutHelp = (bound = null) =>
  BILLING_SHORTCUTS.map((s) => ({
    keys: s.keys.join(" or "),
    action: s.action,
    label: s.label,
    sigfa: s.sigfa,
    scope: s.scope,
    bound: bound === null ? true : Boolean(bound?.has?.(s.action) ?? bound?.[s.action]),
  }));

/**
 * Where Enter goes next, within a row.
 *
 * Sigfa walks a transaction line left to right and drops onto the next line
 * at the end. `null` means "this was the last field" and the caller decides
 * -- which is a new row, not a submit. Enter must never submit a billing
 * form: a stray Enter in a quantity box would post the invoice.
 */
export const ROW_FIELD_ORDER = ["quantity", "cost", "discount"];

export const nextRowField = (field) => {
  const at = ROW_FIELD_ORDER.indexOf(String(field));
  if (at === -1) return ROW_FIELD_ORDER[0];
  return ROW_FIELD_ORDER[at + 1] ?? null;
};

/**
 * Which master Alt+A should create, from the field the caret is in.
 *
 * Sigfa's "Create New Masters In Transaction" is context-sensitive: the master
 * it offers is the one the current field needs. `null` means the field has no
 * master behind it, and the key does nothing rather than guessing.
 */
export const MASTER_FOR_FIELD = {
  item: "item",
  itemName: "item",
  party: "customer",
  customer: "customer",
  hsn: "hsn",
  unit: "unit",
  group: "group",
  state: "state",
  stateOfSupply: "state",
};

export const masterForField = (field) => MASTER_FOR_FIELD[text(field)] ?? null;
