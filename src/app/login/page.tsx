import { signInAction } from "@/app/login/actions";

export default async function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f5f7fa] px-4 py-8">
      <section className="w-full max-w-md rounded-2xl border border-[#e7eaef] bg-white p-6 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#64748b]">Olympic Equipment</p>
        <h1 className="mt-2 text-2xl font-semibold text-[#121826]">OES Service Tracker</h1>
        <p className="mt-2 text-sm text-[#475569]">You are signed out. Continue to enter the local sandbox workspace.</p>

        <form action={signInAction} className="mt-5 space-y-3">
          <button type="submit" className="btn-primary w-full">Continue as Sandbox User</button>
        </form>
      </section>
    </main>
  );
}
