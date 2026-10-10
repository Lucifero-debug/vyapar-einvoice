import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import Company from "@/models/companyModel";
import User from "@/models/userModel";
import { hashPassword, passwordProblem } from "@/lib/password.mjs";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  signSession,
  sessionCookieOptions,
} from "@/lib/session.mjs";
import { withTransaction, AbortTransaction } from "@/lib/withTransaction.mjs";

export const dynamic = "force-dynamic";

/**
 * Create a firm and its first owner, and sign them in.
 *
 * The company and the user commit together. A company with no owner is a firm
 * nobody can ever sign in to, and an owner with no company is a session with
 * no books behind it -- both are unreachable states that would have to be
 * cleaned up by hand.
 *
 * Set SIGNUP_DISABLED=true to turn self-serve signup off and onboard firms
 * yourself.
 */
export async function POST(req) {
  try {
    if (String(process.env.SIGNUP_DISABLED || "").toLowerCase() === "true") {
      return NextResponse.json(
        { success: false, message: "Sign-up is closed. Ask your administrator for an account." },
        { status: 403 }
      );
    }

    const secret = process.env.AUTH_SECRET;
    if (!secret || secret.length < 16) {
      return NextResponse.json(
        { success: false, message: "AUTH_SECRET is not configured on the server." },
        { status: 500 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const companyName = String(body.companyName || "").trim();
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");

    if (!companyName) {
      return NextResponse.json({ success: false, message: "Enter your firm's name." }, { status: 400 });
    }
    // Deliberately loose: an address either reaches the person or it does not,
    // and a strict pattern mostly rejects valid ones.
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return NextResponse.json({ success: false, message: "Enter a valid email address." }, { status: 400 });
    }
    const problem = passwordProblem(password);
    if (problem) {
      return NextResponse.json({ success: false, message: problem }, { status: 400 });
    }

    await connect();

    const passwordHash = await hashPassword(password);

    const created = await withTransaction(async (session) => {
      const [company] = await Company.create([{ name: companyName }], { session });
      const [user] = await User.create(
        [
          {
            email,
            name,
            passwordHash,
            // Whoever creates the firm runs it. Everyone else is added by them.
            role: "owner",
            companyId: company._id,
          },
        ],
        { session }
      );
      return { company, user };
    });

    const token = await signSession(
      {
        uid: String(created.user._id),
        cid: String(created.company._id),
        role: "owner",
        v: 0,
      },
      secret
    );

    const res = NextResponse.json({
      success: true,
      message: `${created.company.name} is set up. You are signed in as the owner.`,
      user: { name: created.user.name, email: created.user.email, role: "owner" },
      company: { id: String(created.company._id), name: created.company.name },
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
    if (error instanceof AbortTransaction) {
      return NextResponse.json(error.payload, { status: error.status });
    }
    if (error?.code === 11000) {
      return NextResponse.json(
        { success: false, message: "That email address is already in use." },
        { status: 409 }
      );
    }
    return NextResponse.json({ success: false, message: error.message }, { status: 500 });
  }
}
