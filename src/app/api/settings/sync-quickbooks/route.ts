import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { isAdminUnlockedForUser } from "@/lib/admin-access";
import { revalidateOrdersProjection } from "@/lib/orders/orders-projection-cache";
import { syncQuickbooksInvoices } from "@/lib/quickbooks/integration";

export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sign in again before syncing QuickBooks." }, { status: 401 });
  if (!await isAdminUnlockedForUser(user.id)) {
    return NextResponse.json({ error: "Enter the admin code before syncing QuickBooks." }, { status: 403 });
  }

  try {
    const result = await syncQuickbooksInvoices();
    revalidatePath("/");
    revalidatePath("/settings");
    revalidatePath("/cases/new");
    revalidatePath("/shipping-review");
    revalidateOrdersProjection();
    revalidatePath("/orders");
    revalidatePath("/orders/[id]", "page");

    const paymentRefreshMessage = result.paymentLinkedInvoicesRefreshed
      ? ` Refreshed ${result.paymentLinkedInvoicesRefreshed} payment-linked invoice${result.paymentLinkedInvoicesRefreshed === 1 ? "" : "s"}.`
      : "";
    const queueMessage = result.queueProductsRebuilt
      ? ` Rebuilt ${result.queueProductsRebuilt} affected customer list${result.queueProductsRebuilt === 1 ? "" : "s"}.`
      : "";
    const intakeMessage = result.forwardIntakeEnabled
      ? ` Imported ${result.forwardIntakeImportedLines ?? 0} clean demand line(s).`
      : " Continuous forward intake is disabled.";

    return NextResponse.json({
      message: `QuickBooks sync complete: ${result.invoiceCount} invoices, ${result.customerCount} customers, ${result.ordersUpdated ?? 0} first-payment dates updated.${paymentRefreshMessage}${queueMessage}${intakeMessage}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "QuickBooks sync failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
