/**
 * Extract a creator name from common archive file naming patterns.
 *
 * Priority in the worker: topic name > filename extraction.
 * This is the fallback when no forum topic name is available.
 *
 * Patterns handled (split on ` - `):
 *   "Mammoth Factory - 2026-01.zip"        → "Mammoth Factory"
 *   "Artist Name - Pack Title.part01.rar"   → "Artist Name"
 *   "some_random_file.zip"                  → null
 */
export declare function extractCreatorFromFileName(fileName: string): string | null;
