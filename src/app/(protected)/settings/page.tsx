import { requireUser } from "@/lib/auth";
import { getSupabaseAdmin } from "@/lib/supabase/admin";
import {
  createAccessUserAction,
  setAccessUserActiveAction,
} from "@/app/(protected)/settings/actions";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  await requireUser();
  const supabase = getSupabaseAdmin();
  const { error } = await searchParams;

  const [{ data: accessUsers }, { data: loginEvents }] = await Promise.all([
    supabase
      .from("access_users")
      .select("id, full_name, is_active, last_login_at, created_at")
      .order("full_name"),
    supabase
      .from("access_login_events")
      .select("id, full_name_snapshot, success, login_at")
      .order("login_at", { ascending: false })
      .limit(200),
  ]);

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

      <section className="card p-4">
        <h2 className="text-xl">Create Access User</h2>
        <p className="mt-1 text-sm text-[#5a5a5a]">The shared code is configured by environment variable. Add names here for assignment and audit history.</p>
        <form action={createAccessUserAction} className="mt-3 grid gap-3 md:grid-cols-3">
          <div>
            <label htmlFor="full_name" className="label">Full Name</label>
            <input id="full_name" name="full_name" className="input" required />
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
              <th className="px-2 py-2">Status</th>
              <th className="px-2 py-2">Last Login</th>
              <th className="px-2 py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(accessUsers ?? []).map((user) => (
              <tr key={user.id} className="border-b border-[#f2f2f2]">
                <td className="px-2 py-2">{user.full_name}</td>
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
