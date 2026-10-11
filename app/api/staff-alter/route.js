import { NextResponse } from "next/server";
import { connect } from "@/lib/mongodb";
import { tenantRoute } from "@/lib/tenantRoute.mjs";
import { hashPassword, passwordProblem } from "@/lib/password.mjs";
import {
  countActiveOwners,
  findStaffByEmail,
  findStaffById,
  updateStaff,
} from "@/lib/staffStore.mjs";
import {
  emailProblem,
  nameProblem,
  needsTokenBump,
  normalizeEmail,
  roleChangeProblem,
} from "@/lib/staffRules.mjs";

export const dynamic = "force-dynamic";

/**
 * Edit a staff member: their name, their address, their role, or their
 * password.
 *
 * THE TWO REFUSALS THAT MATTER are in lib/staffRules.mjs and are about people
 * rather than roles, which is why they cannot live in the path table:
 *
 *   - you cannot change your own role. `user:manage` is held by owners alone,
 *     so an owner who makes themselves a biller has locked the door they are
 *     standing in and cannot reopen it.
 *   - the firm's last active owner cannot be demoted, for the same reason by
 *     another route.
 *
 * Both are checked here, on the server. The screen greys the controls out from
 * the same module, which is politeness, not the lock.
 */
async function handlePATCH(req, auth) {
  try {
    const body = await req.json().catch(() => ({}));
    const id = String(body.id || "").trim();
    if (!id) {
      return NextResponse.json({ success: false, error: "Which staff member?" }, { status: 400 });
    }

    await connect();

    // Fetched by id AND company together, so another firm's user id comes back
    // null rather than as their record -- the behaviour tenantPlugin gives
    // every other collection, done by hand because `users` cannot carry it.
    const target = await findStaffById(auth.companyId, id);
    if (!target) {
      return NextResponse.json(
        { success: false, error: "That staff member is not at this firm." },
        { status: 404 }
      );
    }

    const patch = {};
    const problems = [];

    if (body.name !== undefined) {
      const bad = nameProblem(body.name);
      if (bad) problems.push(bad);
      else patch.name = String(body.name).trim();
    }

    if (body.email !== undefined) {
      const email = normalizeEmail(body.email);
      const bad = emailProblem(email);
      if (bad) problems.push(bad);
      else if (email !== normalizeEmail(target.email)) {
        const clash = await findStaffByEmail(auth.companyId, email, { excludeId: id });
        if (clash) problems.push("Somebody at this firm already uses that email address.");
        else patch.email = email;
      }
    }

    if (body.role !== undefined && String(body.role).trim() !== String(target.role)) {
      const activeOwners = await countActiveOwners(auth.companyId);
      const bad = roleChangeProblem({
        actorId: auth.userId,
        target,
        nextRole: body.role,
        activeOwners,
      });
      if (bad) problems.push(bad);
      else patch.role = String(body.role).trim();
    }

    // An owner resetting a forgotten password. The account is put back into
    // owing-a-change, so the owner does not end up knowing a working one.
    let passwordChanged = false;
    if (body.password !== undefined && String(body.password) !== "") {
      const bad = passwordProblem(String(body.password));
      if (bad) problems.push(bad);
      else {
        patch.passwordHash = await hashPassword(String(body.password));
        patch.mustChangePassword = true;
        passwordChanged = true;
      }
    }

    if (problems.length) {
      return NextResponse.json(
        { success: false, error: problems[0], problems },
        { status: 400 }
      );
    }
    if (!Object.keys(patch).length) {
      return NextResponse.json({ success: false, error: "Nothing to change." }, { status: 400 });
    }

    // Sessions are stateless, so a role change or a new password only takes
    // hold once `tokenVersion` moves -- and the bump travels in the SAME write
    // as the change, never a second one that could fail on its own.
    const bumpToken = needsTokenBump({
      before: { role: target.role, active: target.active },
      after: { role: patch.role ?? target.role, active: target.active, passwordChanged },
    });

    const staff = await updateStaff(auth.companyId, id, patch, { bumpToken });
    if (!staff) {
      return NextResponse.json(
        { success: false, error: "That staff member is not at this firm." },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      message: bumpToken
        ? `${staff.name} is updated. They will have to sign in again.`
        : `${staff.name} is updated.`,
      staff,
      signedOut: bumpToken,
    });
  } catch (error) {
    if (error?.code === 11000) {
      return NextResponse.json(
        { success: false, error: "Somebody at this firm already uses that email address." },
        { status: 409 }
      );
    }
    console.error("Staff alter error:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const PATCH = tenantRoute(handlePATCH);
