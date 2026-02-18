"use client";

import { type Column } from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface DataTableColumnHeaderProps<TData, TValue> {
  column: Column<TData, TValue>;
  title: string;
  className?: string;
}

export function DataTableColumnHeader<TData, TValue>({
  column,
  title,
  className,
}: DataTableColumnHeaderProps<TData, TValue>) {
  if (!column.getCanSort()) {
    return <div className={cn(className)}>{title}</div>;
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn("-ml-3 h-8 text-xs", className)}
      onClick={() => {
        const currentSort = column.getIsSorted();
        if (currentSort === false) {
          column.toggleSorting(false);
        } else if (currentSort === "asc") {
          column.toggleSorting(true);
        } else {
          column.clearSorting();
        }
      }}
    >
      <span>{title}</span>
      {column.getIsSorted() === "desc" ? (
        <ArrowDown className="ml-1 h-3 w-3" />
      ) : column.getIsSorted() === "asc" ? (
        <ArrowUp className="ml-1 h-3 w-3" />
      ) : (
        <ArrowUpDown className="ml-1 h-3 w-3 opacity-50" />
      )}
    </Button>
  );
}
