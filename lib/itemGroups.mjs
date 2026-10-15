/**
 * The item group master -- Sigfa's `Masters > Item Group` screen.
 *
 * Pure and dependency-free, so `node scripts/item-groups.test.mjs` runs it
 * directly. No React, no Mongoose, no model imports.
 *
 *
 * WHAT THIS IS BUILT FROM
 * -----------------------
 * A screenshot of SIGFA 10.5-G16's Item Group screen, which cannot be read
 * out of SIGFA105.exe from here. Four fields, in this order:
 *
 *   Group Name    the name, and the only thing an item stores
 *   Main Group    Yes / No -- the screenshot shows "No"
 *   Under Group   blank in the screenshot, beneath Main Group
 *   Remark        free text
 *
 * The screen is reached from a menu that lists `Accounts Group` and
 * `Item Group` as two separate entries, which is the evidence for the
 * decision under TWO GROUP MASTERS below.
 *
 * What the screenshot does NOT show is how Main Group and Under Group relate.
 * The reading taken here -- and it is a reading, not something observed -- is
 * the one the two fields can only sensibly have together: a MAIN group is a
 * top of the tree and sits under nothing, and any other group sits under one.
 * `groupProblems` enforces exactly that and nothing more.
 *
 *
 * TWO GROUP MASTERS
 * -----------------
 * This app had ONE group list, shared: `MASTER_FIELDS` mapped both the item
 * master's Group box and the customer master's to the same `group` kind, and
 * both read /api/get-group -- the customer groups. So "Sundry Debtors" was
 * offered as a category of goods, and a group added for screws turned up in
 * the list of what a party could be. Sigfa keeps them apart and so does this.
 *
 * The accounts side keeps its reserved names and its cash/bank meaning
 * (lib/customerGroups.mjs); this side has none of that. An item group is a
 * shelf, not an account, so nothing here is load-bearing for the ledger.
 *
 *
 * ITEMS HOLD THE NAME, NOT A REFERENCE
 * ------------------------------------
 * `items.group` is a string, as it always has been, and every report that
 * groups goods already reads it that way. That makes a rename a cascade --
 * api/item-group-update does it -- and it is why `delete-item-group` refuses
 * while items are still in a group rather than orphaning them.
 */

/** Sigfa's own field width. */
export const GROUP_NAME_MAX = 40;

/** Trim and collapse, with a cap. Blank for anything that is not text. */
const text = (value, max = 0) => {
  if (value === null || value === undefined) return "";
  const out = String(value).replace(/\s+/g, " ").trim();
  return max > 0 ? out.slice(0, max) : out;
};

/**
 * How two group names are compared.
 *
 * Case- and space-insensitive, because the box is free text and "Raw
 * Material", "raw material" and "RAW  MATERIAL" are one shelf. Used for the
 * duplicate check, for finding a parent, and for walking the tree -- all
 * three have to agree or a group could be its own ancestor without anything
 * noticing.
 */
export const groupKey = (name) => text(name).toLowerCase();

export const sameGroup = (a, b) => {
  const left = groupKey(a);
  return left !== "" && left === groupKey(b);
};

/** The flag, from a form that may post "false" as a string. */
export const groupFlag = (value, fallback = false) => {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const word = String(value).trim().toLowerCase();
  if (["true", "yes", "y", "1", "on"].includes(word)) return true;
  if (["false", "no", "n", "0", "off"].includes(word)) return false;
  return fallback;
};

/** Every field of an item group, and nothing else. */
export const ITEM_GROUP_DEFAULTS = {
  name: "",
  mainGroup: false,
  underGroup: "",
  remark: "",
};

export const ITEM_GROUP_FIELDS = Object.keys(ITEM_GROUP_DEFAULTS);

/**
 * A whole group from whatever the form or the route sent.
 *
 * EVERY FIELD, ALWAYS. A route that spread only the keys it was given would
 * clear the rest on a partial post, which is the contract lib/masterActions
 * upholds for every master here.
 *
 * A main group's Under Group is dropped rather than carried: the two cannot
 * both be true, and keeping a stale parent on a row that no longer uses it is
 * how a group comes back into the tree the next time somebody unticks Main.
 */
export const normalizeItemGroup = (input = {}) => {
  const mainGroup = groupFlag(input.mainGroup, ITEM_GROUP_DEFAULTS.mainGroup);
  return {
    name: text(input.name, GROUP_NAME_MAX),
    mainGroup,
    underGroup: mainGroup ? "" : text(input.underGroup, GROUP_NAME_MAX),
    remark: text(input.remark, 200),
  };
};

/**
 * What is wrong with this group, in the order a person would meet it.
 *
 * `groups` is every OTHER group of the firm -- the row being edited left out,
 * or re-saving it would report it as its own duplicate and its own ancestor.
 *
 * The refusals:
 *   - no name
 *   - a name another group already has
 *   - not a main group, and no parent named
 *   - a parent that is not a group
 *   - its own parent, or its own grandparent: a cycle
 *
 * Returns a list so a caller can show the first and a test can see them all.
 */
export const itemGroupProblems = (group = {}, groups = []) => {
  const draft = normalizeItemGroup(group);
  const problems = [];

  if (!draft.name) {
    problems.push("A group name is needed.");
    return problems;
  }

  if (groups.some((row) => sameGroup(row?.name, draft.name))) {
    problems.push(`Group ${draft.name} already exists.`);
  }

  if (draft.mainGroup) return problems;

  if (!draft.underGroup) {
    problems.push(
      `Choose the group ${draft.name} sits under, or tick Main Group.`
    );
    return problems;
  }

  if (sameGroup(draft.underGroup, draft.name)) {
    problems.push(`${draft.name} cannot be under itself.`);
    return problems;
  }

  const parent = groups.find((row) => sameGroup(row?.name, draft.underGroup));
  if (!parent) {
    problems.push(`There is no group called ${draft.underGroup}.`);
    return problems;
  }

  // Walking UP from the parent: if this group is already somewhere above it,
  // putting the parent over it closes a loop, and every later walk of the
  // tree -- the picker's indenting, a rename cascade -- would never end.
  if (ancestorsOf(parent.name, groups).some((up) => sameGroup(up, draft.name))) {
    problems.push(
      `${draft.underGroup} is already under ${draft.name}, so this would make a loop.`
    );
  }

  return problems;
};

/**
 * Every group above this one, nearest first.
 *
 * Guarded against a loop that is already in the data rather than assuming
 * there is none: these rows can be edited by two people at once, and a walk
 * that trusted the tree would hang the request rather than the save.
 */
export const ancestorsOf = (name, groups = []) => {
  const out = [];
  const seen = new Set();
  let current = groupKey(name);

  while (current && !seen.has(current)) {
    seen.add(current);
    const row = groups.find((entry) => groupKey(entry?.name) === current);
    const parent = row && !groupFlag(row.mainGroup) ? text(row.underGroup) : "";
    if (!parent) break;
    out.push(parent);
    current = groupKey(parent);
  }

  return out;
};

/** How deep a group sits, for the picker's indenting. A main group is 0. */
export const depthOf = (name, groups = []) => ancestorsOf(name, groups).length;

/**
 * The groups a picker offers: every one, in tree order, with its depth.
 *
 * Sorted by the PATH rather than the name, so a child follows its parent
 * instead of landing wherever the alphabet puts it. Groups whose parent is
 * missing still appear, at the top -- a list that silently dropped them would
 * leave an item filed under a group nobody can see or pick again.
 */
export const itemGroupOptions = (groups = []) => {
  const rows = (Array.isArray(groups) ? groups : [])
    .map((row) => ({ ...row, name: text(row?.name) }))
    .filter((row) => row.name);

  return rows
    .map((row) => {
      const path = [...ancestorsOf(row.name, rows)].reverse();
      return {
        code: row.name,
        name: row.name,
        depth: path.length,
        // What the option reads as when the name alone is ambiguous: two
        // firms really do keep "Loose" under both Cement and Sugar.
        path: [...path, row.name].join(" / "),
        remark: text(row.remark),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
};

/**
 * The groups that may be offered as a PARENT while editing `name`.
 *
 * Itself and everything under it are left out, which is the same refusal
 * `itemGroupProblems` makes -- offered here so the loop cannot be chosen in
 * the first place, rather than only refused after Save.
 */
export const parentOptions = (name, groups = []) => {
  const self = groupKey(name);
  if (!self) return itemGroupOptions(groups);

  return itemGroupOptions(groups).filter(
    (option) =>
      groupKey(option.name) !== self &&
      !ancestorsOf(option.name, groups).some((up) => groupKey(up) === self)
  );
};

/**
 * How many items are in this group.
 *
 * Pure, so the delete route's refusal and the master screen's "in use" count
 * are the same number arrived at the same way. Case-insensitive, because the
 * box was free text before this master existed and holds whatever was typed.
 */
export const itemsInGroup = (name, items = []) => {
  const needle = groupKey(name);
  if (!needle) return 0;
  return (Array.isArray(items) ? items : []).filter(
    (item) => groupKey(item?.group) === needle
  ).length;
};

/** The groups directly under this one. Used by the delete refusal. */
export const childrenOf = (name, groups = []) => {
  const needle = groupKey(name);
  if (!needle) return [];
  return (Array.isArray(groups) ? groups : []).filter(
    (row) => !groupFlag(row?.mainGroup) && groupKey(row?.underGroup) === needle
  );
};
