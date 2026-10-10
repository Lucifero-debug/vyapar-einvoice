/**
 * The firm's e-invoice portal credentials — the part that is not secret.
 *
 * The password itself is sealed by lib/secretBox.mjs and never leaves the
 * server. This module is the shape around it: which fields exist, which
 * environment is selected, and what is wrong with what the owner typed.
 *
 * Pure and client-safe on purpose. The profile form imports it; it must never
 * reach for secretBox, which imports node:crypto and would break the client
 * bundle (PROJECT_CONTEXT.md section 6).
 */

/** Sandbox first, because filing a test invoice as a real one is the mistake. */
export const EINVOICE_ENVS = [
  { value: "sandbox", label: "Sandbox — for testing" },
  { value: "production", label: "Production — real filings" },
];

export const EINVOICE_DEFAULT_ENV = "sandbox";

/** The columns on `companies` this covers. The password is not one of them. */
export const CREDENTIAL_FIELDS = ["einvoiceEnabled", "einvoiceUsername", "einvoiceEnv"];

export const normalizeEnv = (value) => {
  const v = String(value || "").trim().toLowerCase();
  return EINVOICE_ENVS.some((e) => e.value === v) ? v : EINVOICE_DEFAULT_ENV;
};

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

/**
 * What the browser is allowed to know: whether e-invoicing is on, which
 * portal, the username, and whether a password exists at all.
 *
 * `passwordSet` is a boolean and never the value, so the form can say "a
 * password is saved" without the password ever being sent back out.
 */
export const credentialState = (company) => ({
  enabled: Boolean(company?.einvoiceEnabled),
  username: text(company?.einvoiceUsername),
  env: normalizeEnv(company?.einvoiceEnv),
  passwordSet: Boolean(text(company?.einvoicePasswordEnc)),
});

/**
 * What is wrong with what was typed, as [{ field, message }].
 *
 * Switching e-invoicing ON is what demands a complete set. Everything can be
 * left blank while it is off, so a firm can fill this in over two sittings.
 */
export const credentialProblems = (form, { passwordSet = false } = {}) => {
  const problems = [];
  const add = (field, message) => problems.push({ field, message });

  const enabled = Boolean(form?.enabled ?? form?.einvoiceEnabled);
  const username = text(form?.username ?? form?.einvoiceUsername);
  // The plaintext, only ever on its way in.
  const password = text(form?.password);
  const env = text(form?.env ?? form?.einvoiceEnv);

  if (env && normalizeEnv(env) !== env.toLowerCase()) {
    add("env", "Choose either the sandbox or production portal.");
  }

  if (!enabled) return problems;

  if (!username) add("username", "The portal username is needed to file invoices.");
  if (!password && !passwordSet) {
    add("password", "The portal password is needed to file invoices.");
  }

  return problems;
};

/** Is this firm set up well enough to try reaching the portal? */
export const credentialsReady = (company) => {
  const state = credentialState(company);
  return state.enabled && Boolean(state.username) && state.passwordSet;
};
