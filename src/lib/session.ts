import crypto from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

const SESSION_COOKIE = "app_access_session";
const ONE_DAY_SECONDS = 60 * 60 * 24;

function getSessionSecret() {
  const secret = process.env.APP_SESSION_SECRET;
  if (!secret) {
    throw new Error("Missing APP_SESSION_SECRET environment variable.");
  }
  return secret;
}

function base64urlEncode(input: string) {
  return Buffer.from(input, "utf8").toString("base64url");
}

function base64urlDecode(input: string) {
  return Buffer.from(input, "base64url").toString("utf8");
}

function sign(payload: string) {
  return crypto
    .createHmac("sha256", getSessionSecret())
    .update(payload)
    .digest("base64url");
}

type SessionPayload = {
  userId: string;
  fullName: string;
  createdAt: string;
};

export async function createSession(userId: string, fullName: string) {
  const payload: SessionPayload = {
    userId,
    fullName,
    createdAt: new Date().toISOString(),
  };

  const encodedPayload = base64urlEncode(JSON.stringify(payload));
  const signature = sign(encodedPayload);

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, `${encodedPayload}.${signature}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ONE_DAY_SECONDS,
  });
}

export async function clearSession() {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}

function parseSessionValue(value: string | undefined): SessionPayload | null {
  if (!value) return null;

  const [encodedPayload, signature] = value.split(".");
  if (!encodedPayload || !signature) return null;

  const expected = sign(encodedPayload);
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return null;
  }

  try {
    return JSON.parse(base64urlDecode(encodedPayload)) as SessionPayload;
  } catch {
    return null;
  }
}

export async function getCurrentAccessUser() {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(SESSION_COOKIE)?.value;
  const session = parseSessionValue(sessionCookie);

  if (!session) {
    return null;
  }

  return {
    id: session.userId,
    fullName: session.fullName,
  };
}

export async function requireAccessUser() {
  const user = await getCurrentAccessUser();
  if (!user) {
    redirect("/login");
  }

  return user;
}
