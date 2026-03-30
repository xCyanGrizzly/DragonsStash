"use client";

import { useState, useCallback, useTransition, useMemo, useRef } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Search, Layers } from "lucide-react";
import { useDataTable } from "@/hooks/use-data-table";
import {
  getPackageColumns,
  type PackageRow,
  type StlTableRow,
  type PackageTableRow,
  type GroupHeaderRow,
} from "./package-columns";
import { PackageFilesDrawer } from "./package-files-drawer";
import { IngestionStatus } from "./ingestion-status";
import { SkippedPackagesTab } from "./skipped-packages-tab";
import { DataTable } from "@/components/shared/data-table";
import { DataTablePagination } from "@/components/shared/data-table-pagination";
import { DataTableViewOptions } from "@/components/shared/data-table-view-options";
import { PageHeader } from "@/components/shared/page-header";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import type { DisplayItem, IngestionAccountStatus, PackageListItem } from "@/lib/telegram/types";
import type { SkippedRow } from "./skipped-columns";
import {
  updatePackageCreator,
  updatePackageTags,
  renameGroupAction,
  dissolveGroupAction,
  createGroupAction,
  removeFromGroupAction,
  sendAllInGroupAction,
  updateGroupPreviewAction,
  mergeGroupsAction,
} from "../actions";

interface StlTableProps {
  data: DisplayItem[];
  pageCount: number;
  totalCount: number;
  ingestionStatus: IngestionAccountStatus[];
  availableTags: string[];
  searchTerm: string;
  skippedData: SkippedRow[];
  skippedPageCount: number;
  skippedTotalCount: number;
  ungroupedData: PackageListItem[];
  ungroupedPageCount: number;
  ungroupedTotalCount: number;
}

export function StlTable({
  data,
  pageCount,
  totalCount,
  ingestionStatus,
  availableTags,
  searchTerm,
  skippedData,
  skippedPageCount,
  skippedTotalCount,
  ungroupedData,
  ungroupedPageCount,
  ungroupedTotalCount,
}: StlTableProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [searchValue, setSearchValue] = useState(searchParams.get("search") ?? "");
  const [viewPkg, setViewPkg] = useState<PackageRow | null>(null);
  const [, startTransition] = useTransition();

  // Group expansion state
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // Package selection state (for manual grouping)
  const [selectedPackages, setSelectedPackages] = useState<Set<string>>(new Set());

  // Create group dialog state
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const [groupName, setGroupName] = useState("");

  // Group preview upload ref
  const previewInputRef = useRef<HTMLInputElement>(null);
  const [uploadGroupId, setUploadGroupId] = useState<string | null>(null);

  // Group merge state
  const [mergeSourceId, setMergeSourceId] = useState<string | null>(null);

  const toggleGroup = useCallback((groupId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  const toggleSelect = useCallback((packageId: string) => {
    setSelectedPackages((prev) => {
      const next = new Set(prev);
      if (next.has(packageId)) {
        next.delete(packageId);
      } else {
        next.add(packageId);
      }
      return next;
    });
  }, []);

  // Flatten DisplayItem[] into StlTableRow[] based on expansion state
  const tableRows: StlTableRow[] = useMemo(() => {
    const rows: StlTableRow[] = [];
    for (const item of data) {
      if (item.type === "package") {
        rows.push({
          ...item.data,
          _rowType: "package" as const,
          _groupId: null,
          _isGroupMember: false,
        });
      } else {
        const group = item.data;
        const isExpanded = expandedGroups.has(group.id);
        rows.push({
          _rowType: "group" as const,
          id: group.id,
          name: group.name,
          hasPreview: group.hasPreview,
          totalFileSize: group.totalFileSize,
          totalFileCount: group.totalFileCount,
          packageCount: group.packageCount,
          combinedTags: group.combinedTags,
          archiveTypes: group.archiveTypes,
          latestIndexedAt: group.latestIndexedAt,
          sourceChannel: group.sourceChannel,
          _expanded: isExpanded,
        });
        if (isExpanded) {
          for (const pkg of group.packages) {
            rows.push({
              ...pkg,
              _rowType: "package" as const,
              _groupId: group.id,
              _isGroupMember: true,
              packageGroupId: group.id,
            });
          }
        }
      }
    }
    return rows;
  }, [data, expandedGroups]);

  const updateSearch = useCallback(
    (value: string) => {
      setSearchValue(value);
      const params = new URLSearchParams(searchParams.toString());
      if (value) {
        params.set("search", value);
        params.set("page", "1");
      } else {
        params.delete("search");
      }
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams]
  );

  const updateTagFilter = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value && value !== "all") {
        params.set("tag", value);
        params.set("page", "1");
      } else {
        params.delete("tag");
      }
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams]
  );

  const activeTab = searchParams.get("tab") ?? "packages";

  const updateTab = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === "packages") {
        params.delete("tab");
      } else {
        params.set("tab", value);
      }
      params.set("page", "1");
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams]
  );

  const handleRenameGroup = useCallback(
    (groupId: string, currentName: string) => {
      const value = prompt("Enter group name:", currentName);
      if (value === null || value.trim() === currentName) return;
      startTransition(async () => {
        const result = await renameGroupAction(groupId, value);
        if (result.success) {
          toast.success(`Group renamed to "${value.trim()}"`);
          router.refresh();
        } else {
          toast.error(result.error);
        }
      });
    },
    [router]
  );

  const handleDissolveGroup = useCallback(
    (groupId: string) => {
      if (!confirm("Dissolve this group? Packages will become standalone items.")) return;
      startTransition(async () => {
        const result = await dissolveGroupAction(groupId);
        if (result.success) {
          toast.success("Group dissolved");
          setExpandedGroups((prev) => {
            const next = new Set(prev);
            next.delete(groupId);
            return next;
          });
          router.refresh();
        } else {
          toast.error(result.error);
        }
      });
    },
    [router]
  );

  const handleSendAllInGroup = useCallback(
    (groupId: string) => {
      if (!confirm("Send all packages in this group to your Telegram?")) return;
      startTransition(async () => {
        const result = await sendAllInGroupAction(groupId);
        if (result.success) {
          toast.success("Group packages queued for sending");
          router.refresh();
        } else {
          toast.error(result.error);
        }
      });
    },
    [router]
  );

  const handleRemoveFromGroup = useCallback(
    (packageId: string) => {
      startTransition(async () => {
        const result = await removeFromGroupAction(packageId);
        if (result.success) {
          toast.success("Package removed from group");
          router.refresh();
        } else {
          toast.error(result.error);
        }
      });
    },
    [router]
  );

  const handleCreateGroup = useCallback(() => {
    if (selectedPackages.size < 2) return;
    setGroupName("");
    setCreateGroupOpen(true);
  }, [selectedPackages.size]);

  const submitCreateGroup = useCallback(() => {
    if (!groupName.trim() || selectedPackages.size < 2) return;
    const ids = Array.from(selectedPackages);
    startTransition(async () => {
      const result = await createGroupAction(groupName, ids);
      if (result.success) {
        toast.success(`Group "${groupName.trim()}" created`);
        setSelectedPackages(new Set());
        setCreateGroupOpen(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }, [groupName, selectedPackages, router]);

  // Group preview upload handler (Task 12)
  const handleGroupPreviewUpload = useCallback((groupId: string) => {
    setUploadGroupId(groupId);
    // Trigger file input after state update
    setTimeout(() => {
      previewInputRef.current?.click();
    }, 0);
  }, []);

  const handlePreviewFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file || !uploadGroupId) return;

      const formData = new FormData();
      formData.append("file", file);

      startTransition(async () => {
        const result = await updateGroupPreviewAction(uploadGroupId, formData);
        if (result.success) {
          toast.success("Group preview updated");
          router.refresh();
        } else {
          toast.error(result.error);
        }
        setUploadGroupId(null);
      });

      // Reset input so the same file can be selected again
      e.target.value = "";
    },
    [uploadGroupId, router]
  );

  const handleStartMerge = useCallback((groupId: string) => {
    setMergeSourceId((prev) => {
      if (prev === groupId) {
        toast.info("Merge cancelled");
        return null;
      }
      toast.info("Merge source selected — click the merge-here button on the target group");
      return groupId;
    });
  }, []);

  const handleMergeGroups = useCallback(
    (targetGroupId: string) => {
      if (!mergeSourceId) return;
      const sourceId = mergeSourceId;
      startTransition(async () => {
        const result = await mergeGroupsAction(targetGroupId, sourceId);
        if (result.success) {
          toast.success("Groups merged successfully");
          setMergeSourceId(null);
          router.refresh();
        } else {
          toast.error(result.error);
        }
      });
    },
    [mergeSourceId, router]
  );

  const columns = getPackageColumns({
    onViewFiles: (pkg) => setViewPkg(pkg),
    searchTerm,
    onSetCreator: (pkg) => {
      const value = prompt("Enter creator name:", pkg.creator ?? "");
      if (value === null) return;
      startTransition(async () => {
        const result = await updatePackageCreator(pkg.id, value || null);
        if (result.success) {
          toast.success(value ? `Creator set to "${value}"` : "Creator removed");
          router.refresh();
        } else {
          toast.error(result.error);
        }
      });
    },
    onSetTags: (pkg) => {
      const value = prompt(
        "Enter tags (comma-separated):",
        pkg.tags.join(", ")
      );
      if (value === null) return;
      const tags = value.split(",").map((t) => t.trim()).filter(Boolean);
      startTransition(async () => {
        const result = await updatePackageTags(pkg.id, tags);
        if (result.success) {
          toast.success(tags.length > 0 ? `Tags updated` : "Tags removed");
          router.refresh();
        } else {
          toast.error(result.error);
        }
      });
    },
    onToggleGroup: toggleGroup,
    onRenameGroup: handleRenameGroup,
    onDissolveGroup: handleDissolveGroup,
    onSendAllInGroup: handleSendAllInGroup,
    onRemoveFromGroup: handleRemoveFromGroup,
    onGroupPreviewUpload: handleGroupPreviewUpload,
    selectedPackages,
    onToggleSelect: toggleSelect,
    mergeSourceId,
    onStartMerge: handleStartMerge,
    onCompleteMerge: handleMergeGroups,
  });

  const { table } = useDataTable({ data: tableRows, columns, pageCount });

  const ungroupedRows: StlTableRow[] = useMemo(
    () =>
      ungroupedData.map((pkg) => ({
        ...pkg,
        _rowType: "package" as const,
        _groupId: null,
        _isGroupMember: false,
      })),
    [ungroupedData]
  );

  const { table: ungroupedTable } = useDataTable({
    data: ungroupedRows,
    columns,
    pageCount: ungroupedPageCount,
  });

  const activeTag = searchParams.get("tag") ?? "";

  return (
    <div className="space-y-4">
      <PageHeader
        title="STL Files"
        description="Browse indexed archive packages from Telegram channels"
      >
        <IngestionStatus initialStatus={ingestionStatus} />
      </PageHeader>

      <Tabs value={activeTab} onValueChange={updateTab}>
        <TabsList>
          <TabsTrigger value="packages">Packages</TabsTrigger>
          <TabsTrigger value="skipped" className="gap-1.5">
            Skipped / Failed
            {skippedTotalCount > 0 && (
              <Badge variant="secondary" className="text-[10px] ml-1">
                {skippedTotalCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="ungrouped" className="gap-1.5">
            Ungrouped
            {ungroupedTotalCount > 0 && (
              <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                {ungroupedTotalCount}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="packages" className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[200px] max-w-sm">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search packages or files..."
                value={searchValue}
                onChange={(e) => updateSearch(e.target.value)}
                className="pl-9 h-9"
              />
            </div>
            {availableTags.length > 0 && (
              <Select value={activeTag || "all"} onValueChange={updateTagFilter}>
                <SelectTrigger className="w-[160px] h-9">
                  <SelectValue placeholder="All Tags" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Tags</SelectItem>
                  {availableTags.map((tag) => (
                    <SelectItem key={tag} value={tag}>
                      {tag}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <DataTableViewOptions table={table} />
            {selectedPackages.size >= 2 && (
              <Button
                variant="outline"
                size="sm"
                className="h-9 gap-1.5"
                onClick={handleCreateGroup}
              >
                <Layers className="h-3.5 w-3.5" />
                Group {selectedPackages.size} Selected
              </Button>
            )}
            {selectedPackages.size > 0 && selectedPackages.size < 2 && (
              <span className="text-xs text-muted-foreground">
                Select at least 2 packages to group
              </span>
            )}
          </div>

          <DataTable
            table={table}
            emptyMessage="No packages found. Archives will appear here after ingestion."
            rowClassName={(row) => {
              const data = row.original as StlTableRow;
              if (data._rowType === "group") {
                return "bg-muted/30 border-border";
              }
              if (data._rowType === "package" && (data as PackageTableRow)._isGroupMember) {
                return "bg-muted/10";
              }
              return "";
            }}
          />
          <DataTablePagination table={table} totalCount={totalCount} />
        </TabsContent>

        <TabsContent value="skipped">
          <SkippedPackagesTab
            data={skippedData}
            pageCount={skippedPageCount}
            totalCount={skippedTotalCount}
          />
        </TabsContent>

        <TabsContent value="ungrouped" className="space-y-4">
          <DataTable table={ungroupedTable} emptyMessage="All packages are grouped!" />
          <DataTablePagination table={ungroupedTable} totalCount={ungroupedTotalCount} />
        </TabsContent>
      </Tabs>

      <PackageFilesDrawer
        pkg={viewPkg}
        open={!!viewPkg}
        onOpenChange={(open) => {
          if (!open) setViewPkg(null);
        }}
        highlightTerm={searchTerm}
      />

      {/* Create Group Dialog */}
      <Dialog open={createGroupOpen} onOpenChange={setCreateGroupOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create Package Group</DialogTitle>
            <DialogDescription>
              Group {selectedPackages.size} selected packages together. Enter a name for the group.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Input
              placeholder="Group name..."
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitCreateGroup();
              }}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateGroupOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submitCreateGroup} disabled={!groupName.trim()}>
              <Layers className="h-4 w-4 mr-1" />
              Create Group
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Hidden file input for group preview upload (Task 12) */}
      <input
        ref={previewInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={handlePreviewFileChange}
      />
    </div>
  );
}
