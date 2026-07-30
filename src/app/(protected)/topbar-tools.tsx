"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

function toTitle(segment: string) {
  return segment
    .replace(/-/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function TopbarTools() {
  const pathname = usePathname();
  const segments = pathname.split("/").filter(Boolean);
  const crumbs = ["Home", ...segments.map(toTitle)];

  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <div className="min-w-0">
        <div className="truncate text-xs text-[#7a8699]">
          {crumbs.join(" / ")}
        </div>
        <p className="truncate text-sm font-semibold text-[#111827]">{crumbs[crumbs.length - 1] ?? "Workspace"}</p>
      </div>

      <div className="ml-auto hidden items-center gap-2 lg:flex">
        <label className="relative block">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-[#8f98a8]">/</span>
          <input
            className="h-9 w-64 rounded-lg border border-[#dbe1ea] bg-white pl-7 pr-3 text-sm outline-none focus:border-[#d50917]"
            placeholder="Search cases, customers"
            type="search"
          />
        </label>

        <button
          type="button"
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[#dbe1ea] bg-white text-[#5f6b7e] hover:border-[#d50917] hover:text-[#d50917]"
          aria-label="Notifications"
        >
          •
        </button>

        <Link href="/cases/new" className="btn-primary h-9 px-3 py-0 text-sm leading-9">
          + Quick Create
        </Link>
      </div>
    </div>
  );
}
