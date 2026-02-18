"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  type ColumnDef,
  type ColumnFiltersState,
  type PaginationState,
  type SortingState,
  type VisibilityState,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useCallback, useState } from "react";

interface UseDataTableProps<TData> {
  data: TData[];
  columns: ColumnDef<TData, unknown>[];
  pageCount: number;
  defaultPerPage?: number;
}

export function useDataTable<TData>({
  data,
  columns,
  pageCount,
  defaultPerPage = 20,
}: UseDataTableProps<TData>) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const page = Number(searchParams.get("page")) || 1;
  const perPage = Number(searchParams.get("perPage")) || defaultPerPage;
  const sort = searchParams.get("sort") ?? "";
  const order = (searchParams.get("order") as "asc" | "desc") ?? "desc";

  const pagination: PaginationState = {
    pageIndex: page - 1,
    pageSize: perPage,
  };

  const sorting: SortingState = sort ? [{ id: sort, desc: order === "desc" }] : [];

  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);

  const createQueryString = useCallback(
    (params: Record<string, string | null>) => {
      const newParams = new URLSearchParams(searchParams.toString());
      Object.entries(params).forEach(([key, value]) => {
        if (value === null) {
          newParams.delete(key);
        } else {
          newParams.set(key, value);
        }
      });
      return newParams.toString();
    },
    [searchParams]
  );

  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table API is safe in this context
  const table = useReactTable({
    data,
    columns,
    pageCount,
    state: {
      pagination,
      sorting,
      columnVisibility,
      columnFilters,
    },
    onPaginationChange: (updater) => {
      const newPagination = typeof updater === "function" ? updater(pagination) : updater;
      router.push(
        `${pathname}?${createQueryString({
          page: String(newPagination.pageIndex + 1),
          perPage: String(newPagination.pageSize),
        })}`,
        { scroll: false }
      );
    },
    onSortingChange: (updater) => {
      const newSorting = typeof updater === "function" ? updater(sorting) : updater;
      const [firstSort] = newSorting;
      router.push(
        `${pathname}?${createQueryString({
          sort: firstSort?.id ?? null,
          order: firstSort ? (firstSort.desc ? "desc" : "asc") : null,
          page: "1",
        })}`,
        { scroll: false }
      );
    },
    onColumnVisibilityChange: setColumnVisibility,
    onColumnFiltersChange: setColumnFilters,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    manualFiltering: true,
  });

  return { table };
}
