"use server";

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";

const execFileAsync = promisify(execFile);
const IMPORTS_DIR = path.join(process.cwd(), "imports", "backlog");
const REPORTS_DIR = path.join(process.cwd(), "tmp", "import-reports");

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

async function resolvePayloadText(formData: FormData) {
  const rawJson = getString(formData, "raw_json");
  if (rawJson) {
    return {
      payloadText: rawJson,
      sourceLabel: "pasted-json",
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

export async function bulkImportOrdersAction(formData: FormData) {
  await requireUser();

  const mode = getString(formData, "mode") === "apply" ? "apply" : "preview";
  const { payloadText, sourceLabel } = await resolvePayloadText(formData);

  try {
    JSON.parse(payloadText);
  } catch {
    redirect("/orders/import?error=Uploaded+content+is+not+valid+JSON");
  }

  await ensureDir(REPORTS_DIR);
  const stagedPath = await stagePayload(sourceLabel, payloadText);
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

  const reportName = mode === "apply"
    ? previewReportName.replace("preview", "apply")
    : previewReportName;

  revalidatePath("/orders");
  revalidatePath("/orders/import");
  redirect(`/orders/import?mode=${mode}&report=${encodeURIComponent(reportName)}&message=${encodeURIComponent(mode === "apply" ? "Import applied" : "Preview generated")}`);
}