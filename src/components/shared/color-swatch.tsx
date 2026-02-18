import { cn } from "@/lib/utils";

interface ColorSwatchProps {
  hex: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const sizeClasses = {
  sm: "h-4 w-4",
  md: "h-6 w-6",
  lg: "h-8 w-8",
};

export function ColorSwatch({ hex, size = "sm", className }: ColorSwatchProps) {
  return (
    <div
      className={cn(
        "rounded-sm border border-border",
        sizeClasses[size],
        className
      )}
      style={{ backgroundColor: hex }}
      title={hex}
    />
  );
}

export function ColorPreviewStrip({ hex, className }: { hex: string; className?: string }) {
  return (
    <div
      className={cn("h-full w-1 rounded-full", className)}
      style={{ backgroundColor: hex }}
      title={hex}
    />
  );
}
