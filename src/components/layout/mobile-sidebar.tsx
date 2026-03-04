"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  LayoutDashboard,
  Cylinder,
  Droplets,
  Paintbrush,
  Gem,
  FileBox,
  Send,
  ClipboardList,
  Building2,
  MapPin,
  Settings,
  Flame,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { APP_NAME, NAV_ITEMS } from "@/lib/constants";
import { SheetHeader, SheetTitle } from "@/components/ui/sheet";

const icons = { LayoutDashboard, Cylinder, Droplets, Paintbrush, Gem, FileBox, Send, ClipboardList, Building2, MapPin, Settings };

export function MobileSidebar() {
  const pathname = usePathname();
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === "ADMIN";

  const visibleItems = NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin);

  return (
    <div className="flex h-full flex-col">
      <SheetHeader className="border-b border-border p-4">
        <SheetTitle className="flex items-center gap-2">
          <Flame className="h-5 w-5 text-primary" />
          {APP_NAME}
        </SheetTitle>
      </SheetHeader>
      <nav className="flex-1 space-y-1 p-2">
        {visibleItems.map((item) => {
          const Icon = icons[item.icon];
          const isActive = pathname.startsWith(item.href);

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "border-l-2 border-primary bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <Icon className="h-4 w-4" />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
