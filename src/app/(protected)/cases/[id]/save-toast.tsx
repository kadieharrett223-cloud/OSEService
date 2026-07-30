"use client";

import { useEffect, useState } from "react";

export function SaveToast({
  message,
}: {
  message: string;
}) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(false);
    }, 2200);

    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;

  return (
    <div className="fixed right-4 top-4 z-50 rounded-md border border-[#bbf7d0] bg-[#f0fdf4] px-3 py-2 text-sm font-medium text-[#166534] shadow-lg">
      {message}
    </div>
  );
}
