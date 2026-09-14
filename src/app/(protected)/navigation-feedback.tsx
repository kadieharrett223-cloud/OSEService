"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

function isInternalNavigation(event: MouseEvent) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  const target = event.target;
  if (!(target instanceof Element)) return false;
  const anchor = target.closest<HTMLAnchorElement>("a[href]");
  if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return false;

  const nextUrl = new URL(anchor.href, window.location.href);
  if (nextUrl.origin !== window.location.origin) return false;
  return `${nextUrl.pathname}${nextUrl.search}` !== `${window.location.pathname}${window.location.search}`;
}

function NavigationFeedbackState() {
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const startForLink = (event: MouseEvent) => {
      if (isInternalNavigation(event)) setPending(true);
    };
    const startForHistory = () => setPending(true);
    document.addEventListener("click", startForLink, true);
    window.addEventListener("popstate", startForHistory);
    return () => {
      document.removeEventListener("click", startForLink, true);
      window.removeEventListener("popstate", startForHistory);
    };
  }, []);

  if (!pending) return null;
  return <div className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-1 overflow-hidden bg-[#f5b5ba]" role="status" aria-live="polite"><div className="occ-navigation-progress h-full w-1/3 bg-[#d50917]" /><span className="sr-only">Loading page</span></div>;
}

export function NavigationFeedback() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return <NavigationFeedbackState key={`${pathname}?${searchParams.toString()}`} />;
}
