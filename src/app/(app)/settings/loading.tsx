import { Skeleton } from "@/components/ui/skeleton";

export default function SettingsLoading() {
  return (
    <div className="space-y-6">
      <div>
        <Skeleton className="h-8 w-32" />
        <Skeleton className="mt-1 h-4 w-64" />
      </div>
      <div className="max-w-2xl space-y-6">
        <div className="rounded-lg border p-6 space-y-4">
          <Skeleton className="h-6 w-40" />
          <div className="space-y-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
          <Skeleton className="h-9 w-24" />
        </div>
      </div>
    </div>
  );
}
