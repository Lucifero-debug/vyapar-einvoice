/**
 * Reading an API response on a screen, and saying what went wrong in words.
 *
 * Pure and dependency-free, like the rest of lib/*.mjs, so
 * scripts/error-handling.test.mjs runs it under bare node.
 *
 * WHY
 * ---
 * Screens did `const result = await res.json(); if (result.success) ... else
 * alert('Failed: ' + result.error)`. That goes wrong three ways:
 *
 *   - the routes do not agree on the field: most send `error`, the auth gate
 *     (middleware.js) and lib/authServer.mjs send `message` -- so a timed-out
 *     session showed "Failed to save invoice: undefined"
 *   - a 500 that is not JSON (a crash page, a proxy timeout) makes `res.json()`
 *     throw, and the screen reports "Error saving invoice" with no hint that
 *     it was the server rather than the connection
 *   - some routes answer a refusal with 200 and `success: false`, others with
 *     a 4xx and no `success` field at all
 *
 * `readResponse` folds all of that into one shape, and `errorMessage` turns a
 * status into something a shopkeeper can act on. Neither ever shows a stack
 * trace or a raw exception: the server's own `error`/`message` text is shown
 * when it sent one (that text is written for the user), a generic sentence
 * otherwise.
 */

/** When the request never got an answer at all. */
export const NETWORK_ERROR =
  "Could not reach the server. Check the internet connection and try again.";

/** The longest server message shown as-is. Anything longer is not a sentence for a person. */
const MAX_MESSAGE = 400;

/** Looks like a stack trace or an internal exception rather than a sentence for the user. */
const looksInternal = (text) =>
  /\n\s+at\s|\bat\s+\S+\s+\(.*:\d+:\d+\)|E11000|MongoServerError|MongooseError|Cast to \w+ failed|ECONNREFUSED|TypeError:|ReferenceError:|SyntaxError:|Unexpected token/.test(
    text
  );

/** The words for a status code when the server did not send any. */
export function statusMessage(status) {
  const code = Number(status) || 0;
  if (code === 401) return "Your session has ended. Sign in again, then retry.";
  if (code === 403) return "You do not have permission to do that.";
  if (code === 404) return "That record was not found. It may have been deleted -- reload and try again.";
  if (code === 409) return "That conflicts with a change already saved. Reload and try again.";
  if (code === 413) return "That is too large to send.";
  if (code === 429) return "Too many requests. Wait a moment and try again.";
  if (code >= 500) return "The server ran into a problem. Try again; if it keeps happening, note the time and report it.";
  if (code >= 400) return "The request was refused. Check the details and try again.";
  return "Something went wrong. Try again.";
}

/**
 * The message to show for a failed response.
 *
 * The server's own `error` (or `message`) when it is a plain sentence; the
 * status's generic sentence when it is missing, empty, too long or looks like
 * an internal exception.
 */
export function errorMessage(body, status) {
  const sent = [body?.error, body?.message].find((v) => typeof v === "string" && v.trim());
  if (sent) {
    const text = sent.trim();
    if (text.length <= MAX_MESSAGE && !looksInternal(text)) return text;
  }
  return statusMessage(status);
}

/**
 * Read a fetch Response into `{ ok, status, body, message }`.
 *
 *   ok        2xx AND not `success: false`
 *   body      the parsed JSON, or {} when there was none
 *   message   '' when ok, otherwise what to tell the user
 *
 * Never throws: a body that is not JSON is an empty body.
 */
export async function readResponse(res) {
  let body = {};
  try {
    const parsed = await res.json();
    if (parsed && typeof parsed === "object") body = parsed;
  } catch {
    body = {};
  }
  const status = Number(res?.status) || 0;
  const ok = Boolean(res?.ok) && body.success !== false;
  return { ok, status, body, message: ok ? "" : errorMessage(body, status) };
}

/**
 * Where to send somebody after signing in, from the login page's `?next=`.
 *
 * Only a path on THIS site. The gate (middleware.js) puts the page they were
 * headed for there, but anybody can put anything in a link: `?next=https://
 * look-alike.example/login` used to send a freshly signed-in user straight to
 * another site, which is how a phishing page asks for the password "again".
 * `//host` and `/\host` are other sites too, to a browser.
 */
export function safeNextPath(next) {
  const value = String(next ?? "").trim();
  if (!value.startsWith("/")) return "/";
  if (value.startsWith("//") || value.startsWith("/\\")) return "/";
  if (/[\u0000-\u001f]/.test(value)) return "/";
  return value;
}
