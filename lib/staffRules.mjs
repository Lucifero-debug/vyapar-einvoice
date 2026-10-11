/**
 * Who an owner may add to their firm, and what they may do to them.
 *
 * Pure and dependency-free, like the rest of lib/*.mjs, so `node` can run
 * scripts/staff.test.mjs directly. The database half lives in
 * lib/staffStore.mjs, which is the only module allowed to touch `User`.
 *
 *
 * WHY THIS IS A SEPARATE MODULE FROM lib/roles.mjs
 * ------------------------------------------------
 * roles.mjs answers "may this ROLE reach this PATH". It knows nothing about
 * particular people, and it should not: it is imported by the edge middleware,
 * where there is no database and no notion of who else works at the firm.
 *
 * The rules here are about PEOPLE. "You may not demote yourself" and "the last
 * active owner may not be switched off" cannot be expressed as a role-to-path
 * table, because they depend on who is asking and on who else is left.
 *
 *
 * THE INVARIANT THAT MATTERS MOST
 * ------------------------------
 * A firm must always have at least one active owner.
 *
 * `user:manage` is owner-only, and an owner is the only role that holds it. So
 * a firm that reaches zero active owners can never add one back from inside
 * the application -- there is nobody left who may open the staff page. It is
 * not a recoverable mistake, it is a firm locked out of its own books, and the
 * only repair is somebody editing the database by hand.
 *
 * Two different actions can cause it, which is why there are two guards:
 * changing the last owner's role, and deactivating them. Both are refused
 * here, and both refusals are checked on the server rather than hidden on the
 * screen.
 */

import { passwordProblem } from "./passwordRules.mjs";

const text = (value) => String(value ?? "").trim();
const idOf = (value) => String(value ?? "");

/**
 * The roles an owner may hand out.
 *
 * A WHITELIST, not a blacklist of "owner". The difference matters: a blacklist
 * has to anticipate every value that should be refused, and the day a fourth
 * role is added to roles.mjs it would be assignable by accident. This list has
 * to be edited deliberately before anything new can be granted.
 */
export const ASSIGNABLE_ROLES = ["accountant", "biller"];

/** What each role is called on screen, and what it can do, in one line. */
export const ROLE_LABELS = {
  owner: "Owner",
  accountant: "Accountant",
  biller: "Biller",
};

export const ROLE_BLURBS = {
  owner: "Everything, including staff.",
  accountant: "Invoices, vouchers, ledgers, masters and reports.",
  biller: "Invoices, and read-only masters.",
};

/** May an owner assign this role? Unknown value: no. */
export const isAssignableRole = (role) => ASSIGNABLE_ROLES.includes(text(role));

/**
 * What actually gets stored.
 *
 * Lowercased and trimmed to match `userModel`'s own `lowercase: true`, so the
 * clash check below compares the same thing the unique index will.
 */
export const normalizeEmail = (value) => text(value).toLowerCase();

/**
 * Why this address is not usable, or null.
 *
 * Deliberately loose, and deliberately the SAME rule as the sign-up route: an
 * address either reaches the person or it does not, and a strict pattern
 * mostly rejects valid ones. Two different rules would be worse than either --
 * an address accepted at sign-up and refused here reads as a bug.
 */
export const emailProblem = (value) => {
  const email = normalizeEmail(value);
  if (!email) return "Enter an email address.";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return "Enter a valid email address.";
  return null;
};

/** Why this name is not usable, or null. */
export const nameProblem = (value) => {
  // Required here although `userModel` defaults it to "", because this is the
  // column the staff list is read by. A row with no name is a row the owner
  // cannot tell apart from the next one.
  if (!text(value)) return "Enter the staff member's name.";
  return null;
};

/**
 * Everything wrong with a new staff member, in words. [] when it can be saved.
 *
 * Returns ALL the problems rather than the first, so somebody filling in a
 * form is not sent round the loop four times.
 */
export const staffCreateProblems = ({ name, email, role, password } = {}) => {
  const problems = [];

  const badName = nameProblem(name);
  if (badName) problems.push(badName);

  const badEmail = emailProblem(email);
  if (badEmail) problems.push(badEmail);

  if (!isAssignableRole(role)) {
    // Named explicitly when somebody asked for owner, because that is the one
    // wrong value with a reason behind it rather than a typo.
    problems.push(
      text(role) === "owner"
        ? "Staff cannot be made owners. Pick Accountant or Biller."
        : "Pick a role: Accountant or Biller."
    );
  }

  const badPassword = passwordProblem(password);
  if (badPassword) problems.push(badPassword);

  return problems;
};

/**
 * Why this role change is refused, or null.
 *
 *   actorId        who is asking
 *   target         the staff member as stored: { _id, role, active }
 *   nextRole       what they are to become
 *   activeOwners   how many active owners the firm has right now
 */
export const roleChangeProblem = ({ actorId, target, nextRole, activeOwners } = {}) => {
  if (!target) return "That staff member is not at this firm.";

  const next = text(nextRole);
  const current = text(target.role);

  if (next === current) return null;

  if (!isAssignableRole(next)) {
    return next === "owner"
      ? "An owner cannot be created from the staff page."
      : "Pick a role: Accountant or Biller.";
  }

  // Self-demotion. The owner holds `user:manage` and nobody else does, so an
  // owner who makes themselves a biller has shut the door they are standing
  // in -- and cannot reopen it.
  if (idOf(actorId) === idOf(target._id)) {
    return "You cannot change your own role.";
  }

  // Demoting an owner is only safe while another active one remains. Checked
  // even though the self-check above catches the common case: a firm with two
  // owners can reach zero through the other one.
  if (current === "owner" && Number(activeOwners) <= 1) {
    return "This is the firm's only active owner. Add another owner before changing this one.";
  }

  return null;
};

/**
 * Why switching this account off is refused, or null.
 *
 * Reactivating is never refused -- turning somebody back on cannot lock a firm
 * out of anything.
 */
export const deactivateProblem = ({ actorId, target, activeOwners } = {}) => {
  if (!target) return "That staff member is not at this firm.";
  if (target.active === false) return null;

  if (idOf(actorId) === idOf(target._id)) {
    return "You cannot deactivate your own account.";
  }

  if (text(target.role) === "owner" && Number(activeOwners) <= 1) {
    return "This is the firm's only active owner. Deactivating it would lock the firm out.";
  }

  return null;
};

/**
 * Does this change have to end the staff member's open sessions?
 *
 * Sessions are stateless (lib/session.mjs), so the only way to end one early
 * is to bump `tokenVersion` and let lib/authServer.mjs refuse the stale token.
 *
 * DEACTIVATION does not strictly need it -- `requireAuth` already refuses a
 * user whose `active` is false -- but it is bumped anyway, so that "this
 * account is off" and "its tokens are dead" are never two separate states one
 * of which might be missed.
 *
 * A ROLE CHANGE genuinely needs it, and this is the part that is easy to miss:
 * middleware.js decides which PAGES a request may reach from the role in the
 * TOKEN, because it runs at the edge with no database. So until a new token is
 * issued, a promoted biller stays locked out of the ledger page and a demoted
 * accountant still gets past the gate to it. Bumping forces a fresh sign-in,
 * which is the only thing that makes the edge and the database agree.
 *
 * A PASSWORD CHANGE ends other sessions because that is what changing a
 * password is for.
 */
export const needsTokenBump = ({ before = {}, after = {} } = {}) => {
  if (text(before.role) !== text(after.role)) return true;
  if (before.active !== false && after.active === false) return true;
  if (after.passwordChanged === true) return true;
  return false;
};

/**
 * The shape that may leave the server.
 *
 * Built field by field from a whitelist rather than by deleting what must not
 * go out. `passwordHash` carries `select: false`, so it is normally absent --
 * but a query that asked for it by name would hand it straight to the browser
 * through a spread, and "we remembered to delete it" is a weaker guarantee
 * than "it was never copied".
 */
export const publicStaff = (user = {}) => ({
  id: idOf(user._id ?? user.id),
  name: text(user.name),
  email: normalizeEmail(user.email),
  role: text(user.role),
  active: user.active !== false,
  mustChangePassword: user.mustChangePassword === true,
  createdAt: user.createdAt ?? null,
  lastLoginAt: user.lastLoginAt ?? null,
});

/**
 * What the owner may do to this row, and why not.
 *
 * The screen asks this so a refusal is visible before it is attempted; the
 * routes ask the two guards above, which are the ones that bind. Same module
 * either way, so the two cannot drift.
 */
export const rowPowers = ({ actorId, staff, activeOwners } = {}) => {
  const self = idOf(actorId) === idOf(staff?.id ?? staff?._id);
  const roleReason = roleChangeProblem({
    actorId,
    target: { _id: staff?.id ?? staff?._id, role: staff?.role, active: staff?.active },
    // Asking about the opposite of what they are: "could this row be moved at
    // all", rather than "may it become this particular role".
    nextRole: text(staff?.role) === "biller" ? "accountant" : "biller",
    activeOwners,
  });
  const statusReason = deactivateProblem({
    actorId,
    target: { _id: staff?.id ?? staff?._id, role: staff?.role, active: staff?.active },
    activeOwners,
  });

  return {
    self,
    canChangeRole: roleReason === null,
    roleReason,
    // Reactivating is always allowed, and `deactivateProblem` already says so
    // by returning null for an account that is off. This used to repeat that
    // with a ternary -- two copies of one rule, and the copy is what goes
    // stale. The name is about the control, not the direction: on an off row
    // it is the Reactivate button.
    canDeactivate: statusReason === null,
    statusReason,
  };
};

/** The three figures above the list. */
export const staffSummary = (staff = []) => {
  let active = 0;
  const byRole = { owner: 0, accountant: 0, biller: 0 };
  for (const person of staff) {
    if (person?.active !== false) active += 1;
    const role = text(person?.role);
    if (role in byRole) byRole[role] += 1;
  }
  return { total: staff.length, active, inactive: staff.length - active, byRole };
};

/** Does this row match what was typed in the search box? */
export const matchesSearch = (staff, search) => {
  const needle = text(search).toLowerCase();
  if (!needle) return true;
  return (
    text(staff?.name).toLowerCase().includes(needle) ||
    normalizeEmail(staff?.email).includes(needle)
  );
};

export const STATUS_FILTERS = ["all", "active", "inactive"];

/**
 * The list as the filters leave it.
 *
 * Pure, and used by the page rather than re-filtered on the server: the whole
 * staff of a trading firm is a handful of rows, and a round trip per keystroke
 * would be slower than the typing.
 */
export const filterStaff = ({ staff = [], search = "", role = "all", status = "all" } = {}) =>
  staff.filter((person) => {
    if (!matchesSearch(person, search)) return false;
    if (text(role) !== "all" && text(person?.role) !== text(role)) return false;
    if (text(status) === "active" && person?.active === false) return false;
    if (text(status) === "inactive" && person?.active !== false) return false;
    return true;
  });
