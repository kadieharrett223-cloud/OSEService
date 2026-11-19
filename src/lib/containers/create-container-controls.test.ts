import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ pending: false }));
vi.mock("react-dom", () => ({ useFormStatus: () => ({ pending: state.pending }) }));
import { CreateContainerControls } from "@/app/(protected)/containers/create-container-controls";

describe("container save feedback", () => {
  it("disables repeat submission and announces saving until the server finishes", () => {
    vi.stubGlobal("React", React);
    state.pending = true;
    const html = renderToStaticMarkup(React.createElement(CreateContainerControls, { onCancel: () => {} }));
    expect(html).toContain("Saving container and products");
    expect(html).toContain('role="status"');
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).toContain('aria-busy="true"');
    state.pending = false;
    const ready = renderToStaticMarkup(React.createElement(CreateContainerControls, { onCancel: () => {} }));
    expect(ready).not.toContain('disabled=""');
    expect(ready).toContain("Save Container");
    vi.unstubAllGlobals();
  });
});
