import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getDashboardStats } from "@/data/dashboard.queries";
import { getAllUserItems } from "@/data/usage.queries";
import { getUserSettings } from "@/data/settings.queries";
import { Package, Euro, AlertTriangle, Activity } from "lucide-react";
import { StatCard } from "@/components/shared/stat-card";
import { ColorSwatch } from "@/components/shared/color-swatch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RecentUsageCard } from "./_components/recent-usage-card";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const settings = await getUserSettings(session.user.id);
  const [stats, items] = await Promise.all([
    getDashboardStats(session.user.id, settings.lowStockThreshold),
    getAllUserItems(session.user.id),
  ]);

  const currencyFormatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: settings.currency,
  });

  // Serialize dates for the client component
  const serializedUsage = stats.recentUsage.map((log) => ({
    ...log,
    createdAt: log.createdAt.toISOString(),
  }));

  return (
    <div className="space-y-6">
      {/* Stats Grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Total Items"
          value={stats.totalItems}
          icon={Package}
          description="Filaments, resins & paints"
        />
        <StatCard
          title="Inventory Value"
          value={currencyFormatter.format(stats.inventoryValue)}
          icon={Euro}
          description="Total purchase cost"
        />
        <StatCard
          title="Low Stock"
          value={stats.lowStockCount}
          icon={AlertTriangle}
          description={`Below ${settings.lowStockThreshold}% remaining`}
          iconClassName={stats.lowStockCount > 0 ? "text-orange-400" : undefined}
        />
        <StatCard
          title="Recent Activity"
          value={stats.recentActivityCount}
          icon={Activity}
          description="Usage logs in last 24h"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Low Stock Alerts */}
        <Card className="border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Low Stock Alerts</CardTitle>
            <CardDescription>Items below {settings.lowStockThreshold}% remaining</CardDescription>
          </CardHeader>
          <CardContent>
            {stats.lowStockItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">All items are well stocked.</p>
            ) : (
              <div className="space-y-3">
                {stats.lowStockItems.map((item) => (
                  <div key={`${item.type}-${item.id}`} className="flex items-center gap-3">
                    <ColorSwatch hex={item.colorHex} size="sm" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{item.name}</p>
                      <p className="text-xs text-muted-foreground capitalize">{item.type}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-medium text-orange-400">
                        {Math.round(item.remaining)}
                        {item.type === "filament" ? "g" : "ml"}
                      </p>
                      <p className="text-xs text-muted-foreground">{Math.round(item.percent)}% left</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent Usage */}
        <RecentUsageCard recentUsage={serializedUsage} items={items} />
      </div>
    </div>
  );
}
