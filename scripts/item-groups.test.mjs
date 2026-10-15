/**
 * The item group master.
 *
 *   node scripts/item-groups.test.mjs
 *
 * Two things are being held up here. The RULES -- Sigfa's Main Group and
 * Under Group, and the loop they can be made to close -- which are pure and
 * tested as values. And the WIRING: that this master is its own, separate
 * from the accounts groups it used to share a list with, and that the item
 * form fills its Group box from it.
 */

import assert from "node:assert/strict";
import fs from "node:fs";

import {
  GROUP_NAME_MAX,
  ITEM_GROUP_DEFAULTS,
  ITEM_GROUP_FIELDS,
  ancestorsOf,
  childrenOf,
  depthOf,
  groupFlag,
  groupKey,
  itemGroupOptions,
  itemGroupProblems,
  itemsInGroup,
  normalizeItemGroup,
  parentOptions,
  sameGroup,
} from "../lib/itemGroups.mjs";

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

/** A tree: Raw Material > Metals > Fasteners, and Finished Goods alongside. */
const tree = [
  { name: "Raw Material", mainGroup: true, underGroup: "" },
  { name: "Metals", mainGroup: false, underGroup: "Raw Material" },
  { name: "Fasteners", mainGroup: false, underGroup: "Metals" },
  { name: "Finished Goods", mainGroup: true, underGroup: "" },
];

console.log("\n--- the four fields on Sigfa's screen ---");

test("a group is its name, its Main Group flag, its parent and a remark", () => {
  assert.deepEqual(ITEM_GROUP_FIELDS, ["name", "mainGroup", "underGroup", "remark"]);
  assert.equal(ITEM_GROUP_DEFAULTS.mainGroup, false, "the screenshot shows No");
  assert.equal(ITEM_GROUP_DEFAULTS.underGroup, "");
});

test("every field comes back, whatever was sent", () => {
  // A route that kept only the keys it was given would clear the rest on a
  // partial post -- the contract every master here upholds.
  const out = normalizeItemGroup({ name: "Metals" });
  assert.deepEqual(Object.keys(out).sort(), ITEM_GROUP_FIELDS.slice().sort());
});

test("the name is trimmed, collapsed and capped", () => {
  assert.equal(normalizeItemGroup({ name: "  Raw   Material " }).name, "Raw Material");
  assert.equal(normalizeItemGroup({ name: "x".repeat(80) }).name.length, GROUP_NAME_MAX);
  assert.equal(normalizeItemGroup({}).name, "");
  assert.equal(normalizeItemGroup({ name: null }).name, "");
});

test("a main group keeps no parent, even when one is posted", () => {
  // Both cannot be true. A stale parent left on the row is how a group walks
  // back into the tree the next time somebody unticks Main Group.
  const out = normalizeItemGroup({ name: "Raw Material", mainGroup: true, underGroup: "Metals" });
  assert.equal(out.underGroup, "");
});

test("a checkbox posted as the string \"false\" is false", () => {
  // The bug this exists for: "false" is a truthy string, so a form that
  // posted its flags as text made every group a main group.
  assert.equal(groupFlag("false"), false);
  assert.equal(groupFlag("no"), false);
  assert.equal(groupFlag("true"), true);
  assert.equal(groupFlag("yes"), true);
  assert.equal(groupFlag(undefined, true), true, "falls back when absent");
  assert.equal(groupFlag("", false), false);
  assert.equal(normalizeItemGroup({ name: "M", mainGroup: "false" }).mainGroup, false);
});

test("names are matched the way a person would read them", () => {
  assert.equal(groupKey("  Raw   Material "), "raw material");
  assert.ok(sameGroup("Raw Material", "raw  material"));
  assert.ok(!sameGroup("", ""), "two blanks are not the same group");
  assert.ok(!sameGroup("Metals", "Metal"));
});

console.log("\n--- what the screen refuses ---");

test("a group needs a name, and says only that", () => {
  const problems = itemGroupProblems({ name: "  " }, tree);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /group name is needed/i);
});

test("a name another group already has is refused", () => {
  assert.match(itemGroupProblems({ name: "metals", mainGroup: true }, tree)[0], /already exists/);
  // The row being edited is left OUT of the list passed in, or re-saving it
  // would report it as a duplicate of itself.
  const others = tree.filter((g) => g.name !== "Metals");
  assert.deepEqual(itemGroupProblems({ name: "Metals", underGroup: "Raw Material" }, others), []);
});

test("a group that is not a main group has to sit under one", () => {
  assert.match(
    itemGroupProblems({ name: "Screws" }, tree)[0],
    /Choose the group Screws sits under, or tick Main Group/
  );
  // Ticking Main Group is the other way out, and then nothing is wrong.
  assert.deepEqual(itemGroupProblems({ name: "Screws", mainGroup: true }, tree), []);
});

test("a parent that does not exist is refused", () => {
  assert.match(
    itemGroupProblems({ name: "Screws", underGroup: "Hardware" }, tree)[0],
    /no group called Hardware/
  );
});

test("a group cannot be under itself", () => {
  // The row being edited is left out of the list, as every caller does --
  // passed in, the duplicate check would fire first and hide this one.
  const others = tree.filter((g) => g.name !== "Metals");
  assert.match(
    itemGroupProblems({ name: "Metals", underGroup: "metals" }, others)[0],
    /cannot be under itself/
  );
});

test("a loop further up the tree is refused too", () => {
  // Putting Raw Material under Fasteners closes Raw Material > Metals >
  // Fasteners > Raw Material. Every later walk of the tree would never end.
  const others = tree.filter((g) => g.name !== "Raw Material");
  const problems = itemGroupProblems(
    { name: "Raw Material", underGroup: "Fasteners" },
    others
  );
  assert.match(problems[0], /would make a loop/);
});

test("a legal move is not refused", () => {
  const others = tree.filter((g) => g.name !== "Fasteners");
  assert.deepEqual(
    itemGroupProblems({ name: "Fasteners", underGroup: "Finished Goods" }, others),
    []
  );
});

console.log("\n--- walking the tree ---");

test("the groups above one, nearest first", () => {
  assert.deepEqual(ancestorsOf("Fasteners", tree), ["Metals", "Raw Material"]);
  assert.deepEqual(ancestorsOf("Raw Material", tree), [], "a main group is the top");
  assert.deepEqual(ancestorsOf("Nothing", tree), []);
  assert.equal(depthOf("Fasteners", tree), 2);
  assert.equal(depthOf("Raw Material", tree), 0);
});

test("a loop already in the data stops the walk instead of hanging it", () => {
  // Two people editing at once can leave one behind, and a walk that trusted
  // the tree would hang the REQUEST rather than the save.
  const looped = [
    { name: "A", mainGroup: false, underGroup: "B" },
    { name: "B", mainGroup: false, underGroup: "A" },
  ];
  assert.deepEqual(ancestorsOf("A", looped), ["B", "A"]);
});

test("the picker lists the tree in order, with each group's depth", () => {
  const options = itemGroupOptions(tree);
  assert.deepEqual(
    options.map((o) => o.path),
    [
      "Finished Goods",
      "Raw Material",
      "Raw Material / Metals",
      "Raw Material / Metals / Fasteners",
    ],
    "a child must follow its parent, not the alphabet"
  );
  assert.deepEqual(options.map((o) => o.depth), [0, 0, 1, 2]);
});

test("a group whose parent has gone is still offered", () => {
  // Dropping it would leave items filed under a group nobody can see or pick
  // again -- the orphan has to be visible to be fixed.
  const orphaned = [{ name: "Loose", mainGroup: false, underGroup: "Gone" }];
  assert.deepEqual(itemGroupOptions(orphaned).map((o) => o.name), ["Loose"]);
});

test("nothing passed is an empty list, not a crash", () => {
  assert.deepEqual(itemGroupOptions(), []);
  assert.deepEqual(itemGroupOptions(null), []);
  assert.deepEqual(itemGroupOptions([{ name: "  " }]), [], "a nameless row is not a group");
});

test("a group is never offered as its own parent, nor its children's", () => {
  // The same refusal itemGroupProblems makes, offered here so the loop cannot
  // be picked in the first place.
  const names = parentOptions("Metals", tree).map((o) => o.name);
  assert.deepEqual(names, ["Finished Goods", "Raw Material"]);
  assert.ok(!names.includes("Metals"));
  assert.ok(!names.includes("Fasteners"), "a child cannot become the parent");
});

console.log("\n--- what is in a group ---");

test("items are counted by group, as they were typed", () => {
  const items = [
    { group: "Metals" },
    { group: "metals" },
    { group: "Finished Goods" },
    {},
    { group: "" },
  ];
  assert.equal(itemsInGroup("Metals", items), 2, "case-insensitive");
  assert.equal(itemsInGroup("Finished Goods", items), 1);
  assert.equal(itemsInGroup("", items), 0, "a blank group is not a group");
  assert.equal(itemsInGroup("Metals"), 0);
});

test("the groups directly under one", () => {
  assert.deepEqual(childrenOf("Raw Material", tree).map((g) => g.name), ["Metals"]);
  assert.deepEqual(childrenOf("Fasteners", tree), []);
  assert.deepEqual(childrenOf("", tree), []);
});

console.log("\n--- the module stays pure ---");

test("no imports at all, so nothing it describes can import it back", () => {
  assert.doesNotMatch(read("../lib/itemGroups.mjs"), /^import /m);
});

test("it says what it was built from, and marks the one inference", () => {
  const src = read("../lib/itemGroups.mjs");
  assert.match(src, /Group Name/);
  assert.match(src, /Main Group/);
  assert.match(src, /Under Group/);
  assert.match(src, /Remark/);
  // The relation between Main Group and Under Group is NOT on the screenshot.
  assert.match(src, /a reading, not something observed/);
});

console.log("\n--- its own master, not the accounts one ---");

test("the item group has its own model, and it is tenant-scoped", () => {
  const src = read("../models/itemGroupModel.js");
  assert.match(src, /\.plugin\(\s*tenantPlugin\s*\)/, "not scoped to one firm");
  assert.match(src, /index\(\{ companyId: 1, name: 1 \}, \{ unique: true \}\)/);
  // Declared, or Mongoose strict mode drops them and the tree is never saved.
  for (const field of ITEM_GROUP_FIELDS) {
    assert.match(src, new RegExp(`${field}:`), `${field} is not declared`);
  }
});

test("the item form's Group box no longer reads the accounts groups", () => {
  // The bug: MASTER_FIELDS sent both `itemGroup` and `customerGroup` to the
  // same kind, so "Sundry Debtors" was offered as a category of goods.
  const src = code("../lib/masterActions.mjs");
  assert.match(src, /itemGroup: "itemGroup"/);
  assert.match(src, /customerGroup: "group"/, "the accounts side must not move");
  // And its own spec, pointing at its own endpoints.
  assert.match(src, /itemGroup: \{/);
  assert.match(src, /\/api\/get-item-group/);
  assert.match(src, /\/api\/item-group-add/);
  assert.match(src, /\/api\/item-group-update/);
  assert.match(src, /\/api\/delete-item-group/);
});

test("every route is signed in, permissioned and scoped", () => {
  const roles = read("../lib/roles.mjs");
  assert.match(roles, /\["\/api\/get-item-group", "master:read"\]/);
  for (const route of ["item-group-add", "item-group-update", "delete-item-group"]) {
    assert.match(roles, new RegExp(`\\["/api/${route}", "master:write"\\]`), route);
  }
  for (const route of [
    "get-item-group",
    "item-group-add",
    "item-group-update",
    "delete-item-group",
  ]) {
    assert.match(
      read(`../app/api/${route}/route.js`),
      /tenantRoute\(/,
      `${route} is not tenant-scoped`
    );
  }
});

test("the rules live in the module, not copied into the routes", () => {
  for (const route of ["item-group-add", "item-group-update"]) {
    const src = code(`../app/api/${route}/route.js`);
    assert.match(src, /itemGroupProblems\(/, `${route} checks by hand`);
    assert.match(src, /normalizeItemGroup\(/, `${route} builds the row by hand`);
  }
});

test("a rename cascades, or items are left pointing at nothing", () => {
  // Items hold the NAME. A rename that did not follow would leave them filed
  // under a group that is no longer in the picker.
  const src = code("../app/api/item-group-update/route.js");
  assert.match(src, /Item\.updateMany/);
  // And the children follow too, or the tree breaks at the renamed row.
  assert.match(src, /ItemGroup\.updateMany/);
  assert.match(src, /withTransaction|session/, "the rename and the cascade must commit together");
});

test("a group in use is not deleted", () => {
  const src = code("../app/api/delete-item-group/route.js");
  assert.match(src, /countDocuments/);
  assert.match(src, /\b409\b/);
  // Both reasons: items in it, and groups under it.
  assert.match(src, /childrenOf\(|underGroup/);
});

console.log("\n--- the item master fills its Group from it ---");

test("the Group box is a picker fed by the master", () => {
  const src = read("../app/itemadd/page.js");
  assert.match(src, /\/api\/get-item-group/, "the form never loads the master");
  assert.match(src, /data-master-field="itemGroup"/, "Alt+A cannot create one here");
  assert.match(src, /itemGroupOptions\(/, "the tree is not shown as a tree");
});

test("a group the master no longer holds is still shown", () => {
  // Same reason as the series box on a bill: an item filed under a group
  // that was switched off would otherwise show a BLANK, look cleared, and be
  // saved that way without anybody choosing it.
  assert.match(read("../app/itemadd/page.js"), /groupChoices/);
});

console.log(`\n  ${passed} checks passed\n`);
