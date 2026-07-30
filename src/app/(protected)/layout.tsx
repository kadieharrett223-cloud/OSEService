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
    <div className="flex min-h-screen flex-col bg-[#f3f5f8]">
      <div className="h-1 w-full bg-[#d50917]" />

      <div className="mx-auto grid w-full max-w-[1600px] flex-1 md:grid-cols-[246px_1fr]">
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
              <div className="h-8 w-px bg-[#e1e5ec]" />
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-[#d50917] text-sm font-semibold text-white">
                {userName.slice(0, 1).toUpperCase()}
              </span>
              <form action={signOutAction}>
                <button type="submit" className="btn-secondary h-9 px-3 py-0 text-sm leading-9">
                  Sign Out
                </button>
              </form>
            </div>
          </header>

          <main className="px-4 py-4 md:px-6 md:py-5">{children}</main>
        </div>
      </div>
    </div>
  );
}
