"use client";

import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { UserMenu } from "./user-menu";
import { MobileSidebar } from "./mobile-sidebar";

const routeTitles: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/filaments": "Filaments",
  "/resins": "Resins",
  "/paints": "Paints",
  "/vendors": "Vendors",
  "/locations": "Locations",
  "/settings": "Settings",
};

export function Header() {
  const pathname = usePathname();
  const title = routeTitles[pathname] || "Dragon's Stash";

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-4 border-b border-border bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60 lg:px-6">
      {/* Mobile menu */}
      <Sheet>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" className="lg:hidden">
            <Menu className="h-5 w-5" />
            <span className="sr-only">Toggle menu</span>
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-60 p-0">
          <MobileSidebar />
        </SheetContent>
      </Sheet>

      <h1 className="text-lg font-semibold">{title}</h1>

      <div className="ml-auto">
        <UserMenu />
      </div>
    </header>
  );
}
