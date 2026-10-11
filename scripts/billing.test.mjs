/**
 * The billing refactor's safety net.
 *
 * Run with bare node. Three jobs, in order of how much damage they prevent:
 *
 *   1. THE ACCOUNTING CONTRACT. The four screens sent an identical 31-key
 *      payload differing only in `type` and `return`. Those two fields are
 *      what the server turns into a party-balance sign and a stock direction,
 *      so they are the whole of the accounting risk in a UI refactor. Pinned
 *      against a list extracted mechanically from the pages BEFORE anything
 *      moved.
 *
 *   2. THE ARITHMETIC, QUIRKS AND ALL. `recalcItem` and `buildHsnTotals` were
 *      copied, not rewritten, and the stored per-line money is whatever the
 *      browser computed. Four deliberate oddities are asserted here precisely
 *      so a later tidy-up cannot silently rewrite figures on invoices.
 *
 *   3. THE KEYBOARD. That no shortcut is bound to a key the browser will not
 *      give up, and that nothing fires while somebody is typing a quantity.
 *
 * The audit this rests on, for the record:
 *
 *     saleadd    vs purchaseadd       8 differing lines out of 1,547
 *     salereturn vs purchasereturn    6 differing lines out of 1,220
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  BILLING_KEYS,
  BILLING_TYPES,
  DIRECTIONS,
  billingType,
  canBillFromOrder,
  postingFlags,
} from "../lib/billingTypes.mjs";
import {
  PAYLOAD_KEYS,
  buildHsnTotals,
  buildInvoicePayload,
  hsnTotalsArray,
  recalcItem,
  saveEndpoint,
  totalGstOf,
} from "../lib/billingMath.mjs";
import {
  BILLING_SHORTCUTS,
  FORBIDDEN_KEYS,
  ROW_FIELD_ORDER,
  isTypingTarget,
  keyName,
  masterForField,
  nextRowField,
  shortcutFor,
  shortcutHelp,
} from "../lib/billingKeys.mjs";

let passed = 0;
const test = (name, fn) => {
  try {
    const result = fn();
    assert.equal(result, undefined, "this test body is async -- make it synchronous");
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    process.exitCode = 1;
  }
};

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

/**
 * Source with its comments removed.
 *
 * These files EXPLAIN what they avoid -- "nothing to debounce", "never reach
 * the form" -- and a grep cannot tell the explanation from the thing. Two
 * checks below failed on their own prose the first time they ran.
 */
const code = (p) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** A keydown event, as the browser would hand one over. */
const ev = (key, mods = {}) => ({
  key,
  altKey: Boolean(mods.alt),
  ctrlKey: Boolean(mods.ctrl),
  shiftKey: Boolean(mods.shift),
  metaKey: Boolean(mods.meta),
});

const FORM = {
  invoiceNo: 7,
  originalInvoiceNo: "",
  date: "2026-10-11",
  customer: { name: "Acme Traders", phone: "9876543210", email: "a@b.co", _id: "cus1" },
  paymentType: "Credit",
  balanceDue: 1180,
  stateOfSupply: "Delhi",
  stateCode: "07",
  taxType: "local",
  gst: 180,
  totalAmount: 1000,
  finalAmount: 1180,
  received: 0,
  items: [{ name: "Plate", hsn: "7308", gstRate: 18, cost: 100, quantity: 10, discount: 0 }],
  partyTaxes: [],
  shippedTo: "",
  dispatchFrom: "",
  transport: "",
  grNo: "",
  grDate: "",
  pvtMark: "",
  caseDetails: "",
  freight: "",
  weight: 0,
  ewayBillNo: "",
  ewayBillDate: "",
  orderDate: "",
  orderNo: "",
};

console.log("\n--- the four screens are one screen and a table ---");

test("there are exactly four billing types", () => {
  assert.deepEqual([...BILLING_KEYS].sort(), [
    "purchase",
    "purchasereturn",
    "sale",
    "salereturn",
  ]);
});

test("an unknown type throws rather than falling back", () => {
  // A typo'd key quietly defaulting to "sale" would post a purchase return as
  // a sale invoice -- the party sign AND the stock direction both wrong.
  assert.throws(() => billingType("sales"), /Unknown billing type/);
  assert.throws(() => billingType(""), /Unknown billing type/);
  assert.throws(() => billingType(undefined), /Unknown billing type/);
});

test("each type keeps the title and subtitle its page had", () => {
  // The one difference a user would notice. Taken from the pre-refactor files.
  assert.equal(BILLING_TYPES.sale.title, "Sale Invoice");
  assert.equal(BILLING_TYPES.sale.subtitle, "Bill a customer and record the sale.");
  assert.equal(BILLING_TYPES.purchase.title, "Purchase Invoice");
  assert.equal(BILLING_TYPES.purchase.subtitle, "Record a bill received from a supplier.");
  assert.equal(BILLING_TYPES.salereturn.title, "Sale Return");
  assert.equal(BILLING_TYPES.salereturn.subtitle, "Take goods back from a customer.");
  assert.equal(BILLING_TYPES.purchasereturn.title, "Purchase Return");
  assert.equal(BILLING_TYPES.purchasereturn.subtitle, "Send goods back to a supplier.");
});

test("only the two non-returns can bill from an order", () => {
  // The 164-line prefill effect and the 141-line picker existed on the add
  // screens alone. This flag is what switches the whole feature off.
  assert.equal(canBillFromOrder(BILLING_TYPES.sale), true);
  assert.equal(canBillFromOrder(BILLING_TYPES.purchase), true);
  assert.equal(canBillFromOrder(BILLING_TYPES.salereturn), false);
  assert.equal(canBillFromOrder(BILLING_TYPES.purchasereturn), false);
});

test("a sale screen bills sale orders and a purchase screen purchase orders", () => {
  // ORDER_DOC in the old files, and the only other value that differed
  // between saleadd and purchaseadd.
  assert.equal(BILLING_TYPES.sale.orderDoc, "Sale");
  assert.equal(BILLING_TYPES.purchase.orderDoc, "Purchase");
});

console.log("\n--- the accounting direction, which must not move ---");

test("type and return match the direction table exactly", () => {
  // From the brief:
  //   Sale             party +   stock issue
  //   Sale return      party -   stock receipt
  //   Purchase         party -   stock receipt
  //   Purchase return  party +   stock issue
  //
  // The SIGNS are the server's to derive (lib/invoicePosting.mjs,
  // lib/invoiceGl.mjs). What the screen owes is these two fields, and getting
  // either wrong inverts a party balance and a stock movement together.
  assert.deepEqual(postingFlags(billingType("sale")), { type: "Sale", return: false });
  assert.deepEqual(postingFlags(billingType("salereturn")), { type: "Sale", return: true });
  assert.deepEqual(postingFlags(billingType("purchase")), { type: "Purchase", return: false });
  assert.deepEqual(postingFlags(billingType("purchasereturn")), {
    type: "Purchase",
    return: true,
  });
});

test("the four combinations are all distinct", () => {
  // Two types sharing a (type, return) pair would mean one of them posts as
  // the other, and every individual assertion above would still pass.
  const seen = BILLING_KEYS.map((k) => JSON.stringify(postingFlags(billingType(k))));
  assert.equal(new Set(seen).size, 4, `only ${new Set(seen).size} distinct pairs`);
});

test("there are only two directions, and no third slips in", () => {
  assert.deepEqual(DIRECTIONS, ["Sale", "Purchase"]);
  for (const key of BILLING_KEYS) {
    assert.ok(DIRECTIONS.includes(billingType(key).type), key);
  }
});

console.log("\n--- the payload contract, frozen before anything moved ---");

test("the frozen list is the 31 keys the pages actually sent", () => {
  assert.equal(PAYLOAD_KEYS.length, 31);
  // Spot-checked against the extract: the ones whose absence would be silent.
  for (const key of ["return", "type", "hsnTotals", "balanceDue", "originalInvoiceNo"]) {
    assert.ok(PAYLOAD_KEYS.includes(key), `${key} is missing from the contract`);
  }
});

test("every type builds exactly those keys, in that order", () => {
  for (const key of BILLING_KEYS) {
    const payload = buildInvoicePayload(FORM, billingType(key));
    assert.deepEqual(Object.keys(payload), PAYLOAD_KEYS, key);
  }
});

test("the payloads differ in type and return, and in nothing else", () => {
  // THE CENTRAL CLAIM OF THE AUDIT, asserted rather than asserted-about: four
  // screens, one body.
  //
  // The expected difference is PER PAIR, not one list for all three -- which
  // is the 2x2 written out. A sale and a purchase share `return: false`, so
  // they differ in `type` alone; a sale and a sale return share `type:
  // "Sale"`, so they differ in `return` alone. Expecting both fields
  // everywhere passed only because the first assertion checked happened to be
  // the one pair that differs in both.
  const sale = buildInvoicePayload(FORM, billingType("sale"));
  const expected = {
    purchase: ["type"],
    salereturn: ["return"],
    purchasereturn: ["return", "type"],
  };

  for (const [key, fields] of Object.entries(expected)) {
    const other = buildInvoicePayload(FORM, billingType(key));
    const differing = PAYLOAD_KEYS.filter(
      (k) => JSON.stringify(sale[k]) !== JSON.stringify(other[k])
    );
    assert.deepEqual(differing.sort(), fields, `sale vs ${key}`);
  }

  // And every pair of the four differs in at most those two fields -- the
  // claim stated over all six pairs rather than the three against sale.
  for (const a of BILLING_KEYS) {
    for (const b of BILLING_KEYS) {
      if (a === b) continue;
      const pa = buildInvoicePayload(FORM, billingType(a));
      const pb = buildInvoicePayload(FORM, billingType(b));
      const differing = PAYLOAD_KEYS.filter(
        (k) => JSON.stringify(pa[k]) !== JSON.stringify(pb[k])
      );
      assert.ok(
        differing.every((k) => k === "type" || k === "return"),
        `${a} vs ${b} also differs in ${differing}`
      );
    }
  }
});

test("originalInvoiceNo is absent rather than empty on a new bill", () => {
  // sale-alter uses its PRESENCE to find the row being edited, so an empty
  // string would make a new invoice look like an edit of invoice "".
  const fresh = buildInvoicePayload({ ...FORM, originalInvoiceNo: "" }, billingType("sale"));
  assert.equal(fresh.originalInvoiceNo, undefined);
  assert.equal("originalInvoiceNo" in fresh, true, "the key stays, the value goes");

  const edit = buildInvoicePayload({ ...FORM, originalInvoiceNo: 7 }, billingType("sale"));
  assert.equal(edit.originalInvoiceNo, 7);
});

test("the numeric coercions are the originals'", () => {
  const payload = buildInvoicePayload(
    { ...FORM, totalAmount: "1000", finalAmount: "1180", received: "" },
    billingType("sale")
  );
  assert.equal(payload.totalAmount, 1000);
  assert.equal(payload.finalAmount, 1180);
  assert.equal(payload.received, 0, "a blank received is 0, not NaN");
});

test("the customer is flattened to the four fields the server reads", () => {
  const payload = buildInvoicePayload(FORM, billingType("sale"));
  assert.deepEqual(Object.keys(payload.customer).sort(), ["custId", "email", "name", "phone"]);
  assert.equal(payload.customer.custId, "cus1", "custId comes off _id");
});

test("an edit goes to sale-alter and a new bill to save-invoice", () => {
  // One endpoint pair for all four types, as before -- there is no
  // purchase-alter, and inventing one would be a backend change.
  assert.equal(saveEndpoint(true), "/api/sale-alter");
  assert.equal(saveEndpoint(false), "/api/save-invoice");
});

console.log("\n--- the arithmetic, including four quirks kept on purpose ---");

test("a line's figures are computed as they always were", () => {
  const line = recalcItem({ cost: 100, quantity: 10, discount: 10, gstRate: 18 });
  assert.equal(line.taxableAmount, 900, "1000 less 10%");
  assert.equal(line.gstAmount, 162, "18% of 900");
  assert.equal(line.total, 1062);
});

test("QUIRK: nothing is rounded, and that is load-bearing", () => {
  // The server rounds the invoice total once; the lines keep their dust, and
  // the stored hsnTotals are built from these raw floats. Rounding here would
  // change stored line totals on every future invoice and make them disagree
  // with every past one.
  const line = recalcItem({ cost: 10 / 3, quantity: 1, gstRate: 18 });
  assert.equal(line.total, 3.9333333333333336);
  assert.notEqual(line.total, 3.93, "a round2 has crept in");
});

test("QUIRK: a cost of zero falls through to the sale price", () => {
  // `||` not `??`, in that order. An item deliberately billed at nothing
  // picks up its master rate instead.
  assert.equal(recalcItem({ cost: 0, salePrice: 50, quantity: 1 }).cost, 50);
  assert.equal(recalcItem({ cost: 20, salePrice: 50, quantity: 1 }).cost, 20);
  assert.equal(recalcItem({ quantity: 1 }).cost, 0, "neither one present");
});

test("QUIRK: an HSN group takes the rate of its first line", () => {
  // A real bug, preserved. Two items under one HSN at different rates: the
  // amounts are right, the printed rate is the first line's. Fixing it would
  // change what prints on a GST return, so it is reported, not repaired.
  const grouped = buildHsnTotals([
    { hsn: "7308", gstRate: 5, gstAmount: 5, total: 105 },
    { hsn: "7308", gstRate: 18, gstAmount: 18, total: 118 },
  ]);
  assert.equal(grouped["7308"].gstRate, 5, "first rate wins -- documented");
  assert.equal(grouped["7308"].gstAmount, 23, "the amounts are still correct");
  assert.equal(grouped["7308"].total, 223);
});

test("QUIRK: a line with no HSN groups under the string N/A", () => {
  assert.deepEqual(Object.keys(buildHsnTotals([{ gstRate: 5, gstAmount: 1, total: 2 }])), ["N/A"]);
});

test("the HSN array renames gstAmount to amount", () => {
  // What invoiceModel declares and lib/hsnTotals.mjs reads back. Sending
  // `gstAmount` would store an undefined `amount`, and the printed summary
  // would read it as zero -- which is the bug the hsnTotals comment in
  // invoiceModel.js records from last time.
  const rows = hsnTotalsArray({ 7308: { gstRate: 18, gstAmount: 180, total: 1180 } });
  assert.deepEqual(rows, [{ hsn: "7308", gstRate: 18, amount: 180, total: 1180 }]);
});

test("an empty invoice produces an empty summary, not a crash", () => {
  assert.deepEqual(buildHsnTotals([]), {});
  assert.deepEqual(buildHsnTotals(undefined), {});
  assert.deepEqual(hsnTotalsArray(undefined), []);
  assert.equal(totalGstOf(undefined), 0);
});

test("the invoice GST is the lines' own tax added up", () => {
  assert.equal(totalGstOf([{ gstAmount: 90 }, { gstAmount: 90 }]), 180);
  assert.equal(totalGstOf([{ gstAmount: "90" }, {}]), 90, "a string counts, a blank is zero");
});

console.log("\n--- the keyboard: Sigfa's keys, where a browser allows them ---");

test("Sigfa's own letters are kept", () => {
  // The muscle memory is the entire reason to copy them.
  const byAction = Object.fromEntries(BILLING_SHORTCUTS.map((s) => [s.action, s.keys]));
  assert.ok(byAction.newMaster.includes("Alt+A"), "Alt+A creates a master -- the one asked for");
  assert.ok(byAction.save.includes("Alt+S"));
  assert.ok(byAction.deleteRow.includes("Alt+E"));
  assert.ok(byAction.alterMaster.includes("Alt+M"));
  assert.ok(byAction.itemLedger.includes("Alt+I"));
  assert.ok(byAction.partyLedger.includes("Alt+P"));
  assert.ok(byAction.itemInfo.includes("Alt+J"));
  assert.ok(byAction.partyInfo.includes("Alt+Y"));
  assert.ok(byAction.help.includes("Alt+H"));
  assert.ok(byAction.itemSearch.includes("F2"), "F2 is Sigfa's item search");
  assert.ok(byAction.customerList.includes("Shift+F1"));
  assert.ok(byAction.supplierList.includes("Shift+F2"));
  assert.ok(byAction.accountList.includes("Shift+F3"));
});

test("no shortcut is bound to a key the browser will not surrender", () => {
  // THE CHECK THAT STOPS A SHORTCUT SHIPPING BROKEN. Alt+F12 is devtools and
  // Shift+F5 hard-reloads Chrome, which would throw away a half-typed
  // invoice. Both are in Sigfa's set and both had to move.
  const bound = new Set(BILLING_SHORTCUTS.flatMap((s) => s.keys));
  for (const key of FORBIDDEN_KEYS) {
    assert.equal(bound.has(key), false, `${key} cannot be taken from the browser`);
  }
});

test("the moved shortcuts say what they used to be", () => {
  // So somebody with Sigfa's habits can find out why their key did something
  // else, rather than concluding the feature is broken.
  const moved = BILLING_SHORTCUTS.filter((s) => /moved/.test(s.sigfa || ""));
  assert.equal(moved.length, 2, "Alt+F12 and Shift+F5");
  for (const s of moved) assert.match(s.sigfa, /moved:/);
});

test("delete has three spellings, because one may be eaten", () => {
  // Alt+E opens the Chrome menu. preventDefault usually suppresses it but not
  // dependably in Edge and Firefox, so Sigfa's own aliases are offered too.
  const del = BILLING_SHORTCUTS.find((s) => s.action === "deleteRow");
  assert.deepEqual(del.keys, ["Alt+E", "Alt+D", "Delete"]);
});

test("a keystroke is named unambiguously", () => {
  assert.equal(keyName(ev("a", { alt: true })), "Alt+A");
  assert.equal(keyName(ev("F2")), "F2");
  assert.equal(keyName(ev("Enter", { ctrl: true })), "Ctrl+Enter");
  assert.equal(keyName(ev("F1", { shift: true })), "Shift+F1");
  assert.equal(keyName(ev("Escape")), "Escape");
  // Modifier order is fixed, so a lookup is exact rather than a set compare.
  assert.equal(keyName(ev("q", { ctrl: true, alt: true })), "Ctrl+Alt+Q");
  // A capital letter is not Shift+letter, or every capital would be a chord:
  // the browser already folds Shift into the character, so naming it again
  // would make "Shift+A" of a capital A and no letter shortcut would match.
  assert.equal(keyName(ev("A")), "A");
  assert.equal(keyName(ev("a", { shift: true })), "A");
  assert.equal(keyName(ev("s", { ctrl: true, alt: true, shift: true })), "Ctrl+Alt+S");
  assert.equal(keyName(null), "");
});

test("a letter shortcut survives caps lock", () => {
  // The shop floor leaves caps lock on. Alt+A has to work either way, which
  // is what upper-casing the single character buys.
  assert.equal(shortcutFor(ev("a", { alt: true })), "newMaster");
  assert.equal(shortcutFor(ev("A", { alt: true })), "newMaster");
  assert.equal(shortcutFor(ev("s", { alt: true })), "save");
  assert.equal(shortcutFor(ev("S", { alt: true })), "save");
});

test("Shift is kept on a named key, where it is not in the character", () => {
  // Shift+F1 has to stay Shift+F1 -- F1 carries no case for the shift to
  // hide in, so the fold that applies to letters must not apply here.
  assert.equal(keyName(ev("F1", { shift: true })), "Shift+F1");
  assert.equal(shortcutFor(ev("F1", { shift: true })), "customerList");
  assert.equal(shortcutFor(ev("F1")), null, "F1 alone is the browser's help key");
});

test("Cmd is treated as Ctrl, so a Mac is not left out", () => {
  assert.equal(keyName(ev("Enter", { meta: true })), "Ctrl+Enter");
  assert.equal(shortcutFor(ev("Enter", { meta: true })), "addRow");
});

test("an unbound key means nothing", () => {
  assert.equal(shortcutFor(ev("A")), null);
  assert.equal(shortcutFor(ev("q", { alt: true })), null);
  assert.equal(shortcutFor(ev("Tab")), null, "Tab is the browser's -- never intercepted");
});

test("plain Delete does not eat a row while a quantity is being corrected", () => {
  // The exact failure the brief asks to avoid, and the reason this decision
  // is in a tested module rather than an `if` inside a keydown handler.
  assert.equal(shortcutFor(ev("Delete"), { typing: false }), "deleteRow");
  assert.equal(shortcutFor(ev("Delete"), { typing: true }), null);
  // But the modified spellings still work there, which is how Sigfa behaves.
  assert.equal(shortcutFor(ev("e", { alt: true }), { typing: true }), "deleteRow");
  assert.equal(shortcutFor(ev("d", { alt: true }), { typing: true }), "deleteRow");
});

test("Alt+A fires with the caret in the item box", () => {
  // Precisely how Sigfa is used: type a name that is not in the master, press
  // Alt+A, create it. A guard that blocked every shortcut while typing would
  // break the feature that was asked for.
  assert.equal(shortcutFor(ev("a", { alt: true }), { typing: true }), "newMaster");
  assert.equal(shortcutFor(ev("F2"), { typing: true }), "itemSearch");
  assert.equal(shortcutFor(ev("s", { alt: true }), { typing: true }), "save");
});

test("Enter is not a shortcut, so it can never submit the form", () => {
  // A stray Enter in a quantity box must not post the invoice. Enter is
  // handled per-field by nextRowField; it is deliberately absent from the
  // shortcut table.
  assert.equal(shortcutFor(ev("Enter")), null);
  assert.equal(shortcutFor(ev("Enter"), { typing: true }), null);
  assert.equal(
    BILLING_SHORTCUTS.some((s) => s.keys.includes("Enter")),
    false,
    "bare Enter must not be bound to anything"
  );
});

test("Enter walks the row and then stops", () => {
  // Left to right, as Sigfa does, and null at the end so the CALLER decides
  // -- which is a new row, not a submit.
  assert.deepEqual(ROW_FIELD_ORDER, ["quantity", "cost", "discount"]);
  assert.equal(nextRowField("quantity"), "cost");
  assert.equal(nextRowField("cost"), "discount");
  assert.equal(nextRowField("discount"), null, "the end of the row is not a submit");
  assert.equal(nextRowField("nonsense"), "quantity", "an unknown field starts the row");
});

test("a text field is recognised, and a checkbox is not", () => {
  assert.equal(isTypingTarget({ tagName: "INPUT", type: "text" }), true);
  assert.equal(isTypingTarget({ tagName: "INPUT", type: "number" }), true);
  assert.equal(isTypingTarget({ tagName: "TEXTAREA" }), true);
  assert.equal(isTypingTarget({ isContentEditable: true }), true);
  assert.equal(isTypingTarget({ tagName: "INPUT", type: "checkbox" }), false);
  assert.equal(isTypingTarget({ tagName: "INPUT", type: "radio" }), false);
  assert.equal(isTypingTarget({ tagName: "BUTTON" }), false);
  assert.equal(isTypingTarget({ tagName: "SELECT" }), false, "a select handles its own keys");
  assert.equal(isTypingTarget(null), false);
  // An input with no type attribute is a text box.
  assert.equal(isTypingTarget({ tagName: "INPUT" }), true);
});

test("Alt+A offers the master the field in focus needs", () => {
  // Sigfa's "Create New Masters In Transaction" is context-sensitive.
  assert.equal(masterForField("item"), "item");
  assert.equal(masterForField("party"), "customer");
  assert.equal(masterForField("hsn"), "hsn");
  assert.equal(masterForField("unit"), "unit");
  assert.equal(masterForField("group"), "group");
  assert.equal(masterForField("stateOfSupply"), "state");
  // A field with no master behind it does nothing rather than guessing.
  assert.equal(masterForField("freight"), null);
  assert.equal(masterForField(""), null);
  assert.equal(masterForField(undefined), null);
});

test("every shortcut is listed in the help overlay", () => {
  // Alt+H exists so the keys are discoverable. A shortcut missing from it is
  // a shortcut nobody finds.
  const help = shortcutHelp();
  assert.equal(help.length, BILLING_SHORTCUTS.length);
  for (const row of help) {
    assert.ok(row.keys, "a row with no keys");
    assert.ok(row.label, `${row.keys} has no label`);
    assert.ok(["screen", "row"].includes(row.scope), `${row.keys} has scope ${row.scope}`);
  }
});

test("every shortcut has a distinct action and no key is bound twice", () => {
  const actions = BILLING_SHORTCUTS.map((s) => s.action);
  assert.equal(new Set(actions).size, actions.length, "two shortcuts share an action");
  const keys = BILLING_SHORTCUTS.flatMap((s) => s.keys);
  assert.equal(new Set(keys).size, keys.length, "a key is bound to two actions");
});

console.log("\n--- the component is wired to the same contract ---");

/** The object literal passed as `buildInvoicePayload`'s first argument. */
const formObjectKeys = () => {
  const src = read("../components/billing/BillingScreen.jsx");
  const at = src.indexOf("buildInvoicePayload(");
  assert.ok(at > 0, "BillingScreen does not call buildInvoicePayload");
  const open = src.indexOf("{", at);
  let depth = 0;
  let end = open;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = src.slice(open + 1, end);
  // Top-level keys only: strip anything nested.
  let level = 0;
  let flat = "";
  for (const ch of body) {
    if ("{[(".includes(ch)) level += 1;
    else if ("}])".includes(ch)) level -= 1;
    if (level === 0) flat += ch;
  }
  return flat
    .split(",")
    .map((seg) => seg.replace(/\/\/.*$/gm, "").trim())
    .filter(Boolean)
    .map((seg) => {
      const named = seg.match(/^([A-Za-z_$][\w$]*)\s*:/);
      if (named) return named[1];
      const shorthand = seg.match(/^([A-Za-z_$][\w$]*)$/);
      return shorthand ? shorthand[1] : null;
    })
    .filter(Boolean);
};

test("the screen feeds the builder every field the payload needs", () => {
  // THE CHECK THAT CATCHES A DROPPED FIELD. The old pages built the body as a
  // literal; the shared screen hands a form object to the builder. A key
  // missed in that move would arrive at the server as undefined -- silent,
  // and stored, because Mongoose would simply not write it.
  //
  // `type` and `return` are the config's, so they are the only two the form
  // does not supply.
  const supplied = new Set(formObjectKeys());
  const derived = new Set(["type", "return"]);
  const missing = PAYLOAD_KEYS.filter((k) => !supplied.has(k) && !derived.has(k));
  assert.deepEqual(missing, [], "these payload fields are not passed in");
});

test("the screen passes nothing the payload has no room for", () => {
  // The other direction: a field the builder ignores is a field somebody
  // believes is being sent.
  const supplied = formObjectKeys();
  const stray = supplied.filter((k) => !PAYLOAD_KEYS.includes(k));
  assert.deepEqual(stray, [], "these are passed but never sent");
});

test("the screen does not build a payload of its own", () => {
  // One builder, so a change to the contract cannot reach three of the four
  // screens and miss the fourth -- which is the whole reason for this
  // refactor.
  const src = read("../components/billing/BillingScreen.jsx");
  assert.doesNotMatch(src, /'return':\s*(true|false)/, "a hardcoded return flag");
  assert.doesNotMatch(src, /type:\s*["'](Sale|Purchase)["']/, "a hardcoded type");
  assert.ok(/config\.isReturn/.test(src) || /buildInvoicePayload/.test(src));
  assert.ok(/saveEndpoint\(/.test(src), "the endpoint choice is shared too");
});

test("the screen computes no money of its own", () => {
  // recalcItem and buildHsnTotals are imported, not redefined. A second copy
  // is how the stored line totals start disagreeing with the printed ones.
  const src = read("../components/billing/BillingScreen.jsx");
  assert.ok(/from '@\/lib\/billingMath\.mjs'/.test(src));
  assert.doesNotMatch(src, /const recalcItem\s*=/, "recalcItem is redefined here");
  assert.doesNotMatch(src, /const buildHsnTotals\s*=/, "buildHsnTotals is redefined here");
});

test("order billing is switched off by the config, not by a copy of the file", () => {
  // The returns used not to contain the feature at all. One flag now stands
  // in for 300 lines that were absent.
  const src = read("../components/billing/BillingScreen.jsx");
  assert.ok(/canBillFromOrder/.test(src));
  assert.ok(/if \(!billsFromOrder\) return;/.test(src), "the prefill effect is not guarded");
  assert.ok(/billsFromOrder && showPicker/.test(src), "the picker is not guarded");
  assert.ok(/ORDER_DOC = config\.orderDoc/.test(src), "ORDER_DOC is still hardcoded");
});

test("the sale page is a thin wrapper and holds no billing logic", () => {
  const src = read("../app/saleadd/page.js");
  assert.ok(/<BillingScreen typeKey='sale'/.test(src));
  assert.ok(src.split("\n").length < 40, "the page is not thin");
  // The things that used to live here and must not any more.
  assert.doesNotMatch(src, /useState|useEffect|invoiceData|recalcItem/);
});

console.log("\n--- the keyboard layer is wired, and guards nothing twice ---");

test("one listener, and the rule lives in the tested module", () => {
  const hook = code("../components/billing/useBillingKeys.js");
  assert.equal((hook.match(/addEventListener/g) || []).length, 1, "one listener, not one per field");
  assert.ok(/shortcutFor/.test(hook), "the decision is the module's");
  assert.ok(/isTypingTarget/.test(hook));
  // A held key must not fire repeatedly: leaning on Ctrl+Enter would add
  // forty rows, which is the accidental duplicate creation to prevent.
  assert.ok(/event\.repeat/.test(hook));
  // preventDefault only once something will handle it, or the app breaks
  // copy and paste.
  const guard = hook.indexOf("typeof handler !== 'function'");
  assert.ok(guard > 0 && guard < hook.indexOf("event.preventDefault()"));
});

test("Enter in a row advances and never submits", () => {
  const src = read("../components/billing/BillingScreen.jsx");
  assert.ok(/const onRowKeyDown/.test(src));
  assert.ok(/nextRowField\(field\)/.test(src), "the order is the shared one");
  // Unconditional: a bare Enter in a number box submits the surrounding form.
  const handler = src.slice(src.indexOf("const onRowKeyDown"));
  const body = handler.slice(0, handler.indexOf("};"));
  assert.ok(/if \(e\.key !== 'Enter'\) return;\s*\n\s*e\.preventDefault\(\);/.test(body));
  // All three row fields carry it.
  assert.equal((src.match(/onKeyDown=\{\(e\) => onRowKeyDown\(e, index,/g) || []).length, 3);
});

test("the row shortcuts act on the focused line, not the last one", () => {
  const src = read("../components/billing/BillingScreen.jsx");
  assert.equal((src.match(/onFocus=\{\(\) => setActiveRow\(index\)\}/g) || []).length, 3);
  assert.ok(/activeRow === null \|\| !selectedItem\[activeRow\]/.test(src), "deleteRow guesses");
});

test("a keyboard delete is confirmed before it happens", () => {
  const src = read("../components/billing/BillingScreen.jsx");
  assert.ok(/setConfirmRemove\(activeRow\)/.test(src));
  assert.ok(/Remove this line\?/.test(src));
  assert.ok(/the other lines are/.test(src), "it should say the rest survive");
});

test("Escape closes the innermost thing, and never the bill", () => {
  const src = read("../components/billing/BillingScreen.jsx");
  const back = src.slice(src.indexOf("back: () =>"));
  const body = back.slice(0, back.indexOf("},"));
  assert.ok(/showShortcuts/.test(body) && /quickMaster/.test(body) && /confirmRemove/.test(body));
  assert.doesNotMatch(body, /router\.(push|back)/, "Escape must not leave a half-typed bill");
});

test("Alt+A asks the field which master it needs", () => {
  const src = read("../components/billing/BillingScreen.jsx");
  assert.ok(/masterForField\(field\)/.test(src));
  assert.ok(/if \(!kind\) return;/.test(src), "a field with no master should do nothing");
  // The name already typed carries across, so it is not asked for twice.
  assert.ok(/prefill: typed \? \{ name: typed \}/.test(src));
});

test("every master Alt+A offers has an endpoint behind it", () => {
  const src = read("../components/billing/QuickMaster.jsx");
  for (const kind of ["item", "customer", "hsn", "group", "state"]) {
    assert.ok(new RegExp(`${kind}:\\s*\\{`).test(src), `${kind} has no form`);
  }
  // Every endpoint named is one that exists.
  for (const [, endpoint] of src.matchAll(/endpoint: '([^']+)'/g)) {
    const route = `../app${endpoint}/route.js`;
    assert.doesNotThrow(() => read(route), `${endpoint} does not exist`);
  }
  // The unit master genuinely does not exist here, and the dialog says so
  // rather than posting somewhere that would store it wrongly.
  assert.ok(/unavailable:/.test(src));
});

test("the quick-master dialog uses the endpoints' own field names", () => {
  // Renaming them to something prettier means Mongoose strict mode silently
  // dropping the value -- the mistake this project has made seven times.
  const src = read("../components/billing/QuickMaster.jsx");
  assert.ok(/'hsncode'|name: 'hsncode'/.test(src), "hsn-add reads hsncode");
  assert.ok(/'gstIn'|name: 'gstIn'/.test(src), "customer-add reads gstIn");
  assert.ok(/'salePrice'/.test(src));
  // A blank box is not stored as an empty string.
  assert.ok(/filledOnly/.test(src));
});

test("the item search reuses the loaded master and asks for nothing", () => {
  // /api/get-item already does find({}), so searching costs no request --
  // which is also why there is nothing to debounce.
  const src = code("../components/billing/ItemSearch.jsx");
  assert.doesNotMatch(src, /fetch\(/, "the search should need no request");
  assert.doesNotMatch(src, /debounce/i, "nothing to debounce when the data is already here");
  // Name, code and HSN.
  assert.ok(/item\?\.short/.test(src) && /item\?\.hsn/.test(src) && /item\?\.name/.test(src));
});

test("the item search is a proper combobox", () => {
  const src = code("../components/billing/ItemSearch.jsx");
  for (const attr of ['role="combobox"', 'role="listbox"', 'role="option"', "aria-expanded", "aria-activedescendant", "aria-selected"]) {
    assert.ok(src.includes(attr), `missing ${attr}`);
  }
  // Arrow keys, Enter and Escape, and Tab left to the browser.
  assert.ok(/ArrowDown/.test(src) && /ArrowUp/.test(src));
  assert.ok(/key === 'Escape'/.test(src));
  assert.doesNotMatch(src, /key === 'Tab'/, "Tab is the browser's");
  // Enter is prevented unconditionally -- it must never reach the form.
  // The next statement after the test, with comments gone -- so a long
  // explanation between the two cannot hide the thing being asserted.
  const enter = src.slice(src.indexOf("if (event.key === 'Enter')"));
  assert.match(enter.slice(0, 120), /event\.preventDefault\(\);/);
});

test("nothing uses a positive tabIndex", () => {
  // A positive tabIndex takes a control out of document order and breaks the
  // tab sequence for everything else on the page.
  for (const file of [
    "../components/billing/BillingScreen.jsx",
    "../components/billing/ItemSearch.jsx",
    "../components/billing/QuickMaster.jsx",
    "../components/billing/ShortcutHelp.jsx",
  ]) {
    const matches = [...read(file).matchAll(/tabIndex=\{?(-?\d+)/g)];
    for (const [, value] of matches) {
      assert.ok(Number(value) <= 0, `${file} has tabIndex=${value}`);
    }
  }
});

test("focus is moved only in response to a keystroke or a pick", () => {
  // Never on mount, and never on a re-render -- that is how a form yanks the
  // caret out from under somebody mid-typing.
  const src = read("../components/billing/BillingScreen.jsx");
  assert.doesNotMatch(src, /useEffect\(\(\) => \{\s*itemBoxRef\.current\?\.focus\(\)/);
});

test("the dialogs are dialogs, and say what they are", () => {
  for (const file of ["../components/billing/QuickMaster.jsx", "../components/billing/ShortcutHelp.jsx"]) {
    const src = read(file);
    assert.ok(/role="dialog"/.test(src), `${file} is not a dialog`);
    assert.ok(/aria-modal="true"/.test(src), `${file} is not modal`);
    assert.ok(/aria-label=/.test(src), `${file} has no name`);
    assert.ok(/key === 'Escape'/.test(src), `${file} cannot be closed by keyboard`);
  }
});

test("an error is not communicated by colour alone", () => {
  // The quick-master error carries role="alert" and words; the required
  // fields carry a marked label as well as the asterisk.
  const src = code("../components/billing/QuickMaster.jsx");
  assert.ok(/role="alert"/.test(src));
  assert.ok(/aria-hidden="true"/.test(src), "the decorative asterisk should be hidden");
  assert.ok(/required=\{field\.required\}/.test(src));
});

console.log("\n--- the pure modules stay pure ---");

test("none of the three imports React, Mongoose or a model", () => {
  for (const file of ["../lib/billingTypes.mjs", "../lib/billingMath.mjs", "../lib/billingKeys.mjs"]) {
    const src = read(file);
    assert.doesNotMatch(src, /from\s+["']react["']/, file);
    assert.doesNotMatch(src, /from\s+["']mongoose["']/, file);
    assert.doesNotMatch(src, /from\s+["'][^"']*models\//, file);
  }
});

test("the money module has no rounding helper in it at all", () => {
  // Not just unused -- absent, so there is nothing to reach for. The absence
  // of rounding is the contract.
  const src = read("../lib/billingMath.mjs");
  assert.doesNotMatch(src, /round2\s*\(/, "rounding would rewrite stored line totals");
  assert.doesNotMatch(src, /toFixed\s*\(/);
  assert.doesNotMatch(src, /Math\.round\s*\(/);
});

console.log(`\n  ${passed} checks passed\n`);
