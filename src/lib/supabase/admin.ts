import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

type SandboxRecord = Record<string, unknown>;

let client: ReturnType<typeof createClient<Database>> | null = null;

function isPlaceholderEnv(value: string | undefined) {
  if (!value) return true;
  const normalized = value.trim();
  return normalized === "[SENSITIVE]"
    || normalized.startsWith("your-")
    || normalized.startsWith("changeme")
    || normalized.includes("example.com")
    || normalized.includes("<")
    || normalized.includes(">")
    || normalized.includes("replace-me");
}

function createSandboxClient() {
  const store = new Map<string, SandboxRecord[]>();
  const storageFiles = new Map<string, SandboxRecord[]>();

  class SandboxQuery {
    private filters: Array<(row: SandboxRecord) => boolean> = [];
    private orderBy: { column: string; ascending: boolean } | null = null;
    private limitValue: number | null = null;
    private selectedColumns: string | null = null;
    private payload: SandboxRecord | null = null;
    private operation: "select" | "insert" | "update" | "delete" = "select";

    constructor(private table: string) {}

    select(columns: string) {
      this.selectedColumns = columns;
      return this;
    }

    eq(column: string, value: unknown) {
      this.filters.push((row) => row[column] === value);
      return this;
    }

    or(_condition: string) {
      return this;
    }

    order(column: string, options?: { ascending?: boolean }) {
      this.orderBy = { column, ascending: options?.ascending !== false };
      return this;
    }

    limit(value: number) {
      this.limitValue = value;
      return this;
    }

    insert(payload: SandboxRecord) {
      this.operation = "insert";
      this.payload = {
        ...payload,
        id: payload.id ?? crypto.randomUUID(),
        created_at: payload.created_at ?? new Date().toISOString(),
        updated_at: payload.updated_at ?? new Date().toISOString(),
      };
      return this;
    }

    update(payload: SandboxRecord) {
      this.operation = "update";
      this.payload = payload;
      return this;
    }

    delete() {
      this.operation = "delete";
      return this;
    }

    maybeSingle() {
      return Promise.resolve({ data: this.getRows()[0] ?? null, error: null });
    }

    single() {
      if (this.operation === "insert") {
        return Promise.resolve({ data: this.payload ? this.serializeRow(this.payload) : null, error: null });
      }

      if (this.operation === "update") {
        this.applyUpdate();
        return Promise.resolve({ data: this.getRows()[0] ?? null, error: null });
      }

      if (this.operation === "delete") {
        this.applyDelete();
        return Promise.resolve({ data: null, error: null });
      }

      return Promise.resolve({ data: this.getRows()[0] ?? null, error: null });
    }

    private readRows() {
      const rows = store.get(this.table) ?? [];
      const filtered = rows.filter((row) => this.filters.every((filter) => filter(row)));
      const ordered = [...filtered];
      if (this.orderBy) {
        ordered.sort((left, right) => {
          const leftValue = left[this.orderBy!.column];
          const rightValue = right[this.orderBy!.column];
          const leftText = typeof leftValue === "string" ? leftValue : String(leftValue ?? "");
          const rightText = typeof rightValue === "string" ? rightValue : String(rightValue ?? "");
          return this.orderBy!.ascending ? leftText.localeCompare(rightText) : rightText.localeCompare(leftText);
        });
      }
      if (this.limitValue !== null) {
        return ordered.slice(0, this.limitValue);
      }
      return ordered;
    }

    private getRows() {
      return this.readRows().map((row) => this.serializeRow(row));
    }

    private serializeRow(row: SandboxRecord) {
      if (!this.selectedColumns) return row;
      const columns = this.selectedColumns.split(",").map((column) => column.trim()).filter(Boolean);
      return columns.reduce<SandboxRecord>((accumulator, column) => {
        accumulator[column] = row[column];
        return accumulator;
      }, {});
    }

    private applyUpdate() {
      const rows = store.get(this.table) ?? [];
      const matches = rows.filter((row) => this.filters.every((filter) => filter(row)));
      const updated = matches.map((row) => ({ ...row, ...this.payload, updated_at: new Date().toISOString() }));
      const remaining = rows.filter((row) => !matches.some((match) => match.id === row.id));
      store.set(this.table, [...remaining, ...updated]);
    }

    private applyDelete() {
      const rows = store.get(this.table) ?? [];
      const remaining = rows.filter((row) => !this.filters.every((filter) => filter(row)));
      store.set(this.table, remaining);
    }

    then(resolve: (value: { data: unknown; error: null }) => unknown) {
      return Promise.resolve(this.single()).then(resolve);
    }

    catch(reject: (reason: unknown) => unknown) {
      return Promise.resolve(this.single()).catch(reject);
    }
  }

  class SandboxStorageBucket {
    constructor(private bucket: string) {}

    upload(path: string) {
      const entries = storageFiles.get(this.bucket) ?? [];
      entries.push({ path, uploaded_at: new Date().toISOString() });
      storageFiles.set(this.bucket, entries);
      return Promise.resolve({ data: { path }, error: null });
    }

    remove(paths: string[]) {
      const entries = (storageFiles.get(this.bucket) ?? []).filter((entry) => !paths.includes(String(entry.path)));
      storageFiles.set(this.bucket, entries);
      return Promise.resolve({ data: [], error: null });
    }
  }

  class SandboxStorage {
    from(bucket: string) {
      return new SandboxStorageBucket(bucket);
    }
  }

  return {
    from(table: string) {
      if (!store.has(table)) {
        store.set(table, []);
      }
      return new SandboxQuery(table);
    },
    storage: new SandboxStorage(),
  } as unknown as ReturnType<typeof createClient<Database>>;
}

export function getSupabaseAdmin() {
  if (client) return client;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey || isPlaceholderEnv(supabaseUrl) || isPlaceholderEnv(serviceRoleKey)) {
    client = createSandboxClient();
    return client;
  }

  try {
    client = createClient<Database>(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  } catch {
    client = createSandboxClient();
  }

  return client;
}
