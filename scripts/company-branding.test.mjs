/**
 * Fixture tests for the firm's logo and its document preferences.
 *
 *   node scripts/company-branding.test.mjs
 *
 * This feature exists because of one line:
 *
 *     export const COMPANY_LOGO = "/logo.jpg";
 *
 * One file in /public -- still there, 100KB of it -- rendered at the top of
 * every firm's invoice on the instance. The firm's NAME, GSTIN and address had
 * already been moved onto the `companies` row some time ago; the logo had not,
 * so the second firm to sign up printed the first firm's mark on their tax
 * invoices. These tests are mostly about the four ways that can come back:
 *
 *   1. A FALLBACK THAT IS SOMEBODY ELSE'S. A firm with no logo must print
 *      NOTHING. Any default -- a path, a placeholder, the last firm's value --
 *      is a stranger's mark on a tax invoice, which is the original bug.
 *
 *   2. THE TYPE COMING FROM THE CALLER. The stored value goes into a `src`
 *      on a page served from this app's own origin, so a `data:text/html`
 *      accepted here is a script running as the app. The filename and the
 *      Content-Type are both supplied by whoever is uploading; only the magic
 *      bytes are evidence.
 *
 *   3. A DEFAULT THAT CHANGES AN EXISTING BILL. Every `companies` row in the
 *      database has no `invoicePrefs` at all, so every default has to be the
 *      value that reproduces today's invoice exactly -- measured against
 *      components/InvoiceDocument.jsx, not guessed.
 *
 *   4. A PREFERENCE THAT IS NOT PRESENTATION. A setting that changes a FIGURE
 *      changes it for bills already issued, because a bill is printed from
 *      the invoice row plus the firm's CURRENT profile. A test below asserts
 *      that nothing financial has crept into the list.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import {
  LOGO_ACCEPT,
  LOGO_FORMAT_WORDS,
  LOGO_FRAME,
  LOGO_MIMES,
  LOGO_TYPES,
  MAX_LOGO_BYTES,
  NO_LOGO,
  hasLogo,
  isStoredLogo,
  logoBytesOf,
  logoProblem,
  logoSrc,
  sniffImageType,
  storeLogo,
} from "../lib/companyLogo.mjs";
import {
  DEFAULT_FOOTER_NOTE,
  DEFAULT_PAPER,
  DEFAULT_PREFS,
  MAX_FOOTER_LENGTH,
  PAPER_VALUES,
  PREF_FIELDS,
  PREF_NAMES,
  footerLines,
  isPaperSize,
  pageRuleFor,
  prefProblems,
  prefsFrom,
  showsDetail,
} from "../lib/invoicePrefs.mjs";
import { BLANK_COMPANY, FIELD_NAMES, companyFrom, profileProblems } from "../lib/company.mjs";
import { canAccessPath, permissionForPath } from "../lib/roles.mjs";

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

/**
 * The same file with its comments stripped.
 *
 * Needed here more than in most suites, because the modules this feature
 * touches QUOTE the old code in their own headers -- the whole point of those
 * notes is to record that `export const COMPANY_LOGO = "/logo.jpg"` used to
 * exist. A check for the string would match the apology instead of the bug,
 * and pass forever while the bug came back.
 */
const code = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** A file of `n` bytes beginning with a real signature. */
const image = (kind, n = 64) => {
  const heads = {
    png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    jpeg: [0xff, 0xd8, 0xff, 0xe0],
    // RIFF ____ WEBP
    webp: [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
  };
  const head = heads[kind];
  const bytes = Buffer.alloc(Math.max(n, head.length));
  Buffer.from(head).copy(bytes);
  return bytes;
};

console.log("\n--- the type comes from the bytes ---");

test("each supported format is recognised from its own signature", () => {
  assert.equal(sniffImageType(image("png")).mime, "image/png");
  assert.equal(sniffImageType(image("jpeg")).mime, "image/jpeg");
  assert.equal(sniffImageType(image("webp")).mime, "image/webp");
  assert.deepEqual(LOGO_MIMES, ["image/png", "image/jpeg", "image/webp"]);
  assert.equal(LOGO_ACCEPT, "image/png,image/jpeg,image/webp");
  assert.match(LOGO_FORMAT_WORDS, /PNG, JPEG or WebP/);
});

test("EVERY byte of a signature is compared, not just the first", () => {
  // 0x89 opens a PNG and opens nothing else that matters, so a first-byte
  // check passes a file that is not a PNG at all.
  const nearly = Buffer.alloc(64);
  nearly[0] = 0x89;
  assert.equal(sniffImageType(nearly), null);
  // The same for JPEG's three-byte marker and WebP's "RIFF".
  const halfJpeg = Buffer.from([0xff, 0xd8, 0x00, 0x00]);
  assert.equal(sniffImageType(halfJpeg), null);
  const halfRiff = Buffer.from([0x52, 0x00, 0x00, 0x00]);
  assert.equal(sniffImageType(halfRiff), null);
});

test("a RIFF container that is not WebP is refused", () => {
  // An AVI and a WAV both begin "RIFF". Checking only the first four bytes
  // would store a sound file as the firm's logo.
  const riff = image("webp");
  Buffer.from("AVI ").copy(riff, 8);
  assert.equal(sniffImageType(riff), null);
});

test("THE FILENAME IS NOT EVIDENCE", () => {
  const html = Buffer.from('<html><script>alert(1)</script></html>');
  assert.equal(sniffImageType(html), null);
  const problem = logoProblem({ bytes: html, name: "logo.png" });
  assert.match(problem, /not a PNG, JPEG or WebP image, whatever its name says/);
});

test("a PDF, an SVG and an empty file are all refused", () => {
  for (const [what, bytes] of [
    ["pdf", Buffer.from("%PDF-1.7\n")],
    // SVG is a document that can carry script and would be rendered from
    // this app's own origin, so it is deliberately not on the list.
    ["svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ["gif", Buffer.from("GIF89a")],
  ]) {
    assert.equal(sniffImageType(bytes), null, what);
    assert.ok(logoProblem({ bytes }), what);
  }
  assert.match(logoProblem({ bytes: Buffer.alloc(0) }), /Choose an image/);
  assert.match(logoProblem({}), /Choose an image/);
});

console.log("\n--- the size cap ---");

test("it is enforced, in words a shopkeeper can act on", () => {
  const big = image("png", MAX_LOGO_BYTES + 1);
  const problem = logoProblem({ bytes: big });
  assert.match(problem, /150KB/);
  assert.match(problem, /400 pixels/);
  // One byte under is fine.
  assert.equal(logoProblem({ bytes: image("png", MAX_LOGO_BYTES) }), null);
});

test("size is checked BEFORE the type, so a 40MB photo is not sniffed first", () => {
  // A huge file that is also the wrong type should be refused by its size:
  // that is the cheaper answer and the more useful message.
  const huge = Buffer.alloc(MAX_LOGO_BYTES * 4);
  assert.match(logoProblem({ bytes: huge, name: "scan.pdf" }), /KB/);
});

console.log("\n--- what gets stored ---");

test("a validated image becomes a data URL carrying the SNIFFED type", () => {
  const stored = storeLogo({ bytes: image("png") });
  assert.ok(stored.startsWith("data:image/png;base64,"));
  assert.equal(isStoredLogo(stored), true);
  // A JPEG does not become a PNG because somebody said so.
  const jpeg = storeLogo({ bytes: image("jpeg") });
  assert.ok(jpeg.startsWith("data:image/jpeg;base64,"));
});

test("bytes that are not an image store nothing", () => {
  assert.equal(storeLogo({ bytes: Buffer.from("not an image at all") }), "");
  assert.equal(storeLogo({}), "");
});

test("the stored size is reported back, roughly", () => {
  // 3002 rather than a multiple of three ON PURPOSE: base64 pads a length
  // that does not divide by three, and a size that ignores the padding is
  // right for every multiple of three and wrong for the other two thirds of
  // all files.
  for (const size of [3000, 3001, 3002]) {
    const reported = logoBytesOf(storeLogo({ bytes: image("png", size) }));
    // Exact, in fact -- but stated as a tolerance because it is shown to a
    // person, not enforced.
    assert.ok(Math.abs(reported - size) <= 1, `${size} -> ${reported}`);
  }
  assert.equal(logoBytesOf("/logo.jpg"), 0);
  assert.equal(logoBytesOf(""), 0);
  // A value WITH a comma that is not a stored logo: it must report nothing
  // rather than measuring whatever payload it carries.
  assert.equal(logoBytesOf("data:text/html;base64,PHNjcmlwdD4="), 0);
});

console.log("\n--- the fallback is NOTHING ---");

test("a firm with no logo prints no logo", () => {
  assert.equal(NO_LOGO, "");
  assert.equal(logoSrc({}), "");
  assert.equal(logoSrc({ logo: "" }), "");
  assert.equal(logoSrc(null), "");
  assert.equal(hasLogo({}), false);
  // And a real one DOES have one -- or the whole feature is a no-op that
  // every "prints nothing" assertion above would happily agree with.
  const stored = storeLogo({ bytes: image("png") });
  assert.equal(hasLogo({ logo: stored }), true);
  assert.equal(hasLogo({ logo: "https://cdn.example.com/a.png" }), true);
});

test("THE OLD SHARED PATH IS NOT A LOGO ANY MORE", () => {
  // This is the bug. `/logo.jpg` was one file in /public printed on every
  // firm's invoice; a row still holding it must render nothing rather than
  // one shop's mark on another shop's tax invoice.
  assert.equal(logoSrc({ logo: "/logo.jpg" }), "");
  assert.equal(logoSrc({ logo: "/public/logo.jpg" }), "");
  assert.equal(hasLogo({ logo: "/logo.jpg" }), false);
  // And it is gone from the branding module -- from the CODE, not from the
  // header note that records why it went.
  assert.equal(/export const COMPANY_LOGO/.test(code(read("../lib/company.mjs"))), false);
  assert.equal(BLANK_COMPANY.logo, "");
});

test("A data:text/html URL IS REFUSED", () => {
  // The stored value goes into a `src` on a page served from this app's own
  // origin. This is the check that matters most in the module.
  for (const nasty of [
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Lz48L3N2Zz4=",
    "javascript:alert(1)",
    "data:image/png;base64,",
    "http://insecure.example.com/a.png",
  ]) {
    assert.equal(logoSrc({ logo: nasty }), "", nasty);
    assert.equal(isStoredLogo(nasty), false, nasty);
  }
});

test("an https URL is allowed, for a later move to object storage", () => {
  assert.equal(logoSrc({ logo: "https://cdn.example.com/acme.png" }), "https://cdn.example.com/acme.png");
});

test("companyFrom puts every logo through the validator", () => {
  // So nothing reaches a printed page by being copied straight off the row.
  assert.equal(companyFrom({ name: "A", logo: "/logo.jpg" }).logo, "");
  assert.equal(companyFrom({ name: "A", logo: "data:text/html;base64,eA==" }).logo, "");
  const good = storeLogo({ bytes: image("png") });
  assert.equal(companyFrom({ name: "A", logo: good }).logo, good);
});

test("the frame contains the logo rather than cropping it", () => {
  // `object-cover` crops to fill, which is what the invoice used to do
  // inside a `rounded-full` box: a wide wordmark printed as a circle cut
  // from its middle. That is the brief's "avoid distorting" in one word.
  for (const variant of Object.values(LOGO_FRAME)) {
    assert.match(variant, /object-contain/);
    assert.equal(/object-cover/.test(variant), false);
    // A fixed height and an auto width, with a cap, so a banner cannot push
    // the firm's name off the line.
    assert.match(variant, /\bh-\d+\b/);
    assert.match(variant, /w-auto/);
    assert.match(variant, /max-w-/);
  }
});

console.log("\n--- the preferences preserve today's invoice ---");

test("the defaults are measured against the component, not guessed", () => {
  assert.deepEqual(DEFAULT_PREFS, {
    showLogo: true,
    showGstin: true,
    showPhone: true,
    // The invoice has NEVER printed an email, so defaulting this on would
    // silently change every bill.
    showEmail: false,
    showAddress: true,
    // Off, for the same reason as the email: the bill has never printed
    // bank details either.
    showBank: false,
    // There is no signature area on the bill today.
    showSignatory: false,
    paper: "A4",
    footerNote: DEFAULT_FOOTER_NOTE,
  });
});

test("the default footer is the two sentences the component had hard-coded", () => {
  assert.deepEqual(footerLines({}), [
    "Thank you for doing business with us.",
    "Please contact us if you have any questions about this invoice.",
  ]);
});

test("a row with no preferences at all reads as the defaults", () => {
  // Which is every `companies` row in the database right now.
  assert.deepEqual(prefsFrom({}), DEFAULT_PREFS);
  assert.deepEqual(prefsFrom(null), DEFAULT_PREFS);
  assert.deepEqual(prefsFrom({ name: "Acme" }), DEFAULT_PREFS);
  assert.deepEqual(companyFrom({ name: "Acme" }).invoicePrefs, DEFAULT_PREFS);
});

test("FALSE IS A CHOICE, not an absence", () => {
  // `||` would quietly turn a switch the owner turned off back on. The
  // difference between `??` and `||` is the whole of this test.
  assert.equal(prefsFrom({ invoicePrefs: { showGstin: false } }).showGstin, false);
  assert.equal(prefsFrom({ invoicePrefs: { showLogo: false } }).showLogo, false);
  // And a blank footer is "print no footer", not "use the default".
  assert.equal(prefsFrom({ invoicePrefs: { footerNote: "" } }).footerNote, "");
  assert.deepEqual(footerLines({ invoicePrefs: { footerNote: "" } }), []);
  // Absent, though, does default.
  assert.equal(prefsFrom({ invoicePrefs: {} }).footerNote, DEFAULT_FOOTER_NOTE);
});

test("an over-long footer is capped on the way in, not just refused", () => {
  // `prefProblems` refuses it, but a direct write that got past the form
  // must not be able to put four thousand characters on a bill either.
  const long = "x".repeat(MAX_FOOTER_LENGTH + 500);
  assert.equal(prefsFrom({ invoicePrefs: { footerNote: long } }).footerNote.length, MAX_FOOTER_LENGTH);
});

test("a preference the module does not declare cannot get in", () => {
  const out = prefsFrom({ invoicePrefs: { gstRate: 99, showLogo: true, sneaky: true } });
  assert.deepEqual(Object.keys(out).sort(), [...PREF_NAMES].sort());
  assert.equal("gstRate" in out, false);
  assert.equal("sneaky" in out, false);

  // AND through companyFrom, which is what every document actually reads.
  // Copying the sub-document straight off the row would carry whatever a
  // stray write had put in it onto a printed page.
  const firm = companyFrom({ name: "Acme", invoicePrefs: { gstRate: 99, showLogo: false } });
  assert.deepEqual(Object.keys(firm.invoicePrefs).sort(), [...PREF_NAMES].sort());
  assert.equal("gstRate" in firm.invoicePrefs, false);
  assert.equal(firm.invoicePrefs.showLogo, false, "and a real one is respected");
  // A row with a MISSING sub-document still gets every default.
  assert.deepEqual(companyFrom({ name: "Acme" }).invoicePrefs, DEFAULT_PREFS);
});

test("NOTHING IN THE LIST IS A FINANCIAL SETTING", () => {
  // A setting that changes a FIGURE changes it for bills already issued,
  // because a bill is printed from the invoice row plus the firm's CURRENT
  // profile. This is the line the whole module is built around.
  //
  // Pinned as an exact list rather than sniffed for forbidden words: a name
  // cannot say what a setting does -- `showGstin` is presentation and
  // `gstRate` would not be, and both contain "gst". Pinning it means adding
  // a preference is a deliberate edit HERE, where this comment is, which is
  // the only check that actually bites.
  assert.deepEqual(PREF_NAMES, [
    "showLogo",
    "showGstin",
    "showPhone",
    "showEmail",
    "showAddress",
    "showBank",
    "showSignatory",
    "paper",
    "footerNote",
  ]);

  // Everything but the paper and the note is a show/hide switch, which can
  // only ever change what is drawn.
  for (const field of PREF_FIELDS) {
    const isSwitch = field.name.startsWith("show") && field.kind === "boolean";
    assert.ok(
      isSwitch || ["paper", "footerNote"].includes(field.name),
      `"${field.name}" is neither a show/hide switch nor one of the two known presentation fields`
    );
    assert.ok(["boolean", "choice", "text"].includes(field.kind), field.name);
    assert.ok(field.label, `${field.name} has no label`);
  }
});

console.log("\n--- paper ---");

test("A4 is the default and A5 scales rather than needing a template", () => {
  assert.equal(DEFAULT_PAPER, "A4");
  assert.deepEqual(PAPER_VALUES, ["A4", "A5"]);
  assert.equal(isPaperSize("A4"), true);
  assert.equal(isPaperSize("Legal"), false);
  assert.equal(pageRuleFor({}).scale, 1);
  const a5 = pageRuleFor({ invoicePrefs: { paper: "A5" } });
  assert.equal(a5.size, "A5");
  // Less than 1, or the bill is 203mm wide on a 148mm sheet and the money
  // column is clipped.
  assert.ok(a5.scale > 0.5 && a5.scale < 1, `${a5.scale}`);
});

test("a paper size this build cannot print is refused, not silently swapped", () => {
  assert.match(prefProblems({ paper: "Legal" })[0].message, /A4 or A5/);
  assert.deepEqual(prefProblems({ paper: "A5" }), []);
  assert.deepEqual(prefProblems({}), []);
  // But a stored bad value still renders, as the default, rather than
  // throwing on a page.
  assert.equal(prefsFrom({ invoicePrefs: { paper: "Legal" } }).paper, "A4");
});

test("an over-long footer is refused with its length named", () => {
  const long = "x".repeat(MAX_FOOTER_LENGTH + 1);
  const problem = prefProblems({ footerNote: long });
  assert.match(problem[0].message, new RegExp(String(MAX_FOOTER_LENGTH)));
  assert.match(problem[0].message, new RegExp(String(long.length)));
  assert.deepEqual(prefProblems({ footerNote: "x".repeat(MAX_FOOTER_LENGTH) }), []);
});

console.log("\n--- a detail shows only if it is ON and it EXISTS ---");

test("both halves are required", () => {
  // A component that checks only the preference prints "GSTIN:" with nothing
  // after it, which on a tax invoice is worse than no line at all.
  assert.equal(showsDetail({}, "gstin", "07AAACA1111A1Z5"), true);
  assert.equal(showsDetail({}, "gstin", ""), false);
  assert.equal(showsDetail({}, "gstin", null), false);
  assert.equal(showsDetail({}, "gstin", "   "), false);
  assert.equal(showsDetail({ invoicePrefs: { showGstin: false } }, "gstin", "07AAA"), false);
  // Email is off by default even when the firm has one.
  assert.equal(showsDetail({}, "email", "a@b.in"), false);
  assert.equal(showsDetail({ invoicePrefs: { showEmail: true } }, "email", "a@b.in"), true);
  // An unknown detail is not shown rather than throwing.
  assert.equal(showsDetail({}, "whatever", "x"), false);
});

console.log("\n--- the new profile fields ---");

test("legal name and website are on the form and in the allowlist", () => {
  // FIELD_NAMES is both, which is what keeps the form and the update in step.
  assert.ok(FIELD_NAMES.includes("legalName"));
  assert.ok(FIELD_NAMES.includes("website"));
  assert.equal(BLANK_COMPANY.legalName, "");
  assert.equal(BLANK_COMPANY.website, "");
});

test("a website has to carry its scheme, and is not guessed at", () => {
  // Silently prefixing https:// guesses at a host that may only serve http,
  // and a dead link on a bill is worse than a typo caught while typing.
  const bad = profileProblems({ name: "A", website: "yourfirm.in" });
  assert.match(bad[0].message, /http:\/\/ or https:\/\//);
  assert.deepEqual(profileProblems({ name: "A", website: "https://yourfirm.in" }), []);
  assert.deepEqual(profileProblems({ name: "A", website: "http://yourfirm.in/billing" }), []);
  // Blank is fine -- most firms have none.
  assert.deepEqual(profileProblems({ name: "A", website: "" }), []);
  assert.deepEqual(profileProblems({ name: "A" }), []);
});

test("the GSTIN may still be blank, because not every firm is registered", () => {
  assert.deepEqual(profileProblems({ name: "A", gstin: "" }), []);
  assert.ok(profileProblems({ name: "A", gstin: "NOTAGSTIN" }).length);
});

console.log("\n--- security ---");

console.log();

test("the logo route is owner-only, exactly like the rest of the profile", () => {
  assert.equal(permissionForPath("/api/company-logo"), "setup:write");
  // EQUAL to the profile's, not merely set: a logo is part of the profile.
  assert.equal(permissionForPath("/api/company-logo"), permissionForPath("/api/company-update"));
  assert.equal(canAccessPath("owner", "/api/company-logo"), true);
  assert.equal(canAccessPath("accountant", "/api/company-logo"), false);
  assert.equal(canAccessPath("biller", "/api/company-logo"), false);
});

test("but every role can still READ the letterhead", () => {
  // A biller cannot print a bill without it.
  assert.equal(permissionForPath("/api/company"), null);
  for (const role of ["owner", "accountant", "biller"]) {
    assert.equal(canAccessPath(role, "/api/company"), true, role);
  }
});

test("the logo route takes the firm from the session, never from the body", () => {
  const route = read("../app/api/company-logo/route.js");
  assert.match(route, /export const POST = tenantRoute\(handlePOST\);/);
  assert.match(route, /auth\.companyId/g);
  // There is no companyId field to manipulate, which is the point.
  assert.equal(/body\??\.companyId|body\[.companyId.\]/.test(route), false);
  assert.equal(/searchParams\.get\(["']companyId["']\)/.test(route), false);
});

test("the logo route validates the BYTES, server-side", () => {
  const route = read("../app/api/company-logo/route.js");
  assert.match(route, /logoProblem\(\{ bytes/);
  assert.match(route, /storeLogo\(\{ bytes \}\)/);
  // The declared type is never trusted into the stored value.
  assert.equal(/body\.type|body\.mime|contentType/i.test(route), false);
});

test("the update route allowlists the preferences rather than spreading them", () => {
  const route = read("../app/api/company-update/route.js");
  assert.match(route, /for \(const name of PREF_NAMES\)/);
  // Spreading would let a caller set a key the schema has never heard of.
  assert.equal(/\.\.\.body\.invoicePrefs/.test(route), false);
  assert.equal(/\$set: body/.test(route), false);
  assert.match(route, /prefProblems\(body\)/);
  // And the profile is still built field by field.
  assert.match(route, /for \(const name of FIELD_NAMES\) update\[name\] = normalized\[name\];/);
});

test("the logo cannot be set through the profile save", () => {
  const route = read("../app/api/company-update/route.js");
  // It has its own route, so a 200KB data URL never rides along with every
  // profile save -- and the two can be limited separately.
  assert.equal(/update\.logo|update\["logo"\]/.test(route), false);
  assert.equal(FIELD_NAMES.includes("logo"), false);
});

console.log("\n--- the documents ---");

test("the invoice reads the firm from the firm's own record", () => {
  const doc = read("../components/InvoiceDocument.jsx");
  assert.match(doc, /useCompany\(\)/);
  // And the shared components, rather than its own copy of the letterhead.
  assert.match(doc, /CompanyBrand/);
  assert.match(doc, /CompanyLogo/);
  // The old shared file is gone from the CODE; the comment that explains
  // where it went is meant to stay.
  const live = code(doc);
  assert.equal(/logo\.jpg/.test(live), false);
  assert.equal(/object-cover/.test(live), false);
  // And the footer's two sentences are no longer typed into it -- they are
  // the DEFAULT of the firm's footer note now.
  assert.equal(/Thank you for doing business with us/.test(live), false);
  assert.match(doc, /DocumentFooter/);
});

test("a switch that is on does nothing unless the fields are filled in", () => {
  // showBank was a preference with no effect until the block was mounted.
  // Now it has one, and it is still gated on the firm having typed the
  // details -- an empty "Bank:" line at the foot of a bill is the same
  // mistake as an empty "GSTIN:" at the top.
  const on = { invoicePrefs: { showBank: true } };
  assert.equal(prefsFrom(on).showBank, true);
  const doc = read("../components/InvoiceDocument.jsx");
  assert.match(doc, /<CompanyBank/);
  const brand = read("../components/CompanyBrand.jsx");
  // The block returns null when there is nothing to print.
  assert.match(brand, /if \(!rows\.length\) return null;/);
});

test("the branding components gate every detail through one helper", () => {
  const brand = read("../components/CompanyBrand.jsx");
  assert.match(brand, /showsDetail/);
  assert.match(brand, /logoSrc/);
  assert.match(brand, /LOGO_FRAME/);
  // No second opinion about which details print.
  assert.equal(/has\(company\.gstin\)/.test(brand), false);
});

test("nothing in the app still points at the shared logo file", () => {
  for (const file of [
    "../lib/company.mjs",
    "../lib/companyLogo.mjs",
    "../components/InvoiceDocument.jsx",
    "../components/CompanyBrand.jsx",
  ]) {
    // Mentioned in COMMENTS -- the history is worth keeping, and three of
    // these files deliberately record it -- but never as a value.
    assert.equal(/["'`]\/logo\.jpg["'`]/.test(code(read(file))), false, file);
  }
});

test("the settings page previews the logo in the SAME frame the bill uses", () => {
  const page = read("../app/company/page.js");
  // A separate set of classes here is how a preview comes to flatter a logo
  // that the printed bill then crops.
  assert.match(page, /<CompanyLogo/);
  assert.match(page, /variant="preview"/);
  assert.match(page, /accept=\{LOGO_ACCEPT\}/);
  // The same validator the server uses, for a quick answer.
  assert.match(page, /logoProblem\(\{ bytes, name: file\.name \}\)/);
});

test("the model declares every new field, because strict mode drops the rest", () => {
  const model = read("../models/companyModel.js");
  for (const field of ["legalName", "website", "logo", "invoicePrefs"]) {
    assert.match(model, new RegExp(`\\b${field}\\s*:`), field);
  }
  for (const name of PREF_NAMES) {
    assert.match(model, new RegExp(`\\b${name}\\s*:`), `invoicePrefs.${name}`);
  }
  // The footer default is the real note, NOT "". The sub-document default
  // materialises on the next save of any row, and an empty footer is read as
  // the deliberate choice to print none -- so a blank default here would
  // have deleted the footer from every firm's invoice.
  assert.match(model, /footerNote: \{ type: String, default: DEFAULT_FOOTER_NOTE \}/);
});

console.log(`\n  ${passed} checks passed\n`);
