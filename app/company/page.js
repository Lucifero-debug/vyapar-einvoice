'use client'
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useCompany } from '@/context/CompanyContext';
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
    setForm(companyFrom(company));
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
    () => [...profileProblems(form), ...credentialProblems(credentials, { passwordSet })],
    [form, credentials, passwordSet]
  );
  const problemFor = (field) =>
    showProblems ? problems.find((p) => p.field === field)?.message : undefined;

  const missing = useMemo(() => irpMissing(form), [form]);

  const update = (name) => (e) => {
    setForm((prev) => ({ ...prev, [name]: e.target.value }));
    setSaved(false);
    setServerError('');
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
