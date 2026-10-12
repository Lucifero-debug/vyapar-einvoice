/**
 * What makes a password acceptable.
 *
 * Split out from lib/password.mjs on purpose: that module imports node:crypto
 * to do the hashing, and the sign-up page is a client component. Importing the
 * rule from there dragged node:crypto into the browser bundle, which does not
 * resolve -- the page failed to build.
 *
 * So the RULE lives here, with no imports at all, usable from the browser, the
 * server and the test. The HASHING stays where the node builtins are.
 */

/** The minimum a password may be. Short ones are the whole problem. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * The most a password may be. Sign-in refuses anything longer before hashing
 * it (app/api/auth/login/route.js), so a longer one could be set and never
 * used. Measured in UTF-16 units, as sign-in measures it.
 */
export const MAX_PASSWORD_LENGTH = 1024;

/**
 * Why this password is not acceptable, or null when it is.
 * Returns a sentence that can go straight on screen.
 */
export function passwordProblem(password) {
  if (typeof password !== "string" || password.length === 0) {
    return "Enter a password.";
  }
  // Counted in code points: an 8-emoji password is 8 characters to the person
  // who typed it, whatever .length says.
  if ([...password].length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.trim().length === 0) {
    return "Password cannot be only spaces.";
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
  }
  return null;
}
