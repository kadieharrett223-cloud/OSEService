import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const query = String(searchParams.get("q") ?? "").trim();

  if (!query) {
    return NextResponse.json({ suggestions: [] });
  }

  const supabase = getSupabaseAdmin();

  const { data, error } = await supabase
    .from("quickbooks_invoices")
    .select("id, quickbooks_invoice_id, invoice_number, quickbooks_customer_id, invoice_date, invoice_total, payment_status, raw_payload")
    .or(`invoice_number.ilike.%${query}%,quickbooks_invoice_id.ilike.%${query}%`)
    .order("updated_at", { ascending: false })
    .limit(8);

  if (error) {
    return NextResponse.json({ suggestions: [] });
  }

  const suggestions = (data ?? []).map((invoice) => ({
    id: invoice.id,
    invoiceNumber: invoice.invoice_number,
    quickbooksInvoiceId: invoice.quickbooks_invoice_id,
    customerId: invoice.quickbooks_customer_id,
    invoiceDate: invoice.invoice_date,
    invoiceTotal: invoice.invoice_total,
    paymentStatus: invoice.payment_status,
    label: invoice.invoice_number || invoice.quickbooks_invoice_id,
  }));

  return NextResponse.json({ suggestions });
}
