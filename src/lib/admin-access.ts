import crypto from "node:crypto";
import { cookies } from "next/headers";

const ADMIN_UNLOCK_COOKIE = "ose_admin_unlock";

function getConfiguredAdminCode() {
  const value =
    process.env.APP_ADMIN_CODE
    ?? process.env.APP_DELETE_CASE_CODE
    ?? "9822";

  return value.trim();
}

function getCookieSecret() {
  const value =
    process.env.SESSION_SECRET
    ?? process.env.APP_SHARED_ACCESS_CODE
    ?? "local-admin-cookie-secret";

  return value.trim();
}

function signAdminUnlock(userId: string) {
  return crypto
    .createHmac("sha256", getCookieSecret())
    .update(`${userId}:${getConfiguredAdminCode()}`)
    .digest("hex");
}

function safeEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function isValidAdminCode(value: string) {
  return value.trim() === getConfiguredAdminCode();
}

export async function isAdminUnlockedForUser(userId: string) {
  const cookieStore = await cookies();
  const current = cookieStore.get(ADMIN_UNLOCK_COOKIE)?.value ?? "";
  const expected = signAdminUnlock(userId);
  if (!current || !expected) return false;
  return safeEquals(current, expected);
}

export async function unlockAdminForUser(userId: string) {
  const cookieStore = await cookies();
  cookieStore.set(ADMIN_UNLOCK_COOKIE, signAdminUnlock(userId), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 8,
  });
}

export async function clearAdminUnlock() {
  const cookieStore = await cookies();
  cookieStore.delete(ADMIN_UNLOCK_COOKIE);
}
