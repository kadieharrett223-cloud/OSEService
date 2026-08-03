import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { CASE_STATUSES, CASE_TYPES, PRIORITIES } from "@/lib/constants";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import { AttachmentDropzone } from "@/app/(protected)/cases/new/attachment-dropzone";
import { IssueDetailsAutosaveForm } from "@/app/(protected)/cases/[id]/issue-details-autosave-form";
import { WorkflowAutosaveForm } from "@/app/(protected)/cases/[id]/workflow-autosave-form";
import {
  addCaseWorkflowEventAction,
  addNoteAction,
  deleteAttachmentAction,
  uploadAttachmentAction,
} from "@/app/(protected)/cases/[id]/actions";
import { DeleteCaseButton } from "@/app/(protected)/cases/[id]/delete-case-button";

type ActivityRow = {
  id: string;
  activity_type: string;
  summary: string;
  details?: Record<string, unknown> | null;
  created_at: string;
  access_users: { full_name: string | null } | null;
};

type CaseRecord = {
  id: string;
  case_number: string;
  created_at: string;
  case_type: string;
  status: string;
  priority: string;
  issue_reported_at: string;
  issue_description: string;
  assigned_employee_id: string | null;
  date_of_purchase: string | null;
  quickbooks_invoice_number: string | null;
  quickbooks_invoice_link: string | null;
  created_by: string;
  customer_id: string | null;
  quickbooks_invoice_id: string | null;
  customers: {
    full_name: string | null;
    company_name: string | null;
    phone: string | null;
    email: string | null;
    shipping_address: string | null;
    quickbooks_customer_id: string | null;
  } | null;
  invoice: {
    invoice_date: string | null;
    invoice_total: number | null;
    payment_status: string | null;
    billing_address: string | null;
    shipping_address: string | null;
    raw_payload: unknown;
    quickbooks_invoice_id: string;
  } | null;
  assigned: { full_name: string | null } | null;
  creator: { full_name: string | null } | null;
};

type AttachmentRow = {
  id: string;
  file_name: string;
  file_path: string;
  file_size: number | null;
  mime_type: string | null;
  created_at: string;
  uploader: { full_name: string | null } | null;
};

type InternalNoteRow = {
  id: string;
  note_type: string;
  content: string;
  created_at: string;
  access_users: { full_name: string | null } | null;
};

function formatBytes(size: number | null) {
  if (!size || size < 0) return "-";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function parseProductsPurchased(rawPayload: unknown) {
  if (!rawPayload || typeof rawPayload !== "object") return "-";

  const payload = rawPayload as { Line?: unknown[] };
  const lines = Array.isArray(payload.Line) ? payload.Line : [];

  const products = lines
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
    .filter((value): value is string => Boolean(value));

  return products.length > 0 ? products.join("\n") : "-";
}

function activityLabel(activityType: string) {
  const map: Record<string, string> = {
    case_created: "CASE",
    status_changed: "STATUS",
    workflow_status_changed: "WORKFLOW",
    note_added: "NOTE",
    file_uploaded: "FILE",
    file_deleted: "FILE",
    add_tracking_number: "TRACK",
    replacement_part_ordered: "PART",
    replacement_delivered: "DELIVERED",
    waiting_customer: "WAIT",
    waiting_supplier: "WAIT",
    customer_contacted: "CALL",
    send_customer_email: "EMAIL",
    warranty_approved: "WARRANTY",
    assigned_user_changed: "ASSIGNED",
    next_action_set: "NEXT",
    issue_details_updated: "ISSUE",
  };

  return map[activityType] ?? "EVENT";
}

function activityIcon(activityType: string) {
  const map: Record<string, string> = {
    case_created: "#",
    status_changed: "S",
    workflow_status_changed: "W",
    note_added: "N",
    file_uploaded: "U",
    file_deleted: "D",
    add_tracking_number: "T",
    replacement_part_ordered: "P",
    replacement_delivered: "R",
    waiting_customer: "C",
    waiting_supplier: "F",
    customer_contacted: "C",
    send_customer_email: "E",
    warranty_approved: "A",
    assigned_user_changed: "A",
    next_action_set: "N",
    issue_details_updated: "I",
  };

  return map[activityType] ?? "*";
}

function statusBadgeClass(status: string) {
  if (status === "Resolved") return "bg-[#e8f9ee] text-[#0f6f35]";
  if (status === "Waiting for Customer") return "bg-[#fff8dd] text-[#915f00]";
  if (status === "Waiting on Supplier" || status === "Waiting for Supplier") return "bg-[#e8f1ff] text-[#1d4ed8]";
  if (status === "Parts Ordered") return "bg-[#f4ecff] text-[#6d28d9]";
  if (status === "Closed") return "bg-[#eceff3] text-[#334155]";
  if (status === "In Progress" || status === "New") return "bg-[#ffe6e6] text-[#8f030d]";
  return "bg-[#eef2f7] text-[#334155]";
}

function safeInputDate(value: string | null | undefined) {
  if (!value) return "";
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toISOString().slice(0, 10);
}

function buildTrackingUrl(trackingNumber: string) {
  return `https://www.google.com/search?q=${encodeURIComponent(`${trackingNumber} package tracking`)}`;
}

function extractInvoiceContactFallbacks(rawPayload: unknown) {
  if (!rawPayload || typeof rawPayload !== "object") {
    return { phone: "", email: "" };
  }

  const payload = rawPayload as Record<string, unknown>;
  const billEmail = payload.BillEmail as Record<string, unknown> | undefined;
  const primaryEmail = payload.PrimaryEmailAddr as Record<string, unknown> | undefined;
  const billPhone = payload.BillPhone as Record<string, unknown> | undefined;
  const primaryPhone = payload.PrimaryPhone as Record<string, unknown> | undefined;

  const email = typeof billEmail?.Address === "string"
    ? billEmail.Address
    : typeof primaryEmail?.Address === "string"
      ? primaryEmail.Address
      : "";

  const phone = typeof billPhone?.FreeFormNumber === "string"
    ? billPhone.FreeFormNumber
    : typeof primaryPhone?.FreeFormNumber === "string"
      ? primaryPhone.FreeFormNumber
      : "";

  return { phone, email };
}

function formatAddressFromRaw(address: unknown) {
  if (!address || typeof address !== "object") return "";

  const addressRecord = address as Record<string, unknown>;
  const asText = [
    addressRecord.Line1,
    addressRecord.Line2,
    addressRecord.Line3,
    addressRecord.Line4,
    addressRecord.Line5,
    [addressRecord.City, addressRecord.CountrySubDivisionCode, addressRecord.PostalCode].filter(Boolean).join(" "),
    addressRecord.Country,
  ]
    .filter((line): line is string => typeof line === "string" && line.trim().length > 0)
    .map((line) => line.trim());

  return asText.join(", ");
}

function normalizeStatusLabel(status: string) {
  if (status === "Completed" || status === "Closed") return "Resolved";
  return status;
}

export default async function CaseDetailsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; timeline?: string }>;
}) {
  const user = await requireUser();

  const { id } = await params;
  const { error, timeline } = await searchParams;
  const supabase = getSupabaseAdmin();

  const { data: caseRecordRaw, error: caseError } = await supabase
    .from("customer_service_cases")
    .select(
      "id, case_number, created_at, case_type, status, priority, issue_reported_at, issue_description, assigned_employee_id, date_of_purchase, quickbooks_invoice_number, quickbooks_invoice_link, created_by, customer_id, quickbooks_invoice_id",
    )
    .eq("id", id)
    .maybeSingle();

  const caseRecord = caseRecordRaw as unknown as CaseRecord | null;

  let customerRow: CaseRecord["customers"] | null = null;
  let invoiceRow: CaseRecord["invoice"] | null = null;
  let assignedRow: CaseRecord["assigned"] | null = null;
  let creatorRow: CaseRecord["creator"] | null = null;
  let activity: ActivityRow[] = [];
  let attachments: AttachmentRow[] = [];
  let internalNotes: InternalNoteRow[] = [];

  if (caseRecord && !caseError) {
    const [customerResult, invoiceResult, assignedResult, creatorResult, activityResult, attachmentResult, internalNoteResult] = await Promise.all([
      caseRecord.customer_id
        ? supabase.from("customers").select("full_name, company_name, phone, email, shipping_address, quickbooks_customer_id").eq("id", caseRecord.customer_id).maybeSingle()
        : Promise.resolve({ data: null }),
      caseRecord.quickbooks_invoice_id
        ? supabase.from("quickbooks_invoices").select("invoice_date, invoice_total, payment_status, billing_address, shipping_address, raw_payload, quickbooks_invoice_id").eq("id", caseRecord.quickbooks_invoice_id).maybeSingle()
        : Promise.resolve({ data: null }),
      caseRecord.assigned_employee_id
        ? supabase.from("access_users").select("full_name").eq("id", caseRecord.assigned_employee_id).maybeSingle()
        : Promise.resolve({ data: null }),
      caseRecord.created_by
        ? supabase.from("access_users").select("full_name").eq("id", caseRecord.created_by).maybeSingle()
        : Promise.resolve({ data: null }),
      supabase.from("case_activity").select("id, activity_type, summary, details, created_at, access_users:actor_id(full_name)").eq("case_id", id).order("created_at", { ascending: false }),
      supabase.from("case_attachments").select("id, file_name, file_path, file_size, mime_type, created_at, uploader:access_users!case_attachments_uploaded_by_access_user_fkey(full_name)").eq("case_id", id).order("created_at", { ascending: false }),
      supabase.from("case_notes").select("id, note_type, content, created_at, access_users:created_by(full_name)").eq("case_id", id).eq("note_type", "internal").order("created_at", { ascending: false }),
    ]);

    customerRow = (customerResult.data as CaseRecord["customers"] | null) ?? null;
    invoiceRow = (invoiceResult.data as CaseRecord["invoice"] | null) ?? null;
    assignedRow = (assignedResult.data as CaseRecord["assigned"] | null) ?? null;
    creatorRow = (creatorResult.data as CaseRecord["creator"] | null) ?? null;
    activity = (activityResult.data ?? []) as ActivityRow[];
    attachments = (attachmentResult.data ?? []) as AttachmentRow[];
    internalNotes = (internalNoteResult.data ?? []) as InternalNoteRow[];
  }

  if (!caseRecord) {
    return (
      <div className="card p-6">
        <h1 className="text-2xl">Case not found</h1>
        <p className="mt-2 text-sm text-[#5a5a5a]">The case may have been removed or is no longer available.</p>
        <Link href="/cases" className="btn-secondary mt-4 inline-flex">Back to Cases</Link>
      </div>
    );
  }

  const { data: assignees } = await supabase
    .from("access_users")
    .select("id, full_name")
    .order("full_name", { ascending: true });

  const caseRecordWithRelations = {
    ...caseRecord,
    customers: customerRow,
    invoice: invoiceRow,
    assigned: assignedRow,
    creator: creatorRow,
  } as CaseRecord;

  const attachmentLinks = await Promise.all(
    ((attachments ?? []) as AttachmentRow[]).map(async (item) => {
      try {
        const { data, error } = await supabase.storage
          .from("case-attachments")
          .createSignedUrl(item.file_path, 60 * 60);

        if (error) {
          return { ...item, url: null };
        }

        return { ...item, url: data?.signedUrl ?? null };
      } catch {
        return { ...item, url: null };
      }
    }),
  );

  const productsPurchased = parseProductsPurchased(caseRecordWithRelations.invoice?.raw_payload);
  const allActivityRows = activity as ActivityRow[];
  const activityRows = allActivityRows.filter((row) => row.activity_type !== "note_added");
  const showAllTimeline = timeline === "all";
  const visibleTimelineRows = showAllTimeline ? activityRows : activityRows.slice(0, 5);
  const normalizedStatus = normalizeStatusLabel(caseRecordWithRelations.status);
  const isResolvedStatus = normalizedStatus === "Resolved";
  const priorityBadgeLabel = isResolvedStatus ? "Complete" : caseRecordWithRelations.priority;
  const priorityBadgeClass = isResolvedStatus
    ? "badge-complete"
    : caseRecordWithRelations.priority === "High"
      ? "badge-priority-high"
      : "badge-status";
  const statusOptions = CASE_STATUSES.filter((status) => status !== "Completed" && status !== "Closed");
  const latestTrackingFromDetails = allActivityRows.find((row) => row.activity_type === "add_tracking_number")?.details?.tracking_number;
  const latestTracking = (typeof latestTrackingFromDetails === "string" ? latestTrackingFromDetails : "")
    || allActivityRows.find((row) => row.activity_type === "add_tracking_number")?.summary.split(":").slice(1).join(":").trim()
    || "";
  const latestTrackingUrl = latestTracking ? buildTrackingUrl(latestTracking) : "";
  const latestNextActionEvent = allActivityRows.find((row) => row.activity_type === "next_action_set");
  const latestNextAction = typeof latestNextActionEvent?.details?.next_action === "string"
    ? latestNextActionEvent.details.next_action
    : "";
  const latestEtaDate = typeof latestNextActionEvent?.details?.eta_date === "string"
    ? safeInputDate(latestNextActionEvent.details.eta_date)
    : "";
  const invoiceLink = caseRecordWithRelations.quickbooks_invoice_link
    || (caseRecordWithRelations.invoice?.quickbooks_invoice_id
      ? `https://app.qbo.intuit.com/app/invoice?txnId=${encodeURIComponent(caseRecordWithRelations.invoice.quickbooks_invoice_id)}`
      : null);
  const invoiceContactFallbacks = extractInvoiceContactFallbacks(caseRecordWithRelations.invoice?.raw_payload);
  const invoiceRaw = caseRecordWithRelations.invoice?.raw_payload as Record<string, unknown> | undefined;
  const invoiceShippingFromRaw = formatAddressFromRaw(invoiceRaw?.ShipAddr) || formatAddressFromRaw(invoiceRaw?.BillAddr);
  const shippingAddress = invoiceShippingFromRaw
    || caseRecordWithRelations.invoice?.shipping_address
    || caseRecordWithRelations.customers?.shipping_address
    || caseRecordWithRelations.invoice?.billing_address
    || "";
  const issueReportedDisplay = new Date(caseRecordWithRelations.issue_reported_at || caseRecordWithRelations.created_at).toLocaleString();
  const caseCreatedDisplay = new Date(caseRecordWithRelations.created_at).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="space-y-4">
      <section className="card border border-[#e7eaef] bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-2">
            <h1 className="text-4xl leading-tight text-[#121826]">{caseRecordWithRelations.case_number}</h1>
            <p className="text-sm font-semibold text-[#334155]">{caseRecordWithRelations.case_type} Case</p>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className={`rounded-full px-3 py-1 font-semibold ${statusBadgeClass(normalizedStatus)}`}>{normalizedStatus}</span>
              <span className={`badge ${priorityBadgeClass}`}>{priorityBadgeLabel}</span>
            </div>
          </div>

          <div className="grid gap-2 text-sm text-[#334155] sm:grid-cols-2">
            <p><span className="font-semibold">Created:</span> {caseCreatedDisplay}</p>
            <p><span className="font-semibold">Assigned To:</span> {caseRecordWithRelations.assigned?.full_name ?? "Unassigned"}</p>
            <p><span className="font-semibold">Reported:</span> {issueReportedDisplay}</p>
            <div className="text-right sm:text-left">
              <Link href="/cases" className="btn-secondary inline-flex">Back to Cases</Link>
            </div>
          </div>
        </div>
      </section>

      {error ? (
        <p className="rounded-md border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d]">{error}</p>
      ) : null}

      <section className="card border border-[#e7eaef] bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-xl font-semibold text-[#121826]">Customer Information</h2>
          <span className="rounded-full bg-[#eef2f7] px-2 py-1 text-xs font-semibold text-[#334155]">QuickBooks Snapshot</span>
        </div>
        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <label className="label">Customer Name</label>
              <input readOnly className="input bg-[#f8fafc]" value={caseRecordWithRelations.customers?.full_name ?? "-"} />
            </div>
            <div>
              <label className="label">Company</label>
              <input readOnly className="input bg-[#f8fafc]" value={caseRecordWithRelations.customers?.company_name ?? "-"} />
            </div>
            <div>
              <label className="label">Phone</label>
              <input readOnly className="input bg-[#f8fafc]" value={caseRecordWithRelations.customers?.phone ?? invoiceContactFallbacks.phone ?? "-"} />
            </div>
            <div>
              <label className="label">Email</label>
              <input readOnly className="input bg-[#f8fafc]" value={caseRecordWithRelations.customers?.email ?? invoiceContactFallbacks.email ?? "-"} />
            </div>
            <div className="sm:col-span-2">
              <label className="label">Shipping Address</label>
              <textarea readOnly rows={4} className="textarea bg-[#f8fafc]" value={shippingAddress} />
            </div>
          </div>

          <aside className="space-y-2 rounded-lg border border-[#edf0f4] bg-[#fafbfc] p-3 text-sm">
            <div className="grid grid-cols-2 gap-x-3 gap-y-2">
              <p><span className="font-semibold">Invoice #:</span> {caseRecordWithRelations.quickbooks_invoice_number ?? "-"}</p>
              <p><span className="font-semibold">Invoice Date:</span> {caseRecordWithRelations.invoice?.invoice_date ?? "-"}</p>
              <p><span className="font-semibold">Purchase Date:</span> {caseRecordWithRelations.date_of_purchase ?? caseRecordWithRelations.invoice?.invoice_date ?? "-"}</p>
              <p><span className="font-semibold">Invoice Total:</span> {caseRecordWithRelations.invoice?.invoice_total != null ? `$${caseRecordWithRelations.invoice.invoice_total.toFixed(2)}` : "-"}</p>
              <p className="col-span-2"><span className="font-semibold">Payment Status:</span> {caseRecordWithRelations.invoice?.payment_status ?? "-"}</p>
            </div>
            <div>
              <label className="label">Products Purchased</label>
              <textarea readOnly rows={5} className="textarea bg-[#f8fafc]" value={productsPurchased} />
            </div>
            {invoiceLink ? (
              <a href={invoiceLink} target="_blank" rel="noreferrer" className="btn-secondary inline-flex w-full justify-center">View Full Invoice</a>
            ) : (
              <button type="button" disabled className="btn-secondary inline-flex w-full justify-center opacity-60">View Full Invoice</button>
            )}
          </aside>
        </div>
      </section>

      <section className="card border border-[#e7eaef] bg-white p-4 shadow-sm">
        <h2 className="text-xl font-semibold text-[#121826]">Issue Details</h2>
        <IssueDetailsAutosaveForm
          caseId={id}
          caseType={caseRecordWithRelations.case_type ?? "General"}
          priority={caseRecordWithRelations.priority}
          issueDescription={caseRecordWithRelations.issue_description}
          caseTypeOptions={CASE_TYPES}
          priorityOptions={PRIORITIES}
        />
      </section>

      <section className="card border border-[#e7eaef] bg-white p-4 shadow-sm">
        <h2 className="text-xl font-semibold text-[#121826]">Photos & Attachments</h2>
        <p className="mt-1 text-sm text-[#5a5a5a]">Upload unlimited files for this case: JPG, PNG, HEIC, PDF, MP4.</p>

        <form action={uploadAttachmentAction} className="mt-3 space-y-3">
          <input type="hidden" name="case_id" value={id} />
          <AttachmentDropzone uploadedBy={user.fullName ?? "Unknown"} />
          <button type="submit" className="btn-primary">Upload Files</button>
        </form>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {attachmentLinks.map((item) => {
            const isImage = Boolean(item.mime_type?.startsWith("image/"));

            return (
              <div key={item.id} className="rounded-md border border-[#ececec] p-2 text-sm">
                <div className="mb-2 flex h-28 items-center justify-center rounded-md bg-[#f5f7fb]">
                  {isImage && item.url ? (
                    <a href={item.url} target="_blank" rel="noreferrer" className="h-full w-full">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={item.url} alt={item.file_name} className="h-full w-full rounded-md object-cover" />
                    </a>
                  ) : (
                    <span className="text-xs text-[#64748b]">{item.mime_type ?? "File"}</span>
                  )}
                </div>
                <p className="truncate font-semibold" title={item.file_name}>{item.file_name}</p>
                <p className="text-xs text-[#6a6a6a]">Uploaded by: {item.uploader?.full_name ?? "Unknown"}</p>
                <p className="text-xs text-[#6a6a6a]">{new Date(item.created_at).toLocaleString()}</p>
                <p className="text-xs text-[#6a6a6a]">{formatBytes(item.file_size)}</p>
                <div className="mt-2 flex gap-2">
                  {item.url ? (
                    <a className="btn-secondary text-xs" href={item.url} target="_blank" rel="noreferrer">View</a>
                  ) : null}
                  <form action={deleteAttachmentAction}>
                    <input type="hidden" name="case_id" value={id} />
                    <input type="hidden" name="attachment_id" value={item.id} />
                    <button type="submit" className="btn-danger text-xs">Delete</button>
                  </form>
                </div>
              </div>
            );
          })}
          {attachmentLinks.length === 0 ? (
            <p className="rounded-md border border-[#edf0f4] bg-[#fafbfc] p-3 text-sm text-[#64748b] sm:col-span-2 lg:col-span-3">
              No attachments uploaded yet.
            </p>
          ) : null}
        </div>
      </section>

      <section className="card border border-[#e7eaef] bg-white p-4 shadow-sm">
        <h2 className="text-xl font-semibold text-[#121826]">Case Workflow</h2>
        <p className="mt-1 text-sm text-[#5a5a5a]">Use this panel to move the case forward and capture the next operational step.</p>
        <div className="mt-3 space-y-3">
          <WorkflowAutosaveForm
            caseId={id}
            status={normalizedStatus}
            statusOptions={statusOptions}
            assigneeId={caseRecordWithRelations.assigned_employee_id ?? ""}
            assignees={(assignees ?? []) as Array<{ id: string; full_name: string | null }>}
            nextAction={latestNextAction}
            etaDate={latestEtaDate}
          />

          <form action={addCaseWorkflowEventAction} className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <input type="hidden" name="case_id" value={id} />
            <input type="hidden" name="event_type" value="add_tracking_number" />
            <input id="tracking_number" name="tracking_number" className="input" placeholder="Enter tracking number" />
            <button type="submit" className="btn-secondary">Add Tracking Number</button>
          </form>
          {latestTrackingUrl ? (
            <a href={latestTrackingUrl} target="_blank" rel="noreferrer" className="inline-flex text-xs font-semibold text-[#b20610] underline">
              Track latest package ({latestTracking})
            </a>
          ) : null}
        </div>
      </section>

      <section className="card border border-[#e7eaef] bg-white p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold text-[#121826]">Activity Timeline & Internal Notes</h2>
          <span className="badge badge-status">Auto</span>
        </div>
        <p className="mt-2 text-sm text-[#5a5a5a]">The timeline captures automatic updates from the case, while the right-side panel keeps the live internal conversation organized.</p>

        <div className="mt-4 grid gap-4 lg:grid-cols-[1.25fr_0.9fr]">
          <div>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-[#64748b]">Timeline</h3>
              <span className="text-xs text-[#64748b]">Auto-updating</span>
            </div>
            <div className="mt-3 space-y-2">
              {visibleTimelineRows.map((row) => (
                <div key={row.id} className="rounded-md border border-[#ececec] p-3 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[#f1f5f9] text-[11px] font-bold text-[#475569]">
                        {activityIcon(row.activity_type)}
                      </span>
                      <span className="rounded bg-[#f1f5f9] px-2 py-0.5 text-[11px] font-semibold text-[#475569]">{activityLabel(row.activity_type)}</span>
                    </div>
                    <span className="text-xs text-[#6a6a6a]">{new Date(row.created_at).toLocaleString()}</span>
                  </div>
                  <p className="mt-1 font-semibold text-[#1f2937]">{row.summary}</p>
                  <p className="text-xs text-[#6a6a6a]">By {row.access_users?.full_name ?? "System"}</p>
                  {row.activity_type === "add_tracking_number" && ((row.details?.tracking_number as string | undefined) || row.summary.includes(":")) ? (
                    <a
                      href={buildTrackingUrl((row.details?.tracking_number as string | undefined) ?? row.summary.split(":").slice(1).join(":").trim())}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 inline-flex text-xs font-semibold text-[#b20610] underline"
                    >
                      Track package
                    </a>
                  ) : null}
                  {row.details && row.activity_type !== "add_tracking_number" ? (
                    <div className="mt-1 rounded bg-[#f8fafc] px-2 py-1 text-xs text-[#475569]">
                      {Object.entries(row.details)
                        .filter(([, value]) => value != null && value !== "")
                        .map(([key, value]) => `${key.replaceAll("_", " ")}: ${String(value)}`)
                        .join(" | ")}
                    </div>
                  ) : null}
                </div>
              ))}
              {activityRows.length === 0 ? (
                <p className="rounded-md border border-[#edf0f4] bg-[#fafbfc] p-3 text-sm text-[#64748b]">No timeline events yet.</p>
              ) : null}

              {activityRows.length > 5 ? (
                <div className="pt-1 text-right">
                  <Link
                    href={showAllTimeline ? `/cases/${id}` : `/cases/${id}?timeline=all`}
                    className="inline-flex text-xs font-semibold text-[#b20610] underline"
                  >
                    {showAllTimeline ? "Show Less" : "View All"}
                  </Link>
                </div>
              ) : null}
            </div>
          </div>

          <div className="rounded-lg border border-[#edf0f4] bg-[#fafbfc] p-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-[#64748b]">Internal Notes</h3>
              <span className="text-xs text-[#64748b]">Right-side conversation</span>
            </div>
            <p className="mt-2 text-sm text-[#5a5a5a]">Log follow-ups, status updates, and customer communication here. Each note stamps the date, time, and author.</p>

            <form action={addNoteAction} className="mt-3 rounded-md border border-[#edf0f4] bg-white p-3">
              <input type="hidden" name="case_id" value={id} />
              <input type="hidden" name="note_type" value="internal" />
              <label htmlFor="timeline_internal_note" className="label">Add Internal Note</label>
              <textarea
                id="timeline_internal_note"
                name="content"
                rows={4}
                required
                className="textarea"
                placeholder="Example: Waiting on customer to get back to me"
              />
              <div className="mt-2 flex justify-end">
                <button type="submit" className="btn-primary">Save Note</button>
              </div>
            </form>

            <div className="mt-3 space-y-2">
              {internalNotes.map((note) => (
                <div key={note.id} className="rounded-md border border-[#ececec] bg-white p-3 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-semibold text-[#1f2937]">{note.access_users?.full_name ?? "Unknown"}</p>
                    <span className="text-xs text-[#6a6a6a]">{new Date(note.created_at).toLocaleString()}</span>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap text-[#334155]">{note.content}</p>
                </div>
              ))}
              {internalNotes.length === 0 ? (
                <p className="rounded-md border border-[#edf0f4] bg-white p-3 text-sm text-[#64748b]">No internal notes yet.</p>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <section className="card border border-[#f1d5d7] bg-[#fff8f8] p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-[#121826]">Delete this case</h2>
            <p className="mt-1 text-sm text-[#5a5a5a]">This permanently removes the case and its uploaded files. Only the original creator can delete it.</p>
          </div>
          <DeleteCaseButton caseId={id} />
        </div>
      </section>
    </div>
  );
}
