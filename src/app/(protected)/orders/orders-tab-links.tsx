"use client";

import { useRouter } from "next/navigation";
import { startTransition } from "react";

type Tab = {
  id: string;
  label: string;
  count: number;
};

export function OrdersTabLinks({
  tabs,
  activeTab,
  searchText,
}: {
  tabs: Tab[];
  activeTab: string;
  searchText: string;
}) {
  const router = useRouter();

  function pathFor(tabId: string) {
    const query = new URLSearchParams({ tab: tabId });
    if (searchText) query.set("q", searchText);
    return `/orders?${query.toString()}`;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        const path = pathFor(tab.id);
        return (
          <button
            key={tab.id}
            type="button"
            aria-current={isActive ? "page" : undefined}
            className={`rounded-full px-3 py-2 text-sm font-semibold ${isActive ? "bg-[#111827] text-white" : "bg-[#f3f4f6] text-[#374151]"}`}
            onPointerEnter={() => router.prefetch(path)}
            onFocus={() => router.prefetch(path)}
            onClick={() => startTransition(() => router.push(path))}
          >
            {tab.label} ({tab.count})
          </button>
        );
      })}
    </div>
  );
}
