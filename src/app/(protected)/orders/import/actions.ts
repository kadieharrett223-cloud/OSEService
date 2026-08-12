"use server";

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";

const execFileAsync = promisify(execFile);
const IMPORTS_DIR = path.join(process.cwd(), "imports", "backlog");
const REPORTS_DIR = path.join(process.cwd(), "tmp", "import-reports");
const PENDING_IMPORTS_DIR = path.join(REPORTS_DIR, "pending");

type PendingDuplicateEntry = {
  invoiceNumber: string;
  importedCustomerNames: string[];
  existingOrders: Array<{
    id: string;
    orderNumber: string | null;
    reviewStatus: string | null;
    customerName: string | null;
    createdAt: string | null;
  }>;
};

type PendingImportSession = {
  stagedPath: string;
  mode: "apply";
  duplicates: PendingDuplicateEntry[];
};

type ExistingShippingOrderRow = {
  id: string;
  order_number: string | null;
  review_status: string | null;
  legacy_customer_name: string | null;
  created_at: string | null;
};

function sanitizeFileSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function timestampSegment() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getReportFileName(mode: "preview" | "apply") {
  return `backlog-bulk-${mode}-${timestampSegment()}-${crypto.randomUUID()}.json`;
}

async function ensureDir(dirPath: string) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function loadTableColumnSet(tableName: string, candidates: string[]) {
  const supabase = getSupabaseAdmin();
  const columns = new Set<string>();

  for (const column of candidates) {
    const { error } = await supabase.from(tableName).select(column).limit(1);
    if (!error) {
      columns.add(column);
    }
  }

  return columns;
}

function isPathInside(parentPath: string, childPath: string) {
  const relative = path.relative(parentPath, childPath);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function resolvePayloadText(formData: FormData) {
  const rawJson = getString(formData, "raw_json");
  if (rawJson) {
    return {
      payloadText: rawJson,
      sourceLabel: "pasted-json.json",
    };
  }

  const upload = formData.get("payload_file");
  if (!(upload instanceof File) || upload.size === 0) {
    redirect("/orders/import?error=Upload+a+JSON+file+or+paste+raw+JSON");
  }

  const fileName = upload.name || "backlog.json";
  if (!fileName.toLowerCase().endsWith(".json")) {
    redirect("/orders/import?error=Only+JSON+files+are+supported");
  }

  return {
    payloadText: await upload.text(),
    sourceLabel: sanitizeFileSegment(fileName),
  };
}

async function stagePayload(sourceLabel: string, payloadText: string) {
  await ensureDir(IMPORTS_DIR);
  const stagedFileName = `backlog-${timestampSegment()}-${crypto.randomUUID()}-${sourceLabel}`;
  const stagedPath = path.join(IMPORTS_DIR, stagedFileName);
  await fs.writeFile(stagedPath, payloadText, "utf8");
  return stagedPath;
}

function normalizeInvoiceNumber(value: unknown) {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : null;
}

async function detectExistingInvoiceDuplicates(payloadText: string) {
  const parsed = JSON.parse(payloadText);
  if (!Array.isArray(parsed)) {
    redirect("/orders/import?error=Bulk+upload+JSON+must+be+an+array+of+records");
  }

  const invoiceMap = new Map<string, Set<string>>();
  for (const record of parsed) {
    const invoiceNumber = normalizeInvoiceNumber(record?.invoiceNumber);
    if (!invoiceNumber) continue;

    const customerName = String(record?.customerName ?? "").trim() || "Unknown customer";
    if (!invoiceMap.has(invoiceNumber)) {
      invoiceMap.set(invoiceNumber, new Set());
    }
    invoiceMap.get(invoiceNumber)?.add(customerName);
  }

  const invoiceNumbers = Array.from(invoiceMap.keys());
  if (invoiceNumbers.length === 0) {
    return [];
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("shipping_orders")
    .select("id, order_number, review_status, legacy_customer_name, created_at")
    .in("order_number", invoiceNumbers);

  if (error) {
    redirect(`/orders/import?error=${encodeURIComponent(error.message)}`);
  }

  const existingByInvoice = new Map<string, PendingDuplicateEntry["existingOrders"]>();
  const existingRows = (data ?? []) as unknown as ExistingShippingOrderRow[];
  for (const row of existingRows) {
    const invoiceNumber = normalizeInvoiceNumber(row.order_number);
    if (!invoiceNumber) continue;
    const existingOrders = existingByInvoice.get(invoiceNumber) ?? [];
    existingOrders.push({
      id: row.id,
      orderNumber: row.order_number,
      reviewStatus: row.review_status,
      customerName: row.legacy_customer_name,
      createdAt: row.created_at,
    });
    existingByInvoice.set(invoiceNumber, existingOrders);
  }

  return Array.from(existingByInvoice.entries()).map(([invoiceNumber, existingOrders]) => ({
    invoiceNumber,
    importedCustomerNames: Array.from(invoiceMap.get(invoiceNumber) ?? []),
    existingOrders,
  }));
}

async function writePendingImportSession(session: PendingImportSession) {
  await ensureDir(PENDING_IMPORTS_DIR);
  const fileName = `pending-backlog-${timestampSegment()}-${crypto.randomUUID()}.json`;
  await fs.writeFile(path.join(PENDING_IMPORTS_DIR, fileName), `${JSON.stringify(session, null, 2)}\n`, "utf8");
  return fileName;
}

async function loadPendingImportSession(token: string) {
  const safeToken = path.basename(token);
  if (safeToken !== token) {
    redirect("/orders/import?error=Invalid+pending+import+token");
  }

  const filePath = path.join(PENDING_IMPORTS_DIR, safeToken);
  if (!isPathInside(PENDING_IMPORTS_DIR, filePath)) {
    redirect("/orders/import?error=Invalid+pending+import+path");
  }

  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as PendingImportSession;
  } catch {
    redirect("/orders/import?error=Pending+import+session+not+found");
  }
}

async function filterPayloadBySkippedInvoices(stagedPath: string, skippedInvoices: string[]) {
  const raw = await fs.readFile(stagedPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    redirect("/orders/import?error=Pending+payload+is+not+a+JSON+array");
  }

  const skipSet = new Set(skippedInvoices.map((invoiceNumber) => invoiceNumber.trim()).filter(Boolean));
  if (skipSet.size === 0) {
    return raw;
  }

  const filtered = parsed.filter((record) => {
    const invoiceNumber = normalizeInvoiceNumber(record?.invoiceNumber);
    return !invoiceNumber || !skipSet.has(invoiceNumber);
  });

  return `${JSON.stringify(filtered, null, 2)}\n`;
}

async function runImporter({ stagedPath, mode }: { stagedPath: string; mode: "preview" | "apply" }) {
  await ensureDir(REPORTS_DIR);
  const previewReportName = getReportFileName("preview");
  const previewReportPath = path.join(REPORTS_DIR, previewReportName);

  try {
    const args = ["scripts/import-old-erp-backlog.mjs", "--input", stagedPath, "--report-out", previewReportPath];
    if (mode === "apply") {
      args.push("--apply");
    }

    await execFileAsync(process.execPath, args, {
      cwd: process.cwd(),
      env: process.env,
      maxBuffer: 1024 * 1024 * 8,
    });
  } catch (error) {
    const stderr = typeof error === "object" && error !== null && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr ?? "")
      : "";
    const stdout = typeof error === "object" && error !== null && "stdout" in error
      ? String((error as { stdout?: unknown }).stdout ?? "")
      : "";
    const message = stderr || stdout || (error instanceof Error ? error.message : "Bulk import failed");
    redirect(`/orders/import?error=${encodeURIComponent(message.slice(0, 400))}`);
  }

  return mode === "apply"
    ? previewReportName.replace("preview", "apply")
    : previewReportName;
}

export async function bulkImportOrdersAction(formData: FormData) {
  await requireUser();

  const mode = getString(formData, "mode") === "apply" ? "apply" : "preview";
  const pendingToken = getString(formData, "pending_token");

  if (pendingToken) {
    const pendingSession = await loadPendingImportSession(pendingToken);
    if (!isPathInside(IMPORTS_DIR, pendingSession.stagedPath)) {
      redirect("/orders/import?error=Pending+payload+path+is+invalid");
    }

    const duplicateStrategy = getString(formData, "duplicate_strategy") === "skip" ? "skip" : "proceed";
    const stagedPath = duplicateStrategy === "skip"
      ? await stagePayload(
        "filtered-duplicates.json",
        await filterPayloadBySkippedInvoices(
          pendingSession.stagedPath,
          formData.getAll("skip_invoice_numbers").map((value) => String(value)),
        ),
      )
      : pendingSession.stagedPath;

    const reportName = await runImporter({ stagedPath, mode: pendingSession.mode });

    revalidatePath("/orders");
    revalidatePath("/orders/import");
    redirect(`/orders/import?mode=${pendingSession.mode}&report=${encodeURIComponent(reportName)}&message=${encodeURIComponent("Import applied")}`);
  }

  const { payloadText, sourceLabel } = await resolvePayloadText(formData);

  try {
    JSON.parse(payloadText);
  } catch {
    redirect("/orders/import?error=Uploaded+content+is+not+valid+JSON");
  }

  if (mode === "apply") {
    const duplicates = await detectExistingInvoiceDuplicates(payloadText);
    if (duplicates.length > 0) {
      const stagedPathForReview = await stagePayload(sourceLabel, payloadText);
      const pendingTokenValue = await writePendingImportSession({
        stagedPath: stagedPathForReview,
        mode,
        duplicates,
      });
      redirect(`/orders/import?pending=${encodeURIComponent(pendingTokenValue)}&message=${encodeURIComponent("Duplicate invoices found. Review before applying import.")}`);
    }
  }

  const stagedPath = await stagePayload(sourceLabel, payloadText);
  const reportName = await runImporter({ stagedPath, mode });

  revalidatePath("/orders");
  revalidatePath("/orders/import");
  redirect(`/orders/import?mode=${mode}&report=${encodeURIComponent(reportName)}&message=${encodeURIComponent(mode === "apply" ? "Import applied" : "Preview generated")}`);
}