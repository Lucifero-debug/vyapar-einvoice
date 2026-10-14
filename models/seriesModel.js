import mongoose from "mongoose";
import { tenantPlugin } from "../lib/tenantPlugin.mjs";
import {
  SERIES_CODE_MAX,
  SERIES_DEFAULTS,
  SERIES_DOC_TYPE_CODES,
} from "../lib/series.mjs";

/**
 * A document series -- Sigfa's Series Master.
 *
 * Every field on that screen, in the order the screen lays them out. The
 * rules, the defaults and the document list are all in lib/series.mjs, which
 * is pure; this is the storage for them.
 *
 *
 * WHY EVERY FIELD IS DECLARED EVEN THOUGH MOST ARE INERT
 * ------------------------------------------------------
 * Mongoose's strict mode DROPS an undeclared field on save, without error,
 * and the screen then shows the value it just sent. That has happened in this
 * project repeatedly. So the schema and `SERIES_DEFAULTS` are swept against
 * each other by scripts/series.test.mjs: a field on one and not the other
 * fails the suite rather than going missing in production.
 *
 * The print and behaviour fields are stored and nothing reads them yet --
 * lib/series.mjs says which, and why that line is drawn where it is.
 *
 *
 * WHAT IT DELIBERATELY DOES NOT HOLD: A NUMBER
 * --------------------------------------------
 * No `nextNo`, no `lastNo`, no counter. Sigfa's own screen has no such box,
 * and a sequence per series would change what number the next document gets --
 * which cannot be undone once one has gone out. `fillLeftSpaceWithZero` and
 * the code format a number for printing; they do not choose it.
 */
const seriesSchema = new mongoose.Schema(
  {
    // Sigfa's "Series [Initial]". Upper-cased and cut to sixteen by
    // lib/series.mjs before it gets here; sixteen is its own `VOUCHER Text(16)`.
    code: {
      type: String,
      required: [true, "Please provide a series code"],
      trim: true,
      maxlength: [SERIES_CODE_MAX, `A series code is at most ${SERIES_CODE_MAX} characters`],
    },

    // "Series Name" -- what the code stands for. "A" is not self-explanatory
    // six months later. Optional, as Sigfa's own seeds are bare codes.
    name: { type: String, trim: true, default: SERIES_DEFAULTS.name },

    // Which document, from the radio list down the left of Sigfa's screen.
    // Required: a series belongs to exactly one document, and one belonging
    // to none could never be offered anywhere.
    docType: {
      type: String,
      required: [true, "Choose which document this series is for"],
      enum: SERIES_DOC_TYPE_CODES,
    },

    /* ── the boxes down the middle of the screen ── */
    invoiceToBePrint: { type: String, trim: true, default: SERIES_DEFAULTS.invoiceToBePrint },
    compressPrinting: { type: Boolean, default: SERIES_DEFAULTS.compressPrinting },
    rollStationary: { type: Boolean, default: SERIES_DEFAULTS.rollStationary },
    printCompName: { type: Boolean, default: SERIES_DEFAULTS.printCompName },
    // Sigfa's "Effect In Stock". STORED ONLY. Nothing reads it, deliberately:
    // a document saved without moving stock cannot be made to have moved it
    // afterwards, so switching this on is its own change.
    effectInStock: { type: Boolean, default: SERIES_DEFAULTS.effectInStock },
    remark: { type: String, trim: true, default: SERIES_DEFAULTS.remark },
    topHeading: { type: String, trim: true, default: SERIES_DEFAULTS.topHeading },
    topSubHeading: { type: String, trim: true, default: SERIES_DEFAULTS.topSubHeading },
    invoiceNoCaption: { type: String, trim: true, default: SERIES_DEFAULTS.invoiceNoCaption },
    declarationCaption: { type: String, trim: true, default: SERIES_DEFAULTS.declarationCaption },
    declaration: { type: String, trim: true, default: SERIES_DEFAULTS.declaration },
    // Recorded, and that is ALL it does -- the same as `store` on a production
    // slip. This app holds stock in one place; models/productionModel.js has
    // the long version of why.
    store: { type: String, trim: true, default: SERIES_DEFAULTS.store },

    /* ── the boxes down the right ── */
    // How many digits to pad the printed number to. Formatting, not numbering.
    fillLeftSpaceWithZero: { type: Number, default: SERIES_DEFAULTS.fillLeftSpaceWithZero },
    bookNo: { type: String, trim: true, default: SERIES_DEFAULTS.bookNo },
    lockVoucher: { type: Boolean, default: SERIES_DEFAULTS.lockVoucher },

    /* ── "Slip Size For DJ/Laser Printer" ── */
    slipWidthCm: { type: Number, default: SERIES_DEFAULTS.slipWidthCm },
    slipHeightCm: { type: Number, default: SERIES_DEFAULTS.slipHeightCm },

    /* ── "Font Size Setting For PrnInvB" ── */
    // Dot-matrix and DeskJet font settings. Sigfa shows "None" for both.
    // Stored for fidelity; this app prints through a browser and has no use
    // for them.
    dmpFont: { type: String, trim: true, default: SERIES_DEFAULTS.dmpFont },
    djFont: { type: String, trim: true, default: SERIES_DEFAULTS.djFont },

    /* ── not Sigfa's ── */
    // Retires a series without deleting it: the documents that carry it keep
    // their label, and it stops being offered on new ones. This is what makes
    // the delete refusal in app/api/delete-series workable.
    active: { type: Boolean, default: SERIES_DEFAULTS.active },
    // The series a new document of this type starts on. One per document --
    // the routes clear the previous holder rather than letting two claim it.
    isDefault: { type: Boolean, default: SERIES_DEFAULTS.isDefault },
  },
  { timestamps: true }
);

// Every row belongs to one firm. The plugin adds companyId, scopes every
// query to it, and stamps it onto everything created -- see lib/tenantPlugin.mjs.
seriesSchema.plugin(tenantPlugin);

// Unique per FIRM and per DOCUMENT. companyId leads it, which is the whole
// point of the index audit: a unique index on `code` alone would mean the
// second firm to open could not create series A. Per document because Sigfa
// defines its series per document too -- series A on a sales invoice and
// series A on a purchase invoice are two rows.
seriesSchema.index({ companyId: 1, docType: 1, code: 1 }, { unique: true });

// The master screen and every Series dropdown read it in this order.
seriesSchema.index({ companyId: 1, docType: 1 });

const Series = mongoose.models.series || mongoose.model("series", seriesSchema);

export default Series;
