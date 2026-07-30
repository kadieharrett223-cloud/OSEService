import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { APP_SHORT_NAME } from "@/lib/constants";
import { signOutAction } from "@/app/(protected)/actions";

const navItems = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/cases", label: "Cases" },
  { href: "/cases/new", label: "Create Case" },
  { href: "/settings", label: "Settings" },
];

export default async function ProtectedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();

  return (
    <div className="min-h-screen bg-[#f8f8f8]">
      <header className="border-b border-[#dddddd] bg-white">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-4 md:px-6">
          <div>
            <p className="text-xs uppercase tracking-[0.1em] text-[#b20610]">Olympic Equipment</p>
            <p className="text-xl">{APP_SHORT_NAME}</p>
          </div>

          <nav className="flex items-center gap-2 text-sm">
            {navItems.map((item) => (
              <Link key={item.href} href={item.href} className="rounded-md px-3 py-2 hover:bg-[#f1f1f1]">
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="flex items-center gap-3">
            <p className="text-right text-sm text-[#5a5a5a]">{user.fullName ?? "Unknown User"}</p>
            <form action={signOutAction}>
              <button type="submit" className="btn-secondary">
                Sign Out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl px-4 py-6 md:px-6">{children}</main>
    </div>
  );
}
