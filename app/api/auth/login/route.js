import { NextResponse } from "next/server";
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
    const user = address
      ? await User.findOne({ email: address })
          .select("+passwordHash email name role companyId tokenVersion active")
          .collation({ locale: "en", strength: 2 })
      : null;

    // The password is verified even when no user was found, against a dummy
    // hash, so a missing account and a wrong password take the same time. A
    // fast "no" is how you enumerate who banks here.
    const stored = user?.passwordHash || DUMMY_HASH;
    const ok = await verifyPassword(String(password || ""), stored);

    if (!user || !ok || user.active === false) {
      return NextResponse.json(
        { success: false, message: "Email or password is incorrect." },
        { status: 401 }
      );
    }

    const company = await Company.findById(user.companyId).select("name active").lean();
    if (!company || company.active === false) {
      return NextResponse.json(
        { success: false, message: "This account is not active." },
        { status: 403 }
      );
    }

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
    return NextResponse.json({ success: false, message: error.message }, { status: 500 });
  }
}

// A real scrypt string for a password nobody has. Only ever compared against,
// so the work of a failed sign-in matches that of a successful one.
const DUMMY_HASH =
  "scrypt$65536$8$1$64$00000000000000000000000000000000$" + "0".repeat(128);
