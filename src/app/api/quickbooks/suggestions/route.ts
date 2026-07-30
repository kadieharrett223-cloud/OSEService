import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

type Suggestion = {
  key: string;
  type: "invoice" | "customer";
  lookupQuery: string;
  primary: string;
  secondary?: string;
  invoiceNumber?: string;
  invoiceDate?: string | null;
  invoiceTotal?: number | null;
  paymentStatus?: string | null;
};

function normalizeLike(input: string) {
  return input.replace(/[%_,()]/g, "").trim();
}

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const raw = searchParams.get("q") ?? "";
  const query = normalizeLike(raw);

  if (query.length < 2) {
    return NextResponse.json({ suggestions: [] as Suggestion[] });
  }

  const supabase = getSupabaseAdmin();
  const like = `%${query}%`;

  const [invoiceResult, customerResult] = await Promise.all([
    supabase
      .from("quickbooks_invoices")
      .select("id, quickbooks_invoice_id, invoice_number, invoice_date, invoice_total, payment_status, quickbooks_customer_id")
      .or([
        `invoice_number.ilike.${like}`,
        `quickbooks_invoice_id.ilike.${like}`,
        `quickbooks_customer_id.ilike.${like}`,
      ].join(","))
      .order("invoice_date", { ascending: false, nullsFirst: false })
      .limit(8),
    supabase
      .from("customers")
      .select("id, full_name, company_name, quickbooks_customer_id, email")
      .or([
        `full_name.ilike.${like}`,
        `company_name.ilike.${like}`,
        `quickbooks_customer_id.ilike.${like}`,
      ].join(","))
      .order("full_name", { ascending: true })
      .limit(6),
  ]);

  const invoiceSuggestions: Suggestion[] = (invoiceResult.data ?? []).map((invoice) => {
    const customerName = invoice.quickbooks_customer_id ?? "Unknown customer";
    const number = invoice.invoice_number ?? "No number";

    return {
      key: `invoice:${invoice.id}`,
      type: "invoice",
      lookupQuery: String(invoice.invoice_number ?? invoice.quickbooks_invoice_id ?? invoice.quickbooks_customer_id ?? customerName),
      primary: customerName,
      secondary: `Invoice #${number}`,
      invoiceNumber: invoice.invoice_number,
      invoiceDate: invoice.invoice_date,
      invoiceTotal: invoice.invoice_total,
      paymentStatus: invoice.payment_status,
    };
  });

  const customerSuggestions: Suggestion[] = (customerResult.data ?? []).map((customer) => ({
    key: `customer:${customer.id}`,
    type: "customer",
    lookupQuery: String(customer.quickbooks_customer_id ?? customer.full_name ?? customer.company_name ?? ""),
    primary: customer.full_name ?? customer.company_name ?? "Unknown customer",
    secondary: customer.email ?? customer.quickbooks_customer_id ?? undefined,
  }));

  const suggestions = [...invoiceSuggestions, ...customerSuggestions].slice(0, 12);

  return NextResponse.json({ suggestions });
}
