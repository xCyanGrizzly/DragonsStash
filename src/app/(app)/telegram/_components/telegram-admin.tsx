"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/shared/page-header";
import { AccountsTab } from "./accounts-tab";
import { ChannelsTab } from "./channels-tab";
import { WorkerStatusPanel } from "./worker-status-panel";
import { BotSendsTab } from "./bot-sends-tab";
import type { AccountRow, ChannelRow, GlobalDestination } from "@/lib/telegram/admin-queries";
import type { IngestionAccountStatus } from "@/lib/telegram/types";
import type { SendHistoryRow } from "@/types/telegram.types";

interface TelegramAdminProps {
  accounts: AccountRow[];
  channels: ChannelRow[];
  ingestionStatus: IngestionAccountStatus[];
  globalDestination: GlobalDestination;
  sendHistory: SendHistoryRow[];
}

export function TelegramAdmin({
  accounts,
  channels,
  ingestionStatus,
  globalDestination,
  sendHistory,
}: TelegramAdminProps) {
  return (
    <div className="space-y-4">
      <PageHeader
        title="Telegram"
        description="Manage Telegram accounts, channels, and ingestion"
      />

      <WorkerStatusPanel initialStatus={ingestionStatus} />

      <Tabs defaultValue="accounts" className="space-y-4">
        <TabsList>
          <TabsTrigger value="accounts">
            Accounts ({accounts.length})
          </TabsTrigger>
          <TabsTrigger value="channels">
            Channels ({channels.length})
          </TabsTrigger>
          <TabsTrigger value="sends">
            Bot Sends ({sendHistory.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="accounts">
          <AccountsTab accounts={accounts} />
        </TabsContent>
        <TabsContent value="channels">
          <ChannelsTab channels={channels} globalDestination={globalDestination} />
        </TabsContent>
        <TabsContent value="sends">
          <BotSendsTab history={sendHistory} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
