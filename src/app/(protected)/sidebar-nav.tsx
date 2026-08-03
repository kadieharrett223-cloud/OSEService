"use client";

import Link from "next/link";
import { Suspense } from "react";
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
    { href: "/installation", label: "Installation", matchPath: "/installation", icon: "IN" },
    { href: "/cases/completed", label: "Archived / Completed", matchPath: "/cases/completed", icon: "AR" },
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

function SidebarNavContent() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  return (
    <div className="space-y-3">
      {navGroups.map((group, groupIndex) => (
        <div key={`group-${groupIndex}`} className="space-y-0.5">
          {group.map((item) => {
            const active = isItemActive(item, pathname, searchParams);

            return (
              <Link
                key={item.href}
                href={item.href}
                className={`group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[15px] font-medium leading-6 transition ${
                  active
                    ? "bg-[#1a2230] text-white"
                    : "text-[#d9e1ef] hover:bg-[#1f2633] hover:text-white"
                }`}
              >
                {active ? <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r bg-[#d50917]" /> : null}
                <span className={`inline-flex h-5 w-5 items-center justify-center rounded-sm border text-[8px] font-semibold tracking-[0.03em] ${
                  active ? "border-[#7a8aa6]" : "border-[#48536a]"
                }`}>
                  {item.icon}
                </span>
                <span className="truncate">{item.label}</span>
              </Link>
            );
          })}
          {groupIndex < navGroups.length - 1 ? <div className="mt-2 border-t border-[#273245]" /> : null}
        </div>
      ))}
    </div>
  );
}

export function SidebarNav() {
  return (
    <Suspense fallback={null}>
      <SidebarNavContent />
    </Suspense>
  );
}
