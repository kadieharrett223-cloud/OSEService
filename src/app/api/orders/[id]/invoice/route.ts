import { getCurrentUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { downloadQuickbooksInvoicePdf } from "@/lib/quickbooks/integration";

export const maxDuration = 90;

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const headers = { "Cache-Control": "private, no-store" };
  if (!await getCurrentUser()) return Response.json({ error: "Please sign in again to download this invoice." }, { status: 401, headers });
  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return Response.json({ error: "Invalid order." }, { status: 400, headers });
  const db = getSupabaseAdmin();
  const { data: order, error: orderError } = await db.from("shipping_orders").select("source_invoice_id").eq("id", id).maybeSingle();
  if (orderError) return Response.json({ error: "Could not load this order." }, { status: 500, headers });
  if (!order?.source_invoice_id) return Response.json({ error: "This order has no linked QuickBooks invoice." }, { status: 404, headers });
  // Resolve by the order's immutable invoice link, never by invoice number alone.
  const { data: invoice, error } = await db.from("qbo_invoices").select("qbo_invoice_id, invoice_number").eq("id", order.source_invoice_id).maybeSingle();
  if (error) return Response.json({ error: "Could not load the linked invoice." }, { status: 500, headers });
  if (!invoice?.qbo_invoice_id) return Response.json({ error: "The linked QuickBooks invoice is unavailable." }, { status: 404, headers });
  try {
    const pdf = await downloadQuickbooksInvoicePdf(invoice.qbo_invoice_id);
    const filename = `Invoice-${String(invoice.invoice_number || invoice.qbo_invoice_id).replace(/[^a-zA-Z0-9_-]/g, "_")}.pdf`;
    return new Response(pdf, { headers: { ...headers, "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${filename}"`, "X-Content-Type-Options": "nosniff" } });
  } catch {
    return Response.json({ error: "Could not download the invoice from QuickBooks. Please try again or check the connection in Settings." }, { status: 502, headers });
  }
}
