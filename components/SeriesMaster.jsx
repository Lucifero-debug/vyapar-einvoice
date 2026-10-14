'use client';
import React, { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Notice, useNotice } from '@/components/ui/notice';
import { NETWORK_ERROR, readResponse } from '@/lib/apiResponse.mjs';
import {
  SERIES_CODE_MAX,
  SERIES_DEFAULTS,
  SERIES_DOC_TYPES,
  SERIES_DOC_TYPES_NOT_HERE,
  docTypeLabel,
  formatDocNo,
  normalizeSeries,
  normalizeSeriesCode,
  seriesProblems,
} from '@/lib/series.mjs';

/**
 * The series master -- Sigfa's Series Master screen.
 *
 * Its layout, field for field: the document down the left, the boxes down the
 * middle, the number formatting and the printer settings down the right. The
 * wording is Sigfa's own except where this app already has a correct spelling
 * for the same thing (its list says "Goods Recieved").
 *
 *
 * WHY THIS ONE SIZES ITSELF AND THE OTHER MASTERS DO NOT
 * ------------------------------------------------------
 * `DialogContent` is `fixed` at `top-1/2` with `translate-y-[-50%]` and NO
 * max-height: a dialog taller than the window grows past it at BOTH ends, so
 * the title scrolls off the top and the Save button cannot be reached. The
 * other masters have four fields and never hit it; this one has twenty-four.
 *
 * So the dialog is capped at 90vh and split into three grid rows -- header,
 * a scrolling body, a footer that stays put. `minmax(0,1fr)` rather than
 * `1fr`, because a grid row's default `min-height:auto` refuses to shrink
 * below its content and the overflow would never engage.
 *
 *
 * WHAT IT DOES NOT DO, and says so on the screen:
 *
 *   - It does not number anything. There is no next-number box on Sigfa's
 *     screen either; lib/series.mjs records why that line is drawn here.
 *   - The print and behaviour settings are STORED and nothing reads them yet.
 *     Three of them already exist firm-wide (Roll Stationary in Setup, the
 *     declaration and company name on the company profile), so which one wins
 *     is a decision taken separately rather than inside this dialog.
 */

/** A section of the form, headed as Sigfa groups them. */
const Section = ({ title, note, children }) => (
  <section className="border-t border-border pt-4 first:border-t-0 first:pt-0">
    <h3 className="field-label mb-3">{title}</h3>
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{children}</div>
    {note && <p className="field-hint mt-2">{note}</p>}
  </section>
);

/**
 * A labelled box.
 *
 * `field-input` is 40px tall, and so is `Toggle` below, so a row holding one
 * of each lines up instead of stepping.
 */
const Field = ({ label, hint, wide, children }) => (
  <div className={`field ${wide ? 'sm:col-span-2' : ''}`}>
    <label className="field-label">{label}</label>
    {children}
    {hint && <p className="field-hint">{hint}</p>}
  </div>
);

/**
 * One of Sigfa's Yes/No boxes.
 *
 * Fixed height on purpose. These used to carry their explanation inside the
 * box, which made one twice the height of the one beside it and left the grid
 * stepping down the screen; the explanations are now one line under the
 * group.
 */
const Toggle = ({ label, checked, onChange }) => (
  <label className="flex h-10 cursor-pointer items-center justify-between gap-3 rounded-lg border border-input bg-card px-3 shadow-sm transition-colors hover:border-muted-foreground/40">
    <span className="truncate text-sm text-foreground">{label}</span>
    <input type="checkbox" className="field-check shrink-0" checked={checked} onChange={onChange} />
  </label>
);

const SeriesMaster = ({ open, onClose, selected, docType }) => {
  const [form, setForm] = useState({ ...SERIES_DEFAULTS });
  const [saving, setSaving] = useState(false);
  const [notice, notify] = useNotice();
  const isEditing = Boolean(selected?._id || selected?.id);

  useEffect(() => {
    notify.clear();
    if (!open) return;
    // `normalizeSeries` fills every field from whatever the record holds, so a
    // row written before a field existed opens with that field's default
    // rather than with undefined in a controlled input.
    setForm(
      normalizeSeries({
        ...SERIES_DEFAULTS,
        ...(selected || {}),
        // Creating from a screen that knows its own document starts on it.
        docType: selected?.docType || docType || '',
      })
    );
  }, [open, selected, docType, notify]);

  const set = (field) => (event) => {
    const target = event?.target;
    const value = target?.type === 'checkbox' ? target.checked : target.value;
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleSave = async () => {
    const draft = normalizeSeries(form);
    // The same rules the routes apply, so a refusal is shown before the round
    // trip rather than after it.
    const problems = seriesProblems({ ...draft, docType: form.docType });
    if (problems.length) {
      notify.error(problems[0]);
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(isEditing ? '/api/series-update' : '/api/series-add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The WHOLE record, every time. series-update rebuilds the row from
        // what it is sent, so a body carrying only the boxes that changed
        // would reset the rest to their defaults.
        body: JSON.stringify({ id: selected?._id || selected?.id, ...draft }),
      });
      const { ok, body: result, message } = await readResponse(res);
      if (ok && result.success) {
        onClose(true);
      } else {
        notify.error(`The series was not saved. ${message}`);
      }
    } catch (err) {
      console.error('Error saving series:', err);
      notify.error(`The series was not saved. ${NETWORK_ERROR}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={() => onClose(false)}>
      <DialogContent className="max-w-4xl max-h-[90vh] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0">
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle className="text-base font-semibold text-foreground">
            {isEditing ? 'Edit Series' : 'Series Master'}
            {form.docType && (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                {docTypeLabel(form.docType)}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        {/* The scrolling part. `min-h-0` so the row may shrink below its
            content -- without it the body sets the dialog's height and the
            cap above does nothing. */}
        <div className="min-h-0 overflow-y-auto px-6 py-4">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
            {/* Sigfa picks the document with a radio list down the left of the
                screen, and so does this. One series belongs to one document. */}
            <aside className="lg:sticky lg:top-0 lg:self-start">
              <h3 className="field-label mb-2">Document</h3>
              <div className="max-h-64 overflow-y-auto rounded-lg border border-input bg-card p-1">
                {SERIES_DOC_TYPES.map((doc) => (
                  <label
                    key={doc.code}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-accent/50"
                  >
                    <input
                      type="radio"
                      name="series-doc-type"
                      className="shrink-0 accent-[hsl(var(--primary))]"
                      value={doc.code}
                      checked={form.docType === doc.code}
                      onChange={() => setForm((prev) => ({ ...prev, docType: doc.code }))}
                    />
                    <span className="truncate text-foreground">{doc.label}</span>
                  </label>
                ))}
              </div>
              <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
                Sigfa also lists {SERIES_DOC_TYPES_NOT_HERE.join(', ')} — documents this
                app does not raise.
              </p>
            </aside>

            <div className="space-y-4">
              <Section title="Series">
                <Field label="Series [Initial]">
                  <input
                    className="field-input"
                    placeholder="e.g. A"
                    maxLength={SERIES_CODE_MAX}
                    value={form.code}
                    // Upper-cased as it is typed, because that is how it will
                    // be stored: a register that treats "a" and "A" as one
                    // series must not be given two rows to show in one column.
                    onChange={(e) =>
                      setForm((prev) => ({ ...prev, code: normalizeSeriesCode(e.target.value) }))
                    }
                  />
                </Field>

                <Field
                  label="Fill Left Space With Zero"
                  /* What the two number settings add up to, on a real number.
                     The only place either is acted on today -- the printed
                     bill still shows the plain number. */
                  hint={`Invoice 7 prints as ${formatDocNo(7, form) || '7'}`}
                >
                  <input
                    className="field-input"
                    inputMode="numeric"
                    value={form.fillLeftSpaceWithZero}
                    onChange={(e) =>
                      setForm((prev) => ({
                        ...prev,
                        fillLeftSpaceWithZero: e.target.value.replace(/\D/g, '').slice(0, 2),
                      }))
                    }
                  />
                </Field>

                <Field label="Series Name" wide>
                  <input className="field-input" value={form.name} onChange={set('name')} />
                </Field>

                <Field label="Invoice To Be Print">
                  <input
                    className="field-input"
                    value={form.invoiceToBePrint}
                    onChange={set('invoiceToBePrint')}
                  />
                </Field>

                <Field label="Book No.">
                  <input className="field-input" value={form.bookNo} onChange={set('bookNo')} />
                </Field>
              </Section>

              <Section
                title="Options"
                note="Effect In Stock and Lock Voucher are recorded only — every document still moves stock and can still be altered. Roll Stationary is set for the whole firm in Setup today."
              >
                <Toggle
                  label="Compress Printing"
                  checked={form.compressPrinting}
                  onChange={set('compressPrinting')}
                />
                <Toggle
                  label="Roll Stationary"
                  checked={form.rollStationary}
                  onChange={set('rollStationary')}
                />
                <Toggle
                  label="Print Comp. Name"
                  checked={form.printCompName}
                  onChange={set('printCompName')}
                />
                <Toggle
                  label="Effect In Stock"
                  checked={form.effectInStock}
                  onChange={set('effectInStock')}
                />
                <Toggle
                  label="Lock Voucher"
                  checked={form.lockVoucher}
                  onChange={set('lockVoucher')}
                />
              </Section>

              <Section
                title="Headings and declaration"
                note="Stored with the series. The printed bill still takes its heading and declaration from the company profile."
              >
                <Field label="Top Heading">
                  <input
                    className="field-input"
                    value={form.topHeading}
                    onChange={set('topHeading')}
                  />
                </Field>
                <Field label="Top Sub Heading">
                  <input
                    className="field-input"
                    value={form.topSubHeading}
                    onChange={set('topSubHeading')}
                  />
                </Field>
                <Field label="Invoice No. Caption">
                  <input
                    className="field-input"
                    value={form.invoiceNoCaption}
                    onChange={set('invoiceNoCaption')}
                  />
                </Field>
                <Field label="Declaration Caption">
                  <input
                    className="field-input"
                    value={form.declarationCaption}
                    onChange={set('declarationCaption')}
                  />
                </Field>
                <Field label="Declaration" wide>
                  <input
                    className="field-input"
                    value={form.declaration}
                    onChange={set('declaration')}
                  />
                </Field>
                <Field label="Remark" wide>
                  <input className="field-input" value={form.remark} onChange={set('remark')} />
                </Field>
                <Field
                  label="Store"
                  wide
                  hint="Recorded, like the Store box on a production slip. This app holds stock in one place and does not split it by store."
                >
                  <input className="field-input" value={form.store} onChange={set('store')} />
                </Field>
              </Section>

              <Section
                title="Printer"
                note="Slip Size For DJ/Laser Printer, and Font Size Setting For PrnInvB — dot-matrix and DeskJet settings kept for fidelity with Sigfa. This app prints through the browser and has no use for them."
              >
                <Field label="Width In CM">
                  <input
                    className="field-input"
                    type="number"
                    step="0.01"
                    value={form.slipWidthCm}
                    onChange={set('slipWidthCm')}
                  />
                </Field>
                <Field label="Height In CM">
                  <input
                    className="field-input"
                    type="number"
                    step="0.01"
                    value={form.slipHeightCm}
                    onChange={set('slipHeightCm')}
                  />
                </Field>
                <Field label="DMP Font">
                  <input
                    className="field-input"
                    placeholder="None"
                    value={form.dmpFont}
                    onChange={set('dmpFont')}
                  />
                </Field>
                <Field label="DJ Font">
                  <input
                    className="field-input"
                    placeholder="None"
                    value={form.djFont}
                    onChange={set('djFont')}
                  />
                </Field>
              </Section>

              {/* Not on Sigfa's screen. Headed so, rather than marked one by
                  one, so nobody reads either of them as its. */}
              <Section
                title="In this app"
                note="Switch Active off to stop offering the series on new documents — the ones that already carry it keep their label. One series per document can be the default."
              >
                <Toggle label="Active" checked={form.active} onChange={set('active')} />
                <Toggle
                  label="Selected by default"
                  checked={form.isDefault}
                  onChange={set('isDefault')}
                />
              </Section>
            </div>
          </div>
        </div>

        {/* Stays put, so Save is reachable from anywhere in the form. */}
        <div className="border-t border-border px-6 py-3">
          <Notice notice={notice} onClose={notify.clear} className="mb-2" />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="field-hint max-w-md">
              A series labels a document and groups it on the register. It does not number
              one.
            </p>
            <div className="flex items-center gap-2">
              <button type="button" className="btn btn-secondary" onClick={() => onClose(false)}>
                Cancel
              </button>
              <Button onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : isEditing ? 'Update Series' : 'Save Series'}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default SeriesMaster;
