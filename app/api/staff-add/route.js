import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { hashPassword } from "@/lib/password.mjs";
import { createStaff, findStaffByEmail } from "@/lib/staffStore.mjs";
import { normalizeEmail, staffCreateProblems } from "@/lib/staffRules.mjs";

export const dynamic = "force-dynamic";

/**
 * Add an accountant or a biller to this firm.
 *
 * THE ROLE IS WHITELISTED, not blacklisted. `staffCreateProblems` accepts only
 * what is in ASSIGNABLE_ROLES, so "owner" is refused -- and so is anything
 * added to lib/roles.mjs later that nobody deliberately made assignable. The
 * model's own `enum` is the second net, not the first.
 *
 * The password is hashed by lib/password.mjs, unchanged: scrypt, with the
 * parameters stored alongside the hash. Nothing here touches how that works.
 *
 * The new account is created owing a password change. The owner types the
 * first one and reads it out, and `requireAuth` then refuses every route but
 * the password page until it is replaced -- so the owner never knows the
 * password their staff actually works under, and a biller's actions are
 * genuinely the biller's.
 */
async function handlePOST(req, auth) {
  try {
    const body = await req.json().catch(() => ({}));
    const name = String(body.name || "").trim();
    const email = normalizeEmail(body.email);
    const role = String(body.role || "").trim();
    const password = String(body.password || "");

    // Every problem at once, so a form is not sent round the loop four times.
    const problems = staffCreateProblems({ name, email, role, password });
    if (problems.length) {
      return NextResponse.json(
        { success: false, error: problems[0], problems },
        { status: 400 }
      );
    }

    await connect();

    // Checked before the insert so the answer is a sentence rather than a raw
    // E11000, and checked WITH the company and the index's collation -- see
    // lib/staffStore.mjs on why findNameClash cannot be reused here.
    const clash = await findStaffByEmail(auth.companyId, email);
    if (clash) {
      return NextResponse.json(
        { success: false, error: "Somebody at this firm already uses that email address." },
        { status: 409 }
      );
    }

    const passwordHash = await hashPassword(password);

    const staff = await createStaff(auth.companyId, {
      name,
      email,
      role,
      passwordHash,
      mustChangePassword: true,
    });

    return NextResponse.json(
      {
        success: true,
        message: `${staff.name} can now sign in. They will be asked to set their own password.`,
        staff,
      },
      { status: 201 }
    );
  } catch (error) {
    // The unique index is the real guard; the check above is the civil one.
    // Two owners adding the same address at the same moment both pass it.
    if (error?.code === 11000) {
      return NextResponse.json(
        { success: false, error: "Somebody at this firm already uses that email address." },
        { status: 409 }
      );
    }
    console.error("Staff add error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const POST = tenantRoute(handlePOST);
