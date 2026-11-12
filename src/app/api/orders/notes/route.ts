import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { revalidateOrdersProjection } from "@/lib/orders/orders-projection-cache";
import { OrderNoteError, saveOrderNote } from "@/lib/orders/save-order-note";

export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please sign in again. Your note has not been saved." }, { status: 401 });
  let form: FormData;
  try { form = await request.formData(); }
  catch { return Response.json({ error: "Invalid note submission." }, { status: 400 }); }
  let note;
  try { note = await saveOrderNote(user, form); }
  catch (error) { return Response.json({ error: error instanceof OrderNoteError ? error.message : "Could not confirm the save. Check the order notes before trying again." }, { status: error instanceof OrderNoteError ? error.status : 500 }); }
  // Route-handler invalidation does not re-render the expensive order page in this response.
  // A cache failure must not turn a committed note into an apparent failed save.
  try {
    revalidateOrdersProjection();
    revalidatePath("/orders");
    revalidatePath(`/orders/${String(form.get("orderId"))}`);
  } catch (error) { console.error("Order note saved; cache invalidation failed", error); }
  return Response.json({ note });
}
