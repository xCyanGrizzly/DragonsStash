import { Flame } from "lucide-react";

export default function Loading() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Flame className="h-8 w-8 animate-pulse text-primary" />
    </div>
  );
}
