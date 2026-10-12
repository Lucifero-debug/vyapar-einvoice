/**
 * Downloading a report file from one of the report routes.
 *
 * The report screens used to download by navigating to the route
 * (`window.location.href = '/api/sales-report?...&format=xlsx'`). That works
 * when the file comes back. When it does not -- the session has timed out, a
 * filter is refused, the server fails -- the browser replaces the whole app
 * with a page of raw JSON, and the person has to find their way back and set
 * the filters again. Fetching it first lets the screen say what went wrong
 * and stay where it is.
 *
 * `filenameFrom` is pure; `downloadFrom` needs a browser.
 */

import { NETWORK_ERROR, readResponse } from "./apiResponse.mjs";

/** The file name from a Content-Disposition header, or `fallback`. */
export function filenameFrom(disposition, fallback = "download") {
  const header = String(disposition || "");
  const star = header.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, "")) || fallback;
    } catch {
      // fall through to the plain form
    }
  }
  const plain = header.match(/filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/);
  const name = plain ? (plain[1] ?? plain[2] ?? "").trim() : "";
  // Never a path: a name with separators is reduced to its last part.
  const safe = name.split(/[\\/]/).pop();
  return safe || fallback;
}

/**
 * Fetch `url` and hand the file to the browser.
 *
 * Resolves `{ ok: true }` once the download has been started, or
 * `{ ok: false, message }` with the server's reason (or a network one).
 * Never throws.
 */
export async function downloadFrom(url, { fallbackName = "report" } = {}) {
  let res;
  try {
    res = await fetch(url);
  } catch {
    return { ok: false, message: NETWORK_ERROR };
  }

  const type = String(res.headers.get("content-type") || "");
  // A report route answers a refusal in JSON; a file is never JSON except the
  // GSTR-1 portal file, which comes back with an attachment disposition.
  const attachment = /attachment/i.test(String(res.headers.get("content-disposition") || ""));
  if (!res.ok || (type.includes("application/json") && !attachment)) {
    const { message } = await readResponse(res);
    return { ok: false, message: message || "The file could not be produced." };
  }

  let blob;
  try {
    blob = await res.blob();
  } catch {
    return { ok: false, message: NETWORK_ERROR };
  }

  const name = filenameFrom(res.headers.get("content-disposition"), fallbackName);
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Long enough for the browser to have taken the file.
  setTimeout(() => URL.revokeObjectURL(href), 60000);
  return { ok: true };
}
