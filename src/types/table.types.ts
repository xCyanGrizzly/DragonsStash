export interface DataTableSearchParams {
  page?: string;
  perPage?: string;
  sort?: string;
  order?: "asc" | "desc";
  search?: string;
  [key: string]: string | string[] | undefined;
}

export interface PaginatedResult<T> {
  data: T[];
  pageCount: number;
  totalCount: number;
}

export interface DataTableFilterOption {
  label: string;
  value: string;
}
