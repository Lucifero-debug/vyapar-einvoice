/**
 * The answer a route gives when something broke inside it.
 *
 * Pure and dependency-free, so scripts/error-handling.test.mjs runs it under
 * bare node.
 *
 * The exception itself goes to the server log, tagged with a short
 * reference; the browser gets the reference and a sentence. A person who
 * reports "it said ref 7f3a9c" lets whoever reads the logs find the line,
 * without the screen ever showing a stack, a query, a host name or a key.
 */

const hex = () => {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "").slice(0, 8);
  return Math.random().toString(16).slice(2, 10).padEnd(8, "0");
};

/** `{ ref, payload }` for a 500. `payload` is safe to send to the browser. */
export function internalErrorBody(ref) {
  ref = ref || hex();
  const message = `The server ran into a problem (ref ${ref}). Try again; if it keeps happening, report this reference.`;
  return { ref, payload: { success: false, error: message, message, ref } };
}

/**
 * A 500 says what happened in the SERVER LOG, and only a reference to the
 * browser. Used on the way out of every tenant route (lib/tenantRoute.mjs).
 *
 * Nearly every route ends `catch (err) { return NextResponse.json({ error:
 * err.message }, { status: 500 }) }`, which hands the raw exception to the
 * screen: a duplicate-key dump naming the index and the values, a Mongo
 * connection error naming the cluster host, a "Cast to ObjectId failed" with
 * the field path, the tenant diagnosis naming internal module ids. Rewriting
 * the catch in ninety routes is a broad change; doing it once, on the way out,
 * covers every tenant route and cannot be forgotten by a new one.
 *
 * Only status 500 is touched. 4xx answers are the route speaking to the user
 * on purpose, and 502/503 carry deliberate operator messages (an IRP or AI
 * service that is down or unconfigured). Anything that is not a Response is
 * returned as it came.
 */
export async function hideInternalError(res, req, { log = console.error, ref } = {}) {
  if (!res || typeof res.status !== "number" || res.status !== 500) return res;
  let body = null;
  try {
    body = await res.clone().json();
  } catch {
    body = null;
  }

  // A schema refusal is the user's input, not a crash. Several add/alter
  // routes return Mongoose's ValidationError as a 500; told "the server ran
  // into a problem", the person would retry or report a bug instead of
  // filling in the field. Answered as a 400 naming the fields.
  const fields = validationMessage(body?.error || body?.message);
  if (fields) {
    return Response.json({ success: false, error: fields, message: fields }, { status: 400 });
  }

  const { ref: id, payload } = internalErrorBody(ref);
  let path = "";
  try {
    path = new URL(req?.url).pathname;
  } catch {
    path = "";
  }
  // The whole body (some routes put the exception in `details`), capped.
  const detail = body ? JSON.stringify(body).slice(0, 2000) : "(no JSON body)";
  log(`[api ${id}] ${req?.method || ""} ${path} -> 500:`, detail);
  return Response.json(payload, { status: 500 });
}

/**
 * A Mongoose ValidationError message, as a sentence for the user; null for
 * anything else.
 *
 *   "Item validation failed: hsn: Path `hsn` is required., name: Path `name` is required."
 *   -> "Check these fields: hsn is required; name is required."
 *
 * Only the field names and Mongoose's own rule text survive; values are not
 * included (a "Cast to Number failed for value ..." is dropped to its path).
 */
export function validationMessage(text) {
  const m = String(text ?? "").match(/^\w[\w ]* validation failed: ([\s\S]+)$/);
  if (!m) return null;
  const parts = m[1]
    .split(/,\s(?=[\w.]+: )/)
    .map((part) => {
      const [field, ...rest] = part.split(": ");
      const rule = rest.join(": ").replace(/\.$/, "");
      if (/is required/.test(rule)) return `${field} is required`;
      if (/Cast to \w+ failed/.test(rule)) return `${field} is not a valid value`;
      const plain = rule.replace(/Path `[^`]+`/g, field).replace(/\(`[^`]*`\)/g, "").trim();
      return plain.length <= 120 ? plain : `${field} is not valid`;
    })
    .filter(Boolean);
  return parts.length ? `Check these fields: ${parts.join("; ")}.` : null;
}
