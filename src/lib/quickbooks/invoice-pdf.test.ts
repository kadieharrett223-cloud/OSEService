import crypto from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ db: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ getSupabaseAdmin: mock.db }));
import { downloadQuickbooksInvoicePdf } from "./integration";

function encrypted(value: string) {
  const iv = Buffer.alloc(12, 1);
  const cipher = crypto.createCipheriv("aes-256-gcm", crypto.createHash("sha256").update("synthetic-test-key").digest(), iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${data.toString("base64url")}`;
}
beforeEach(() => {
  vi.stubEnv("QUICKBOOKS_CLIENT_ID", "synthetic-client");
  vi.stubEnv("QUICKBOOKS_CLIENT_SECRET", "synthetic-secret");
  vi.stubEnv("QUICKBOOKS_TOKEN_ENCRYPTION_KEY", "synthetic-test-key");
  const chain = { select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
    maybeSingle: async () => ({ data: { realm_id: "synthetic-company", environment: "sandbox", encrypted_access_token: encrypted("synthetic-access"), encrypted_refresh_token: encrypted("synthetic-refresh"), access_token_expires_at: new Date(Date.now() + 3600_000).toISOString() }, error: null }) };
  mock.db.mockReturnValue({ from: () => chain });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("fetches the PDF with a GET to the exact linked transaction without running a sync", async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response("%PDF-1.4 synthetic", { headers: { "Content-Type": "application/pdf" } }));
  vi.stubGlobal("fetch", fetcher);
  expect(new TextDecoder().decode(await downloadQuickbooksInvoicePdf("20613"))).toBe("%PDF-1.4 synthetic");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][0]).toBe("https://sandbox-quickbooks.api.intuit.com/v3/company/synthetic-company/invoice/20613/pdf");
  expect(fetcher.mock.calls[0][1]).toMatchObject({ cache: "no-store", headers: { Accept: "application/pdf", Authorization: "Bearer synthetic-access" } });
});
it("rejects successful upstream error pages instead of serving them as invoice PDFs", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>Login</html>")));
  await expect(downloadQuickbooksInvoicePdf("20613")).rejects.toThrow("valid invoice PDF");
});
it("does not request a document for an invalid transaction identity", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(downloadQuickbooksInvoicePdf("../other")).rejects.toThrow("identity");
  expect(fetcher).not.toHaveBeenCalled();
});
