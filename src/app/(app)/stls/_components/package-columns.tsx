"use client";

import { type ColumnDef } from "@tanstack/react-table";
import { FileArchive, Eye } from "lucide-react";
import { DataTableColumnHeader } from "@/components/shared/data-table-column-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
}

interface PackageColumnsProps {
  onViewFiles: (pkg: PackageRow) => void;
  onSetCreator: (pkg: PackageRow) => void;
  onSetTags: (pkg: PackageRow) => void;
}

function formatBytes(bytesStr: string): string {
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

export function getPackageColumns({
  onViewFiles,
  onSetCreator,
  onSetTags,
}: PackageColumnsProps): ColumnDef<PackageRow, unknown>[] {
  return [
    {
      id: "preview",
      header: "",
      cell: ({ row }) => <PreviewCell pkg={row.original} />,
      enableHiding: false,
      enableSorting: false,
      size: 52,
    },
    {
      accessorKey: "fileName",
      header: ({ column }) => <DataTableColumnHeader column={column} title="File Name" />,
      cell: ({ row }) => (
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium truncate max-w-[300px]">{row.original.fileName}</span>
          {row.original.isMultipart && (
            <Badge variant="outline" className="text-[10px] shrink-0">
              Multi
            </Badge>
          )}
        </div>
      ),
      enableHiding: false,
    },
    {
      accessorKey: "archiveType",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Type" />,
      cell: ({ row }) => (
        <Badge variant="secondary" className="text-[10px]">
          {row.original.archiveType}
        </Badge>
      ),
    },
    {
      accessorKey: "fileSize",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Size" />,
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {formatBytes(row.original.fileSize)}
        </span>
      ),
    },
    {
      accessorKey: "fileCount",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Files" />,
      cell: ({ row }) => (
        <span className="text-sm">
          {row.original.fileCount.toLocaleString()}
        </span>
      ),
    },
    {
      accessorKey: "creator",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Creator" />,
      cell: ({ row }) => (
        <button
          className="text-sm text-muted-foreground truncate max-w-[160px] block hover:text-foreground hover:underline cursor-pointer text-left"
          onClick={() => onSetCreator(row.original)}
          title="Click to edit creator"
        >
          {row.original.creator || "\u2014"}
        </button>
      ),
    },
    {
      id: "tags",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Tags" />,
      cell: ({ row }) => {
        const tags = row.original.tags;
        if (tags.length === 0) {
          return (
            <button
              className="text-sm text-muted-foreground hover:text-foreground cursor-pointer"
              onClick={() => onSetTags(row.original)}
              title="Click to add tags"
            >
              {"\u2014"}
            </button>
          );
        }
        return (
          <button
            className="flex flex-wrap gap-1 cursor-pointer"
            onClick={() => onSetTags(row.original)}
            title="Click to edit tags"
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
      accessorFn: (row) => row.tags.join(", "),
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
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {new Date(row.original.indexedAt).toLocaleDateString()}
        </span>
      ),
    },
    {
      id: "actions",
      cell: ({ row }) => (
        <div className="flex items-center gap-0.5">
          <SendToTelegramButton
            packageId={row.original.id}
            packageName={row.original.fileName}
            variant="icon"
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => onViewFiles(row.original)}
          >
            <Eye className="h-4 w-4" />
          </Button>
        </div>
      ),
      enableHiding: false,
    },
  ];
}
