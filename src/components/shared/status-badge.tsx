import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type StatusVariant = "inStock" | "lowStock" | "empty" | "archived";

interface StatusBadgeProps {
  variant: StatusVariant;
  className?: string;
}

const variantConfig: Record<StatusVariant, { label: string; className: string }> = {
  inStock: {
    label: "In Stock",
    className: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  },
  lowStock: {
    label: "Low Stock",
    className: "bg-orange-500/15 text-orange-400 border-orange-500/30",
  },
  empty: {
    label: "Empty",
    className: "bg-red-500/15 text-red-400 border-red-500/30",
  },
  archived: {
    label: "Archived",
    className: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
  },
};

export function StatusBadge({ variant, className }: StatusBadgeProps) {
  const config = variantConfig[variant];

  return (
    <Badge variant="outline" className={cn("text-[10px] font-medium", config.className, className)}>
      {config.label}
    </Badge>
  );
}

export function getStockStatus(
  remaining: number,
  total: number,
  threshold: number,
  archived: boolean
): StatusVariant {
  if (archived) return "archived";
  const percent = total > 0 ? (remaining / total) * 100 : 0;
  if (percent <= 0) return "empty";
  if (percent <= threshold) return "lowStock";
  return "inStock";
}
