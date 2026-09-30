import type { KeyObject } from "node:crypto";
import { randomBytes, randomUUID } from "node:crypto";
import { connectorKindFromToolName, redactSecrets } from "@ardurbot/core";
import type { EvidenceStore } from "@ardurbot/db";
import { EvidenceSequenceConflict } from "@ardurbot/db";
import type { EvidenceChain, ReceiptClaims, ReceiptRunIdentity } from "@ardurbot/evidence";
import {
  createEvidenceChain,
  generateEvidenceKey,
  loadEvidencePrivateKey,
  resumeChain,
  sealRun,
  verifyChain,
} from "@ardurbot/evidence";
import { redactSensitiveText } from "@ardurbot/logging";
import type { EncryptedSecretStore } from "../secrets.js";
import type { DecisionKind } from "./decision-kinds.js";
import { decisionFields } from "./decision-kinds.js";
import { toolEvidenceClass } from "./tool-classes.js";

export interface EvidenceRun {
  id: string;
  spaceId: string;
  botId: string;
  userId: string;
}
export interface RecordDecisionInput {
  run: EvidenceRun;
  toolName: string;
  viaConnector: boolean;
  args: unknown;
  target?: { path?: string; host?: string; connectorKind?: string };
  decisionKind: DecisionKind;
  ruleId?: string;
  decisionId?: string;
  secrets?: string[];
}
export type EvidenceResult = { ok: true } | { ok: false; reason: string };
interface RecorderDeps {
  store: EvidenceStore;
  secretStore: Pick<EncryptedSecretStore, "put" | "load">;
  logFailure?: (codes: string[]) => void;
}
interface RunChain {
  chain: EvidenceChain;
  identity: ReceiptRunIdentity;
  kid: string;
}

function claims(jws: string): ReceiptClaims {
  const payload = jws.split(".")[1];
  if (!payload) throw new Error("Missing evidence payload");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ReceiptClaims;
}

function safeTarget(input: RecordDecisionInput): string {
  // Only paths, hosts and connector kinds are admitted; never arbitrary tool text.
  let target = "";
  if (input.viaConnector) target = connectorKindFromToolName(input.toolName);
  else if (input.target?.path) target = input.target.path.split(/[\\/]/).at(-1) ?? "";
  else if (input.target?.host) {
    const url = new URL(
      input.target.host.includes("://") ? input.target.host : `https://${input.target.host}`,
    );
    target = url.hostname;
  } else if (input.target?.connectorKind) target = input.target.connectorKind;
  return redactSensitiveText(
    redactSecrets(`${input.toolName}${target ? `:${target}` : ""}`, input.secrets ?? []),
  )
    .replace(/[\r\n\t]/g, " ")
    .slice(0, 160);
}

export function createEvidenceRecorder(deps: RecorderDeps) {
  const enabled = new Map<string, Promise<boolean>>();
  const chains = new Map<string, RunChain>();
  const queues = new Map<string, Promise<unknown>>();
  const keys = new Map<string, KeyObject>();
  const pendingGaps = new Map<string, number>();

  function releaseRunState(runId: string) {
    chains.delete(runId);
    enabled.delete(runId);
    // Undurable gap counts are retry work, not a cache; flushGaps releases them after persistence.
  }

  async function serial<T>(runId: string, work: () => Promise<T>): Promise<T> {
    const next = (queues.get(runId) ?? Promise.resolve()).catch(() => undefined).then(work);
    queues.set(runId, next);
    try {
      return await next;
    } finally {
      if (queues.get(runId) === next) queues.delete(runId);
    }
  }
  async function governance(run: EvidenceRun) {
    let lookup = enabled.get(run.id);
    if (!lookup) {
      lookup = deps.store.governanceEnabled(run.spaceId);
      enabled.set(run.id, lookup);
    }
    try {
      return await lookup;
    } catch (error) {
      enabled.delete(run.id);
      throw error;
    }
  }
  function privateKey(row: { kid: string; privateKeyCiphertext: string; secretRecordId: string }) {
    let key = keys.get(row.kid);
    if (!key) {
      key = loadEvidencePrivateKey(
        deps.secretStore.load(row.privateKeyCiphertext, row.secretRecordId),
      );
      keys.set(row.kid, key);
    }
    return key;
  }
  async function spaceKey(run: EvidenceRun) {
    const active = await deps.store.activeKey(run.spaceId);
    if (active) return active;
    const generated = generateEvidenceKey();
    const secretRecordId = randomUUID();
    const stored = await deps.secretStore.put(
      generated.privateKeyPem,
      {
        operationId: `evidence:${run.id}`,
        traceId: `trace:${run.id}`,
        spaceId: run.spaceId,
        userId: run.userId,
        botId: run.botId,
        runId: run.id,
        signal: new AbortController().signal,
      },
      secretRecordId,
    );
    return deps.store.insertKey({
      spaceId: run.spaceId,
      kid: generated.kid,
      publicKeyPem: generated.publicKeyPem,
      privateKeyCiphertext: stored.ciphertext,
      secretRecordId: stored.id,
    });
  }
  async function runChain(run: EvidenceRun): Promise<RunChain> {
    const cached = chains.get(run.id);
    if (cached) return cached;
    const last = await deps.store.lastRecord(run.id);
    const first = last ? await deps.store.firstRecord(run.id) : null;
    if (last && !first) throw new Error("Missing first evidence record");
    const row = first ? await deps.store.keyByKid(first.kid) : await spaceKey(run);
    if (!row || row.spaceId !== run.spaceId || (last && last.kid !== row.kid))
      throw new Error("Evidence key mismatch");
    if (first && !verifyChain([first.jws], row.publicKeyPem).ok)
      throw new Error("Invalid first evidence record");
    const identity: ReceiptRunIdentity = {
      runId: run.id,
      spaceId: run.spaceId,
      grantId: `grant:${run.id}`,
      traceId: `trace:${run.id}`,
      runNonce: first ? claims(first.jws).run_nonce : randomBytes(24).toString("base64url"),
      actor: `bot:${run.botId}`,
      verifierId: `ardur:${run.spaceId}:evidence`,
    };
    // Bind the first receipt as well as the tail to the actual run, not decoded identity.
    if (first)
      resumeChain(
        { lastJws: first.jws, lastSeq: 0, expectedRun: identity },
        privateKey(row),
        row.kid,
      );
    const chain = last
      ? resumeChain(
          { lastJws: last.jws, lastSeq: last.seq, expectedRun: identity },
          privateKey(row),
          row.kid,
        )
      : createEvidenceChain(privateKey(row), row.kid);
    const state = { chain, identity, kid: row.kid };
    chains.set(run.id, state);
    return state;
  }
  async function flushGaps(runId: string) {
    while ((pendingGaps.get(runId) ?? 0) > 0) {
      await deps.store.noteGap(runId);
      pendingGaps.set(runId, (pendingGaps.get(runId) ?? 1) - 1);
    }
    pendingGaps.delete(runId);
  }
  async function recordDecision(input: RecordDecisionInput): Promise<EvidenceResult> {
    return serial(input.run.id, async () => {
      try {
        if (!(await governance(input.run))) return { ok: true };
        const durableId = input.decisionId
          ? `evidence:${input.run.id}:${input.decisionId}`
          : undefined;
        if (durableId && (await deps.store.recordById(durableId))) return { ok: true };
        await flushGaps(input.run.id);
        for (let attempt = 0; attempt < 3; attempt++) {
          const state = await runChain(input.run);
          const fields = decisionFields(input.decisionKind, input.ruleId);
          const record = state.chain.append({
            ...state.identity,
            ...toolEvidenceClass(input.toolName, input.viaConnector),
            ...fields,
            tool: input.toolName,
            args: input.args,
            target: safeTarget(input),
            budgetRemaining: {},
          });
          try {
            await deps.store.insertRecord({
              ...record,
              ...(durableId ? { id: durableId } : {}),
              runId: input.run.id,
              spaceId: input.run.spaceId,
              kid: state.kid,
              verdict: fields.verdict,
              decisionKind: input.decisionKind,
              toolName: input.toolName,
            });
            return { ok: true };
          } catch (error) {
            chains.delete(input.run.id);
            if (durableId && (await deps.store.recordById(durableId))) return { ok: true };
            if (!(error instanceof EvidenceSequenceConflict) || attempt === 2) throw error;
          }
        }
        throw new Error("Evidence retry exhausted");
      } catch {
        chains.delete(input.run.id);
        pendingGaps.set(input.run.id, (pendingGaps.get(input.run.id) ?? 0) + 1);
        try {
          await flushGaps(input.run.id);
        } catch {
          /* Retry when storage recovers. */
        }
        return { ok: false, reason: "recording_failed" };
      }
    });
  }
  async function sealRunEvidence(runId: string): Promise<EvidenceResult> {
    return serial(runId, async () => {
      try {
        await flushGaps(runId);
        if (await deps.store.sealForRun(runId)) return { ok: true };
        const records = await deps.store.recordsForRun(runId);
        const first = records[0];
        const last = records.at(-1);
        if (!first || !last) return { ok: true };
        const row = await deps.store.keyByKid(first.kid);
        if (!row || row.spaceId !== first.spaceId) throw new Error("Missing evidence key");
        const journal = records.map((record) => record.jws);
        const verification = verifyChain(journal, row.publicKeyPem);
        if (!verification.ok) {
          deps.logFailure?.(verification.failures.map((failure) => failure.code));
          return { ok: false, reason: "chain_invalid" };
        }
        await flushGaps(runId);
        const identity = claims(first.jws);
        const jws = sealRun(
          {
            records: journal,
            actor: identity.actor,
            grantId: identity.grant_id,
            iss: identity.iss,
          },
          privateKey(row),
          row.kid,
        );
        await deps.store.insertSeal({
          runId,
          spaceId: first.spaceId,
          jws,
          headSha256: last.sha256,
          recordCount: records.length,
          gapCount: await deps.store.gapCount(runId),
        });
        return { ok: true };
      } catch {
        return { ok: false, reason: "sealing_failed" };
      } finally {
        releaseRunState(runId);
      }
    });
  }
  return { recordDecision, sealRunEvidence, releaseRunState };
}

export type EvidenceRecorder = ReturnType<typeof createEvidenceRecorder>;
