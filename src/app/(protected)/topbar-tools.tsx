"use client";

import Link from "next/link";
import { Suspense, type FormEvent } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

function toTitle(segment: string) {
  return segment
    .replace(/-/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function TopbarToolsContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const segments = pathname.split("/").filter(Boolean);
  const crumbs = ["Home", ...segments.map(toTitle)];

  function handleSearchSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const formData = new FormData(event.currentTarget);
    const query = String(formData.get("q") ?? "").trim();
    const targetPath = pathname.startsWith("/cases/completed") ? "/cases/completed" : "/cases";

    if (!query) {
      router.push(targetPath);
      return;
    }

    router.push(`${targetPath}?q=${encodeURIComponent(query)}`);
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <div className="min-w-0">
        <div className="truncate text-xs text-[#7a8699]">
          {crumbs.join(" / ")}
        </div>
        <p className="truncate text-sm font-semibold text-[#111827]">{crumbs[crumbs.length - 1] ?? "Workspace"}</p>
      </div>

      <div className="ml-auto hidden items-center gap-2 lg:flex">
        <form onSubmit={handleSearchSubmit} className="relative block">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-[#9aa3b2]">⌘</span>
          <input
            className="h-9 w-72 rounded-xl border border-[#dbe1ea] bg-white pl-7 pr-3 text-[13px] shadow-sm outline-none focus:border-[#d50917]"
            placeholder="Search customers, invoices, cases..."
            type="search"
            name="q"
            defaultValue={searchParams.get("q") ?? ""}
            aria-label="Search customers, invoices, and cases"
          />
        </form>

        <Link
          href="/cases/new"
          className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-[#dbe1ea] bg-white text-[#4f5d75] hover:border-[#d50917] hover:text-[#d50917]"
          aria-label="Quick create case"
        >
          +
        </Link>

        <button
          type="button"
          className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-[#dbe1ea] bg-white text-[#5f6b7e] hover:border-[#d50917] hover:text-[#d50917]"
          aria-label="Notifications"
        >
          ◦
        </button>
      </div>
    </div>
  );
}

export function TopbarTools() {
  return (
    <Suspense fallback={null}>
      <TopbarToolsContent />
    </Suspense>
  );
}
