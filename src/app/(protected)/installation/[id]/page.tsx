import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

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

function formatBytes(size: number | null) {
  if (!size || size < 0) return "-";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export default async function InstallationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireUser();
  const { id } = await params;
  const supabase = getSupabaseAdmin();

  const [{ data: job }, { data: notes }, { data: photos }] = await Promise.all([
    supabase
      .from("installation_jobs")
      .select("id, invoice_number, quickbooks_invoice_id, customer_name, company_name, phone, email, shipping_address, summary, status, created_at, updated_at")
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("installation_notes")
      .select("id, content, created_at, creator:access_users!installation_notes_created_by_access_user_fkey(full_name)")
      .eq("installation_job_id", id)
      .order("created_at", { ascending: false }),
    supabase
      .from("installation_photos")
      .select("id, file_name, file_path, file_size, mime_type, created_at, uploader:access_users!installation_photos_uploaded_by_access_user_fkey(full_name)")
      .eq("installation_job_id", id)
      .order("created_at", { ascending: false }),
  ]);

  const installationJob = job as InstallationJobRecord | null;
  if (!installationJob) {
    return (
      <div className="card p-6">
        <h1 className="text-2xl">Installation not found</h1>
        <p className="mt-2 text-sm text-[#5a5a5a]">The installation record may have been removed or is no longer available.</p>
        <Link href="/installation" className="btn-secondary mt-4 inline-flex">Back to Installations</Link>
      </div>
    );
  }

  const signedPhotoUrls = await Promise.all(
    ((photos ?? []) as InstallationPhotoRow[]).map(async (photo) => {
      const { data } = await supabase.storage.from("case-attachments").createSignedUrl(photo.file_path, 60 * 60);
      return { ...photo, url: data?.signedUrl ?? null };
    }),
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl">{installationJob.customer_name}</h1>
          <p className="text-sm text-[#5a5a5a]">Invoice #{installationJob.invoice_number} • Status {installationJob.status}</p>
        </div>
        <Link href="/installation" className="btn-secondary">Back to List</Link>
      </div>

      <section className="card border border-[#e7eaef] bg-white p-4 shadow-sm">
        <h2 className="text-xl font-semibold text-[#121826]">Installation Details</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <div className="space-y-2 text-sm text-[#334155]">
            <p><span className="font-semibold">Invoice:</span> {installationJob.invoice_number}</p>
            <p><span className="font-semibold">Company:</span> {installationJob.company_name ?? "-"}</p>
            <p><span className="font-semibold">Phone:</span> {installationJob.phone ?? "-"}</p>
            <p><span className="font-semibold">Email:</span> {installationJob.email ?? "-"}</p>
            <p><span className="font-semibold">Shipping Address:</span> {installationJob.shipping_address ?? "-"}</p>
            <p><span className="font-semibold">Updated:</span> {new Date(installationJob.updated_at).toLocaleString()}</p>
          </div>
        </div>
      </section>

      <section className="card border border-[#e7eaef] bg-white p-4 shadow-sm">
        <h2 className="text-xl font-semibold text-[#121826]">Notes</h2>
        <div className="mt-4 space-y-3">
          {(notes ?? []).length ? (
            (notes as InstallationNoteRow[]).map((note) => (
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
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {signedPhotoUrls.length ? (
            signedPhotoUrls.map((photo) => (
              <div key={photo.id} className="rounded-lg border border-[#ececec] p-3">
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
