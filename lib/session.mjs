/**
 * The signed session token.
 *
 * Deliberately built on Web Crypto (globalThis.crypto.subtle) rather than
 * node:crypto, because this module has to run in THREE places: the Next
 * middleware (edge runtime, where node:crypto does not exist), the API route
 * handlers (node), and the fixture test under bare node. Web Crypto is the
 * only one of the two available in all three.
 *
 * SHAPE
 * -----
 *   base64url(JSON payload) . base64url(HMAC-SHA256 of that)
 *
 * Stateless on purpose: no sessions collection, so checking a request costs no
 * database round trip and the middleware can do it at the edge.
 *
 * The cost of stateless is revocation. A token stays valid until it expires,
 * so sacking someone would not lock them out. That is what `v` (the user's
 * `tokenVersion`) is for: the API-side guard compares it with the stored one
 * and refuses a stale token. The middleware checks only the signature and the
 * expiry, which is all it can do without a database -- it is a gate, not the
 * lock.
 */

const te = new TextEncoder();

export const SESSION_COOKIE = "vyapaar_session";

/** How long a sign-in lasts. */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const b64urlEncode = (bytes) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const b64urlDecode = (text) => {
  const padded = String(text).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
};

const keyFor = (secret) => {
  if (typeof secret !== "string" || secret.length < 16) {
    throw new Error("AUTH_SECRET must be set to at least 16 characters.");
  }
  return crypto.subtle.importKey(
    "raw",
    te.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
};

/**
 * Sign a session.
 *
 * `claims` carries who and which firm:
 *   uid  user id
 *   cid  company id -- the tenant. Everything the request may read hangs off it
 *   role one of lib/roles.mjs ROLES
 *   v    the user's tokenVersion, for revocation
 */
export async function signSession(claims, secret, { now = Date.now(), ttl = SESSION_TTL_SECONDS } = {}) {
  const issued = Math.floor(now / 1000);
  const payload = {
    uid: String(claims?.uid || ""),
    cid: String(claims?.cid || ""),
    role: String(claims?.role || ""),
    v: Number(claims?.v) || 0,
    iat: issued,
    exp: issued + ttl,
  };
  if (!payload.uid || !payload.cid || !payload.role) {
    throw new Error("A session needs uid, cid and role.");
  }

  const body = b64urlEncode(te.encode(JSON.stringify(payload)));
  const mac = await crypto.subtle.sign("HMAC", await keyFor(secret), te.encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(mac))}`;
}

/**
 * Read a session back, or null.
 *
 * Null for every failure -- bad shape, wrong signature, expired, not JSON. The
 * caller gets "no session", never a hint about which part was wrong.
 */
export async function verifySession(token, secret, { now = Date.now() } = {}) {
  try {
    const [body, mac] = String(token || "").split(".");
    if (!body || !mac) return null;

    const ok = await crypto.subtle.verify(
      "HMAC",
      await keyFor(secret),
      b64urlDecode(mac),
      te.encode(body)
    );
    if (!ok) return null;

    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (!payload?.uid || !payload?.cid || !payload?.role) return null;

    // Expiry is checked AFTER the signature, so an unsigned token can never
    // be read at all, expired or not.
    if (!Number.isFinite(payload.exp) || payload.exp * 1000 <= now) return null;

    return payload;
  } catch {
    return null;
  }
}

/** The Set-Cookie attributes a session should carry. */
export const sessionCookieOptions = ({ secure = true, maxAge = SESSION_TTL_SECONDS } = {}) => ({
  httpOnly: true,
  sameSite: "lax",
  // Not reachable from JavaScript, not sent cross-site, and over HTTPS only in
  // production -- dev runs on plain http://localhost, where `secure` would stop
  // the cookie being stored at all.
  secure,
  path: "/",
  maxAge,
});
