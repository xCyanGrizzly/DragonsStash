"use client";

import { useEffect, useState, useCallback, useRef, useTransition } from "react";
import {
  Image as ImageIcon,
  Loader2,
  Check,
  AlertCircle,
  ImageOff,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { setPreviewFromExtract } from "../actions";

interface ArchiveImage {
  id: string;
  path: string;
  fileName: string;
  extension: string | null;
  size: string;
}

interface ThumbnailState {
  status: "idle" | "loading" | "loaded" | "failed";
  requestId?: string;
  imageUrl?: string;
  error?: string;
}

interface ArchivePreviewPickerProps {
  packageId: string;
  packageName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPreviewSet?: () => void;
}

function formatBytes(bytesStr: string): string {
  const bytes = Number(bytesStr);
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function ArchivePreviewPicker({
  packageId,
  packageName,
  open,
  onOpenChange,
  onPreviewSet,
}: ArchivePreviewPickerProps) {
  const [images, setImages] = useState<ArchiveImage[]>([]);
  const [loading, setLoading] = useState(false);
  const [thumbnails, setThumbnails] = useState<Map<string, ThumbnailState>>(new Map());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const pollTimers = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  // Track which paths have already been requested to avoid re-requesting
  const requestedPaths = useRef<Set<string>>(new Set());

  // Cleanup poll timers on unmount
  useEffect(() => {
    return () => {
      for (const timer of pollTimers.current.values()) {
        clearInterval(timer);
      }
    };
  }, []);

  // Fetch image list when opened
  useEffect(() => {
    if (!open) return;

    setImages([]);
    setThumbnails(new Map());
    setSelectedPath(null);
    requestedPaths.current.clear();

    // Clear any leftover poll timers
    for (const timer of pollTimers.current.values()) {
      clearInterval(timer);
    }
    pollTimers.current.clear();

    const fetchImages = async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/zips/${packageId}/images`);
        if (!res.ok) throw new Error("Failed to fetch images");
        const data = await res.json();
        setImages(data.images);
      } catch {
        toast.error("Failed to load archive images");
      } finally {
        setLoading(false);
      }
    };

    fetchImages();
  }, [open, packageId]);

  // Poll callback for a specific request
  const startPolling = useCallback(
    (filePath: string, requestId: string) => {
      // Clear any existing poll for this path
      const existing = pollTimers.current.get(filePath);
      if (existing) clearInterval(existing);

      const pollId = setInterval(async () => {
        try {
          const pollRes = await fetch(
            `/api/zips/${packageId}/extract/${requestId}`
          );
          if (!pollRes.ok) return;
          const pollData = await pollRes.json();

          if (pollData.status === "COMPLETED") {
            clearInterval(pollId);
            pollTimers.current.delete(filePath);
            setThumbnails((prev) => {
              const next = new Map(prev);
              next.set(filePath, {
                status: "loaded",
                requestId,
                imageUrl: `/api/zips/${packageId}/extract/${requestId}?image=true`,
              });
              return next;
            });
          } else if (pollData.status === "FAILED") {
            clearInterval(pollId);
            pollTimers.current.delete(filePath);
            setThumbnails((prev) => {
              const next = new Map(prev);
              next.set(filePath, {
                status: "failed",
                error: pollData.error || "Extraction failed",
              });
              return next;
            });
          }
        } catch {
          // Silently retry on network error
        }
      }, 2000);

      pollTimers.current.set(filePath, pollId);
    },
    [packageId]
  );

  // Request extraction for a specific image
  const requestThumbnail = useCallback(
    async (filePath: string) => {
      // Don't re-request if already in progress
      if (requestedPaths.current.has(filePath)) return;
      requestedPaths.current.add(filePath);

      setThumbnails((prev) => {
        const next = new Map(prev);
        next.set(filePath, { status: "loading" });
        return next;
      });

      try {
        const res = await fetch(`/api/zips/${packageId}/extract`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filePath }),
        });

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || "Extract failed");
        }

        const data = await res.json();

        if (data.status === "COMPLETED") {
          setThumbnails((prev) => {
            const next = new Map(prev);
            next.set(filePath, {
              status: "loaded",
              requestId: data.requestId,
              imageUrl: `/api/zips/${packageId}/extract/${data.requestId}?image=true`,
            });
            return next;
          });
          return;
        }

        // Pending or in-progress: start polling
        setThumbnails((prev) => {
          const next = new Map(prev);
          next.set(filePath, { status: "loading", requestId: data.requestId });
          return next;
        });

        startPolling(filePath, data.requestId);
      } catch (err) {
        requestedPaths.current.delete(filePath);
        setThumbnails((prev) => {
          const next = new Map(prev);
          next.set(filePath, {
            status: "failed",
            error: err instanceof Error ? err.message : "Failed to extract",
          });
          return next;
        });
      }
    },
    [packageId, startPolling]
  );

  // Auto-request thumbnails for the first batch of images
  useEffect(() => {
    if (!open || images.length === 0) return;

    // Request the first 12 images automatically
    const toRequest = images.slice(0, 12);
    for (const img of toRequest) {
      requestThumbnail(img.path);
    }
    // Only trigger when images list changes, not on every requestThumbnail change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [images, open]);

  // Handle selection confirmation
  const handleConfirm = () => {
    if (!selectedPath) return;
    const thumbState = thumbnails.get(selectedPath);
    if (!thumbState?.requestId) return;

    startTransition(async () => {
      const result = await setPreviewFromExtract(packageId, thumbState.requestId!);
      if (result.success) {
        toast.success("Preview updated from archive image");
        onOpenChange(false);
        onPreviewSet?.();
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[80vh] flex flex-col gap-0 p-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border space-y-1">
          <DialogTitle>Select Preview Image</DialogTitle>
          <DialogDescription className="text-sm">
            Choose an image from the archive to use as the preview for{" "}
            <span className="font-medium text-foreground">{packageName}</span>
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 min-h-0">
          <div className="p-4">
            {loading ? (
              <div className="flex flex-col items-center justify-center gap-2 py-12">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                <span className="text-sm text-muted-foreground">
                  Loading image list...
                </span>
              </div>
            ) : images.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-12">
                <ImageOff className="h-6 w-6 text-muted-foreground/50" />
                <span className="text-sm text-muted-foreground">
                  No images found in this archive
                </span>
              </div>
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                {images.map((img) => {
                  const thumbState = thumbnails.get(img.path);
                  const isSelected = selectedPath === img.path;
                  const isLoaded = thumbState?.status === "loaded";
                  const isLoading = thumbState?.status === "loading";
                  const isFailed = thumbState?.status === "failed";

                  return (
                    <button
                      key={img.id}
                      type="button"
                      className={cn(
                        "relative aspect-square rounded-lg overflow-hidden border-2 transition-all",
                        "hover:border-primary/50 cursor-pointer group",
                        isSelected
                          ? "border-primary ring-2 ring-primary/30"
                          : "border-border",
                        isFailed && "opacity-60"
                      )}
                      onClick={() => {
                        if (isLoaded) {
                          setSelectedPath(img.path);
                        } else if (isFailed) {
                          // Allow retry on failed
                          requestedPaths.current.delete(img.path);
                          requestThumbnail(img.path);
                        } else if (!thumbState || thumbState.status === "idle") {
                          requestThumbnail(img.path);
                        }
                      }}
                      title={img.path}
                    >
                      {isLoaded && thumbState.imageUrl ? (
                        <img
                          src={thumbState.imageUrl}
                          alt={img.fileName}
                          className="h-full w-full object-cover"
                          loading="lazy"
                        />
                      ) : isLoading ? (
                        <div className="h-full w-full flex items-center justify-center bg-muted">
                          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                        </div>
                      ) : isFailed ? (
                        <div className="h-full w-full flex flex-col items-center justify-center bg-muted gap-1">
                          <AlertCircle className="h-4 w-4 text-destructive" />
                          <span className="text-[10px] text-destructive px-1 text-center">
                            Click to retry
                          </span>
                        </div>
                      ) : (
                        <div className="h-full w-full flex items-center justify-center bg-muted">
                          <ImageIcon className="h-5 w-5 text-muted-foreground" />
                        </div>
                      )}

                      {/* Selection checkmark */}
                      {isSelected && (
                        <div className="absolute top-1.5 right-1.5 h-5 w-5 rounded-full bg-primary flex items-center justify-center">
                          <Check className="h-3 w-3 text-primary-foreground" />
                        </div>
                      )}

                      {/* File info overlay */}
                      <div className="absolute bottom-0 left-0 right-0 bg-black/60 px-1.5 py-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <p className="text-[10px] text-white truncate">
                          {img.fileName}
                        </p>
                        <p className="text-[9px] text-white/70">
                          {formatBytes(img.size)}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Footer */}
        {images.length > 0 && (
          <div className="px-6 py-4 border-t border-border flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              {images.length} image{images.length !== 1 ? "s" : ""} found
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={!selectedPath || isPending}
                onClick={handleConfirm}
              >
                {isPending ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                    Setting...
                  </>
                ) : (
                  "Use as Preview"
                )}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
