import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { isAdminUnlockedForUser } from "@/lib/admin-access";
import {
  connectQuickbooksFromCallback,
  syncQuickbooksInvoices,
} from "@/lib/quickbooks/integration";

const STATE_COOKIE = "qbo_oauth_state";

function asUuidOrNull(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.redirect(new URL("/enter-code", request.url));
  }

  const unlocked = await isAdminUnlockedForUser(user.id);
  if (!unlocked) {
    return NextResponse.redirect(new URL("/settings?error=Admin+code+required", request.url));
  }

  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const realmId = url.searchParams.get("realmId") ?? "";
  const oauthError = url.searchParams.get("error") ?? "";

  if (oauthError) {
    return NextResponse.redirect(new URL(`/settings?error=${encodeURIComponent(`QuickBooks authorization failed: ${oauthError}`)}`, request.url));
  }

  const cookieStore = await cookies();
  const savedState = cookieStore.get(STATE_COOKIE)?.value ?? "";
  cookieStore.delete(STATE_COOKIE);

  if (!state || !savedState || state !== savedState) {
    return NextResponse.redirect(new URL("/settings?error=Invalid+QuickBooks+OAuth+state", request.url));
  }

  if (!code || !realmId) {
    return NextResponse.redirect(new URL("/settings?error=Missing+QuickBooks+OAuth+code+or+realmId", request.url));
  }

  try {
    await connectQuickbooksFromCallback({
      code,
      realmId,
      origin: url.origin,
      connectedBy: asUuidOrNull(user.id),
    });

    const syncResult = await syncQuickbooksInvoices();
    return NextResponse.redirect(
      new URL(
        `/settings?message=${encodeURIComponent(`QuickBooks connected. Synced ${syncResult.invoiceCount} invoices.`)}`,
        request.url,
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "QuickBooks callback failed.";
    return NextResponse.redirect(new URL(`/settings?error=${encodeURIComponent(message)}`, request.url));
  }
}
