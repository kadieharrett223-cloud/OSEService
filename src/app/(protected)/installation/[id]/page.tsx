import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { AttachmentDropzone } from "@/app/(protected)/cases/new/attachment-dropzone";
import { addInstallationPhotosAction } from "@/app/(protected)/installation/actions";

type InstallationJobRecord = {
  id: string;
  invoice_number: string;
  quickbooks_invoice_id: string | null;
  customer_name: string;
  company_name: string | null;
  phone: string | null;
  email: string | null;
  shipping_address: string | null;
  summary: string;
  status: string;
  created_at: string;
  updated_at: string;
};

type InstallationNoteRow = {
  id: string;
  content: string;
  created_at: string;
  creator: { full_name: string | null } | null;
};

type InstallationPhotoRow = {
  id: string;
  file_name: string;
  file_path: string;
  file_size: number | null;
  mime_type: string | null;
  created_at: string;
  uploader: { full_name: string | null } | null;
};

type QuickbooksInvoiceRow = {
  quickbooks_invoice_id: string;
  raw_payload: unknown;
};

function getFileExtension(fileName: string) {
  if (!fileName.includes(".")) return "";
  return fileName.split(".").pop()?.toLowerCase() ?? "";
}

function getPreviewType(photo: { mime_type: string | null; file_name: string }) {
  const mime = (photo.mime_type ?? "").toLowerCase();
  const extension = getFileExtension(photo.file_name);

  if (mime.startsWith("image/") || ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"].includes(extension)) {
    return "image";
  }

  if (mime.startsWith("video/") || ["mp4", "mov", "webm", "ogg"].includes(extension)) {
    return "video";
  }

  if (mime === "application/pdf" || extension === "pdf") {
    return "pdf";
  }

  return "file";
}

function formatBytes(size: number | null) {
  if (!size || size < 0) return "-";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseInvoiceLineItems(rawPayload: unknown) {
  if (!rawPayload || typeof rawPayload !== "object") return [] as string[];

  const payload = rawPayload as { Line?: unknown[] };
  const lines = Array.isArray(payload.Line) ? payload.Line : [];

  return lines
    .map((line, index) => {
      if (!line || typeof line !== "object") return null;

      const item = line as {
        Description?: unknown;
        Qty?: unknown;
        SalesItemLineDetail?: { Qty?: unknown; ItemRef?: { name?: unknown } };
      };

      const description = typeof item.Description === "string"
        ? item.Description.trim()
        : typeof item.SalesItemLineDetail?.ItemRef?.name === "string"
          ? item.SalesItemLineDetail.ItemRef.name.trim()
          : "";

      if (!description) return null;

      const qtyRaw = item.SalesItemLineDetail?.Qty ?? item.Qty;
      const qty = typeof qtyRaw === "number" || typeof qtyRaw === "string"
        ? String(qtyRaw).trim()
        : "";

      return `${index + 1}. ${description}${qty ? ` (Qty ${qty})` : ""}`;
    })
    .filter((line): line is string => Boolean(line));
}

export default async function InstallationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const { error, success } = await searchParams;
  const supabase = getSupabaseAdmin();

  let job: InstallationJobRecord | null = null;
  let notes: InstallationNoteRow[] = [];
  let photos: InstallationPhotoRow[] = [];
  let quickbooksInvoice: QuickbooksInvoiceRow | null = null;

  try {
    const [jobResult, notesResult, photosResult] = await Promise.all([
      supabase
        .from("installation_jobs")
        .select("id, invoice_number, quickbooks_invoice_id, customer_name, company_name, phone, email, shipping_address, summary, status, created_at, updated_at")
        .eq("id", id)
        .maybeSingle(),
      supabase
        .from("installation_notes")
        .select("id, content, created_at, creator:access_users!installation_notes_created_by_fkey(full_name)")
        .eq("installation_job_id", id)
        .order("created_at", { ascending: false }),
      supabase
        .from("installation_photos")
        .select("id, file_name, file_path, file_size, mime_type, created_at, uploader:access_users!installation_photos_uploaded_by_fkey(full_name)")
        .eq("installation_job_id", id)
        .order("created_at", { ascending: false }),
    ]);

    if (!jobResult.error) {
      job = jobResult.data as InstallationJobRecord | null;
    }
    if (!notesResult.error) {
      notes = (notesResult.data ?? []) as InstallationNoteRow[];
    }
    if (!photosResult.error) {
      photos = (photosResult.data ?? []) as InstallationPhotoRow[];
    }
  } catch {
    job = null;
    notes = [];
    photos = [];
  }

  const installationJob = job;
  if (!installationJob) {
    return (
      <div className="card p-6">
        <h1 className="text-2xl">Installation not found</h1>
        <p className="mt-2 text-sm text-[#5a5a5a]">The installation record may have been removed or is no longer available.</p>
        <Link href="/installation" className="btn-secondary mt-4 inline-flex">Back to Installations</Link>
      </div>
    );
  }

  if (installationJob.quickbooks_invoice_id) {
    try {
      const lookupByUuid = isUuid(installationJob.quickbooks_invoice_id);
      const invoiceQuery = lookupByUuid
        ? supabase
            .from("quickbooks_invoices")
            .select("quickbooks_invoice_id, raw_payload")
            .eq("id", installationJob.quickbooks_invoice_id)
            .maybeSingle()
        : supabase
            .from("quickbooks_invoices")
            .select("quickbooks_invoice_id, raw_payload")
            .eq("quickbooks_invoice_id", installationJob.quickbooks_invoice_id)
            .maybeSingle();

      const { data } = await invoiceQuery;
      quickbooksInvoice = (data as QuickbooksInvoiceRow | null) ?? null;

      // Support legacy records that may store external QuickBooks invoice ids in quickbooks_invoice_id.
      if (!quickbooksInvoice && lookupByUuid) {
        const { data: fallbackInvoice } = await supabase
          .from("quickbooks_invoices")
          .select("quickbooks_invoice_id, raw_payload")
          .eq("quickbooks_invoice_id", installationJob.quickbooks_invoice_id)
          .maybeSingle();

        quickbooksInvoice = (fallbackInvoice as QuickbooksInvoiceRow | null) ?? null;
      }
    } catch {
      quickbooksInvoice = null;
    }
  }

  const signedPhotoUrls = await Promise.all(
    (photos as InstallationPhotoRow[]).map(async (photo) => {
      try {
        const { data } = await supabase.storage.from("case-attachments").createSignedUrl(photo.file_path, 60 * 60);
        return { ...photo, url: data?.signedUrl ?? null };
      } catch {
        return { ...photo, url: null };
      }
    }),
  );
  const invoiceLineItems = parseInvoiceLineItems(quickbooksInvoice?.raw_payload);
  const invoiceLink = quickbooksInvoice?.quickbooks_invoice_id
    ? `https://app.qbo.intuit.com/app/invoice?txnId=${encodeURIComponent(quickbooksInvoice.quickbooks_invoice_id)}`
    : installationJob.quickbooks_invoice_id
      ? `https://app.qbo.intuit.com/app/invoice?txnId=${encodeURIComponent(installationJob.quickbooks_invoice_id)}`
      : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl">{installationJob.customer_name}</h1>
          <p className="text-sm text-[#5a5a5a]">Invoice #{installationJob.invoice_number} • Status {installationJob.status}</p>
        </div>
        <Link href="/installation" className="btn-secondary">Back to List</Link>
      </div>

      {error ? (
        <p className="rounded-md border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d]">{error}</p>
      ) : null}

      {success === "photos_uploaded" ? (
        <p className="rounded-md border border-[#ccebd7] bg-[#f2fff6] p-3 text-sm text-[#0f6f35]">Photos uploaded successfully.</p>
      ) : null}

      <section className="card border border-[#e7eaef] bg-white p-4 shadow-sm">
        <h2 className="text-xl font-semibold text-[#121826]">Customer Info</h2>
        <div className="mt-4 space-y-3 text-sm text-[#334155]">
          <p><span className="font-semibold">Invoice Number:</span> {installationJob.invoice_number}</p>
          <p><span className="font-semibold">Customer Name:</span> {installationJob.customer_name}</p>
          <p><span className="font-semibold">Shipping Address:</span> {installationJob.shipping_address ?? "-"}</p>
          {invoiceLink ? (
            <a
              href={invoiceLink}
              target="_blank"
              rel="noreferrer"
              className="btn-secondary inline-flex"
            >
              View Invoice
            </a>
          ) : null}
          {invoiceLineItems.length ? (
            <div className="rounded-lg border border-[#ececec] bg-[#fafbfc] p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-[#64748b]">Invoice Line Items</p>
              <textarea
                readOnly
                rows={Math.min(Math.max(invoiceLineItems.length + 1, 5), 12)}
                className="textarea mt-2 bg-[#f8fafc]"
                value={invoiceLineItems.join("\n")}
              />
            </div>
          ) : null}
        </div>
      </section>

      <section className="card border border-[#e7eaef] bg-white p-4 shadow-sm">
        <h2 className="text-xl font-semibold text-[#121826]">Notes</h2>
        <div className="mt-4 space-y-3">
          {notes.length ? (
            notes.map((note) => (
              <div key={note.id} className="rounded-lg border border-[#ececec] bg-[#fafbfc] p-3 text-sm text-[#334155]">
                <p className="whitespace-pre-wrap">{note.content}</p>
                <p className="mt-2 text-xs text-[#64748b]">{note.creator?.full_name ?? "Unknown"} • {new Date(note.created_at).toLocaleString()}</p>
              </div>
            ))
          ) : (
            <p className="text-sm text-[#64748b]">No notes yet for this installation.</p>
          )}
        </div>
      </section>

      <section className="card border border-[#e7eaef] bg-white p-4 shadow-sm">
        <h2 className="text-xl font-semibold text-[#121826]">Photos</h2>
        <form action={addInstallationPhotosAction} className="mt-4 space-y-3 rounded-lg border border-[#ececec] bg-[#fafbfc] p-3">
          <input type="hidden" name="installation_job_id" value={installationJob.id} />
          <p className="text-sm text-[#334155]">Add new photos to this installation.</p>
          <AttachmentDropzone uploadedBy={user.fullName ?? "Unknown"} />
          <div className="flex justify-end">
            <button type="submit" className="btn-primary">Upload Photos</button>
          </div>
        </form>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {signedPhotoUrls.length ? (
            signedPhotoUrls.map((photo) => (
              <div key={photo.id} className="rounded-lg border border-[#ececec] p-3">
                {photo.url ? (
                  <div className="mb-3 overflow-hidden rounded-md border border-[#e7eaef] bg-[#f8fafc]">
                    {getPreviewType(photo) === "image" ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={photo.url}
                        alt={photo.file_name}
                        className="h-52 w-full object-cover"
                        loading="lazy"
                      />
                    ) : null}

                    {getPreviewType(photo) === "video" ? (
                      <video
                        src={photo.url}
                        controls
                        preload="metadata"
                        className="h-52 w-full bg-black object-contain"
                      />
                    ) : null}

                    {getPreviewType(photo) === "pdf" ? (
                      <iframe
                        src={photo.url}
                        title={photo.file_name}
                        className="h-52 w-full"
                      />
                    ) : null}

                    {getPreviewType(photo) === "file" ? (
                      <div className="flex h-52 items-center justify-center px-4 text-center text-sm text-[#64748b]">
                        Preview is not available for this file type.
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <p className="text-sm font-semibold">{photo.file_name}</p>
                <p className="text-xs text-[#64748b]">{formatBytes(photo.file_size)} • {photo.uploader?.full_name ?? "Unknown"}</p>
                {photo.url ? (
                  <a href={photo.url} target="_blank" rel="noreferrer" className="mt-3 inline-flex text-sm font-semibold text-[#b20610] hover:underline">
                    Open file
                  </a>
                ) : null}
              </div>
            ))
          ) : (
            <p className="text-sm text-[#64748b]">No photos yet for this installation.</p>
          )}
        </div>
      </section>
    </div>
  );
}
