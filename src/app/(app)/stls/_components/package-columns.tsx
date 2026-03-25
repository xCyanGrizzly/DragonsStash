"use client";

import { type ColumnDef } from "@tanstack/react-table";
import { FileArchive, Eye, ChevronRight, Layers, Ungroup, Send, ImagePlus } from "lucide-react";
import { DataTableColumnHeader } from "@/components/shared/data-table-column-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SendToTelegramButton } from "./send-to-telegram-button";

export interface PackageRow {
  id: string;
  fileName: string;
  fileSize: string;
  contentHash: string;
  archiveType: "ZIP" | "RAR" | "SEVEN_Z" | "DOCUMENT";
  fileCount: number;
  isMultipart: boolean;
  hasPreview: boolean;
  creator: string | null;
  tags: string[];
  indexedAt: string;
  sourceChannel: {
    id: string;
    title: string;
  };
  matchedFileCount: number;
  matchedByContent: boolean;
  packageGroupId?: string | null;
}

export interface GroupHeaderRow {
  _rowType: "group";
  id: string;
  name: string;
  hasPreview: boolean;
  totalFileSize: string;
  totalFileCount: number;
  packageCount: number;
  combinedTags: string[];
  archiveTypes: ("ZIP" | "RAR" | "SEVEN_Z" | "DOCUMENT")[];
  latestIndexedAt: string;
  sourceChannel: { id: string; title: string };
  _expanded: boolean;
}

export interface PackageTableRow extends PackageRow {
  _rowType: "package";
  _groupId: string | null;
  _isGroupMember: boolean;
}

export type StlTableRow = GroupHeaderRow | PackageTableRow;

function isGroupRow(row: StlTableRow): row is GroupHeaderRow {
  return row._rowType === "group";
}

interface PackageColumnsProps {
  onViewFiles: (pkg: PackageRow) => void;
  onSetCreator: (pkg: PackageRow) => void;
  onSetTags: (pkg: PackageRow) => void;
  searchTerm: string;
  onToggleGroup: (groupId: string) => void;
  onRenameGroup: (groupId: string, currentName: string) => void;
  onDissolveGroup: (groupId: string) => void;
  onSendAllInGroup: (groupId: string) => void;
  onRemoveFromGroup: (packageId: string) => void;
  onGroupPreviewUpload: (groupId: string) => void;
  selectedPackages: Set<string>;
  onToggleSelect: (packageId: string) => void;
}

export function formatBytes(bytesStr: string): string {
  const bytes = Number(bytesStr);
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function PreviewCell({ pkg }: { pkg: PackageRow }) {
  if (pkg.hasPreview) {
    return (
      <img
        src={`/api/zips/${pkg.id}/preview`}
        alt=""
        className="h-9 w-9 rounded-md object-cover bg-muted"
        loading="lazy"
      />
    );
  }
  return (
    <div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted">
      <FileArchive className="h-4 w-4 text-muted-foreground" />
    </div>
  );
}

function GroupPreviewCell({
  group,
  onUpload,
}: {
  group: GroupHeaderRow;
  onUpload: (groupId: string) => void;
}) {
  if (group.hasPreview) {
    return (
      <button
        className="relative group/preview cursor-pointer"
        onClick={() => onUpload(group.id)}
        title="Click to change preview image"
      >
        <img
          src={`/api/groups/${group.id}/preview`}
          alt=""
          className="h-9 w-9 rounded-md object-cover bg-muted"
          loading="lazy"
        />
        <div className="absolute inset-0 flex items-center justify-center rounded-md bg-black/50 opacity-0 group-hover/preview:opacity-100 transition-opacity">
          <ImagePlus className="h-3.5 w-3.5 text-white" />
        </div>
      </button>
    );
  }
  return (
    <button
      className="flex h-9 w-9 items-center justify-center rounded-md bg-muted hover:bg-muted/80 transition-colors cursor-pointer"
      onClick={() => onUpload(group.id)}
      title="Click to add preview image"
    >
      <Layers className="h-4 w-4 text-muted-foreground" />
    </button>
  );
}

export function getPackageColumns({
  onViewFiles,
  onSetCreator,
  onSetTags,
  searchTerm,
  onToggleGroup,
  onRenameGroup,
  onDissolveGroup,
  onSendAllInGroup,
  onRemoveFromGroup,
  onGroupPreviewUpload,
  selectedPackages,
  onToggleSelect,
}: PackageColumnsProps): ColumnDef<StlTableRow, unknown>[] {
  return [
    {
      id: "select",
      header: "",
      cell: ({ row }) => {
        const data = row.original;
        if (isGroupRow(data)) return null;
        return (
          <Checkbox
            checked={selectedPackages.has(data.id)}
            onCheckedChange={() => onToggleSelect(data.id)}
            aria-label="Select package"
            className="translate-y-[2px]"
          />
        );
      },
      enableHiding: false,
      enableSorting: false,
      size: 32,
    },
    {
      id: "preview",
      header: "",
      cell: ({ row }) => {
        const data = row.original;
        if (isGroupRow(data)) {
          return (
            <div className="flex items-center gap-1">
              <button
                className="shrink-0 p-0.5 cursor-pointer"
                onClick={() => onToggleGroup(data.id)}
                aria-label={data._expanded ? "Collapse group" : "Expand group"}
              >
                <ChevronRight
                  className={`h-4 w-4 text-muted-foreground transition-transform ${
                    data._expanded ? "rotate-90" : ""
                  }`}
                />
              </button>
              <GroupPreviewCell group={data} onUpload={onGroupPreviewUpload} />
            </div>
          );
        }
        return (
          <div className={data._isGroupMember ? "pl-5" : ""}>
            <PreviewCell pkg={data} />
          </div>
        );
      },
      enableHiding: false,
      enableSorting: false,
      size: 72,
    },
    {
      accessorKey: "fileName",
      header: ({ column }) => <DataTableColumnHeader column={column} title="File Name" />,
      cell: ({ row }) => {
        const data = row.original;
        if (isGroupRow(data)) {
          return (
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <button
                  className="font-semibold truncate max-w-[300px] cursor-pointer hover:underline text-left"
                  onClick={() => onRenameGroup(data.id, data.name)}
                  title="Click to rename group"
                >
                  {data.name}
                </button>
                <Badge variant="secondary" className="text-[10px] shrink-0">
                  {data.packageCount} pkg{data.packageCount !== 1 ? "s" : ""}
                </Badge>
              </div>
            </div>
          );
        }
        return (
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium truncate max-w-[300px]">{data.fileName}</span>
              {data.isMultipart && (
                <Badge variant="outline" className="text-[10px] shrink-0">
                  Multi
                </Badge>
              )}
            </div>
            {searchTerm && data.matchedByContent && (
              <button
                className="text-[11px] text-amber-500 hover:text-amber-400 hover:underline cursor-pointer mt-0.5"
                onClick={() => onViewFiles(data)}
              >
                {data.matchedFileCount.toLocaleString()} file match{data.matchedFileCount !== 1 ? "es" : ""}
              </button>
            )}
          </div>
        );
      },
      enableHiding: false,
    },
    {
      accessorKey: "archiveType",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Type" />,
      cell: ({ row }) => {
        const data = row.original;
        if (isGroupRow(data)) {
          const types = data.archiveTypes;
          if (types.length === 1) {
            return (
              <Badge variant="secondary" className="text-[10px]">
                {types[0]}
              </Badge>
            );
          }
          return (
            <Badge variant="secondary" className="text-[10px]">
              Mixed
            </Badge>
          );
        }
        return (
          <Badge variant="secondary" className="text-[10px]">
            {data.archiveType}
          </Badge>
        );
      },
    },
    {
      accessorKey: "fileSize",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Size" />,
      cell: ({ row }) => {
        const data = row.original;
        const size = isGroupRow(data) ? data.totalFileSize : data.fileSize;
        return (
          <span className="text-sm text-muted-foreground">
            {formatBytes(size)}
          </span>
        );
      },
    },
    {
      accessorKey: "fileCount",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Files" />,
      cell: ({ row }) => {
        const data = row.original;
        const count = isGroupRow(data) ? data.totalFileCount : data.fileCount;
        return (
          <span className="text-sm">
            {count.toLocaleString()}
          </span>
        );
      },
    },
    {
      accessorKey: "creator",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Creator" />,
      cell: ({ row }) => {
        const data = row.original;
        if (isGroupRow(data)) {
          return <span className="text-sm text-muted-foreground">{"\u2014"}</span>;
        }
        return (
          <button
            className="text-sm text-muted-foreground truncate max-w-[160px] block hover:text-foreground hover:underline cursor-pointer text-left"
            onClick={() => onSetCreator(data)}
            title="Click to edit creator"
          >
            {data.creator || "\u2014"}
          </button>
        );
      },
    },
    {
      id: "tags",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Tags" />,
      cell: ({ row }) => {
        const data = row.original;
        const tags = isGroupRow(data) ? data.combinedTags : data.tags;
        if (tags.length === 0) {
          if (isGroupRow(data)) {
            return <span className="text-sm text-muted-foreground">{"\u2014"}</span>;
          }
          return (
            <button
              className="text-sm text-muted-foreground hover:text-foreground cursor-pointer"
              onClick={() => onSetTags(data)}
              title="Click to add tags"
            >
              {"\u2014"}
            </button>
          );
        }
        const clickHandler = isGroupRow(data) ? undefined : () => onSetTags(data as PackageTableRow);
        return (
          <button
            className={`flex flex-wrap gap-1 ${clickHandler ? "cursor-pointer" : "cursor-default"}`}
            onClick={clickHandler}
            title={clickHandler ? "Click to edit tags" : undefined}
          >
            {tags.map((tag) => (
              <Badge
                key={tag}
                variant="outline"
                className="text-[10px] bg-primary/5"
              >
                {tag}
              </Badge>
            ))}
          </button>
        );
      },
      accessorFn: (row) => {
        if (isGroupRow(row)) return row.combinedTags.join(", ");
        return row.tags.join(", ");
      },
    },
    {
      id: "channel",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Source" />,
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground truncate max-w-[160px] block">
          {row.original.sourceChannel.title}
        </span>
      ),
      accessorFn: (row) => row.sourceChannel.title,
    },
    {
      accessorKey: "indexedAt",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Indexed" />,
      cell: ({ row }) => {
        const data = row.original;
        const date = isGroupRow(data) ? data.latestIndexedAt : data.indexedAt;
        return (
          <span className="text-sm text-muted-foreground">
            {new Date(date).toLocaleDateString()}
          </span>
        );
      },
    },
    {
      id: "actions",
      cell: ({ row }) => {
        const data = row.original;
        if (isGroupRow(data)) {
          return (
            <div className="flex items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => onSendAllInGroup(data.id)}
                title="Send all packages in group"
              >
                <Send className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => onDissolveGroup(data.id)}
                title="Dissolve group"
              >
                <Ungroup className="h-4 w-4" />
              </Button>
            </div>
          );
        }
        return (
          <div className="flex items-center gap-0.5">
            <SendToTelegramButton
              packageId={data.id}
              packageName={data.fileName}
              variant="icon"
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => onViewFiles(data)}
            >
              <Eye className="h-4 w-4" />
            </Button>
            {data._isGroupMember && (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={() => onRemoveFromGroup(data.id)}
                title="Remove from group"
              >
                <Ungroup className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        );
      },
      enableHiding: false,
    },
  ];
}
