export interface SendHistoryRow {
  id: string;
  packageName: string;
  recipientName: string | null;
  status: string;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}
