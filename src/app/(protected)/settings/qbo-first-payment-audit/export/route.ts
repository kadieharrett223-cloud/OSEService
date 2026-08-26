import { NextResponse } from "next/server";
import { isAdminUnlockedForUser } from "@/lib/admin-access";
import { requireUser } from "@/lib/auth";
import { runQboFirstPaymentAudit } from "@/lib/quickbooks/first-payment-audit";

export async function GET() {
  const user = await requireUser();
  if (!await isAdminUnlockedForUser(user.id)) return NextResponse.json({ error: "Admin code required" }, { status: 403 });
  const audit = await runQboFirstPaymentAudit();
  return NextResponse.json(audit, { headers: { "Content-Disposition": "attachment; filename=qbo-first-payment-audit.json" } });
}