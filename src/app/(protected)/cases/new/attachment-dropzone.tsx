"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { type ChangeEvent } from "react";

type SelectedFile = {
  id: string;
  file: File;
  previewUrl: string | null;
  selectedAt: string;
};

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentDropzone({
  uploadedBy,
}: {
  uploadedBy: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<SelectedFile[]>([]);
  const [dragActive, setDragActive] = useState(false);

  const hasFiles = selected.length > 0;

  const previewCount = useMemo(() => selected.filter((item) => item.previewUrl).length, [selected]);

  function filesToSelected(files: File[]) {
    return files.map((file) => ({
      id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
      file,
      previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
      selectedAt: new Date().toISOString(),
    }));
  }

  function syncInputFiles(files: File[]) {
    if (!inputRef.current) return;
    const dataTransfer = new DataTransfer();
    files.forEach((file) => dataTransfer.items.add(file));
    inputRef.current.files = dataTransfer.files;
  }

  function updateFiles(files: File[], append = true) {
    const incoming = filesToSelected(files);

    setSelected((current) => {
      const combined = append
        ? [...current, ...incoming]
        : incoming;

      const uniqueById = combined.filter((item, index, list) => list.findIndex((candidate) => candidate.id === item.id) === index);
      const nextFiles = uniqueById.map((item) => item.file);

      syncInputFiles(nextFiles);
      return uniqueById;
    });
  }

  function removeFile(fileId: string) {
    setSelected((current) => {
      const removing = current.find((item) => item.id === fileId);
      if (removing?.previewUrl) {
        URL.revokeObjectURL(removing.previewUrl);
      }

      const next = current.filter((item) => item.id !== fileId);
      syncInputFiles(next.map((item) => item.file));
      return next;
    });
  }

  function onInputChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    updateFiles(files, true);
  }

  function onDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length === 0) return;
    updateFiles(files, true);
  }

  useEffect(() => {
    return () => {
      selected.forEach((item) => {
        if (item.previewUrl) {
          URL.revokeObjectURL(item.previewUrl);
        }
      });
    };
  }, []);

  return (
    <div className="space-y-3">
      <input
        ref={inputRef}
        id="attachments"
        type="file"
        name="attachments"
        className="sr-only"
        accept=".jpg,.jpeg,.png,.heic,.pdf,.mp4"
        multiple
        onChange={onInputChange}
      />

      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          setDragActive(false);
        }}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        className={`cursor-pointer rounded-lg border border-dashed px-4 py-5 text-center transition ${
          dragActive ? "border-[#d50917] bg-[#fff5f5]" : "border-[#c9d1dd] bg-[#f8fafc]"
        }`}
      >
        <p className="text-sm font-medium text-[#253247]">Drag files here</p>
        <p className="my-1 text-xs text-[#64748b]">or</p>
        <span className="inline-flex rounded-md border border-[#d0d7e2] bg-white px-3 py-1.5 text-xs font-medium text-[#334155]">Upload Files</span>
        <p className="mt-1 text-xs text-[#64748b]">Supports JPG, PNG, HEIC, PDF, MP4</p>
      </div>

      {hasFiles ? (
        <div className="space-y-2 rounded-md border border-[#eceff4] bg-white p-3">
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[#64748b]">
            {selected.length} file(s) selected • {previewCount} image preview(s)
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {selected.map((item) => (
              <div key={item.id} className="rounded-md border border-[#ececec] p-2">
                <div className="mb-2 flex h-20 items-center justify-center rounded bg-[#f5f7fb]">
                  {item.previewUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.previewUrl} alt={item.file.name} className="h-full w-full rounded object-cover" />
                  ) : (
                    <span className="text-xs text-[#64748b]">{item.file.type || "File"}</span>
                  )}
                </div>
                <p className="truncate text-sm font-semibold" title={item.file.name}>{item.file.name}</p>
                <p className="text-xs text-[#6a6a6a]">{formatBytes(item.file.size)}</p>
                <p className="text-xs text-[#6a6a6a]">Upload date: {new Date(item.selectedAt).toLocaleString()}</p>
                <p className="text-xs text-[#6a6a6a]">Uploaded by: {uploadedBy}</p>
                <button
                  type="button"
                  className="mt-2 text-xs font-semibold text-[#b20610]"
                  onClick={() => removeFile(item.id)}
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
