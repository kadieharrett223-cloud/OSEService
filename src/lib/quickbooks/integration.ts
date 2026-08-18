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

type QuickbooksApiPayload = Record<string, unknown>;

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
  const configuredScope = readEnv("QUICKBOOKS_SCOPE");

  // Accept either comma-delimited or space-delimited scope configuration.
  const normalizedScope = configuredScope
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .join(" ");

  // Keep default scope conservative for production compatibility.
  const scope = normalizedScope || "com.intuit.quickbooks.accounting";

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

function parseQuickbooksFault(payload: QuickbooksApiPayload | null, fallback: string) {
  if (!payload || typeof payload !== "object") {
    return fallback;
  }

  const fault = payload.Fault as Record<string, unknown> | undefined;
  const errors = fault?.Error as Array<Record<string, unknown>> | undefined;
  const first = errors?.[0];

  const code = typeof first?.code === "string" ? first.code : "";
  const detail = typeof first?.Detail === "string" ? first.Detail : "";
  const message = typeof first?.Message === "string" ? first.Message : "";
  const fallbackMessage = typeof payload.message === "string" ? payload.message : "";

  const summary = detail || message || fallbackMessage || fallback;
  return code ? `${summary} (code ${code})` : summary;
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

async function fetchQuickbooksQuery(options: {
  apiBase: string;
  realmId: string;
  accessToken: string;
  query: string;
}) {
  const response = await fetch(
    `${options.apiBase}/v3/company/${encodeURIComponent(options.realmId)}/query?query=${encodeURIComponent(options.query)}&minorversion=75`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${options.accessToken}`,
      },
      cache: "no-store",
    },
  );

  let payload: QuickbooksApiPayload | null = null;

  try {
    payload = await response.json() as QuickbooksApiPayload;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new Error(parseQuickbooksFault(payload, `QuickBooks request failed with status ${response.status}.`));
  }

  return payload ?? {};
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
    address.Line4,
    address.Line5,
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
    prompt: "consent",
  });

  return `${QUICKBOOKS_AUTH_URL}?${params.toString()}`;
}

export async function connectQuickbooksFromCallback(options: {
  code: string;
  realmId: string;
  origin: string;
  connectedBy: string | null;
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

  let connectedByUserId: string | null = options.connectedBy;

  if (connectedByUserId) {
    const { data: accessUser, error: accessUserError } = await supabase
      .from("access_users")
      .select("id")
      .eq("id", connectedByUserId)
      .maybeSingle();

    if (accessUserError) {
      throw new Error(accessUserError.message);
    }

    if (!accessUser?.id) {
      connectedByUserId = null;
    }
  }

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
      connected_by: connectedByUserId,
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

  try {
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
  } catch {
    return {
      connection: null,
      error: null,
    };
  }
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
  const pageSize = 200;
  const maxPages = 50;
  const invoices: Array<Record<string, unknown>> = [];

  for (let page = 0; page < maxPages; page += 1) {
    const startPosition = page * pageSize + 1;
    const qboQuery = `select * from Invoice startposition ${startPosition} maxresults ${pageSize}`;

    const payload = await fetchQuickbooksQuery({
      apiBase,
      realmId: connection.realm_id,
      accessToken,
      query: qboQuery,
    });

    const queryResponse = payload.QueryResponse as Record<string, unknown> | undefined;
    const batch = (queryResponse?.Invoice as Array<Record<string, unknown>> | undefined) ?? [];
    invoices.push(...batch);

    if (batch.length < pageSize) {
      break;
    }
  }

  const customerMap = new Map<string, {
    full_name: string;
    company_name: string | null;
    quickbooks_customer_id: string;
    phone: string | null;
    email: string | null;
    shipping_address: string | null;
  }>();

  const customers: Array<Record<string, unknown>> = [];

  for (let page = 0; page < maxPages; page += 1) {
    const startPosition = page * pageSize + 1;
    const qboQuery = `select * from Customer startposition ${startPosition} maxresults ${pageSize}`;

    const payload = await fetchQuickbooksQuery({
      apiBase,
      realmId: connection.realm_id,
      accessToken,
      query: qboQuery,
    });

    const queryResponse = payload.QueryResponse as Record<string, unknown> | undefined;
    const batch = (queryResponse?.Customer as Array<Record<string, unknown>> | undefined) ?? [];
    customers.push(...batch);

    if (batch.length < pageSize) {
      break;
    }
  }

  for (const customer of customers) {
    const customerId = String(customer.Id ?? "").trim();
    if (!customerId) continue;

    const displayName = typeof customer.DisplayName === "string" ? customer.DisplayName.trim() : "";
    const companyName = typeof customer.CompanyName === "string" ? customer.CompanyName.trim() : "";
    const primaryPhone = customer.PrimaryPhone as Record<string, unknown> | undefined;
    const mobilePhone = customer.Mobile as Record<string, unknown> | undefined;
    const primaryEmail = customer.PrimaryEmailAddr as Record<string, unknown> | undefined;

    customerMap.set(customerId, {
      quickbooks_customer_id: customerId,
      full_name: displayName || companyName || `QuickBooks Customer ${customerId}`,
      company_name: companyName || displayName || null,
      phone: typeof primaryPhone?.FreeFormNumber === "string"
        ? primaryPhone.FreeFormNumber
        : typeof mobilePhone?.FreeFormNumber === "string"
          ? mobilePhone.FreeFormNumber
          : null,
      email: typeof primaryEmail?.Address === "string" ? primaryEmail.Address : null,
      shipping_address: formatAddress(customer.ShipAddr as Record<string, unknown> | undefined)
        ?? formatAddress(customer.BillAddr as Record<string, unknown> | undefined),
    });
  }

  const invoiceRows = invoices
    .map((invoice) => {
      const invoiceId = String(invoice.Id ?? "").trim();
      if (!invoiceId) return null;

      const customerRef = invoice.CustomerRef as Record<string, unknown> | undefined;
      const customerId = typeof customerRef?.value === "string" ? customerRef.value : null;
      const customerName = typeof customerRef?.name === "string" ? customerRef.name : null;

      if (customerId) {
        const existing = customerMap.get(customerId);
        customerMap.set(customerId, {
          quickbooks_customer_id: customerId,
          full_name: existing?.full_name ?? customerName ?? `QuickBooks Customer ${customerId}`,
          company_name: existing?.company_name ?? customerName,
          phone: existing?.phone ?? null,
          email: existing?.email ?? null,
          shipping_address: existing?.shipping_address ?? null,
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

  const qboInvoiceRows = invoices
    .map((invoice) => {
      const invoiceId = String(invoice.Id ?? "").trim();
      if (!invoiceId) return null;

      const customerRef = invoice.CustomerRef as Record<string, unknown> | undefined;
      const customerId = typeof customerRef?.value === "string" ? customerRef.value : null;
      const total = Number(invoice.TotalAmt ?? 0);

      return {
        qbo_invoice_id: invoiceId,
        quickbooks_customer_id: customerId,
        invoice_number: String(invoice.DocNumber ?? invoiceId),
        invoice_date: typeof invoice.TxnDate === "string" ? invoice.TxnDate : null,
        total_amount: Number.isFinite(total) ? total : null,
        payment_status: getPaymentStatus(invoice) ?? "Pending",
        raw_payload: invoice as unknown as Json,
        sync_status: "Imported",
        imported_at: new Date().toISOString(),
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  const customerRows = Array.from(customerMap.values());

  if (customerRows.length > 0) {
    for (let i = 0; i < customerRows.length; i += 500) {
      const chunk = customerRows.slice(i, i + 500);
      const { error: customerError } = await supabase
        .from("customers")
        .upsert(chunk, { onConflict: "quickbooks_customer_id" });

      if (customerError) {
        throw new Error(customerError.message);
      }
    }
  }

  if (invoiceRows.length > 0) {
    for (let i = 0; i < invoiceRows.length; i += 500) {
      const chunk = invoiceRows.slice(i, i + 500);
      const { error: invoiceError } = await supabase
        .from("quickbooks_invoices")
        .upsert(chunk, { onConflict: "quickbooks_invoice_id" });

      if (invoiceError) {
        throw new Error(invoiceError.message);
      }
    }
  }

  const customerIds = Array.from(new Set(
    qboInvoiceRows
      .map((row) => row.quickbooks_customer_id)
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  ));

  const customerIdMap = new Map<string, string>();
  if (customerIds.length > 0) {
    for (let i = 0; i < customerIds.length; i += 500) {
      const chunk = customerIds.slice(i, i + 500);
      const { data: customerMatches, error: customerMatchError } = await supabase
        .from("customers")
        .select("id, quickbooks_customer_id")
        .in("quickbooks_customer_id", chunk);

      if (customerMatchError) {
        throw new Error(customerMatchError.message);
      }

      for (const customer of customerMatches ?? []) {
        if (customer.quickbooks_customer_id) {
          customerIdMap.set(customer.quickbooks_customer_id, customer.id);
        }
      }
    }
  }

  const qboInvoicesForUpsert = qboInvoiceRows.map((row) => ({
    qbo_invoice_id: row.qbo_invoice_id,
    customer_id: row.quickbooks_customer_id ? customerIdMap.get(row.quickbooks_customer_id) ?? null : null,
    invoice_number: row.invoice_number,
    invoice_date: row.invoice_date,
    payment_status: row.payment_status,
    total_amount: row.total_amount,
    raw_payload: row.raw_payload,
    sync_status: row.sync_status,
    imported_at: row.imported_at,
  }));

  if (qboInvoicesForUpsert.length > 0) {
    for (let i = 0; i < qboInvoicesForUpsert.length; i += 500) {
      const chunk = qboInvoicesForUpsert.slice(i, i + 500);
      const { error: qboInvoiceError } = await supabase
        .from("qbo_invoices")
        .upsert(chunk, { onConflict: "qbo_invoice_id" });

      if (qboInvoiceError) {
        throw new Error(qboInvoiceError.message);
      }
    }
  }

  const qboInvoiceIdTexts = qboInvoiceRows.map((row) => row.qbo_invoice_id);
  const qboInvoiceUuidMap = new Map<string, string>();

  if (qboInvoiceIdTexts.length > 0) {
    for (let i = 0; i < qboInvoiceIdTexts.length; i += 500) {
      const chunk = qboInvoiceIdTexts.slice(i, i + 500);
      const { data: qboInvoices, error: qboInvoiceSelectError } = await supabase
        .from("qbo_invoices")
        .select("id, qbo_invoice_id")
        .in("qbo_invoice_id", chunk);

      if (qboInvoiceSelectError) {
        throw new Error(qboInvoiceSelectError.message);
      }

      for (const row of qboInvoices ?? []) {
        qboInvoiceUuidMap.set(row.qbo_invoice_id, row.id);
      }
    }
  }

  const existingLineMap = new Map<string, {
    product_id: string | null;
    mapping_status: string;
    approval_status: string;
    warehouse_status: string;
    allocation_status: string;
    fulfillment_status: string;
  }>();

  const qboInvoiceUuids = Array.from(qboInvoiceUuidMap.values());
  if (qboInvoiceUuids.length > 0) {
    for (let i = 0; i < qboInvoiceUuids.length; i += 500) {
      const chunk = qboInvoiceUuids.slice(i, i + 500);
      const { data: existingLines, error: existingLinesError } = await supabase
        .from("qbo_invoice_lines")
        .select("qbo_invoice_id, qbo_line_id, product_id, mapping_status, approval_status, warehouse_status, allocation_status, fulfillment_status")
        .in("qbo_invoice_id", chunk);

      if (existingLinesError) {
        throw new Error(existingLinesError.message);
      }

      for (const line of existingLines ?? []) {
        existingLineMap.set(`${line.qbo_invoice_id}:${line.qbo_line_id}`, {
          product_id: line.product_id ?? null,
          mapping_status: line.mapping_status,
          approval_status: line.approval_status,
          warehouse_status: line.warehouse_status,
          allocation_status: line.allocation_status,
          fulfillment_status: line.fulfillment_status,
        });
      }
    }
  }

  const qboLineRows = invoices.flatMap((invoice) => {
    const invoiceId = String(invoice.Id ?? "").trim();
    const qboInvoiceId = qboInvoiceUuidMap.get(invoiceId);
    if (!invoiceId || !qboInvoiceId) return [];

    const lines = Array.isArray(invoice.Line) ? invoice.Line : [];
    return lines
      .map((line) => {
        if (!line || typeof line !== "object") return null;

        const typedLine = line as Record<string, unknown>;
        const lineId = String(typedLine.Id ?? "").trim();
        if (!lineId) return null;

        const salesItemDetail = typedLine.SalesItemLineDetail as Record<string, unknown> | undefined;
        const itemRef = salesItemDetail?.ItemRef as Record<string, unknown> | undefined;
        const itemName = typeof itemRef?.name === "string" ? itemRef.name.trim() : null;
        const itemId = typeof itemRef?.value === "string" ? itemRef.value.trim() : null;
        const description = typeof typedLine.Description === "string"
          ? typedLine.Description.trim()
          : itemName;
        const qty = Number(salesItemDetail?.Qty ?? typedLine.Qty ?? 0);
        const unitPrice = Number(salesItemDetail?.UnitPrice ?? 0);
        const lineTotal = Number(typedLine.Amount ?? 0);
        const existing = existingLineMap.get(`${qboInvoiceId}:${lineId}`);

        return {
          qbo_invoice_id: qboInvoiceId,
          qbo_line_id: lineId,
          qbo_item_id: itemId,
          qbo_sku: itemName,
          source_description: description,
          product_id: existing?.product_id ?? null,
          ordered_qty: Number.isFinite(qty) ? qty : 0,
          unit_price: Number.isFinite(unitPrice) ? unitPrice : null,
          line_total: Number.isFinite(lineTotal) ? lineTotal : null,
          mapping_status: existing?.mapping_status ?? "PENDING_REVIEW",
          approval_status: existing?.approval_status ?? "PENDING_REVIEW",
          warehouse_status: existing?.warehouse_status ?? "PENDING_REVIEW",
          allocation_status: existing?.allocation_status ?? "UNALLOCATED",
          fulfillment_status: existing?.fulfillment_status ?? "PENDING",
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);
  });

  if (qboLineRows.length > 0) {
    for (let i = 0; i < qboLineRows.length; i += 500) {
      const chunk = qboLineRows.slice(i, i + 500);
      const { error: qboLineError } = await supabase
        .from("qbo_invoice_lines")
        .upsert(chunk, { onConflict: "qbo_invoice_id,qbo_line_id" });

      if (qboLineError) {
        throw new Error(qboLineError.message);
      }
    }
  }

  return {
    invoiceCount: invoiceRows.length,
    customerCount: customerRows.length,
  };
}

async function syncQuickbooksFirstPaymentDates(
  connection: Awaited<ReturnType<typeof loadConnectionForSync>>,
  accessToken: string,
) {
  const supabase = getSupabaseAdmin();
  const { error: capabilityError } = await supabase.from("shipping_orders").select("first_payment_at").limit(1);
  if (capabilityError) return { paymentsProcessed: 0, ordersUpdated: 0, skipped: true };

  const paymentsByInvoiceId = new Map<string, string>();
  const pageSize = 200;
  for (let page = 0; page < 50; page += 1) {
    const payload = await fetchQuickbooksQuery({
      apiBase: getQuickbooksApiBase(connection.environment),
      realmId: connection.realm_id,
      accessToken,
      query: `select * from Payment startposition ${page * pageSize + 1} maxresults ${pageSize}`,
    });
    const batch = ((payload.QueryResponse as Record<string, unknown> | undefined)?.Payment ?? []) as Array<Record<string, unknown>>;
    if (batch.length === 0) break;

    for (const payment of batch) {
      const paymentDate = typeof payment.TxnDate === "string" ? payment.TxnDate : null;
      if (!paymentDate) continue;
      const lines = Array.isArray(payment.Line) ? payment.Line : [];
      for (const rawLine of lines) {
        if (!rawLine || typeof rawLine !== "object") continue;
        const linked = (rawLine as { LinkedTxn?: unknown[] }).LinkedTxn;
        if (!Array.isArray(linked)) continue;
        for (const rawTxn of linked) {
          if (!rawTxn || typeof rawTxn !== "object") continue;
          const txn = rawTxn as { TxnId?: unknown; TxnType?: unknown };
          if (txn.TxnType !== "Invoice" || typeof txn.TxnId !== "string") continue;
          const existing = paymentsByInvoiceId.get(txn.TxnId);
          if (!existing || Date.parse(paymentDate) < Date.parse(existing)) paymentsByInvoiceId.set(txn.TxnId, paymentDate);
        }
      }
    }

    if (batch.length < pageSize) break;
  }

  const { data: invoices } = await supabase.from("qbo_invoices").select("id,qbo_invoice_id");
  const invoiceIdByQboId = new Map((invoices ?? []).map((invoice) => [invoice.qbo_invoice_id, invoice.id]));
  const updates = [...paymentsByInvoiceId.entries()]
    .map(([qboInvoiceId, firstPaymentAt]) => ({ invoiceId: invoiceIdByQboId.get(qboInvoiceId), firstPaymentAt }))
    .filter((row): row is { invoiceId: string; firstPaymentAt: string } => Boolean(row.invoiceId));

  const results = await Promise.all(updates.map((row) => supabase
    .from("shipping_orders")
    .update({ first_payment_at: row.firstPaymentAt } as never)
    .eq("source_invoice_id", row.invoiceId)));
  const failed = results.find((result) => result.error)?.error;
  if (failed) throw new Error(failed.message);
  return { paymentsProcessed: paymentsByInvoiceId.size, ordersUpdated: updates.length, skipped: false };
}

export async function syncQuickbooksInvoices() {
  const supabase = getSupabaseAdmin();
  const connection = await loadConnectionForSync();

  try {
    const accessToken = await ensureAccessToken(connection);
    const result = await syncQuickbooksSnapshots(connection, accessToken);
    const paymentResult = await syncQuickbooksFirstPaymentDates(connection, accessToken);

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

    return { ...result, ...paymentResult };
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
