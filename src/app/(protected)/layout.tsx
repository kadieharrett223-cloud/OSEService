import { requireUser } from "@/lib/auth";
import { APP_SHORT_NAME } from "@/lib/constants";
import { signOutAction } from "@/app/(protected)/actions";
import { SidebarNav } from "@/app/(protected)/sidebar-nav";
import { TopbarTools } from "@/app/(protected)/topbar-tools";

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  const userName = user.fullName ?? "Unknown User";

  return (
    <div className="flex min-h-screen flex-col bg-[#f5f7fa]">
      <div className="h-1 w-full bg-[#d50917]" />

      <div className="mx-auto grid w-full max-w-[1600px] flex-1 md:grid-cols-[264px_1fr]">
        <aside className="border-r border-[#232833] bg-gradient-to-b from-[#10141b] to-[#141c27] px-3 py-4 text-white">
          <div className="mb-4 px-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9aa7bc]">Olympic Equipment</p>
            <p className="mt-1 text-xl leading-none text-white">{APP_SHORT_NAME}</p>
          </div>
          <p className="px-2 pb-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-[#9aa7bc]">Workflow Menu</p>
          <SidebarNav />
        </aside>

        <div className="flex min-w-0 flex-col">
          <header className="border-b border-[#e3e6ea] bg-white px-4 py-3 shadow-sm md:px-6">
            <div className="flex items-center gap-3">
              <TopbarTools />
              <details className="relative">
                <summary className="list-none cursor-pointer [&::-webkit-details-marker]:hidden">
                  <span className="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-full bg-[#d50917] text-sm font-semibold text-white">
                    {userName.slice(0, 1).toUpperCase()}
                  </span>
                </summary>
                <div className="absolute right-0 z-20 mt-2 w-44 rounded-xl border border-[#e5e7eb] bg-white p-2 shadow-lg">
                  <p className="px-2 py-1 text-xs text-[#6b7280]">Signed in as</p>
                  <p className="px-2 pb-2 text-sm font-semibold text-[#1f2937]">{userName}</p>
                  <form action={signOutAction}>
                    <button type="submit" className="btn-danger w-full text-left">Sign Out</button>
                  </form>
                </div>
              </details>
            </div>
          </header>

          <main className="px-4 py-3 md:px-6 md:py-4">{children}</main>
        </div>
      </div>
    </div>
  );
}
