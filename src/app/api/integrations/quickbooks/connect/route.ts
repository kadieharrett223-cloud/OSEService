import crypto from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getQuickbooksConnectUrl } from "@/lib/quickbooks/integration";

const STATE_COOKIE = "qbo_oauth_state";

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.redirect(new URL("/enter-code", request.url));
  }

  const state = crypto.randomBytes(24).toString("base64url");
  const { origin } = new URL(request.url);

  try {
    const connectUrl = getQuickbooksConnectUrl(origin, state);
    const cookieStore = await cookies();

    cookieStore.set(STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 10,
    });

    return NextResponse.redirect(connectUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to start QuickBooks connection.";
    return NextResponse.redirect(new URL(`/settings?error=${encodeURIComponent(message)}`, request.url));
  }
}
