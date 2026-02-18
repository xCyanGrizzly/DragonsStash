import { Package } from "lucide-react";

interface EmptyStateProps {
  message?: string;
  icon?: React.ReactNode;
}

export function EmptyState({
  message = "No results found",
  icon,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
      {icon || <Package className="h-8 w-8 text-muted-foreground/50" />}
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}
