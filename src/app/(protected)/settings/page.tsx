import { requireUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  connectQuickbooksAction,
  createAccessUserAction,
  disconnectQuickbooksAction,
  setAccessUserActiveAction,
  syncQuickbooksAction,
} from "@/app/(protected)/settings/actions";
import {
  describeQuickbooksConfig,
  getQuickbooksConnectionStatus,
} from "@/lib/quickbooks/integration";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; message?: string }>;
}) {
  await requireUser();
  const supabase = getSupabaseAdmin();
  const { error, message } = await searchParams;
  const quickbooksConfig = describeQuickbooksConfig();

  const [
    { data: accessUsers },
    { data: loginEvents },
    quickbooksStatus,
    { count: quickbooksSnapshotCount },
  ] = await Promise.all([
    supabase
      .from("access_users")
      .select("id, full_name, access_code, is_active, last_login_at, created_at")
      .order("full_name"),
    supabase
      .from("access_login_events")
      .select("id, full_name_snapshot, success, login_at")
      .order("login_at", { ascending: false })
      .limit(200),
    getQuickbooksConnectionStatus(),
    supabase
      .from("quickbooks_invoices")
      .select("id", { count: "exact", head: true }),
  ]);

  const quickbooksTableMissing = quickbooksStatus.error?.code === "42P01";
  const connectedRow = quickbooksStatus.connection;
  const hasSnapshots = (quickbooksSnapshotCount ?? 0) > 0;
  const isConnected = quickbooksTableMissing ? hasSnapshots : Boolean(connectedRow);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-3xl">Settings</h1>
        <p className="text-sm text-[#5a5a5a]">
          Manage active users for the shared code and review login history by person.
        </p>
      </div>

      {error ? (
        <p className="rounded-md border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d]">{error}</p>
      ) : null}

      {message ? (
        <p className="rounded-md border border-[#bfdcc5] bg-[#f3fff6] p-3 text-sm text-[#0f5b28]">{message}</p>
      ) : null}

      <section className="card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl">QuickBooks Integration</h2>
            <p className="mt-1 text-sm text-[#5a5a5a]">
              Connect to QuickBooks sandbox and sync invoice snapshots used by the create-case autofill.
            </p>
          </div>
          <div className={`rounded-md px-3 py-1 text-xs font-semibold ${isConnected ? "bg-[#e8f9ee] text-[#0f6f35]" : "bg-[#fff0f1] text-[#8f030d]"}`}>
            {isConnected ? "Connected" : "Disconnected"}
          </div>
        </div>

        <div className="mt-3 grid gap-3 text-sm md:grid-cols-2">
          <div>
            <p className="text-[#5a5a5a]">Mode</p>
            <p className="font-medium text-[#121826]">{quickbooksConfig.environment}</p>
          </div>
          <div className="md:col-span-2">
            <p className="text-[#5a5a5a]">Redirect URI In Use</p>
            <p className="font-mono text-xs text-[#121826] break-all">
              {quickbooksConfig.configuredRedirectUri || "(dynamic) current-origin/api/integrations/quickbooks/callback"}
            </p>
          </div>
          <div>
            <p className="text-[#5a5a5a]">Snapshot Count</p>
            <p className="font-medium text-[#121826]">{quickbooksSnapshotCount ?? 0}</p>
          </div>
          <div>
            <p className="text-[#5a5a5a]">Realm ID</p>
            <p className="font-medium text-[#121826]">{connectedRow?.realm_id ?? "Not connected"}</p>
          </div>
          <div>
            <p className="text-[#5a5a5a]">Last Sync</p>
            <p className="font-medium text-[#121826]">{connectedRow?.last_sync_at ? new Date(connectedRow.last_sync_at).toLocaleString() : "Never"}</p>
          </div>
          <div>
            <p className="text-[#5a5a5a]">Last Sync Status</p>
            <p className="font-medium text-[#121826]">{connectedRow?.last_sync_status ?? "Unknown"}</p>
          </div>
        </div>

        {connectedRow?.last_sync_error ? (
          <p className="mt-3 rounded-md border border-[#f1bdc0] bg-[#fff4f5] p-3 text-sm text-[#8f030d] break-words">
            Last sync error: {connectedRow.last_sync_error}
          </p>
        ) : null}

        {!quickbooksConfig.hasCredentials ? (
          <p className="mt-3 rounded-md border border-[#f1d3a4] bg-[#fff8ec] p-3 text-sm text-[#915b12]">
            Add QUICKBOOKS_CLIENT_ID and QUICKBOOKS_CLIENT_SECRET in environment variables to enable Connect.
          </p>
        ) : null}

        <p className="mt-3 rounded-md border border-[#d9e2f7] bg-[#f7faff] p-3 text-sm text-[#1e3a8a]">
          In Intuit Developer Keys, add the exact redirect URI shown above in Redirect URIs. It must match character-for-character.
        </p>

        {quickbooksTableMissing ? (
          <p className="mt-3 rounded-md border border-[#f1d3a4] bg-[#fff8ec] p-3 text-sm text-[#915b12]">
            QuickBooks connection table is missing. Run migration supabase/migrations/202607300004_quickbooks_connections.sql.
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap gap-2">
          <form action={connectQuickbooksAction}>
            <button type="submit" className="btn-primary" disabled={!quickbooksConfig.hasCredentials || quickbooksTableMissing}>
              {isConnected ? "Reconnect QuickBooks" : "Connect QuickBooks"}
            </button>
          </form>
          <form action={syncQuickbooksAction}>
            <button type="submit" className="btn-secondary" disabled={!isConnected || quickbooksTableMissing}>
              Sync Invoices
            </button>
          </form>
          <form action={disconnectQuickbooksAction}>
            <button type="submit" className="btn-danger" disabled={!isConnected || quickbooksTableMissing}>
              Disconnect
            </button>
          </form>
        </div>
      </section>

      <section className="card p-4">
        <h2 className="text-xl">Create Access User</h2>
        <p className="mt-1 text-sm text-[#5a5a5a]">Create live users and assign a code they can use at login.</p>
        <form action={createAccessUserAction} className="mt-3 grid gap-3 md:grid-cols-3">
          <div>
            <label htmlFor="full_name" className="label">Full Name</label>
            <input id="full_name" name="full_name" className="input" required />
          </div>
          <div>
            <label htmlFor="access_code" className="label">Access Code (optional)</label>
            <input id="access_code" name="access_code" className="input" placeholder="Auto-generated when empty" />
          </div>
          <div className="flex items-end">
            <button type="submit" className="btn-primary w-full">Create User</button>
          </div>
        </form>
      </section>

      <section className="card p-4 overflow-x-auto">
        <h2 className="text-xl">Access Users</h2>
        <table className="mt-3 w-full min-w-[760px] text-left text-sm">
          <thead>
            <tr className="border-b border-[#ececec] text-[#5a5a5a]">
              <th className="px-2 py-2">Name</th>
              <th className="px-2 py-2">Access Code</th>
              <th className="px-2 py-2">Status</th>
              <th className="px-2 py-2">Last Login</th>
              <th className="px-2 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(accessUsers ?? []).map((user) => (
              <tr key={user.id} className="border-b border-[#f2f2f2]">
                <td className="px-2 py-2">{user.full_name}</td>
                <td className="px-2 py-2 font-mono text-xs">{user.access_code}</td>
                <td className="px-2 py-2">{user.is_active ? "Active" : "Inactive"}</td>
                <td className="px-2 py-2">{user.last_login_at ? new Date(user.last_login_at).toLocaleString() : "Never"}</td>
                <td className="px-2 py-2">
                  <form action={setAccessUserActiveAction}>
                    <input type="hidden" name="user_id" value={user.id} />
                    <input type="hidden" name="is_active" value={user.is_active ? "false" : "true"} />
                    <button type="submit" className="btn-secondary">
                      {user.is_active ? "Disable" : "Enable"}
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card p-4 overflow-x-auto">
        <h2 className="text-xl">Login History</h2>
        <table className="mt-3 w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="border-b border-[#ececec] text-[#5a5a5a]">
              <th className="px-2 py-2">When</th>
              <th className="px-2 py-2">Who</th>
              <th className="px-2 py-2">Result</th>
            </tr>
          </thead>
          <tbody>
            {(loginEvents ?? []).map((event) => (
              <tr key={event.id} className="border-b border-[#f2f2f2]">
                <td className="px-2 py-2">{new Date(event.login_at).toLocaleString()}</td>
                <td className="px-2 py-2">{event.full_name_snapshot ?? "Unknown"}</td>
                <td className="px-2 py-2">{event.success ? "Success" : "Failed"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
