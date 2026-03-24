export interface PackageListItem {
  id: string;
  fileName: string;
  fileSize: string; // BigInt serialized as string
  contentHash: string;
  archiveType: "ZIP" | "RAR" | "SEVEN_Z" | "DOCUMENT";
  fileCount: number;
  isMultipart: boolean;
  hasPreview: boolean;
  creator: string | null;
  tags: string[];
  indexedAt: string;
  sourceChannel: {
    id: string;
    title: string;
  };
  matchedFileCount: number;
  matchedByContent: boolean;
}

export interface PackageDetail extends PackageListItem {
  partCount: number;
  destChannel: {
    id: string;
    title: string;
  } | null;
  destMessageId: string | null;
  sourceMessageId: string;
  ingestionRun: {
    id: string;
    startedAt: string;
  } | null;
}

export interface PackageFileItem {
  id: string;
  path: string;
  fileName: string;
  extension: string | null;
  compressedSize: string;
  uncompressedSize: string;
  crc32: string | null;
}

export interface PaginatedResponse<T> {
  items: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface IngestionAccountStatus {
  id: string;
  displayName: string | null;
  phone: string;
  isActive: boolean;
  authState: string;
  lastSeenAt: string | null;
  lastRun: {
    id: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    messagesScanned: number;
    zipsFound: number;
    zipsDuplicate: number;
    zipsIngested: number;
  } | null;
  currentRun: {
    id: string;
    startedAt: string;
    messagesScanned: number;
    zipsFound: number;
    zipsDuplicate: number;
    zipsIngested: number;
    // Live activity tracking
    currentActivity: string | null;
    currentStep: string | null;
    currentChannel: string | null;
    currentFile: string | null;
    currentFileNum: number | null;
    totalFiles: number | null;
    downloadedBytes: string | null; // BigInt serialized as string
    totalBytes: string | null; // BigInt serialized as string
    downloadPercent: number | null;
    lastActivityAt: string | null;
  } | null;
}
