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
    keys: ["Alt+E", "Alt+D", "Delete"],
    label: "Delete row",
    sigfa: "Alt + E  Delete Row",
    scope: "row",
    // Delete alone must NOT fire while typing -- it is the key that erases a
    // character. Alt+E and Alt+D are safe, and the guard below sorts them out
    // per spelling rather than per action.
    whileTyping: false,
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

/** The help overlay's contents: what to press, what it does, Sigfa's wording. */
export const shortcutHelp = () =>
  BILLING_SHORTCUTS.map((s) => ({
    keys: s.keys.join(" or "),
    label: s.label,
    sigfa: s.sigfa,
    scope: s.scope,
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

export const masterForField = (field) =>
  MASTER_FOR_FIELD[String(field ?? "").trim()] ?? null;
