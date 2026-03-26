"use client";

import { useState, useTransition, useCallback, useEffect } from "react";
import { Search, Package, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { linkPackages } from "../actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";

interface PackageResult {
  id: string;
  fileName: string;
  fileSize: string;
  archiveType: string;
  creator: string | null;
  fileCount: number;
}

interface PackageLinkerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kickstarterId: string;
  kickstarterName: string;
}

function formatSize(bytes: string | number): string {
  const b = Number(bytes);
  if (b >= 1024 * 1024 * 1024) return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(0)} MB`;
  return `${(b / 1024).toFixed(0)} KB`;
}

export function PackageLinkerDialog({
  open,
  onOpenChange,
  kickstarterId,
  kickstarterName,
}: PackageLinkerDialogProps) {
  const [isPending, startTransition] = useTransition();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<PackageResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Fetch currently linked packages when dialog opens
  useEffect(() => {
    if (open) {
      setSearchQuery("");
      setSearchResults([]);
      fetch(`/api/packages/linked?kickstarterId=${kickstarterId}`)
        .then((res) => res.json())
        .then((data) => {
          if (data.packageIds) {
            setSelectedIds(new Set(data.packageIds));
          }
        })
        .catch(() => {});
    }
  }, [open, kickstarterId]);

  const doSearch = useCallback(async (query: string) => {
    if (query.length < 2) {
      setSearchResults([]);
      return;
    }
    setIsSearching(true);
    try {
      const res = await fetch(`/api/packages/search?q=${encodeURIComponent(query)}&limit=20`);
      if (res.ok) {
        const data = await res.json();
        setSearchResults(data.packages ?? []);
      }
    } catch {
      // Ignore search errors
    } finally {
      setIsSearching(false);
    }
  }, []);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => doSearch(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery, doSearch]);

  function togglePackage(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleSave() {
    startTransition(async () => {
      const result = await linkPackages(kickstarterId, Array.from(selectedIds));
      if (result.success) {
        toast.success(`Linked ${selectedIds.size} package(s) to "${kickstarterName}"`);
        onOpenChange(false);
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Link Packages</DialogTitle>
          <DialogDescription>
            Search and select STL packages to link to &ldquo;{kickstarterName}&rdquo;.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Package className="h-4 w-4" />
              {selectedIds.size} package(s) selected
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => setSelectedIds(new Set())}
              >
                Clear all
              </Button>
            </div>
          )}

          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search packages by name or creator..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
              autoFocus
            />
            {isSearching && (
              <Loader2 className="absolute right-2.5 top-2.5 h-4 w-4 animate-spin text-muted-foreground" />
            )}
          </div>

          <ScrollArea className="h-[300px] rounded-md border">
            <div className="p-2 space-y-1">
              {searchResults.length === 0 && searchQuery.length >= 2 && !isSearching && (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No packages found
                </p>
              )}
              {searchQuery.length < 2 && (
                <p className="text-sm text-muted-foreground text-center py-8">
                  Type at least 2 characters to search
                </p>
              )}
              {searchResults.map((pkg) => (
                <label
                  key={pkg.id}
                  className="flex items-center gap-3 p-2 rounded-md hover:bg-muted/50 cursor-pointer"
                >
                  <Checkbox
                    checked={selectedIds.has(pkg.id)}
                    onCheckedChange={() => togglePackage(pkg.id)}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{pkg.fileName}</p>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      {pkg.creator && <span>{pkg.creator}</span>}
                      <span>{formatSize(pkg.fileSize)}</span>
                      <Badge variant="outline" className="text-[10px] h-4 px-1">
                        {pkg.archiveType}
                      </Badge>
                      {pkg.fileCount > 0 && <span>{pkg.fileCount} files</span>}
                    </div>
                  </div>
                  {selectedIds.has(pkg.id) && (
                    <X className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  )}
                </label>
              ))}
            </div>
          </ScrollArea>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isPending}>
            {isPending ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
            Save ({selectedIds.size})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
