"use client";

import { useState, useTransition } from "react";
import { Plus, Play } from "lucide-react";
import { toast } from "sonner";
import { getAccountColumns } from "./account-columns";
import { AccountModal } from "./account-modal";
import { AccountLinksDrawer } from "./account-links-drawer";
import { AuthCodeDialog } from "./auth-code-dialog";
import { deleteAccount, toggleAccountActive, triggerIngestion } from "../actions";
import { DataTable } from "@/components/shared/data-table";
import { DeleteDialog } from "@/components/shared/delete-dialog";
import { Button } from "@/components/ui/button";
import type { AccountRow } from "@/lib/telegram/admin-queries";
import { useDataTable } from "@/hooks/use-data-table";

interface AccountsTabProps {
  accounts: AccountRow[];
}

export function AccountsTab({ accounts }: AccountsTabProps) {
  const [isPending, startTransition] = useTransition();
  const [modalOpen, setModalOpen] = useState(false);
  const [editAccount, setEditAccount] = useState<AccountRow | undefined>();
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [linksAccountId, setLinksAccountId] = useState<string | null>(null);
  const [authCodeAccount, setAuthCodeAccount] = useState<AccountRow | null>(null);

  const columns = getAccountColumns({
    onEdit: (account) => {
      setEditAccount(account);
      setModalOpen(true);
    },
    onToggleActive: (id) => {
      startTransition(async () => {
        const result = await toggleAccountActive(id);
        if (result.success) toast.success("Account toggled");
        else toast.error(result.error);
      });
    },
    onDelete: (id) => setDeleteId(id),
    onViewLinks: (id) => setLinksAccountId(id),
    onEnterCode: (account) => setAuthCodeAccount(account),
    onTriggerSync: (id) => {
      startTransition(async () => {
        const result = await triggerIngestion(id);
        if (result.success) toast.success("Ingestion triggered");
        else toast.error(result.error);
      });
    },
  });

  const { table } = useDataTable({
    data: accounts,
    columns,
    pageCount: 1,
  });

  const handleDelete = () => {
    if (!deleteId) return;
    startTransition(async () => {
      const result = await deleteAccount(deleteId);
      if (result.success) {
        toast.success("Account deleted");
        setDeleteId(null);
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button
          onClick={() => {
            setEditAccount(undefined);
            setModalOpen(true);
          }}
        >
          <Plus className="mr-2 h-4 w-4" />
          Add Account
        </Button>
        <Button
          variant="outline"
          disabled={isPending}
          onClick={() => {
            startTransition(async () => {
              const result = await triggerIngestion();
              if (result.success) toast.success("Ingestion triggered for all accounts");
              else toast.error(result.error);
            });
          }}
        >
          <Play className="mr-2 h-4 w-4" />
          Sync All
        </Button>
      </div>

      <DataTable
        table={table}
        emptyMessage="No accounts configured. Add your first Telegram account."
      />

      <AccountModal
        open={modalOpen}
        onOpenChange={(open) => {
          setModalOpen(open);
          if (!open) setEditAccount(undefined);
        }}
        account={editAccount}
      />

      <DeleteDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
        title="Delete Account"
        description="This will permanently delete this Telegram account and all its channel links. Existing packages will NOT be deleted."
        onConfirm={handleDelete}
        isLoading={isPending}
      />

      <AccountLinksDrawer
        accountId={linksAccountId}
        open={!!linksAccountId}
        onOpenChange={(open) => {
          if (!open) setLinksAccountId(null);
        }}
      />

      <AuthCodeDialog
        account={authCodeAccount}
        open={!!authCodeAccount}
        onOpenChange={(open) => {
          if (!open) setAuthCodeAccount(null);
        }}
      />
    </div>
  );
}
