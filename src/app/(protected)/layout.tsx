import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { APP_SHORT_NAME } from "@/lib/constants";
import { signOutAction } from "@/app/(protected)/actions";

const navItems = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/cases", label: "Cases" },
  { href: "/cases/new", label: "Create Case" },
  { href: "/cases/new?case_type=Warranty", label: "New Warranty Case" },
  { href: "/cases/new?case_type=Freight+Damage", label: "New Freight Damage Case" },
  { href: "/cases/completed", label: "Archived / Completed" },
  { href: "/cases?case_type=Warranty", label: "Warranty" },
  { href: "/cases?case_type=Freight+Damage", label: "Freight Damage" },
  { href: "/settings", label: "Settings" },
];

const navGroups = [
  {
    title: "",
    items: navItems.slice(0, 6),
  },
  {
    title: "",
    items: navItems.slice(6, 8),
  },
  {
    title: "",
    items: navItems.slice(8),
  },
];

function iconFor(label: string) {
  if (label.includes("Dashboard")) return "D";
  if (label.includes("Create")) return "+";
  if (label.includes("Warranty")) return "W";
  if (label.includes("Freight")) return "F";
  if (label.includes("Archived")) return "A";
  if (label.includes("Settings")) return "S";
  return "C";
}

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();

  return (
    <div className="flex min-h-screen flex-col bg-[#f3f5f8]">
      <div className="h-1 w-full bg-[#d50917]" />

      <header className="border-b border-[#e3e6ea] bg-white shadow-sm">
        <div className="mx-auto flex w-full max-w-[1520px] items-center justify-between gap-4 px-4 py-4 md:px-6">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded-sm bg-[#d50917]" />
              <div>
                <p className="text-[13px] font-semibold uppercase tracking-[0.08em] text-[#111]">Olympic Equipment</p>
              </div>
            </div>
            <div className="hidden h-8 w-px bg-[#d9d9d9] md:block" />
            <p className="text-3xl leading-none text-[#121826]">{APP_SHORT_NAME}</p>
          </div>

          <div className="flex items-center gap-3">
            <p className="text-right text-sm font-semibold text-[#2a3140]">{user.fullName ?? "Unknown User"}</p>
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-[#d50917] text-sm font-semibold text-white">
              {(user.fullName ?? "U").slice(0, 1).toUpperCase()}
            </span>
            <form action={signOutAction}>
              <button type="submit" className="btn-secondary">
                Sign Out
              </button>
            </form>
          </div>
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-[1520px] flex-1 gap-6 px-0 py-0 md:grid-cols-[270px_1fr] md:items-stretch">
        <aside className="h-full border-r border-[#232833] bg-gradient-to-b from-[#10141b] to-[#141c27] px-3 py-6 text-white">
          <p className="px-2 pb-3 text-xs font-semibold uppercase tracking-[0.08em] text-[#9aa7bc]">Workflow Menu</p>

          <div className="space-y-4">
            {navGroups.map((group, groupIndex) => (
              <div key={`group-${groupIndex}`} className="space-y-1">
                <nav className="flex flex-col gap-1 text-sm">
                  {group.items.map((item) => {
                    const isPrimary = item.href === "/cases/new";

                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        className={`flex items-center gap-3 rounded-md px-3 py-2.5 transition ${
                          isPrimary
                            ? "bg-[#d50917] text-white"
                            : "text-[#e8eef8] hover:bg-[#202735]"
                        }`}
                      >
                        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-[#8090a8] text-[10px] font-semibold">
                          {iconFor(item.label)}
                        </span>
                        <span>{item.label}</span>
                      </Link>
                    );
                  })}
                </nav>
                {groupIndex < navGroups.length - 1 ? <div className="border-t border-[#263143] pt-3" /> : null}
              </div>
            ))}
          </div>
        </aside>

        <main className="px-4 py-6 md:px-8">{children}</main>
      </div>
    </div>
  );
}
