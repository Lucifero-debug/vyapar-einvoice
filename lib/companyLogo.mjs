/**
 * The firm's logo: what is accepted, and where it is kept.
 *
 * Pure and dependency-free, like the rest of lib/*.mjs, so `node` can run
 * scripts/company-branding.test.mjs directly. Never import Mongoose in here.
 *
 *
 * WHAT WAS WRONG
 * --------------
 * `lib/company.mjs` had, and `public/logo.jpg` still is:
 *
 *     export const COMPANY_LOGO = "/logo.jpg";
 *
 * One file in /public, 100KB of it, printed on the invoice of every firm on
 * the instance. The second firm to sign up got the first firm's logo at the
 * top of their tax invoices. That is the last piece of shared branding left
 * over from when this app served one shop -- the name, the GSTIN and the
 * address were moved onto the `companies` row some time ago, and the file in
 * /public was not.
 *
 * `components/InvoiceDocument.jsx` also rendered it in a `rounded-full`
 * frame with `object-cover`, which CROPS to fill: a wordmark wider than it is
 * tall came out as a circle cut from its middle. See the note on
 * `LOGO_FRAME` below.
 *
 *
 * WHERE IT IS KEPT, AND WHY HERE OF ALL PLACES
 * --------------------------------------------
 * On the firm's own `companies` row, as a `data:` URL. This app has no object
 * storage: `cloudinary` is in package.json and is imported in exactly zero
 * files, there are no CLOUDINARY_* variables anywhere, and nothing else in
 * the app has ever uploaded an image.
 *
 * A logo is a few tens of kilobytes, which is why this is defensible at all
 * -- `MAX_LOGO_BYTES` below is what keeps it defensible, and it is enforced
 * on the server against the DECODED bytes, not against what the browser
 * claimed. It is a deliberate, bounded exception to the ordinary rule that
 * images do not belong in a database, taken so the feature ships without an
 * account to open and three environment variables to set on Vercel.
 *
 * Everything that reads a logo goes through `logoSrc()` and everything that
 * writes one through `storeLogo()`, so swapping in Cloudinary later is those
 * two functions and a column that holds a URL instead of a data URL. No
 * settings page, print component or test changes.
 *
 *
 * THE TYPE COMES FROM THE BYTES
 * -----------------------------
 * Not from the filename, and not from the Content-Type the browser sent --
 * both are supplied by the caller and neither is evidence. `sniffImageType`
 * reads the actual magic bytes. A file called logo.png whose contents are a
 * PDF, or an HTML document with a .jpg extension, is refused.
 *
 * This matters more than it looks: the stored value goes into a `src`
 * attribute on a printed page. A `data:text/html` URL there is a script that
 * runs in the app's own origin, and the only thing standing between the
 * upload form and that is this check.
 */

const text = (value) => String(value ?? "").trim();

/**
 * The cap, on the DECODED image.
 *
 * 150KB. Comfortably more than any sensible logo -- a 400x400 PNG wordmark is
 * usually under 30 -- and small enough that the row stays a row. Base64 adds
 * about a third, so the stored string is around 200KB at the limit.
 */
export const MAX_LOGO_BYTES = 150 * 1024;

/**
 * The formats accepted, and how each one is recognised from its first bytes.
 *
 * PNG, JPEG and WebP: what the brief asks for, what a shop's designer sends,
 * and what every browser prints. Deliberately NOT SVG -- an SVG is a document
 * that can carry script and external references, and it would be rendered
 * from this app's own origin.
 */
export const LOGO_TYPES = [
  {
    mime: "image/png",
    label: "PNG",
    extension: "png",
    // \x89PNG\r\n\x1a\n
    signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  {
    mime: "image/jpeg",
    label: "JPEG",
    extension: "jpg",
    // SOI marker. The third byte is the first marker of the frame and varies,
    // so only two are fixed.
    signature: [0xff, 0xd8, 0xff],
  },
  {
    mime: "image/webp",
    label: "WebP",
    extension: "webp",
    // "RIFF" .... "WEBP" -- the four size bytes between are skipped, which is
    // what `at` is for.
    signature: [0x52, 0x49, 0x46, 0x46],
    also: { at: 8, signature: [0x57, 0x45, 0x42, 0x50] },
  },
];

export const LOGO_MIMES = LOGO_TYPES.map((t) => t.mime);

/** For the file input's `accept`, so the picker shows the right files. */
export const LOGO_ACCEPT = LOGO_MIMES.join(",");

/** "PNG, JPEG or WebP" -- for the hint under the control. */
export const LOGO_FORMAT_WORDS = (() => {
  const labels = LOGO_TYPES.map((t) => t.label);
  return `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`;
})();

const startsWith = (bytes, signature, at = 0) => {
  if (!bytes || bytes.length < at + signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[at + i] !== signature[i]) return false;
  }
  return true;
};

/**
 * What these bytes actually are, or null.
 *
 * The ONLY thing that decides a logo's type. See the header for why the
 * filename and the browser's Content-Type are not consulted.
 */
export const sniffImageType = (bytes) => {
  for (const type of LOGO_TYPES) {
    if (!startsWith(bytes, type.signature)) continue;
    if (type.also && !startsWith(bytes, type.also.signature, type.also.at)) continue;
    return type;
  }
  return null;
};

/**
 * Why this upload cannot be stored, in words. Null when it can be.
 *
 * `bytes` is the decoded image. CHECKED ON THE SERVER -- the form checks the
 * same things for a quicker answer, but a direct POST reaches this and only
 * this.
 */
export const logoProblem = ({ bytes, name } = {}) => {
  if (!bytes || !bytes.length) return "Choose an image file.";

  // Size first: a 40MB photograph should be refused by its size rather than
  // decoded and sniffed.
  if (bytes.length > MAX_LOGO_BYTES) {
    const kb = Math.round(bytes.length / 1024);
    const cap = Math.round(MAX_LOGO_BYTES / 1024);
    return `That image is ${kb}KB. A logo has to be under ${cap}KB -- save it smaller, or scale it down to about 400 pixels wide.`;
  }

  const type = sniffImageType(bytes);
  if (!type) {
    const called = text(name);
    return called
      ? `"${called}" is not a ${LOGO_FORMAT_WORDS} image, whatever its name says. Save it as one and try again.`
      : `Use a ${LOGO_FORMAT_WORDS} image.`;
  }

  return null;
};

/**
 * The stored value for a validated image: a `data:` URL.
 *
 * The MIME comes from the SNIFFED type, never from the caller -- which is the
 * point of sniffing. `toBase64` is injected because Buffer exists on the
 * server and btoa in the browser, and this module belongs to neither.
 */
export const storeLogo = ({ bytes, toBase64 } = {}) => {
  const type = sniffImageType(bytes);
  if (!type) return "";
  const encode =
    toBase64 ||
    ((b) =>
      typeof Buffer !== "undefined"
        ? Buffer.from(b).toString("base64")
        : btoa(String.fromCharCode(...b)));
  return `data:${type.mime};base64,${encode(bytes)}`;
};

/**
 * Is this a value this app stored, as opposed to something else that reached
 * the column?
 *
 * Strict about the prefix, because this guards what goes into a `src`. A
 * stored value that is not one of our three data URLs is treated as no logo
 * at all rather than rendered -- see `logoSrc`.
 */
export const isStoredLogo = (value) => {
  const v = text(value);
  return LOGO_MIMES.some((mime) => v.startsWith(`data:${mime};base64,`)) && v.length > 32;
};

/**
 * NOTHING. No logo means no logo.
 *
 * This is the whole fix. The old fallback was `/logo.jpg`, so a firm that had
 * never uploaded anything printed the file some other shop's logo happened to
 * be sitting in. A blank space on a bill is honest; a stranger's mark at the
 * top of your tax invoice is not -- the same reasoning lib/company.mjs gives
 * for leaving the GSTIN blank rather than printing a plausible-looking one.
 */
export const NO_LOGO = "";

/**
 * What to put in `src`, or "" to render nothing at all.
 *
 * An https URL is allowed through as well as our own data URLs, so that a
 * later move to object storage -- or a firm pasting a link to a logo they
 * already host -- needs no change here. Anything else, including the
 * `data:text/html` an attacker would want, resolves to no logo.
 */
export const logoSrc = (company) => {
  const value = text(company?.logo ?? company);
  if (!value) return NO_LOGO;
  if (isStoredLogo(value)) return value;
  if (/^https:\/\/[^\s]+$/i.test(value)) return value;
  return NO_LOGO;
};

/** Has this firm got a logo worth printing? */
export const hasLogo = (company) => Boolean(logoSrc(company));

/**
 * How the logo is framed, on screen and on paper.
 *
 * `object-contain`, NOT `object-cover`. Cover crops to fill the box, so the
 * old circular frame cut a wide wordmark down to whatever was in the middle
 * of it -- which is a distorted logo on every bill, and the brief's "avoid
 * stretching or distorting" in one word. Contain fits the whole image inside
 * the box and leaves the spare space empty, which is what a letterhead wants.
 *
 * A fixed HEIGHT with an auto width, rather than a square: logos are mostly
 * wider than they are tall, and a square box wastes a third of the masthead
 * on nothing. The max-width stops a very wide banner pushing the firm's name
 * off the line.
 */
export const LOGO_FRAME = Object.freeze({
  // Tailwind, because this is read straight into className by the print
  // components and the settings preview, and both must frame it identically.
  screen: "h-14 w-auto max-w-[180px] object-contain sm:h-16",
  print: "h-16 w-auto max-w-[200px] object-contain",
  preview: "h-20 w-auto max-w-[240px] object-contain",
});

/**
 * Roughly how big the stored string is, for the settings page to print.
 *
 * Base64 is four characters per three bytes, so the decoded size is three
 * quarters of the payload less the padding. Approximate on purpose -- it is
 * shown to a person deciding whether their logo is too heavy, not used to
 * enforce anything. The CAP is enforced on the real bytes, server-side.
 */
export const logoBytesOf = (value) => {
  const v = text(value);
  const comma = v.indexOf(",");
  if (!isStoredLogo(v) || comma < 0) return 0;
  const payload = v.slice(comma + 1);
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
};
