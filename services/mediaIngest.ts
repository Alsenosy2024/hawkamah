// Bridge project-uploaded images/videos into the copilot's multimodal RAG.
//
// The main document uploader extracts files to TEXT (Firestore). For image/video
// files that loses the visual content. This fire-and-forget helper additionally
// sends the ORIGINAL media bytes to the Python copilot's /ingest, which embeds
// them with gemini-embedding-2 and stores the original durably in GCS — so
// project media becomes searchable as media, not just OCR text.
//
// No-op for non-media files or when the copilot backend is disabled. Deduped per
// session (name+size) so repeated extraction/preview doesn't re-upload.

import { copilotEnabled, ingestFiles as copilotIngest } from './copilotClient';

const MEDIA_RE = /^(image|video)\//;
const sent = new Set<string>();

export function maybeIngestMedia(tenantId: string | undefined, file: File): void {
  if (!tenantId || !copilotEnabled()) return;
  if (!MEDIA_RE.test(file.type || '')) return;
  const key = `${tenantId}:${file.name}:${file.size}`;
  if (sent.has(key)) return;
  sent.add(key);
  // Fire-and-forget; on failure allow a later retry.
  copilotIngest(tenantId, [file]).catch(() => { sent.delete(key); });
}
