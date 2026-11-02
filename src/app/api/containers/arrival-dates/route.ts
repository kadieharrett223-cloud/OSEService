import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { revalidateOrdersProjection } from "@/lib/orders/orders-projection-cache";

// A route response acknowledges the write without waiting for the container
// page's expensive customer-coverage projection to render again.
export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ error: "Invalid request origin." }, { status: 403 });
  }
  if (!await getCurrentUser()) {
    return Response.json({ error: "Please sign in again." }, { status: 401 });
  }
  const form = await request.formData();
  const containerId = String(form.get("container_id") ?? "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(containerId)) {
    return Response.json({ error: "Invalid container." }, { status: 400 });
  }
  const dates = { port_date: null, eta_confirmed_date: null, eta_estimated_date: null } as { port_date: string | null; eta_confirmed_date: string | null; eta_estimated_date: string | null };
  for (const key of ["port_date", "eta_confirmed_date", "eta_estimated_date"] as const) {
    const value = String(form.get(key) ?? "").trim();
    if (value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) {
      return Response.json({ error: "Enter a valid date." }, { status: 400 });
    }
    dates[key] = value || null;
  }
  const { data, error } = await getSupabaseAdmin().from("containers")
    .update(dates).eq("id", containerId).select("id").maybeSingle();
  if (error) return Response.json({ error: "Could not save arrival dates. Please try again." }, { status: 500 });
  if (!data) return Response.json({ error: "Container not found." }, { status: 404 });

  revalidateOrdersProjection();
  for (const path of ["/containers", `/containers/${containerId}`, "/inventory", "/dashboard", "/orders", "/shipping-groups"]) {
    revalidatePath(path);
  }
  return Response.json({ success: true });
}
