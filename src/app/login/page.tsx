import { signInAction } from "@/app/login/actions";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const errorMessage = error === "missing_access_code"
    ? "Access code is required."
    : error === "invalid_access_code"
      ? "Access code was invalid or inactive."
      : error === "missing_live_config"
        ? "Live Supabase credentials are missing. Add NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, and APP_SESSION_SECRET in .env.local."
      : null;

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f5f7fa] px-4 py-8">
      <section className="w-full max-w-md rounded-2xl border border-[#e7eaef] bg-white p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#64748b]">Olympic Equipment</p>
        <h1 className="mt-2 text-2xl font-semibold text-[#121826]">OES Service Tracker</h1>
        <p className="mt-2 text-sm text-[#475569]">Sign in with your live employee access code.</p>

        {errorMessage ? (
          <p className="mt-3 rounded-md border border-[#f1bdc0] bg-[#fff4f5] px-3 py-2 text-sm text-[#8f030d]">{errorMessage}</p>
        ) : null}

        <form action={signInAction} className="mt-5 space-y-3">
          <div>
            <label htmlFor="access_code" className="label">Access Code</label>
            <input
              id="access_code"
              name="access_code"
              className="input"
              placeholder="Enter access code"
              required
              autoFocus
            />
          </div>
          <button type="submit" className="btn-primary w-full">Sign In</button>
        </form>
      </section>
    </main>
  );
}
