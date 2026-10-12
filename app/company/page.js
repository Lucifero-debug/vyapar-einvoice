'use client'
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useCompany } from '@/context/CompanyContext';
import { CompanyLogo } from '@/components/CompanyBrand';
import {
  BLANK_COMPANY,
  FIELD_NAMES,
  PROFILE_FIELDS,
  companyFrom,
  irpMissing,
  profileProblems,
} from '@/lib/company.mjs';
import {
  EINVOICE_ENVS,
  EINVOICE_DEFAULT_ENV,
  credentialProblems,
} from '@/lib/einvoiceCredentials.mjs';
import { PAPER_SIZES, PREF_FIELDS, prefProblems, prefsFrom } from '@/lib/invoicePrefs.mjs';
import {
  LOGO_ACCEPT,
  LOGO_FORMAT_WORDS,
  MAX_LOGO_BYTES,
  logoBytesOf,
  logoProblem,
  logoSrc,
} from '@/lib/companyLogo.mjs';

/**
 * The firm's own details — what prints on every document it issues.
 *
 * Owner only (`/company` demands `setup:write` in lib/roles.mjs). Until this
 * is filled in the invoice header is blank, which is deliberate: an empty line
 * is honest, and the placeholder GSTIN that used to sit there was not.
 */
const Page = () => {
  const { company, loading, refresh } = useCompany();

  const [form, setForm] = useState(BLANK_COMPANY);
  // The portal credentials. `password` is only ever on its way OUT of this
  // page: the server returns `passwordSet`, never the value.
  const [credentials, setCredentials] = useState({
    enabled: false,
    username: '',
    env: EINVOICE_DEFAULT_ENV,
    password: '',
  });
  // How this firm's documents look. Seeded from the record with every
  // default already applied by `prefsFrom`, so a firm whose row has no
  // preferences yet sees the switches set to what their bill does today.
  const [prefs, setPrefs] = useState(() => prefsFrom(null));
  // The logo lives on its own route, so it saves on its own -- a 200KB data
  // URL has no business riding along with every profile save.
  const [logo, setLogo] = useState('');
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoError, setLogoError] = useState('');
  const [logoNote, setLogoNote] = useState('');
  const [passwordSet, setPasswordSet] = useState(false);
  const [keyConfigured, setKeyConfigured] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [serverError, setServerError] = useState('');
  // Nothing is marked wrong until the owner has tried to save once. Red text
  // beside a field they have not reached yet is just noise.
  const [showProblems, setShowProblems] = useState(false);

  // Seed the form once, when the firm's record arrives. Once only: the fetch
  // finishing a second later must not overwrite what the owner has started
  // typing. After a save, the response is what sets the form.
  const seeded = useRef(false);
  useEffect(() => {
    if (loading || seeded.current) return;
    seeded.current = true;
    const firm = companyFrom(company);
    setForm(firm);
    setPrefs(prefsFrom(company));
    setLogo(firm.logo);
  }, [loading, company]);

  // Loaded alongside the letterhead, so the page needs no second request.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/company', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled || !data?.success) return;
        setPasswordSet(Boolean(data.einvoice?.passwordSet));
        setKeyConfigured(data.einvoiceKeyConfigured !== false);
        setCredentials((prev) => ({
          ...prev,
          enabled: Boolean(data.einvoice?.enabled),
          username: data.einvoice?.username || '',
          env: data.einvoice?.env || EINVOICE_DEFAULT_ENV,
        }));
      } catch (err) {
        console.error('Could not load the e-invoice settings:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const problems = useMemo(
    () => [
      ...profileProblems(form),
      ...prefProblems({ invoicePrefs: prefs }),
      ...credentialProblems(credentials, { passwordSet }),
    ],
    [form, prefs, credentials, passwordSet]
  );
  const problemFor = (field) =>
    showProblems ? problems.find((p) => p.field === field)?.message : undefined;

  const missing = useMemo(() => irpMissing(form), [form]);

  const update = (name) => (e) => {
    setForm((prev) => ({ ...prev, [name]: e.target.value }));
    setSaved(false);
    setServerError('');
  };

  const updatePref = (field) => (e) => {
    const value = field.kind === 'boolean' ? e.target.checked : e.target.value;
    setPrefs((prev) => ({ ...prev, [field.name]: value }));
    setSaved(false);
    setServerError('');
  };

  /**
   * Put a logo on, or take it off.
   *
   * The file is checked HERE for a quick answer and AGAIN on the server,
   * which is the only check that counts -- lib/companyLogo.mjs reads the
   * actual magic bytes, because a filename and a Content-Type are both
   * supplied by whoever is uploading.
   */
  const pickLogo = async (event) => {
    const file = event.target.files?.[0];
    // So choosing the same file twice in a row fires the change event again.
    event.target.value = '';
    if (!file) return;

    setLogoError('');
    setLogoNote('');
    setLogoBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const problem = logoProblem({ bytes, name: file.name });
      if (problem) {
        setLogoError(problem);
        return;
      }

      // Base64 in chunks: String.fromCharCode(...bytes) on a 150KB array
      // blows the argument limit in some browsers, which looks like a
      // mysteriously failing upload.
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      }

      const res = await fetch('/api/company-logo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: btoa(binary), name: file.name }),
      });
      const data = await res.json();
      if (!data?.success) {
        setLogoError(data?.error || 'Could not save the logo.');
        return;
      }
      setLogo(data.logo || '');
      setLogoNote(data.message || '');
      // So every open document picks up the new mark.
      refresh();
    } catch (err) {
      setLogoError('Could not reach the server.');
    } finally {
      setLogoBusy(false);
    }
  };

  const removeLogo = async () => {
    setLogoError('');
    setLogoNote('');
    setLogoBusy(true);
    try {
      const res = await fetch('/api/company-logo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remove: true }),
      });
      const data = await res.json();
      if (!data?.success) {
        setLogoError(data?.error || 'Could not remove the logo.');
        return;
      }
      setLogo('');
      setLogoNote(data.message || '');
      refresh();
    } catch (err) {
      setLogoError('Could not reach the server.');
    } finally {
      setLogoBusy(false);
    }
  };

  const updateCredential = (name) => (e) => {
    const value = name === 'enabled' ? e.target.checked : e.target.value;
    setCredentials((prev) => ({ ...prev, [name]: value }));
    setSaved(false);
    setServerError('');
  };

  const save = async () => {
    setShowProblems(true);
    if (problems.length) return;

    try {
      setSaving(true);
      setServerError('');

      const payload = {};
      for (const name of FIELD_NAMES) payload[name] = form[name];
      payload.invoicePrefs = { ...prefs };
      payload.einvoice = { ...credentials };

      const res = await fetch('/api/company-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();

      if (!data?.success) {
        setServerError(data?.error || 'Could not save.');
        return;
      }

      setForm(companyFrom(data.company));
      setPrefs(prefsFrom(data.company));
      setLogo(logoSrc(data.company));
      setPasswordSet(Boolean(data.einvoice?.passwordSet));
      // Cleared on the way out, so it is not sitting in the page afterwards.
      setCredentials((prev) => ({ ...prev, password: '' }));
      setSaved(true);
      // So every open document picks up the new letterhead.
      refresh();
    } catch (err) {
      setServerError('Could not reach the server.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page-shell max-w-3xl">
      <header className="page-header">
        <div>
          <h1 className="page-title">Business profile</h1>
          <p className="page-subtitle">
            These details print on your invoices, ledgers and reports. Anything left
            blank is simply not printed.
          </p>
        </div>
      </header>

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">Your firm</h2>
        </div>
        <div className="panel-body grid grid-cols-1 gap-4 sm:grid-cols-2">
          {PROFILE_FIELDS.map((field) => {
            const problem = problemFor(field.name);
            return (
              <div className="field" key={field.name}>
                <label className="field-label" htmlFor={`company-${field.name}`}>
                  {field.label}
                  {field.required ? ' *' : ''}
                </label>
                <input
                  id={`company-${field.name}`}
                  className="field-input"
                  value={form[field.name] || ''}
                  onChange={update(field.name)}
                  placeholder={field.placeholder || ''}
                  maxLength={field.maxLength}
                  autoComplete="off"
                  aria-invalid={problem ? 'true' : undefined}
                />
                {problem ? (
                  <p className="field-hint text-destructive">{problem}</p>
                ) : field.hint ? (
                  <p className="field-hint">{field.hint}</p>
                ) : null}
              </div>
            );
          })}
        </div>
      </section>

      {/* ── the logo ──────────────────────────────────────────────── */}
      <section className="panel mt-5">
        <div className="panel-head">
          <div>
            <h2 className="panel-title">Logo</h2>
            <p className="field-hint mt-0.5">
              {LOGO_FORMAT_WORDS}, under {Math.round(MAX_LOGO_BYTES / 1024)}KB. It prints at
              the top of your invoices beside your name.
            </p>
          </div>
        </div>
        <div className="panel-body">
          <div className="flex flex-wrap items-center gap-5">
            {/* The preview is framed by the SAME rule the printed invoice
                uses, so what is seen here is what comes out of the printer.
                A separate set of classes here is how a preview comes to
                flatter a logo the bill then crops. */}
            <div className="flex h-24 w-48 items-center justify-center rounded-lg border border-dashed border-border bg-muted/30 px-2">
              {logo ? (
                <CompanyLogo company={{ logo }} prefs={{ showLogo: true }} variant="preview" />
              ) : (
                <span className="text-center text-xs text-muted-foreground">
                  No logo.
                  <br />
                  Your documents print without one.
                </span>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <label className="btn btn-secondary cursor-pointer">
                {logo ? 'Replace logo' : 'Upload logo'}
                <input
                  type="file"
                  accept={LOGO_ACCEPT}
                  className="hidden"
                  disabled={logoBusy}
                  onChange={pickLogo}
                />
              </label>
              {logo ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={logoBusy}
                  onClick={removeLogo}
                >
                  Remove
                </button>
              ) : null}
              {logo ? (
                <p className="field-hint">
                  About {Math.max(1, Math.round(logoBytesOf(logo) / 1024))}KB stored.
                </p>
              ) : null}
            </div>
          </div>

          {/* The logo saves on its own, which is worth saying -- the Save
              button at the foot of this page does not apply to it. */}
          <p className="field-hint mt-3">
            Saved as soon as you choose it. The Save button below is for the rest of
            this page.
          </p>

          {logoError ? (
            <p className="mt-2 text-sm text-destructive">{logoError}</p>
          ) : logoNote ? (
            <p className="mt-2 text-sm text-success">{logoNote}</p>
          ) : null}
        </div>
      </section>

      {/* ── how the documents look ────────────────────────────────── */}
      <section className="panel mt-5">
        <div className="panel-head">
          <div>
            <h2 className="panel-title">Invoice appearance</h2>
            <p className="field-hint mt-0.5">
              What prints, and on what paper. None of these changes a figure, a tax
              rate or an invoice number.
            </p>
          </div>
        </div>
        <div className="panel-body flex flex-col gap-3">
          {PREF_FIELDS.filter((f) => f.kind === 'boolean').map((field) => (
            <label
              key={field.name}
              className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3"
            >
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">{field.label}</span>
                {field.hint ? <span className="field-hint">{field.hint}</span> : null}
              </span>
              <input
                type="checkbox"
                name={field.name}
                className="field-check flex-shrink-0"
                checked={Boolean(prefs[field.name])}
                onChange={updatePref(field)}
              />
            </label>
          ))}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="field">
              <label className="field-label" htmlFor="pref-paper">
                Paper
              </label>
              <select
                id="pref-paper"
                className="field-select"
                value={prefs.paper}
                onChange={updatePref(PREF_FIELDS.find((f) => f.name === 'paper'))}
              >
                {PAPER_SIZES.map((size) => (
                  <option key={size.value} value={size.value}>
                    {size.label}
                  </option>
                ))}
              </select>
              <p className="field-hint">
                {PAPER_SIZES.find((p) => p.value === prefs.paper)?.blurb || ''}
              </p>
            </div>
          </div>

          <div className="field">
            <label className="field-label" htmlFor="pref-footer">
              Footer note
            </label>
            <textarea
              id="pref-footer"
              className="field-input min-h-[5rem]"
              value={prefs.footerNote}
              maxLength={PREF_FIELDS.find((f) => f.name === 'footerNote')?.maxLength}
              onChange={updatePref(PREF_FIELDS.find((f) => f.name === 'footerNote'))}
            />
            {problemFor('footerNote') ? (
              <p className="field-hint text-destructive">{problemFor('footerNote')}</p>
            ) : (
              <p className="field-hint">
                Printed at the foot of every bill, one line per line. Clear it to print
                nothing.
              </p>
            )}
          </div>
        </div>
      </section>

      {/* What the IRP needs, said plainly. It answers with a numeric code. */}
      <section className="panel mt-5">
        <div className="panel-head">
          <h2 className="panel-title">E-invoicing</h2>
        </div>
        <div className="panel-body flex flex-col gap-4">
          {missing.length === 0 ? (
            <p className="text-sm text-success">
              Every seller detail the IRP requires is filled in.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Still needed before an invoice can be reported to the IRP:{' '}
              <span className="font-medium text-foreground">{missing.join(', ')}</span>.
            </p>
          )}

          <label className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3">
            <span className="text-sm font-medium text-foreground">
              Report invoices to the IRP
            </span>
            <input
              type="checkbox"
              name="einvoiceEnabled"
              className="field-check"
              checked={credentials.enabled}
              onChange={updateCredential('enabled')}
            />
          </label>

          {credentials.enabled && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="field">
                <label className="field-label" htmlFor="einvoice-env">Portal</label>
                <select
                  id="einvoice-env"
                  className="field-select"
                  value={credentials.env}
                  onChange={updateCredential('env')}
                >
                  {EINVOICE_ENVS.map((e) => (
                    <option key={e.value} value={e.value}>{e.label}</option>
                  ))}
                </select>
                {credentials.env === 'production' && (
                  <p className="field-hint">Filings made here are real and cannot be undone.</p>
                )}
              </div>

              <div className="field">
                <label className="field-label" htmlFor="einvoice-username">Portal username</label>
                <input
                  id="einvoice-username"
                  className="field-input"
                  value={credentials.username}
                  onChange={updateCredential('username')}
                  autoComplete="off"
                  aria-invalid={problemFor('username') ? 'true' : undefined}
                />
                {problemFor('username') && (
                  <p className="field-hint text-destructive">{problemFor('username')}</p>
                )}
              </div>

              <div className="field sm:col-span-2">
                <label className="field-label" htmlFor="einvoice-password">Portal password</label>
                <input
                  id="einvoice-password"
                  type="password"
                  className="field-input"
                  value={credentials.password}
                  onChange={updateCredential('password')}
                  placeholder={passwordSet ? 'Saved — type a new one to replace it' : ''}
                  autoComplete="new-password"
                  aria-invalid={problemFor('password') ? 'true' : undefined}
                />
                <p className="field-hint">
                  {problemFor('password') ? (
                    <span className="text-destructive">{problemFor('password')}</span>
                  ) : keyConfigured ? (
                    'Stored encrypted. It is never shown again, here or anywhere else.'
                  ) : (
                    <span className="text-destructive">
                      EINVOICE_KEY is not set on the server, so a password cannot be stored yet.
                    </span>
                  )}
                </p>
              </div>
            </div>
          )}
        </div>
      </section>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button onClick={save} disabled={saving || loading} className="btn btn-primary">
          {saving ? 'Saving...' : 'Save profile'}
        </button>
        {saved && <span className="text-sm text-success">Saved.</span>}
        {serverError && <span className="text-sm text-destructive">{serverError}</span>}
        {showProblems && problems.length > 0 && (
          <span className="text-sm text-destructive">
            {problems.length === 1
              ? problems[0].message
              : `${problems.length} fields need fixing.`}
          </span>
        )}
      </div>
    </div>
  );
};

export default Page;
