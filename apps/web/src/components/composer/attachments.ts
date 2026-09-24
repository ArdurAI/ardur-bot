import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT } from "@ardurbot/contracts";
import { inferAttachmentMimeType } from "@ardurbot/core";

export type PendingAttachment = { id: string; threadKey: string; file: File; previewUrl?: string };

/** File input, paste and drop all use this one contract gate. */
export function prepareComposerAttachments(
  existingCount: number,
  files: readonly File[],
  threadKey: string,
) {
  const attachments: PendingAttachment[] = [];
  const skipped: string[] = [];
  let limitHit = false;
  for (const file of files) {
    if (
      existingCount + attachments.length >= ATTACHMENT_MAX_COUNT ||
      file.size > ATTACHMENT_MAX_BYTES
    ) {
      limitHit = true;
      continue;
    }
    const mimeType = inferAttachmentMimeType(file.name, file.type);
    if (!mimeType) {
      skipped.push(file.name);
      continue;
    }
    attachments.push({
      id: crypto.randomUUID(),
      threadKey,
      file,
      previewUrl: mimeType.startsWith("image/") ? URL.createObjectURL(file) : undefined,
    });
  }
  return { attachments, skipped, limitHit };
}
