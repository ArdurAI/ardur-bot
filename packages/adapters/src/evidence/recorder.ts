import type { KeyObject } from "node:crypto";
import { randomBytes, randomUUID } from "node:crypto";
import {
  beforeDeadline,
  connectorKindFromToolName,
  redactSecrets,
  StepDeadlineExceeded,
} from "@ardurbot/core";
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
import { getLogger, redactSensitiveText } from "@ardurbot/logging";
import { RESTART_DRAIN_MS } from "../restart-drain.js";
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
export type EvidenceResult = { ok: true; recorded?: boolean } | { ok: false; reason: string };
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
  const gapFlushes = new Map<string, Promise<void>>();

  function releaseRunState(runId: string) {
    chains.delete(runId);
    enabled.delete(runId);
    // Undurable gap counts are retry work, not a cache; flushGaps releases them after persistence.
  }

  async function serial<T>(
    runId: string,
    step: string,
    work: (signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    const deadline = new AbortController();
    const signal = callerSignal
      ? AbortSignal.any([deadline.signal, callerSignal])
      : deadline.signal;
    const next = (queues.get(runId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => work(signal));
    queues.set(runId, next);
    try {
      return await beforeDeadline(step, Date.now() + RESTART_DRAIN_MS, () => next);
    } catch (error) {
      if (error instanceof StepDeadlineExceeded) deadline.abort(error);
      throw error;
    } finally {
      // Keep the queue fenced until the underlying storage work really settles.
      void next
        .catch(() => undefined)
        .finally(() => {
          if (queues.get(runId) === next) queues.delete(runId);
        });
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
  async function spaceKey(run: EvidenceRun, signal?: AbortSignal) {
    const active = await deps.store.activeKey(run.spaceId);
    if (active) return active;
    const generated = generateEvidenceKey();
    const secretRecordId = randomUUID();
    signal?.throwIfAborted();
    const stored = await deps.secretStore.put(
      generated.privateKeyPem,
      {
        operationId: `evidence:${run.id}`,
        traceId: `trace:${run.id}`,
        spaceId: run.spaceId,
        userId: run.userId,
        botId: run.botId,
        runId: run.id,
        signal: signal ?? new AbortController().signal,
      },
      secretRecordId,
    );
    signal?.throwIfAborted();
    return deps.store.insertKey({
      spaceId: run.spaceId,
      kid: generated.kid,
      publicKeyPem: generated.publicKeyPem,
      privateKeyCiphertext: stored.ciphertext,
      secretRecordId: stored.id,
    });
  }
  async function runChain(run: EvidenceRun, signal?: AbortSignal): Promise<RunChain> {
    const cached = chains.get(run.id);
    if (cached) return cached;
    const last = await deps.store.lastRecord(run.id);
    const first = last ? await deps.store.firstRecord(run.id) : null;
    if (last && !first) throw new Error("Missing first evidence record");
    const row = first ? await deps.store.keyByKid(first.kid) : await spaceKey(run, signal);
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
    signal?.throwIfAborted();
    chains.set(run.id, state);
    return state;
  }
  function flushGaps(runId: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const existing = gapFlushes.get(runId);
    if (existing) return existing;
    // Install the fence before starting storage work; callers share it even after a timeout.
    const flush = Promise.resolve().then(async () => {
      try {
        // Gap notes record the failure itself, so a started flush finishes even after a
        // deadline; the deadline path joins this flush to persist its own gap.
        while ((pendingGaps.get(runId) ?? 0) > 0) {
          await deps.store.noteGap(runId);
          pendingGaps.set(runId, (pendingGaps.get(runId) ?? 1) - 1);
        }
        pendingGaps.delete(runId);
      } finally {
        gapFlushes.delete(runId);
      }
    });
    gapFlushes.set(runId, flush);
    return flush;
  }
  function timedOutGap(runId: string, step: string, gapAlreadyCounted = false) {
    chains.delete(runId);
    if (!gapAlreadyCounted) pendingGaps.set(runId, (pendingGaps.get(runId) ?? 0) + 1);
    getLogger().warn("run.step.timed_out", { step });
    // Do not queue this behind the stalled record/seal or hold the reply on it.
    void beforeDeadline("evidence-gap", Date.now() + RESTART_DRAIN_MS, () =>
      flushGaps(runId),
    ).catch(() => undefined);
  }
  async function recordDecision(
    input: RecordDecisionInput,
    signal?: AbortSignal,
  ): Promise<EvidenceResult> {
    let gapCounted = false;
    return serial(
      input.run.id,
      "record",
      async (signal): Promise<EvidenceResult> => {
        try {
          signal.throwIfAborted();
          if (!(await governance(input.run))) return { ok: true };
          const durableId = input.decisionId
            ? `evidence:${input.run.id}:${input.decisionId}`
            : undefined;
          if (durableId && (await deps.store.recordById(durableId))) return { ok: true };
          signal.throwIfAborted();
          await flushGaps(input.run.id, signal);
          for (let attempt = 0; attempt < 3; attempt++) {
            signal.throwIfAborted();
            const state = await runChain(input.run, signal);
            signal.throwIfAborted();
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
              signal.throwIfAborted();
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
              signal.throwIfAborted();
              chains.delete(input.run.id);
              if (durableId && (await deps.store.recordById(durableId))) return { ok: true };
              if (!(error instanceof EvidenceSequenceConflict) || attempt === 2) throw error;
            }
          }
          throw new Error("Evidence retry exhausted");
        } catch {
          chains.delete(input.run.id);
          if (signal.aborted) return { ok: false, reason: "recording_failed" };
          pendingGaps.set(input.run.id, (pendingGaps.get(input.run.id) ?? 0) + 1);
          gapCounted = true;
          try {
            await flushGaps(input.run.id, signal);
          } catch {
            /* Retry when storage recovers. */
          }
          return { ok: false, reason: "recording_failed" };
        }
      },
      signal,
    ).catch((error: unknown) => {
      if (!(error instanceof StepDeadlineExceeded)) throw error;
      if (!signal?.aborted) timedOutGap(input.run.id, error.step, gapCounted);
      return { ok: false, reason: "recording_failed" };
    });
  }
  async function sealRunEvidence(runId: string): Promise<EvidenceResult> {
    return serial(runId, "seal", async (signal): Promise<EvidenceResult> => {
      try {
        signal.throwIfAborted();
        await flushGaps(runId, signal);
        signal.throwIfAborted();
        if (await deps.store.sealForRun(runId)) return { ok: true };
        signal.throwIfAborted();
        const records = await deps.store.recordsForRun(runId);
        signal.throwIfAborted();
        const first = records[0];
        const last = records.at(-1);
        if (!first || !last) return { ok: true };
        const row = await deps.store.keyByKid(first.kid);
        signal.throwIfAborted();
        if (!row || row.spaceId !== first.spaceId) throw new Error("Missing evidence key");
        const journal = records.map((record) => record.jws);
        const verification = verifyChain(journal, row.publicKeyPem);
        if (!verification.ok) {
          deps.logFailure?.(verification.failures.map((failure) => failure.code));
          return { ok: false, reason: "chain_invalid" };
        }
        signal.throwIfAborted();
        await flushGaps(runId, signal);
        signal.throwIfAborted();
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
        const gapCount = await deps.store.gapCount(runId);
        signal.throwIfAborted();
        await deps.store.insertSeal({
          runId,
          spaceId: first.spaceId,
          jws,
          headSha256: last.sha256,
          recordCount: records.length,
          gapCount,
        });
        return { ok: true };
      } catch {
        return { ok: false, reason: "sealing_failed" };
      } finally {
        // serial keeps later steps behind this thunk until cleanup has finished.
        releaseRunState(runId);
      }
    }).catch((error: unknown) => {
      if (!(error instanceof StepDeadlineExceeded)) throw error;
      timedOutGap(runId, error.step);
      return { ok: false, reason: "sealing_failed" };
    });
  }
  return { recordDecision, sealRunEvidence, releaseRunState };
}

export type EvidenceRecorder = ReturnType<typeof createEvidenceRecorder>;

export function createNoopEvidenceRecorder(): EvidenceRecorder {
  return {
    async recordDecision() {
      return { ok: true, recorded: false };
    },
    async sealRunEvidence() {
      return { ok: true, recorded: false };
    },
    releaseRunState() {},
  };
}
