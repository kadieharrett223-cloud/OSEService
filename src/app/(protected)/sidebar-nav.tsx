"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

type NavItem = {
  href: string;
  label: string;
  matchPath: string;
  matchQuery?: string;
  icon: string;
};

const navGroups: NavItem[][] = [
  [
    { href: "/dashboard", label: "Dashboard", matchPath: "/dashboard", icon: "DB" },
    { href: "/cases", label: "Cases", matchPath: "/cases", icon: "CS" },
    { href: "/cases/new", label: "Create Case", matchPath: "/cases/new", icon: "CC" },
    { href: "/cases/completed", label: "Archived / Completed", matchPath: "/cases/completed", icon: "AR" },
  ],
  [
    { href: "/cases/new?case_type=Warranty", label: "New Warranty Case", matchPath: "/cases/new", matchQuery: "case_type=Warranty", icon: "NW" },
    { href: "/cases/new?case_type=Freight+Damage", label: "New Freight Damage Case", matchPath: "/cases/new", matchQuery: "case_type=Freight Damage", icon: "NF" },
    { href: "/cases?case_type=Warranty", label: "Warranty", matchPath: "/cases", matchQuery: "case_type=Warranty", icon: "WT" },
    { href: "/cases?case_type=Freight+Damage", label: "Freight Damage", matchPath: "/cases", matchQuery: "case_type=Freight Damage", icon: "FD" },
  ],
  [{ href: "/settings", label: "Settings", matchPath: "/settings", icon: "ST" }],
];

function isItemActive(item: NavItem, pathname: string, searchParams: URLSearchParams) {
  if (!pathname.startsWith(item.matchPath)) {
    return false;
  }

  if (!item.matchQuery) {
    return true;
  }

  const [key, expectedValue] = item.matchQuery.split("=");
  const actualValue = searchParams.get(key);
  return actualValue === expectedValue;
}

export function SidebarNav() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  return (
    <div className="space-y-4">
      {navGroups.map((group, groupIndex) => (
        <div key={`group-${groupIndex}`} className="space-y-1">
          {group.map((item) => {
            const active = isItemActive(item, pathname, searchParams);

            return (
              <Link
                key={item.href}
                href={item.href}
                className={`group flex items-center gap-2.5 rounded-xl px-3 py-2 text-[13px] font-medium leading-5 transition ${
                  active
                    ? "bg-[#d50917] text-white shadow-[0_8px_24px_rgba(213,9,23,0.35)]"
                    : "text-[#d9e1ef] hover:bg-[#1f2633] hover:text-white"
                }`}
              >
                <span className={`inline-flex h-5 w-5 items-center justify-center rounded-md border text-[9px] font-semibold tracking-[0.03em] ${
                  active ? "border-white/45" : "border-[#48536a]"
                }`}>
                  {item.icon}
                </span>
                <span className="truncate">{item.label}</span>
              </Link>
            );
          })}
          {groupIndex < navGroups.length - 1 ? <div className="mt-3 border-t border-[#273245]" /> : null}
        </div>
      ))}
    </div>
  );
}
