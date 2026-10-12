import { NextResponse } from "next/server";
import { internalErrorBody } from "@/lib/serverError.mjs";
import { connect } from "@/lib/mongodb";
import Company from "@/models/companyModel";
import User from "@/models/userModel";
import { verifyPassword, needsRehash, hashPassword } from "@/lib/password.mjs";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  signSession,
  sessionCookieOptions,
} from "@/lib/session.mjs";
import { MAX_PASSWORD_LENGTH } from "@/lib/passwordRules.mjs";
import { clientIp, tooManyResponse } from "@/lib/rateLimit.mjs";
import { clearRateLimit, hitRateLimit } from "@/lib/rateLimitStore.mjs";

export const dynamic = "force-dynamic";

/**
 * Sign in.
 *
 * Every failure answers the same way: "Email or password is incorrect." Saying
 * which one was wrong tells a guesser which addresses are real accounts.
 */
export async function POST(req) {
  try {
    const { email, password } = await req.json().catch(() => ({}));

    const secret = process.env.AUTH_SECRET;
    if (!secret || secret.length < 16) {
      return NextResponse.json(
        { success: false, message: "AUTH_SECRET is not configured on the server." },
        { status: 500 }
      );
    }

    await connect();

    const address = String(email || "").trim().toLowerCase();
    const secretText = String(password || "");

    // Counted BEFORE any password is hashed: a refused attempt costs a
    // counter write, not a scrypt. lib/rateLimit.mjs has the three limits:
    //   per network                    -- one guesser, many accounts
    //   per address from that network  -- tight; cleared on success
    //   per address from anywhere      -- loose ceiling for spread-out guessing
    // The network ones are skipped when the address cannot be trusted
    // (no proxy in front), rather than counting a value the caller picks.
    const ip = clientIp(req.headers);
    const checks = [];
    if (ip) checks.push(["login-ip", ip]);
    if (address) {
      if (ip) checks.push(["login-email-ip", `${address}\u0000${ip}`]);
      checks.push(["login-email", address]);
    }
    for (const [bucket, id] of checks) {
      const result = await hitRateLimit(bucket, id);
      if (!result.allowed) {
        const { status, body, headers } = tooManyResponse(result, "sign-in attempts");
        return NextResponse.json(body, { status, headers });
      }
    }

    // EVERY account with this address, not the first one found. An email is
    // unique per FIRM (models/userModel.js), so one address can exist in
    // several -- and `findOne` returned whichever MongoDB happened to scan
    // first, then checked the password against that one alone. Another
    // firm's owner could give a staff account somebody else's address and
    // lock that person out of their own firm. Now the password picks the
    // account. Capped, so a crafted address cannot cost unbounded hashing.
    const candidates = address
      ? await User.find({ email: address })
          .select("+passwordHash email name role companyId tokenVersion active")
          .collation({ locale: "en", strength: 2 })
          .limit(MAX_ACCOUNTS_PER_EMAIL)
      : [];

    // The password is verified even when no user was found, against a dummy
    // hash, so a missing account and a wrong password take the same time. A
    // fast "no" is how you enumerate who banks here. An absurdly long
    // "password" is refused before any hashing.
    const matching = [];
    if (secretText.length > MAX_PASSWORD_LENGTH) {
      await verifyPassword("", DUMMY_HASH);
    } else if (!candidates.length) {
      await verifyPassword(secretText, DUMMY_HASH);
    } else {
      for (const candidate of candidates) {
        if (await verifyPassword(secretText, candidate.passwordHash || DUMMY_HASH)) {
          matching.push(candidate);
        }
      }
    }

    // Only accounts that could actually sign in count: active, in an active
    // firm. A deactivated ex-staff account in one firm must not stop the same
    // person signing in to the firm they still work for.
    const usable = [];
    let firmInactive = false;
    for (const candidate of matching) {
      if (candidate.active === false) continue;
      const firm = await Company.findById(candidate.companyId).select("name active").lean();
      if (!firm || firm.active === false) {
        firmInactive = true;
        continue;
      }
      usable.push({ user: candidate, company: firm });
    }

    if (!usable.length) {
      return firmInactive
        ? NextResponse.json({ success: false, message: "This account is not active." }, { status: 403 })
        : NextResponse.json({ success: false, message: "Email or password is incorrect." }, { status: 401 });
    }

    // The same address AND the same password in two working firms: which
    // firm is meant cannot be told from the sign-in form, so neither is
    // guessed.
    if (usable.length > 1) {
      return NextResponse.json(
        {
          success: false,
          message:
            "This email belongs to accounts in more than one firm with the same password. Ask your administrator to change one of them.",
        },
        { status: 409 }
      );
    }

    const { user, company } = usable[0];

    // The right password: this address, from this network, starts again from
    // zero. The per-network count and the address-wide ceiling are left
    // alone -- clearing them would let a guesser who owns one real account,
    // or knows one password, reset their own allowance.
    if (ip) await clearRateLimit("login-email-ip", `${address}\u0000${ip}`);

    // Signing in is the one moment the plain password is in hand, so it is the
    // only moment an old hash can be upgraded to the current cost.
    if (needsRehash(user.passwordHash)) {
      user.passwordHash = await hashPassword(String(password));
    }
    user.lastLoginAt = new Date();
    await user.save();

    const token = await signSession(
      {
        uid: String(user._id),
        cid: String(user.companyId),
        role: user.role,
        v: user.tokenVersion || 0,
      },
      secret
    );

    const res = NextResponse.json({
      success: true,
      user: { name: user.name, email: user.email, role: user.role },
      company: { id: String(company._id), name: company.name },
    });

    res.cookies.set(
      SESSION_COOKIE,
      token,
      sessionCookieOptions({
        secure: process.env.NODE_ENV === "production",
        maxAge: SESSION_TTL_SECONDS,
      })
    );

    return res;
  } catch (error) {
    // The exception to the log, a reference to the screen: a database that
    // will not connect names its host in the message. lib/serverError.mjs.
    const { ref, payload } = internalErrorBody();
    console.error(`[api ${ref}] Sign-in error:`, error);
    return NextResponse.json(payload, { status: 500 });
  }
}

/** How many accounts one address may have across firms before sign-in stops looking. */
const MAX_ACCOUNTS_PER_EMAIL = 10;


// A real scrypt string for a password nobody has. Only ever compared against,
// so the work of a failed sign-in matches that of a successful one.
const DUMMY_HASH =
  "scrypt$65536$8$1$64$00000000000000000000000000000000$" + "0".repeat(128);
