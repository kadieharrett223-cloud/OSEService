"use client";

import { Fragment, type ReactNode, useState } from "react";
import { PackageDimensionsDetails } from "@/components/package-dimensions-details";
import type { PackageDimensions } from "@/lib/products/package-dimensions";

type InventoryDimensionsRowProps = {
  dimensions: PackageDimensions | null;
  children: ReactNode;
};

function isInteractiveTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest("a, button, input, select, textarea, label, [role='button']"));
}

export function InventoryDimensionsRow({ dimensions, children }: InventoryDimensionsRowProps) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = Boolean(dimensions);

  return (
    <Fragment>
      <tr
        className={`border-b border-[#f1f5f9] align-top${canExpand ? " cursor-pointer hover:bg-[#f8fafc]" : ""}`}
        onClick={(event) => {
          if (canExpand && !isInteractiveTarget(event.target)) setExpanded((current) => !current);
        }}
        onKeyDown={(event) => {
          if (canExpand && !isInteractiveTarget(event.target) && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            setExpanded((current) => !current);
          }
        }}
        role={canExpand ? "button" : undefined}
        tabIndex={canExpand ? 0 : undefined}
        aria-expanded={canExpand ? expanded : undefined}
      >
        {children}
        <td className="px-2 py-3 text-right text-sm text-[#94a3b8]" aria-label={canExpand ? (expanded ? "Collapse package dimensions" : "Show package dimensions") : "No package dimensions on file"} title={canExpand ? undefined : "No package dimensions on file"}>
          {canExpand ? (expanded ? "⌄" : "›") : "—"}
        </td>
      </tr>
      {expanded && dimensions ? (
        <tr className="border-b border-[#dbeafe] bg-[#f8fbff]">
          <td colSpan={9} className="px-4 py-3"><PackageDimensionsDetails dimensions={dimensions} /></td>
        </tr>
      ) : null}
    </Fragment>
  );
}
