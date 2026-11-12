import type { CurrentUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

export type SavedOrderNote = { id: string; message: string; author: string; savedAt: string; sku?: string | null };
export class OrderNoteError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

/** Persists only the note audit record. Never runs order, stock or coverage calculations. */
export async function saveOrderNote(user: CurrentUser, form: FormData): Promise<SavedOrderNote> {
  const orderId = String(form.get("orderId") ?? "");
  const lineId = String(form.get("lineId") ?? "") || null;
  const sku = String(form.get("sku") ?? "") || null;
  const message = String(form.get("message") ?? "").trim();
  if (!isUuid(orderId) || (lineId && !isUuid(lineId))) throw new OrderNoteError("Invalid order or item.", 400);
  if (!message) throw new OrderNoteError("Note text is required.", 400);
  const db = getSupabaseAdmin();
  const { data: order, error: orderError } = await db.from("shipping_orders").select("id").eq("id", orderId).maybeSingle();
  if (orderError) throw new OrderNoteError("Could not check this order. Please try again.", 500);
  if (!order) throw new OrderNoteError("Order not found.", 404);
  if (lineId) {
    const { data: line, error } = await db.from("shipping_order_lines").select("id").eq("id", lineId).eq("shipping_order_id", orderId).maybeSingle();
    if (error) throw new OrderNoteError("Could not check this item. Please try again.", 500);
    if (!line) throw new OrderNoteError("This item does not belong to the order.", 400);
  }
  const { data: accessUser, error: actorError } = isUuid(user.id)
    ? await db.from("access_users").select("id").eq("id", user.id).maybeSingle()
    : { data: null, error: null };
  if (actorError) throw new OrderNoteError("Could not check the note author. Please try again.", 500);
  const savedAt = new Date().toISOString();
  const id = crypto.randomUUID();
  const author = user.fullName ?? "Unknown user";
  const { error } = await db.from("audit_log").insert({
    id, entity_type: "shipping_order", entity_id: orderId, action: "ORDER_NOTE_ADDED", actor_id: accessUser?.id ?? null,
    details: { message, note_text: message, author_name: author, saved_at: savedAt, line_id: lineId, sku },
  });
  if (error) throw new OrderNoteError("Unable to save the note. Your text has been kept; please try again.", 500);
  return { id, message, author, savedAt, sku };
}
