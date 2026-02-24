"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/shared/page-header";
import { AccountsTab } from "./accounts-tab";
import { ChannelsTab } from "./channels-tab";
import type { AccountRow, ChannelRow } from "@/lib/telegram/admin-queries";

interface TelegramAdminProps {
  accounts: AccountRow[];
  channels: ChannelRow[];
}

export function TelegramAdmin({ accounts, channels }: TelegramAdminProps) {
  return (
    <div className="space-y-4">
      <PageHeader
        title="Telegram"
        description="Manage Telegram accounts, channels, and ingestion"
      />

      <Tabs defaultValue="accounts" className="space-y-4">
        <TabsList>
          <TabsTrigger value="accounts">
            Accounts ({accounts.length})
          </TabsTrigger>
          <TabsTrigger value="channels">
            Channels ({channels.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="accounts">
          <AccountsTab accounts={accounts} />
        </TabsContent>
        <TabsContent value="channels">
          <ChannelsTab channels={channels} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
