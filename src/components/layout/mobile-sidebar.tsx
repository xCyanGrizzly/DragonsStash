"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Cylinder,
  Droplets,
  Paintbrush,
  Gem,
  ClipboardList,
  Building2,
  MapPin,
  Settings,
  Flame,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { APP_NAME } from "@/lib/constants";
import { SheetHeader, SheetTitle } from "@/components/ui/sheet";

const icons = { LayoutDashboard, Cylinder, Droplets, Paintbrush, Gem, ClipboardList, Building2, MapPin, Settings };

const navItems = [
  { label: "Dashboard", href: "/dashboard", icon: "LayoutDashboard" as const },
  { label: "Filaments", href: "/filaments", icon: "Cylinder" as const },
  { label: "Resins", href: "/resins", icon: "Droplets" as const },
  { label: "Paints", href: "/paints", icon: "Paintbrush" as const },
  { label: "Supplies", href: "/supplies", icon: "Gem" as const },
  { label: "Usage", href: "/usage", icon: "ClipboardList" as const },
  { label: "Vendors", href: "/vendors", icon: "Building2" as const },
  { label: "Locations", href: "/locations", icon: "MapPin" as const },
  { label: "Settings", href: "/settings", icon: "Settings" as const },
];

export function MobileSidebar() {
  const pathname = usePathname();

  return (
    <div className="flex h-full flex-col">
      <SheetHeader className="border-b border-border p-4">
        <SheetTitle className="flex items-center gap-2">
          <Flame className="h-5 w-5 text-primary" />
          {APP_NAME}
        </SheetTitle>
      </SheetHeader>
      <nav className="flex-1 space-y-1 p-2">
        {navItems.map((item) => {
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
