"use client";

import { useState, useRef, useTransition, useEffect } from "react";
import { Upload, File, X, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface UploadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

type UploadStatus = "idle" | "uploading" | "processing" | "done" | "error";

export function UploadDialog({ open, onOpenChange }: UploadDialogProps) {
  const [files, setFiles] = useState<File[]>([]);
  const [groupName, setGroupName] = useState("");
  const [status, setStatus] = useState<UploadStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (open) {
      setFiles([]);
      setGroupName("");
      setStatus("idle");
      setError(null);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [open]);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) {
      setFiles(Array.from(e.target.files));
    }
  }

  function removeFile(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }

  function handleUpload() {
    if (files.length === 0) return;

    startTransition(async () => {
      setStatus("uploading");
      setError(null);

      try {
        const formData = new FormData();
        for (const file of files) {
          formData.append("files", file);
        }
        if (groupName.trim()) {
          formData.append("groupName", groupName.trim());
        }

        const res = await fetch("/api/uploads", {
          method: "POST",
          body: formData,
        });

        const data = await res.json();
        if (!res.ok) {
          setStatus("error");
          setError(data.error ?? "Upload failed");
          return;
        }

        setStatus("processing");

        // Poll for completion
        pollRef.current = setInterval(async () => {
          try {
            const statusRes = await fetch(`/api/uploads/${data.uploadId}`);
            const statusData = await statusRes.json();

            if (statusData.status === "COMPLETED") {
              setStatus("done");
              toast.success(`${files.length} file(s) uploaded and indexed`);
              if (pollRef.current) clearInterval(pollRef.current);
            } else if (statusData.status === "FAILED") {
              setStatus("error");
              setError(statusData.errorMessage ?? "Processing failed");
              if (pollRef.current) clearInterval(pollRef.current);
            }
          } catch {
            // Keep polling
          }
        }, 3000);

        // Stop polling after 10 minutes
        setTimeout(() => {
          if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
            setStatus((s) => s === "processing" ? "done" : s);
          }
        }, 600_000);
      } catch {
        setStatus("error");
        setError("Network error");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Upload Files</DialogTitle>
          <DialogDescription>
            Upload archive files to be processed and indexed. Multiple files will be automatically grouped.
          </DialogDescription>
        </DialogHeader>

        {status === "idle" && (
          <div className="space-y-4">
            <div
              className="border-2 border-dashed rounded-lg p-8 text-center cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                Click to select files or drag & drop
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                ZIP, RAR, 7Z files up to 4GB each
              </p>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".zip,.rar,.7z,.pdf,.stl"
                onChange={handleFileChange}
                className="hidden"
              />
            </div>

            {files.length > 0 && (
              <div className="space-y-2">
                {files.map((file, i) => (
                  <div key={i} className="flex items-center gap-2 p-2 rounded bg-muted/30">
                    <File className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="text-sm flex-1 truncate">{file.name}</span>
                    <span className="text-xs text-muted-foreground">{formatSize(file.size)}</span>
                    <button onClick={() => removeFile(i)} className="p-0.5 hover:text-destructive">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {files.length > 1 && (
              <div>
                <Label htmlFor="groupName" className="text-sm">Group Name (optional)</Label>
                <Input
                  id="groupName"
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  placeholder="Auto-generated from filenames"
                  className="mt-1"
                />
              </div>
            )}
          </div>
        )}

        {(status === "uploading" || status === "processing") && (
          <div className="flex items-center gap-3 p-6 rounded-lg bg-muted/30 border">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
            <div>
              <p className="text-sm font-medium">
                {status === "uploading" ? "Uploading files..." : "Processing & uploading to Telegram..."}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {status === "uploading"
                  ? "Sending files to server"
                  : "Hashing, extracting metadata, uploading to destination channel"}
              </p>
            </div>
          </div>
        )}

        {status === "done" && (
          <div className="flex items-center gap-3 p-6 rounded-lg bg-green-500/10 border border-green-500/20">
            <CheckCircle2 className="h-6 w-6 text-green-500" />
            <div>
              <p className="text-sm font-medium text-green-500">Upload complete!</p>
              <p className="text-xs text-muted-foreground">Files have been indexed and uploaded to Telegram.</p>
            </div>
          </div>
        )}

        {status === "error" && (
          <div className="flex items-center gap-3 p-6 rounded-lg bg-destructive/10 border border-destructive/20">
            <AlertCircle className="h-6 w-6 text-destructive" />
            <div>
              <p className="text-sm font-medium text-destructive">Upload failed</p>
              <p className="text-xs text-muted-foreground">{error}</p>
            </div>
          </div>
        )}

        <DialogFooter>
          {status === "idle" && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={handleUpload} disabled={files.length === 0 || isPending}>
                <Upload className="h-4 w-4 mr-1" />
                Upload {files.length > 0 ? `(${files.length})` : ""}
              </Button>
            </>
          )}
          {(status === "done" || status === "error") && (
            <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
