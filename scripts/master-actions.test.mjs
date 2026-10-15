/**
 * Create, alter and delete a master from the field you are standing in:
 * scripts/master-actions.test.mjs
 *
 * Plain node, no framework -- `node scripts/master-actions.test.mjs`.
 *
 * THE ONE THAT MATTERS. "every field the alter route reads is in toPayload"
 * is not a tidy invariant, it is the difference between a working shortcut
 * and one that quietly destroys the client's item master. `api/item-alter`
 * ends in `existing.set({...})` with every field assigned unconditionally,
 * and two of those assignments turn a missing value into a WRONG one rather
 * than leaving it alone:
 *
 *     isService: Boolean(itemData.isService)          // undefined -> false
 *     uqc: normalizeUqc(itemData.uqc) || UQC_DEFAULT  // undefined -> "OTH"
 *
 * `uqc` is reported to the IRP. A partial alter body is a wrong e-invoice.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  MASTER_ACTION_KEYS,
  MASTER_FIELDS,
  MASTER_SPECS,
  alterPayload,
  deletePrompt,
  deleteUrl,
  findMaster,
  masterActionProblem,
  masterIsEditable,
  masterKindFor,
  masterNameOf,
  masterSpec,
} from "../lib/masterActions.mjs";
import { BILLING_SHORTCUTS, shortcutFor } from "../lib/billingKeys.mjs";

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
const code = (p) =>
  read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** A keydown event, as the browser hands one over. */
const ev = (key, mods = {}) => ({
  key,
  altKey: Boolean(mods.alt),
  ctrlKey: Boolean(mods.ctrl),
  shiftKey: Boolean(mods.shift),
  metaKey: false,
});

console.log("\n--- Sigfa's four keys, and that they are four ---");

test("create, alter, delete-record and delete-row are distinct", () => {
  // From SIGFA105.exe's own status bar:
  //   Create [ Alt + A ]  Alter [ Alt + M ]  Ledger [ Alt + I ]
  //   Delete Row (Alt + E)      Delete (Alt + D)
  assert.deepEqual(MASTER_ACTION_KEYS, {
    create: "Alt+A",
    alter: "Alt+M",
    deleteRecord: "Alt+D",
    deleteRow: "Alt+E",
  });
  // The four are four. Conflating the two deletes left no way to delete a
  // master at all, and made a mis-keyed Alt+D drop an invoice line instead.
  assert.equal(new Set(Object.values(MASTER_ACTION_KEYS)).size, 4);
});

test("Alt+D deletes a record and Alt+E deletes a row, through the key table", () => {
  assert.equal(shortcutFor(ev("d", { alt: true }), { typing: false }), "deleteMaster");
  assert.equal(shortcutFor(ev("e", { alt: true }), { typing: false }), "deleteRow");
  assert.equal(shortcutFor(ev("a", { alt: true }), { typing: false }), "newMaster");
  assert.equal(shortcutFor(ev("m", { alt: true }), { typing: false }), "alterMaster");
  // Alt+D must NOT still be an alias for the row delete.
  const rowDelete = BILLING_SHORTCUTS.find((s) => s.action === "deleteRow");
  assert.equal(rowDelete.keys.includes("Alt+D"), false, "Alt+D belongs to the master now");
  assert.ok(rowDelete.keys.includes("Alt+E"), "Alt+E is Sigfa's row key");
});

test("the three master keys work while typing, and the row delete does not", () => {
  // You press Alt+A with a half-typed name in the box -- that is the point of
  // it. Plain Delete must not eat a row while a quantity is being corrected.
  for (const key of ["a", "m", "d"]) {
    assert.ok(shortcutFor(ev(key, { alt: true }), { typing: true }), `Alt+${key} while typing`);
  }
  assert.equal(shortcutFor(ev("Delete"), { typing: true }), null);
  assert.equal(shortcutFor(ev("Delete"), { typing: false }), "deleteRow");
});

console.log("\n--- which master is behind a field ---");

test("the same field name means the same master on every screen", () => {
  // This is what makes the keys work everywhere rather than on one screen:
  // a bill's HSN column and the item master's HSN box are both `hsn`.
  assert.equal(masterKindFor("hsn"), "hsn");
  assert.equal(masterKindFor("hsncode"), "hsn", "the master screen's own name for it");
  assert.equal(masterKindFor("item"), "item");
  assert.equal(masterKindFor("customer"), "customer");
  assert.equal(masterKindFor("party"), "customer");
  assert.equal(masterKindFor("state"), "state");
  assert.equal(masterKindFor("stateOfSupply"), "state");
  assert.equal(masterKindFor("stateCode"), "state");
  // TWO group masters, as Sigfa's menu has them. `group` and
  // `customerGroup` file PARTIES -- and carry the reserved Cash and Bank
  // names an invoice settles into. `itemGroup` files GOODS and carries a
  // tree. They were the same kind until lib/itemGroups.mjs existed, which is
  // how "Sundry Debtors" came to be offered as a category of goods.
  assert.equal(masterKindFor("group"), "group");
  assert.equal(masterKindFor("customerGroup"), "group");
  assert.equal(masterKindFor("itemGroup"), "itemGroup");
  assert.equal(masterKindFor("unit"), "unit");
  // A field with nothing behind it answers no, rather than guessing.
  assert.equal(masterKindFor("freight"), null);
  assert.equal(masterKindFor("quantity"), null);
  assert.equal(masterKindFor(""), null);
  assert.equal(masterKindFor(undefined), null);
  // Trimmed, because a dataset attribute written across two lines in JSX
  // arrives with the whitespace in it.
  assert.equal(masterKindFor("  hsn  "), "hsn");
  assert.equal(masterKindFor("\nitem\n"), "item");
});

test("every mapped field names a kind that exists", () => {
  for (const [field, kind] of Object.entries(MASTER_FIELDS)) {
    assert.ok(masterSpec(kind), `${field} maps to "${kind}", which has no spec`);
  }
});

test("a kind with no master says so instead of doing nothing", () => {
  assert.equal(masterIsEditable("item"), true);
  assert.equal(masterIsEditable("unit"), false, "there is no unit master in this app");
  assert.equal(masterIsEditable("nonsense"), false);
  // And the refusal is a sentence, because a key that does nothing is
  // indistinguishable from a key that is broken.
  assert.match(masterActionProblem({ field: "unit", action: "create" }), /no unit master/i);
  assert.match(masterActionProblem({ field: "freight", action: "create" }), /no master behind/i);
});

test("create needs nothing in the field; alter and delete need a record", () => {
  assert.equal(masterActionProblem({ field: "item", action: "create" }), null);
  assert.equal(masterActionProblem({ field: "item", action: "create", value: "" }), null);
  assert.match(masterActionProblem({ field: "item", action: "alter", value: "" }), /Alt\+M alters/);
  assert.match(masterActionProblem({ field: "item", action: "delete", value: "" }), /Alt\+D deletes/);
  assert.equal(masterActionProblem({ field: "item", action: "alter", value: "MS Plate" }), null);
});

console.log("\n--- finding the record a field refers to ---");

test("an item field holds a name and an HSN field holds a code", () => {
  // Matching the wrong column is how Alt+D comes to report that a record
  // which is plainly on screen does not exist.
  assert.equal(masterSpec("item").matchField, "name");
  assert.equal(masterSpec("customer").matchField, "name");
  assert.equal(masterSpec("hsn").matchField, "hsncode", "not hsnname");
  assert.equal(masterSpec("state").matchField, "name");
  assert.equal(masterSpec("group").matchField, "name");
});

test("the match is trimmed and case-insensitive, as every join here is", () => {
  const items = [{ _id: "i1", name: "MS Plate" }, { _id: "i2", name: "Washer" }];
  assert.equal(findMaster(items, "item", "MS Plate")?._id, "i1");
  assert.equal(findMaster(items, "item", "ms plate")?._id, "i1");
  assert.equal(findMaster(items, "item", "  MS Plate  ")?._id, "i1");
  assert.equal(findMaster(items, "item", "MS Plat"), null, "not a prefix match");
  assert.equal(findMaster(items, "item", ""), null);
  assert.equal(findMaster([], "item", "MS Plate"), null);
  // An EMPTY field must not match a record whose name is blank. Master data
  // this old has blank names in it, and "Alt+D on an empty box deletes the
  // nameless record" is a bug nobody would ever reproduce deliberately.
  const dirty = [{ _id: "x", name: "" }, { _id: "i1", name: "MS Plate" }];
  assert.equal(findMaster(dirty, "item", ""), null);
  assert.equal(findMaster(dirty, "item", "   "), null);
  assert.equal(findMaster(dirty, "item", "MS Plate")?._id, "i1");
  assert.equal(findMaster(items, "unit", "KGS"), null, "no match field, no match");
  // An HSN list matches on the code.
  const hsn = [{ _id: "h1", hsncode: "7308", hsnname: "Structures" }];
  assert.equal(findMaster(hsn, "hsn", "7308")?._id, "h1");
  assert.equal(findMaster(hsn, "hsn", "Structures"), null, "the code, not the description");
});

test("a record names itself by the column the field matched on", () => {
  assert.equal(masterNameOf("item", { name: "MS Plate" }), "MS Plate");
  assert.equal(masterNameOf("hsn", { hsncode: "7308", hsnname: "Structures" }), "7308");
  assert.equal(masterNameOf("unit", { name: "KGS" }), "", "no match field, no name");
});

console.log("\n--- the alter body: every field the route reads ---");

/**
 * The identifiers an alter route reads off its request body.
 *
 * Both shapes the routes use: `const x = body.foo` / `itemData.foo`, and a
 * destructure `const { a, b, id } = body`.
 */
const fieldsReadBy = (routePath, bodyNames) => {
  const src = code(routePath);
  const found = new Set();
  for (const name of bodyNames) {
    for (const m of src.matchAll(new RegExp(`\\b${name}\\.([A-Za-z_][A-Za-z0-9_]*)`, "g"))) {
      found.add(m[1]);
    }
    for (const m of src.matchAll(new RegExp(`const \\{([^}]*)\\} = ${name}\\b`, "g"))) {
      for (const part of m[1].split(",")) {
        const ident = part.split(":")[0].trim();
        if (ident) found.add(ident);
      }
    }
  }
  // Not fields: these are methods and helpers, not body properties.
  for (const noise of ["json", "get", "set", "save", "toString", "then", "catch"]) {
    found.delete(noise);
  }
  // `_id` is an ALIAS, not a second field: group-update and state-update both
  // open with `const id = body.id || body._id`, so sending `id` satisfies
  // them. Carrying both would put two ids in every payload for no gain.
  if (found.has("_id") && found.has("id")) found.delete("_id");
  return found;
};

const ALTER_ROUTES = [
  { kind: "item", path: "../app/api/item-alter/route.js", bodyNames: ["itemData"] },
  { kind: "customer", path: "../app/api/customer-alter/route.js", bodyNames: ["customerData"] },
  { kind: "hsn", path: "../app/api/hsn-update/route.js", bodyNames: ["body"] },
  { kind: "group", path: "../app/api/group-update/route.js", bodyNames: ["body"] },
  { kind: "state", path: "../app/api/state-update/route.js", bodyNames: ["body"] },
  { kind: "series", path: "../app/api/series-update/route.js", bodyNames: ["body"] },
];

test("toPayload produces every field its alter route reads", () => {
  // THE TEST THIS FILE EXISTS FOR. A field the route reads and toPayload does
  // not produce is a field the route writes as undefined -- and on item-alter
  // that means isService flipped off and uqc reset to "OTH", which is a wrong
  // e-invoice rather than a cosmetic loss.
  for (const { kind, path, bodyNames } of ALTER_ROUTES) {
    const reads = fieldsReadBy(path, bodyNames);
    const produces = new Set(Object.keys(MASTER_SPECS[kind].toPayload({})));
    const missing = [...reads].filter((field) => !produces.has(field)).sort();
    assert.deepEqual(
      missing,
      [],
      `${kind}: the alter route reads ${missing.join(", ")} and toPayload does not send it`
    );
  }
});

test("the two fields that corrupt on a missing value are carried", () => {
  // Named explicitly, because the sweep above would pass if the route were
  // rewritten to stop reading them -- and these two are the reason the whole
  // load-then-send design exists.
  const produces = Object.keys(MASTER_SPECS.item.toPayload({}));
  assert.ok(produces.includes("uqc"), "uqc resets to OTH without it, and it goes to the IRP");
  assert.ok(produces.includes("isService"), "isService flips to false without it");
  const route = code("../app/api/item-alter/route.js");
  assert.match(route, /isService: Boolean\(/, "if this changed, re-read the comment above");
  assert.match(route, /uqc: normalizeUqc\(/, "if this changed, re-read the comment above");
});

test("the schema and the route disagree about three names, and the map knows", () => {
  const record = {
    _id: "i1",
    name: "MS Plate",
    openingQuantity: 50,
    minQuantity: 10,
    lastQuantity: 7,
  };
  const payload = MASTER_SPECS.item.toPayload(record);
  assert.equal(payload.openBal, 50, "openingQuantity is read as openBal");
  assert.equal(payload.minBal, 10, "minQuantity is read as minBal");
  assert.equal(payload.lastBal, 7, "lastQuantity is read as lastBal");
});

test("a party's LIVE balance is never sent as last year's", () => {
  // `lastBal` on the record is the running balance the posting path
  // maintains; the route reads `lastBal` as LAST YEAR's opening. Sending one
  // as the other would rewrite the party's opening position to whatever they
  // happen to owe today.
  const record = {
    _id: "c1",
    name: "Acme",
    openingBal: 1000,
    openingMode: "Dr",
    lastYearBal: 400,
    lastYearMode: "Dr",
    lastBal: 97531,
    lastMode: "Dr",
  };
  const payload = MASTER_SPECS.customer.toPayload(record);
  assert.equal(payload.openBal, 1000);
  assert.equal(payload.lastBal, 400, "last YEAR's, not the live 97531");
  assert.notEqual(payload.lastBal, record.lastBal);
});

test("the edits go over the record, and the id survives them", () => {
  const record = { _id: "i1", name: "MS Plate", salePrice: 100, uqc: "KGS", isService: false };
  const payload = alterPayload("item", record, { salePrice: 120 });
  assert.equal(payload.id, "i1");
  assert.equal(payload.salePrice, 120, "the edit wins");
  assert.equal(payload.uqc, "KGS", "and an untouched field keeps its value");
  assert.equal(payload.isService, false);
  // A box that was on the form and was cleared DOES clear the field.
  assert.equal(alterPayload("item", record, { short: "" }).short, "");
  // An edit cannot smuggle in a different id.
  assert.equal(alterPayload("item", record, { id: "somebody-else" }).id, "i1");
  // No record, no body -- rather than an alter with no id, which the route
  // would answer 400 to after the dialog had already closed.
  assert.equal(alterPayload("item", {}, {}), null);
  assert.equal(alterPayload("unit", record, {}), null);
});

console.log("\n--- the delete ---");

test("a delete goes to its own endpoint with the record's id", () => {
  assert.equal(deleteUrl("item", { _id: "i1" }), "/api/delete-item?id=i1");
  assert.equal(deleteUrl("customer", { _id: "c1" }), "/api/delete-cust?id=c1");
  assert.equal(deleteUrl("hsn", { _id: "h1" }), "/api/delete-hsn?id=h1");
  assert.equal(deleteUrl("group", { _id: "g1" }), "/api/delete-group?id=g1");
  assert.equal(deleteUrl("state", { _id: "s1" }), "/api/delete-state?id=s1");
  // The party endpoint is `delete-cust`, not `delete-customer`. Getting that
  // wrong is a 404 the dialog would report as a failure to delete.
  assert.match(deleteUrl("customer", { _id: "c1" }), /delete-cust\?/);
  assert.equal(deleteUrl("item", {}), null, "no id, no request");
  assert.equal(deleteUrl("unit", { _id: "u1" }), null);
  // An id with anything odd in it is escaped rather than concatenated.
  assert.equal(deleteUrl("item", { _id: "a b&c" }), "/api/delete-item?id=a%20b%26c");
});

test("every delete endpoint named here exists and takes an id", () => {
  for (const [kind, spec] of Object.entries(MASTER_SPECS)) {
    if (!spec.deleteEndpoint) continue;
    const path = `../app${spec.deleteEndpoint.replace("/api", "/api")}/route.js`;
    const src = read(path);
    assert.match(src, /searchParams\.get\(["']id["']\)/, `${kind}: ${spec.deleteEndpoint}`);
    assert.match(src, /export const POST = tenantRoute\(/, `${kind} must be wrapped and POST`);
  }
});

test("the confirmation names the record, and the kind in words", () => {
  // "Delete this record?" on a shortcut nobody meant to press is not a
  // question anybody reads.
  assert.equal(
    deletePrompt("item", { name: "MS Plate 10mm" }),
    'Delete the item "MS Plate 10mm" from the master? This cannot be undone.'
  );
  assert.match(deletePrompt("customer", { name: "Acme" }), /the party "Acme"/);
  assert.match(deletePrompt("hsn", { hsncode: "7308" }), /the HSN code "7308"/);
  assert.equal(deletePrompt("item", {}), null, "nothing named, nothing asked");
  assert.equal(deletePrompt("unit", { name: "KGS" }), null);
});

test("every editable kind has all four endpoints", () => {
  for (const [kind, spec] of Object.entries(MASTER_SPECS)) {
    if (spec.unavailable) continue;
    for (const key of [
      "label", "listEndpoint", "listKey", "createEndpoint",
      "alterEndpoint", "deleteEndpoint", "matchField", "toPayload",
    ]) {
      assert.ok(spec[key], `${kind} has no ${key}`);
    }
    assert.equal(typeof spec.toPayload, "function", kind);
  }
});

console.log("\n--- the keys reach every screen that has a master field ---");

/** Screens that must carry the three keys, and the fields they expose. */
const SCREENS = [
  {
    path: "../components/billing/BillingScreen.jsx",
    name: "the billing screen",
    // It has its own listener for the full key table, so it calls the hook
    // directly rather than mounting MasterShortcuts -- two listeners would
    // both fire on Alt+A.
    mounts: false,
    fields: ["item", "quantity"],
  },
  { path: "../app/itemadd/page.js", name: "the item master", mounts: true, fields: ["hsncode", "itemGroup"] },
  { path: "../app/customeradd/page.js", name: "the party master", mounts: true, fields: ["customerGroup", "stateName"] },
  // The item search box is its own component and carries the tag itself --
  // Alt+A there creates the item whose name is half typed, which is Sigfa's
  // whole reason for the key.
  { path: "../components/billing/ItemSearch.jsx", name: "the item search box", mounts: null, fields: ["item"] },
];

test("every screen with a master field can act on it", () => {
  // The whole complaint this answers: the keys existed on one screen out of
  // four, and on no master screen at all, so "no shortcuts are working".
  for (const screen of SCREENS) {
    const src = read(screen.path);
    // `null` means it is a field, not a screen: it carries the tag and the
    // screen around it owns the listener.
    if (screen.mounts === null) {
      assert.match(src, /data-master-field/, `${screen.name} is not tagged`);
      continue;
    }
    if (screen.mounts) {
      assert.match(src, /<MasterShortcuts/, `${screen.name} does not mount the keys`);
      assert.match(src, /from '@\/components\/masters\/MasterShortcuts'/, screen.name);
    } else {
      assert.match(src, /useMasterActions\(\{/, `${screen.name} does not use the hook`);
      assert.doesNotMatch(src, /<MasterShortcuts/, `${screen.name} would bind Alt+A twice`);
    }
  }
});

test("the tagged fields name a master that exists", () => {
  // A `data-master-field` nobody mapped is a key that does nothing on a box
  // that looks like it should work.
  for (const screen of SCREENS) {
    const src = read(screen.path);
    // String literals only. `data-master-field={masterField}` is the generic
    // InputField passing a prop through, not a field name.
    // Either quote style: this file is single-quoted and the master forms
    // are double-quoted.
    const tagged = [
      ...src.matchAll(/data-master-field=['"]([A-Za-z]+)['"]/g),
      ...src.matchAll(/masterField=['"]([A-Za-z]+)['"]/g),
    ].map((m) => m[1]);
    assert.ok(tagged.length > 0, `${screen.name} tags no field at all`);
    for (const field of tagged) {
      assert.ok(
        masterKindFor(field),
        `${screen.name} tags "${field}", which lib/masterActions.mjs does not map`
      );
    }
  }
});

test("a bill's three busiest boxes can reach their master", () => {
  // The gap this closes: the line inputs were tagged `data-billing-field` for
  // Enter-navigation and nothing else, the party dropdown and the item search
  // box were not tagged at all -- so the three keys answered "there is no
  // master behind this field" in the three places a clerk actually stands.
  const billing = read("../components/billing/BillingScreen.jsx");
  assert.match(billing, /data-master-field='customer'/, "the party dropdown");
  // A line's master is its ITEM; the box itself holds a number, so the name
  // is carried separately.
  assert.equal(
    (billing.match(/data-master-field='item'/g) || []).length,
    3,
    "quantity, rate and discount should all reach the line's item"
  );
  assert.equal(
    (billing.match(/data-master-value=\{items\.name\}/g) || []).length,
    3,
    "and each must name the item, not its own contents"
  );
  assert.match(read("../components/billing/ItemSearch.jsx"), /data-master-field='item'/);
  // The hook has to honour that, or the tag is decoration.
  assert.match(
    code("../components/masters/useMasterActions.js"),
    /dataset\?\.masterValue \?\? el\?\.value/
  );
});

test("a party's State and Group, and an item's HSN, are picked from their masters", () => {
  // They were free text boxes on the quick form. Everything in this app
  // joins BY NAME, so a State typed "Delhi" against a master holding
  // "DELHI" is a party whose state matches nothing -- and `taxTypeFor` then
  // reads no state code and refuses to decide the tax. None of it surfaces
  // as an error; it surfaces as a figure being wrong somewhere else.
  const src = read("../components/billing/QuickMaster.jsx");
  for (const [field, kind] of [
    ["state", "state"],
    ["group", "group"],
    ["hsn", "hsn"],
  ]) {
    const at = src.indexOf(`name: '${field}'`);
    assert.ok(at > 0, `${field} is not on any quick form`);
    const block = src.slice(at, at + 600);
    assert.match(block, /fromMaster: \{/, `${field} is still a free text box`);
    assert.match(block, new RegExp(`kind: '${kind}'`), `${field} points at the wrong master`);
  }
});

test("what a picked record fills comes with it, and cannot drift", () => {
  const src = read("../components/billing/QuickMaster.jsx");
  // Picking a state fills its code; picking an HSN fills the rate and unit.
  assert.match(src, /fills: \{ stateCode: 'code' \}/);
  assert.match(src, /fills: \{ gst: 'gst', unit: 'gstunit' \}/);
  // Those boxes are read-only while their source is chosen, so the two
  // cannot disagree: a state name carrying another state's code is a bill
  // taxed the wrong way with nothing on screen saying so.
  assert.match(src, /derived: true/);
  assert.match(src, /readOnly=\{Boolean\(/);
  // And cleared together, or the party keeps the code of a state it no
  // longer names.
  assert.match(src, /next\[target\] = row \? String\(row\[source\] \?\? ''\) : ''/);
});

test("the pickers read the same endpoints the keys do", () => {
  // Through masterSpec, not a second copy: an endpoint named again here is
  // how this dialog and Alt+M come to point at different lists.
  const src = read("../components/billing/QuickMaster.jsx");
  assert.match(src, /masterSpec\(name\)/);
  assert.match(src, /master\.listEndpoint/);
  assert.match(src, /body\[master\.listKey\]/);
  assert.doesNotMatch(src, /fetch\('\/api\/get-/, "a list endpoint is hardcoded here");
});

test("the unit box stays typed, because there is no unit master", () => {
  // The one exemption, and it is the module's own statement rather than an
  // oversight: units are typed straight onto an item in this app.
  assert.ok(!masterSpec("unit").listEndpoint);
  assert.ok(masterSpec("unit").unavailable);
  const src = read("../components/billing/QuickMaster.jsx");
  const at = src.indexOf("name: 'unit'");
  assert.ok(at > 0);
  assert.doesNotMatch(src.slice(at, at + 400), /fromMaster/);
});

test("the item and party masters tag the fields that have masters", () => {
  const item = read("../app/itemadd/page.js");
  // Its HSN box is the case the brief named: "item master has hsn so there it
  // should work for that too".
  assert.match(item, /data-master-field="hsncode"/);
  // A picker now, fed by the item group master, so it carries the attribute
  // directly rather than through InputField's `masterField` prop.
  assert.match(item, /data-master-field="itemGroup"/);
  const party = read("../app/customeradd/page.js");
  assert.match(party, /data-master-field="customerGroup"/);
  assert.match(party, /data-master-field="stateName"/);
});

test("a changed master refreshes the list the screen is showing", () => {
  // Every join in this app is BY NAME, so a dropdown still offering a renamed
  // record is a posting error and not a cosmetic one.
  for (const path of ["../app/itemadd/page.js", "../app/customeradd/page.js"]) {
    const src = code(path);
    assert.match(src, /onChanged=\{\(\{ kind \}\) =>/, `${path} ignores the change`);
    assert.match(src, /\/api\/get-(hsn|group|state)/, path);
  }
  // And the billing screen reloads the master that changed, not all of them.
  const billing = code("../components/billing/BillingScreen.jsx");
  assert.match(billing, /const reloadMaster = \(kind\) =>/);
  assert.match(billing, /onChanged: \(\{ kind, mode, record \}\)/);
  // A deleted party must not be left selected on the bill.
  assert.match(billing, /setSelectedCustomer\(\{\}\)/);
});

test("one listener resolves the keys, and both screens use the same one", () => {
  // MasterShortcuts and useBillingKeys must agree about what Alt+A means, so
  // both ask lib/billingKeys.mjs rather than comparing event.key themselves.
  const shortcuts = code("../components/masters/MasterShortcuts.jsx");
  assert.match(shortcuts, /shortcutFor\(event, \{ typing \}\)/);
  assert.match(shortcuts, /isTypingTarget\(/);
  assert.doesNotMatch(shortcuts, /event\.key === /, "it must not re-decide what a key means");
  // Installed once, not rebuilt per render.
  assert.match(shortcuts, /window\.addEventListener\('keydown'/);
  assert.match(shortcuts, /\}, \[\]\)/, "the effect must not depend on the handlers");
  // And it only claims the three it handles.
  assert.match(shortcuts, /newMaster: latest\.current\.create/);
  assert.match(shortcuts, /alterMaster: latest\.current\.alter/);
  assert.match(shortcuts, /deleteMaster: latest\.current\.remove/);
});

test("the module stays pure", () => {
  const src = read("../lib/masterActions.mjs");
  assert.doesNotMatch(src, /from\s+["']react["']/);
  assert.doesNotMatch(src, /from\s+["']mongoose["']/);
  assert.doesNotMatch(src, /from\s+["'][^"']*models\//);
  assert.doesNotMatch(src, /\bfetch\(/, "the components fetch; this decides");
});

console.log(`\n  ${passed} checks passed\n`);
