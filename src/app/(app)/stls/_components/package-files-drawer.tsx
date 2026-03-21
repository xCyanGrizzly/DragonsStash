"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { toast } from "sonner";
import {
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  Search,
  ChevronDown,
  ChevronRight,
  Upload,
  ImagePlus,
  Images,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PackageRow } from "./package-columns";
import { SendToTelegramButton } from "./send-to-telegram-button";
import { uploadPackagePreview } from "../actions";
import { ArchivePreviewPicker } from "./archive-preview-picker";

interface FileItem {
  id: string;
  path: string;
  fileName: string;
  extension: string | null;
  compressedSize: string;
  uncompressedSize: string;
  crc32: string | null;
}

interface TreeNode {
  name: string;
  isFolder: boolean;
  children: Map<string, TreeNode>;
  file?: FileItem;
}

interface PackageFilesDrawerProps {
  pkg: PackageRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function formatBytes(bytesStr: string): string {
  const bytes = Number(bytesStr);
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

const EXTENSION_COLORS: Record<string, string> = {
  stl: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  obj: "bg-violet-500/15 text-violet-400 border-violet-500/30",
  "3mf": "bg-cyan-500/15 text-cyan-400 border-cyan-500/30",
  gcode: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  png: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  jpg: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  jpeg: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  pdf: "bg-red-500/15 text-red-400 border-red-500/30",
  txt: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
  lys: "bg-pink-500/15 text-pink-400 border-pink-500/30",
};

function getExtBadgeClass(ext: string | null): string {
  if (!ext) return "bg-zinc-500/15 text-zinc-400 border-zinc-500/30";
  return EXTENSION_COLORS[ext.toLowerCase()] ?? "bg-zinc-500/15 text-zinc-400 border-zinc-500/30";
}

/**
 * Build a tree structure from flat file paths.
 */
function buildFileTree(files: FileItem[]): TreeNode {
  const root: TreeNode = { name: "", isFolder: true, children: new Map() };

  for (const file of files) {
    // Normalize path separators (Windows RAR archives may use backslashes)
    const parts = file.path.replace(/\\/g, "/").split("/").filter(Boolean);
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;

      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          isFolder: !isLast,
          children: new Map(),
          file: isLast ? file : undefined,
        });
      }

      current = current.children.get(part)!;
    }
  }

  return root;
}

/**
 * Recursively renders a file tree node with indentation.
 */
function TreeNodeView({
  node,
  depth,
  search,
  defaultOpen,
}: {
  node: TreeNode;
  depth: number;
  search: string;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  // Sort children: folders first, then files, alphabetical within each group
  const sortedChildren = useMemo(() => {
    const arr = Array.from(node.children.values());
    return arr.sort((a, b) => {
      if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [node.children]);

  // If searching, force all open
  useEffect(() => {
    if (search) setOpen(true);
  }, [search]);

  if (node.isFolder && node.children.size > 0) {
    return (
      <div>
        {/* Don't render a row for the root node */}
        {depth >= 0 && (
          <button
            type="button"
            className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-sm hover:bg-muted/50 transition-colors"
            style={{ paddingLeft: `${Math.max(0, depth) * 16 + 4}px` }}
            onClick={() => setOpen(!open)}
          >
            {open ? (
              <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
            )}
            {open ? (
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-primary/70" />
            ) : (
              <Folder className="h-3.5 w-3.5 shrink-0 text-primary/70" />
            )}
            <span className="text-sm font-medium truncate">{node.name}</span>
            <span className="text-[10px] text-muted-foreground ml-auto shrink-0">
              {countFiles(node)}
            </span>
          </button>
        )}
        {open &&
          sortedChildren.map((child) => (
            <TreeNodeView
              key={child.name}
              node={child}
              depth={depth + 1}
              search={search}
              defaultOpen={depth < 1} // Auto-expand first 2 levels
            />
          ))}
      </div>
    );
  }

  // File node
  if (node.file) {
    return (
      <div
        className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-muted/50 transition-colors"
        style={{ paddingLeft: `${Math.max(0, depth) * 16 + 4}px` }}
      >
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-sm truncate flex-1 min-w-0" title={node.file.path}>
          {node.name}
        </span>
        {node.file.extension && (
          <Badge
            variant="outline"
            className={`text-[10px] shrink-0 ${getExtBadgeClass(node.file.extension)}`}
          >
            .{node.file.extension}
          </Badge>
        )}
        <span className="text-[11px] text-muted-foreground shrink-0 tabular-nums">
          {formatBytes(node.file.uncompressedSize)}
        </span>
      </div>
    );
  }

  return null;
}

function countFiles(node: TreeNode): number {
  if (!node.isFolder) return 1;
  let count = 0;
  for (const child of node.children.values()) {
    count += countFiles(child);
  }
  return count;
}

const PAGE_SIZE = 100;

export function PackageFilesDrawer({ pkg, open, onOpenChange }: PackageFilesDrawerProps) {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [uploading, setUploading] = useState(false);
  const [localPreviewUrl, setLocalPreviewUrl] = useState<string | null>(null);
  const [showPreviewPicker, setShowPreviewPicker] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handlePreviewUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !pkg) return;

      // Reset file input so the same file can be re-selected
      e.target.value = "";

      setUploading(true);
      try {
        const formData = new FormData();
        formData.append("file", file);
        const result = await uploadPackagePreview(pkg.id, formData);
        if (result.success) {
          toast.success("Preview image uploaded");
          // Show uploaded image immediately via local object URL
          setLocalPreviewUrl(URL.createObjectURL(file));
        } else {
          toast.error(result.error);
        }
      } catch {
        toast.error("Failed to upload preview image");
      } finally {
        setUploading(false);
      }
    },
    [pkg]
  );

  // Clean up local preview URL when drawer closes or package changes
  useEffect(() => {
    return () => {
      if (localPreviewUrl) URL.revokeObjectURL(localPreviewUrl);
    };
  }, [localPreviewUrl]);

  const fetchFiles = useCallback(
    async (pageNum: number, append: boolean) => {
      if (!pkg) return;
      if (pageNum === 1) setLoading(true);
      else setLoadingMore(true);

      try {
        const params = new URLSearchParams({
          page: String(pageNum),
          limit: String(PAGE_SIZE),
        });
        const res = await fetch(`/api/zips/${pkg.id}/files?${params}`);
        if (!res.ok) throw new Error("fetch failed");
        const data = await res.json();
        setFiles((prev) => (append ? [...prev, ...data.items] : data.items));
        setTotal(data.pagination.total);
      } catch {
        // Silently handle
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [pkg]
  );

  // Reset and fetch when package changes
  useEffect(() => {
    if (open && pkg) {
      setFiles([]);
      setTotal(0);
      setSearch("");
      setPage(1);
      setLocalPreviewUrl(null);
      fetchFiles(1, false);
    }
  }, [open, pkg, fetchFiles]);

  const loadMore = () => {
    const nextPage = page + 1;
    setPage(nextPage);
    fetchFiles(nextPage, true);
  };

  const hasMore = files.length < total;

  // Client-side search filter (over loaded files)
  const filtered = search
    ? files.filter(
        (f) =>
          f.fileName.toLowerCase().includes(search.toLowerCase()) ||
          f.path.toLowerCase().includes(search.toLowerCase())
      )
    : files;

  // Build tree from filtered files
  const tree = useMemo(() => buildFileTree(filtered), [filtered]);

  // If all files are in root (no folders), skip the tree and show flat list
  const hasNesting = useMemo(() => {
    return filtered.some((f) => f.path.replace(/\\/g, "/").includes("/"));
  }, [filtered]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[80vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border space-y-3">
          {/* Preview image + title row */}
          <div className="flex gap-4">
            {/* Preview image area with upload capability */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={handlePreviewUpload}
            />
            {(pkg?.hasPreview || localPreviewUrl) ? (
              <button
                type="button"
                className="relative group h-20 w-20 shrink-0 rounded-lg overflow-hidden bg-muted"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                title="Click to replace preview image"
              >
                <img
                  src={localPreviewUrl ?? `/api/zips/${pkg!.id}/preview`}
                  alt=""
                  className="h-full w-full object-cover"
                />
                <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  {uploading ? (
                    <Loader2 className="h-5 w-5 text-white animate-spin" />
                  ) : (
                    <Upload className="h-5 w-5 text-white" />
                  )}
                </div>
              </button>
            ) : (
              <button
                type="button"
                className="flex h-20 w-20 shrink-0 items-center justify-center rounded-lg border border-dashed border-muted-foreground/30 bg-muted/50 hover:bg-muted hover:border-muted-foreground/50 transition-colors cursor-pointer"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                title="Upload preview image"
              >
                {uploading ? (
                  <Loader2 className="h-5 w-5 text-muted-foreground animate-spin" />
                ) : (
                  <ImagePlus className="h-5 w-5 text-muted-foreground" />
                )}
              </button>
            )}
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate pr-8">
                {pkg?.fileName ?? "Package Files"}
              </DialogTitle>
              <DialogDescription className="mt-1">
                {total.toLocaleString()} file{total !== 1 ? "s" : ""} in archive
              </DialogDescription>
              {pkg && (
                <div className="mt-2 flex items-center gap-2">
                  <SendToTelegramButton
                    packageId={pkg.id}
                    packageName={pkg.fileName}
                  />
                  {pkg.archiveType !== "DOCUMENT" && !pkg.isMultipart && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5 text-xs"
                      onClick={() => setShowPreviewPicker(true)}
                    >
                      <Images className="h-3.5 w-3.5" />
                      Pick Preview
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Search within file list */}
          {files.length > 0 && (
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Filter files..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 h-9"
              />
            </div>
          )}
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0">
          <div className="px-4 py-3">
            {loading ? (
              <div className="flex flex-col items-center justify-center gap-2 py-12">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Loading files...</span>
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-12">
                <FileText className="h-6 w-6 text-muted-foreground/50" />
                <span className="text-sm text-muted-foreground">
                  {search ? "No matching files" : "No files indexed"}
                </span>
              </div>
            ) : hasNesting ? (
              <>
                {/* Render as folder tree */}
                {Array.from(tree.children.values())
                  .sort((a, b) => {
                    if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
                    return a.name.localeCompare(b.name);
                  })
                  .map((child) => (
                    <TreeNodeView
                      key={child.name}
                      node={child}
                      depth={0}
                      search={search}
                      defaultOpen={true}
                    />
                  ))}
              </>
            ) : (
              <>
                {/* Flat list for archives without folders */}
                {filtered.map((file) => (
                  <div
                    key={file.id}
                    className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/50 transition-colors"
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm truncate" title={file.path}>
                        {file.fileName}
                      </p>
                    </div>
                    {file.extension && (
                      <Badge
                        variant="outline"
                        className={`text-[10px] shrink-0 ${getExtBadgeClass(file.extension)}`}
                      >
                        .{file.extension}
                      </Badge>
                    )}
                    <span className="text-[11px] text-muted-foreground shrink-0 tabular-nums">
                      {formatBytes(file.uncompressedSize)}
                    </span>
                  </div>
                ))}
              </>
            )}

            {/* Load more button */}
            {hasMore && !search && (
              <div className="flex justify-center pt-3 pb-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="gap-1"
                >
                  {loadingMore ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5" />
                  )}
                  Load more ({files.length} of {total.toLocaleString()})
                </Button>
              </div>
            )}
          </div>
        </ScrollArea>
      </DialogContent>

      {/* Archive preview picker modal */}
      {pkg && pkg.archiveType !== "DOCUMENT" && !pkg.isMultipart && (
        <ArchivePreviewPicker
          packageId={pkg.id}
          packageName={pkg.fileName}
          open={showPreviewPicker}
          onOpenChange={setShowPreviewPicker}
          onPreviewSet={() => {
            // Refresh the preview by setting a cache-busting URL
            setLocalPreviewUrl(`/api/zips/${pkg.id}/preview?t=${Date.now()}`);
          }}
        />
      )}
    </Dialog>
  );
}
