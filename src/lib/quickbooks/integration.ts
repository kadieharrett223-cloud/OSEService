import crypto from "node:crypto";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

type QboEnvironment = "sandbox" | "production";

type ConnectionRow = {
  id: string;
  realm_id: string;
  environment: QboEnvironment;
  status: "connected" | "disconnected" | "error";
  encrypted_access_token: string | null;
  encrypted_refresh_token: string | null;
  access_token_expires_at: string | null;
  refresh_token_expires_at: string | null;
  last_sync_at: string | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
  updated_at: string;
};

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in?: number;
};

const QUICKBOOKS_AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
const QUICKBOOKS_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

function readEnv(name: string) {
  const raw = String(process.env[name] ?? "").trim();
  if (!raw) return "";

  // Accept values pasted with wrapping quotes in hosting UIs.
  if (
    (raw.startsWith('"') && raw.endsWith('"'))
    || (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1).trim();
  }

  return raw;
}

function getQuickbooksEnvironment(): QboEnvironment {
  return readEnv("QUICKBOOKS_ENV") === "production" ? "production" : "sandbox";
}

function getQuickbooksCredentials() {
  const clientId = readEnv("QUICKBOOKS_CLIENT_ID");
  const clientSecret = readEnv("QUICKBOOKS_CLIENT_SECRET");
  const scope = readEnv("QUICKBOOKS_SCOPE") || "com.intuit.quickbooks.accounting";

  if (!clientId || !clientSecret) {
    return null;
  }

  return {
    clientId,
    clientSecret,
    scope,
    environment: getQuickbooksEnvironment(),
  };
}

function getQuickbooksRedirectUri(origin: string) {
  const configured = readEnv("QUICKBOOKS_REDIRECT_URI");
  return configured || `${origin}/api/integrations/quickbooks/callback`;
}

function getQuickbooksApiBase(environment: QboEnvironment) {
  return environment === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";
}

function getEncryptionKey() {
  const secret = readEnv("QUICKBOOKS_TOKEN_ENCRYPTION_KEY") || readEnv("APP_SESSION_SECRET");

  if (!secret) {
    throw new Error("Missing QUICKBOOKS_TOKEN_ENCRYPTION_KEY or APP_SESSION_SECRET for token encryption.");
  }

  return crypto.createHash("sha256").update(secret).digest();
}

function encryptToken(value: string) {
  const iv = crypto.randomBytes(12);
  const key = getEncryptionKey();
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

function decryptToken(payload: string) {
  const [ivB64, tagB64, dataB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Invalid encrypted token payload.");
  }

  const key = getEncryptionKey();
  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  const encrypted = Buffer.from(dataB64, "base64url");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}

function parseTokenExpiry(seconds: number | undefined) {
  if (!seconds || Number.isNaN(seconds)) return null;
  return new Date(Date.now() + seconds * 1000).toISOString();
}

async function requestTokens(params: URLSearchParams, clientId: string, clientSecret: string) {
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const response = await fetch(QUICKBOOKS_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const payload = await response.json() as TokenResponse | { error_description?: string; error?: string };

  if (!response.ok) {
    const message = "error_description" in payload
      ? payload.error_description
      : "error" in payload
        ? payload.error
        : "Unable to complete QuickBooks token request.";
    throw new Error(message ?? "Unable to complete QuickBooks token request.");
  }

  return payload as TokenResponse;
}

async function exchangeAuthorizationCode(code: string, redirectUri: string, clientId: string, clientSecret: string) {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });

  return requestTokens(params, clientId, clientSecret);
}

async function refreshAccessToken(refreshToken: string, clientId: string, clientSecret: string) {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  return requestTokens(params, clientId, clientSecret);
}

function formatAddress(address: Record<string, unknown> | null | undefined) {
  if (!address || typeof address !== "object") return null;

  const asText = [
    address.Line1,
    address.Line2,
    address.Line3,
    [address.City, address.CountrySubDivisionCode, address.PostalCode].filter(Boolean).join(" "),
    address.Country,
  ]
    .filter((line): line is string => typeof line === "string" && line.trim().length > 0)
    .map((line) => line.trim());

  if (asText.length === 0) return null;
  return asText.join(", ");
}

function getPaymentStatus(invoice: Record<string, unknown>) {
  const total = Number(invoice.TotalAmt ?? 0);
  const balance = Number(invoice.Balance ?? total);

  if (!Number.isFinite(total) || !Number.isFinite(balance)) {
    return null;
  }

  if (balance <= 0) return "Paid";
  if (balance >= total) return "Unpaid";
  return "Partially Paid";
}

export function getQuickbooksConnectUrl(origin: string, state: string) {
  const config = getQuickbooksCredentials();

  if (!config) {
    throw new Error("QuickBooks credentials are not configured.");
  }

  const redirectUri = getQuickbooksRedirectUri(origin);
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: config.scope,
    state,
  });

  return `${QUICKBOOKS_AUTH_URL}?${params.toString()}`;
}

export async function connectQuickbooksFromCallback(options: {
  code: string;
  realmId: string;
  origin: string;
  connectedBy: string;
}) {
  const config = getQuickbooksCredentials();
  if (!config) {
    throw new Error("QuickBooks credentials are not configured.");
  }

  const supabase = getSupabaseAdmin();
  const redirectUri = getQuickbooksRedirectUri(options.origin);
  const tokenPayload = await exchangeAuthorizationCode(
    options.code,
    redirectUri,
    config.clientId,
    config.clientSecret,
  );

  await supabase
    .from("quickbooks_connections")
    .update({
      status: "disconnected",
    })
    .eq("status", "connected");

  const { error } = await supabase
    .from("quickbooks_connections")
    .upsert({
      realm_id: options.realmId,
      environment: config.environment,
      status: "connected",
      encrypted_access_token: encryptToken(tokenPayload.access_token),
      encrypted_refresh_token: encryptToken(tokenPayload.refresh_token),
      access_token_expires_at: parseTokenExpiry(tokenPayload.expires_in),
      refresh_token_expires_at: parseTokenExpiry(tokenPayload.x_refresh_token_expires_in),
      connected_by: options.connectedBy,
      last_sync_error: null,
    }, {
      onConflict: "realm_id",
    });

  if (error) {
    throw new Error(error.message);
  }
}

export async function getQuickbooksConnectionStatus() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("quickbooks_connections")
    .select("id, realm_id, environment, status, last_sync_at, last_sync_status, last_sync_error, updated_at")
    .eq("status", "connected")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    connection: (data as ConnectionRow | null) ?? null,
    error,
  };
}

export async function disconnectQuickbooksConnection() {
  const supabase = getSupabaseAdmin();

  const { error } = await supabase
    .from("quickbooks_connections")
    .update({
      status: "disconnected",
      encrypted_access_token: null,
      encrypted_refresh_token: null,
      access_token_expires_at: null,
      refresh_token_expires_at: null,
      last_sync_error: null,
    })
    .eq("status", "connected");

  if (error) {
    throw new Error(error.message);
  }
}

async function loadConnectionForSync() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("quickbooks_connections")
    .select("id, realm_id, environment, status, encrypted_access_token, encrypted_refresh_token, access_token_expires_at")
    .eq("status", "connected")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (!data) {
    throw new Error("QuickBooks is not connected yet.");
  }

  return data as Pick<ConnectionRow, "id" | "realm_id" | "environment" | "status" | "encrypted_access_token" | "encrypted_refresh_token" | "access_token_expires_at">;
}

async function persistRefreshedTokens(connectionId: string, tokenPayload: TokenResponse) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("quickbooks_connections")
    .update({
      encrypted_access_token: encryptToken(tokenPayload.access_token),
      encrypted_refresh_token: encryptToken(tokenPayload.refresh_token),
      access_token_expires_at: parseTokenExpiry(tokenPayload.expires_in),
      refresh_token_expires_at: parseTokenExpiry(tokenPayload.x_refresh_token_expires_in),
      status: "connected",
      last_sync_error: null,
    })
    .eq("id", connectionId);

  if (error) {
    throw new Error(error.message);
  }
}

async function ensureAccessToken(connection: Awaited<ReturnType<typeof loadConnectionForSync>>) {
  const config = getQuickbooksCredentials();
  if (!config) {
    throw new Error("QuickBooks credentials are not configured.");
  }

  const encryptedAccess = connection.encrypted_access_token;
  const encryptedRefresh = connection.encrypted_refresh_token;

  if (!encryptedAccess || !encryptedRefresh) {
    throw new Error("QuickBooks connection tokens are missing. Reconnect QuickBooks.");
  }

  let accessToken = decryptToken(encryptedAccess);
  const refreshToken = decryptToken(encryptedRefresh);
  const expiresAt = connection.access_token_expires_at ? Date.parse(connection.access_token_expires_at) : NaN;
  const isExpired = Number.isNaN(expiresAt) || expiresAt - Date.now() < 60_000;

  if (isExpired) {
    const refreshed = await refreshAccessToken(refreshToken, config.clientId, config.clientSecret);
    await persistRefreshedTokens(connection.id, refreshed);
    accessToken = refreshed.access_token;
  }

  return accessToken;
}

async function syncQuickbooksSnapshots(connection: Awaited<ReturnType<typeof loadConnectionForSync>>, accessToken: string) {
  const supabase = getSupabaseAdmin();
  const apiBase = getQuickbooksApiBase(connection.environment);
  const qboQuery = "select * from Invoice startposition 1 maxresults 200";

  const response = await fetch(
    `${apiBase}/v3/company/${encodeURIComponent(connection.realm_id)}/query?query=${encodeURIComponent(qboQuery)}&minorversion=75`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      cache: "no-store",
    },
  );

  const payload = await response.json() as Record<string, unknown>;

  if (!response.ok) {
    const fault = payload.Fault as Record<string, unknown> | undefined;
    const errors = fault?.Error as Array<Record<string, unknown>> | undefined;
    const detail = errors?.[0]?.Detail;
    throw new Error(typeof detail === "string" ? detail : "QuickBooks sync failed.");
  }

  const queryResponse = payload.QueryResponse as Record<string, unknown> | undefined;
  const invoices = (queryResponse?.Invoice as Array<Record<string, unknown>> | undefined) ?? [];

  const customerMap = new Map<string, { full_name: string; company_name: string | null; quickbooks_customer_id: string }>();

  const invoiceRows = invoices
    .map((invoice) => {
      const invoiceId = String(invoice.Id ?? "").trim();
      if (!invoiceId) return null;

      const customerRef = invoice.CustomerRef as Record<string, unknown> | undefined;
      const customerId = typeof customerRef?.value === "string" ? customerRef.value : null;
      const customerName = typeof customerRef?.name === "string" ? customerRef.name : null;

      if (customerId) {
        customerMap.set(customerId, {
          full_name: customerName ?? `QuickBooks Customer ${customerId}`,
          company_name: customerName,
          quickbooks_customer_id: customerId,
        });
      }

      const total = Number(invoice.TotalAmt ?? 0);

      return {
        quickbooks_invoice_id: invoiceId,
        quickbooks_customer_id: customerId,
        invoice_number: String(invoice.DocNumber ?? invoiceId),
        invoice_date: typeof invoice.TxnDate === "string" ? invoice.TxnDate : null,
        invoice_total: Number.isFinite(total) ? total : null,
        payment_status: getPaymentStatus(invoice),
        billing_address: formatAddress(invoice.BillAddr as Record<string, unknown> | undefined),
        shipping_address: formatAddress(invoice.ShipAddr as Record<string, unknown> | undefined),
        raw_payload: invoice as unknown as Json,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  const customerRows = Array.from(customerMap.values());

  if (customerRows.length > 0) {
    const { error: customerError } = await supabase
      .from("customers")
      .upsert(customerRows, { onConflict: "quickbooks_customer_id" });

    if (customerError) {
      throw new Error(customerError.message);
    }
  }

  if (invoiceRows.length > 0) {
    const { error: invoiceError } = await supabase
      .from("quickbooks_invoices")
      .upsert(invoiceRows, { onConflict: "quickbooks_invoice_id" });

    if (invoiceError) {
      throw new Error(invoiceError.message);
    }
  }

  return {
    invoiceCount: invoiceRows.length,
    customerCount: customerRows.length,
  };
}

export async function syncQuickbooksInvoices() {
  const supabase = getSupabaseAdmin();
  const connection = await loadConnectionForSync();

  try {
    const accessToken = await ensureAccessToken(connection);
    const result = await syncQuickbooksSnapshots(connection, accessToken);

    const { error } = await supabase
      .from("quickbooks_connections")
      .update({
        last_sync_at: new Date().toISOString(),
        last_sync_status: "success",
        last_sync_error: null,
      })
      .eq("id", connection.id);

    if (error) {
      throw new Error(error.message);
    }

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "QuickBooks sync failed.";

    await supabase
      .from("quickbooks_connections")
      .update({
        last_sync_at: new Date().toISOString(),
        last_sync_status: "failed",
        last_sync_error: message,
      })
      .eq("id", connection.id);

    throw error;
  }
}

export function describeQuickbooksConfig() {
  const hasCredentials = Boolean(readEnv("QUICKBOOKS_CLIENT_ID") && readEnv("QUICKBOOKS_CLIENT_SECRET"));
  const configuredRedirectUri = readEnv("QUICKBOOKS_REDIRECT_URI");

  return {
    hasCredentials,
    environment: getQuickbooksEnvironment(),
    configuredRedirectUri,
  };
}
