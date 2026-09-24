import { createHash } from "node:crypto";
import type {
  DocumentScope,
  MemoryAccess,
  MemoryBundle,
  MemoryImportPreview,
} from "@ardurbot/adapter-kit";
import { MemoryConflictError } from "@ardurbot/adapter-kit";
import { MemoryBundleSchema } from "@ardurbot/contracts";
import { assertMemoryPath, assertMemorySafe } from "./redaction.js";
import { assertScope, scopeKey } from "./scope.js";

export function bundleHash(bundle: MemoryBundle): string {
  return createHash("sha256")
    .update(JSON.stringify(MemoryBundleSchema.parse(bundle)))
    .digest("hex");
}
export function parseBundle(value: unknown): MemoryBundle {
  if (JSON.stringify(value).length > 20_000_000)
    throw new Error("This memory bundle is too large.");
  assertMemorySafe(value);
  const bundle = MemoryBundleSchema.parse(value);
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const doc of bundle.documents) {
    if (ids.has(doc.id)) throw new Error("Duplicate document in memory bundle.");
    ids.add(doc.id);
    const first = doc.revisions[0]!;
    const identity = `${scopeKey(first.scopeKey)}:${first.path}`;
    if (paths.has(identity)) throw new Error("Duplicate path in memory bundle.");
    paths.add(identity);
    doc.revisions.forEach((revision, index) => {
      assertMemoryPath(revision.path);
      if (
        revision.documentId !== doc.id ||
        revision.revision !== index + 1 ||
        scopeKey(revision.scopeKey) !== scopeKey(first.scopeKey) ||
        revision.path !== first.path ||
        (index > 0 && revision.createdAt < doc.revisions[index - 1]!.createdAt)
      ) {
        throw new Error("Invalid revision history in memory bundle.");
      }
    });
  }
  return bundle;
}
export function previewImport(
  value: unknown,
  current: MemoryBundle,
  access: MemoryAccess,
  remapping: Record<string, DocumentScope> = {},
): { bundle: MemoryBundle; preview: MemoryImportPreview } {
  const bundle = parseBundle(value);
  const scopes = new Map<string, DocumentScope>();
  for (const doc of bundle.documents) {
    for (const revision of doc.revisions) {
      const from = scopeKey(revision.scopeKey);
      const to = remapping[from] ?? revision.scopeKey;
      assertScope(to, access);
      scopes.set(from, to);
      revision.scopeKey = to;
    }
  }
  // Remapping may collapse formerly distinct paths. Validate again before any write.
  parseBundle(bundle);
  const conflicts = bundle.documents
    .filter((doc) => {
      const head = doc.revisions.at(-1)!;
      return current.documents.some((other) => {
        const existing = other.revisions.at(-1)!;
        return (
          (other.id === doc.id ||
            (scopeKey(existing.scopeKey) === scopeKey(head.scopeKey) &&
              existing.path === head.path)) &&
          !(
            other.id === doc.id &&
            other.revisions.length <= doc.revisions.length &&
            JSON.stringify(other.revisions) ===
              JSON.stringify(doc.revisions.slice(0, other.revisions.length))
          )
        );
      });
    })
    .map((doc) => ({ id: doc.id, path: doc.revisions.at(-1)!.path }));
  return {
    bundle,
    preview: {
      hash: bundleHash(bundle),
      documents: bundle.documents.length,
      revisions: bundle.documents.reduce((count, doc) => count + doc.revisions.length, 0),
      conflicts,
      scopes: [...scopes].map(([from, to]) => ({ from, to })),
    },
  };
}
export function requireImportReady(preview: MemoryImportPreview, expectedHash: string): void {
  if (preview.hash !== expectedHash || preview.conflicts.length) throw new MemoryConflictError();
}
