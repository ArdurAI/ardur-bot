import type { DispatchReceipt } from "@ardurbot/contracts";
import { requireOptionalNativeModule } from "expo-modules-core";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import type { NativeDevices, PairedHome } from "./dispatch-client";
import { createDispatchClient, dispatchReceiptLabel } from "./dispatch-client";

const native = requireOptionalNativeModule<NativeDevices>("ArdurBotDevices");
const unavailable = () => {
  throw new Error("Install a development build to pair this phone.");
};
export const nativeDevices: NativeDevices = native ?? {
  nonce: unavailable,
  createKeys: unavailable,
  sign: unavailable,
  verifyHome: unavailable,
  request: unavailable,
  scanQr: unavailable,
};
let status: string | null = null;
const listeners = new Set<() => void>();
export const dispatchClient = createDispatchClient(
  nativeDevices,
  {
    get: (key) => SecureStore.getItemAsync(key),
    set: (key, value) =>
      SecureStore.setItemAsync(key, value, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      }),
    remove: (key) => SecureStore.deleteItemAsync(key),
  },
  setDispatchStatus,
  Platform.OS,
);
function setDispatchStatus(next: string | null) {
  status = next;
  for (const listener of listeners) listener();
}
export function dispatchStatus() {
  return status;
}
export function subscribeDispatchStatus(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export async function hasPairedDevice() {
  return Boolean(await dispatchClient.loadHome());
}

const snapshots = new Map<
  string,
  {
    run?: { id: string; taskId: string };
    activeRuns?: Array<{ id: string; taskId: string }>;
    messages?: Array<{
      id: string;
      runId?: string;
      blocks: Array<{ kind: string; approvalEffectId?: string }>;
    }>;
  }
>();
export async function deviceRpc<T>(
  home: PairedHome,
  procedure: string,
  value: unknown,
): Promise<T> {
  const body = value as Record<string, unknown>;
  const botId = typeof body.botId === "string" ? body.botId : "";
  if (procedure === "delegations/cancel")
    return dispatchClient.request<T>("team-stop", { rootTaskId: body.rootTaskId });
  if (procedure === "delegations/accept")
    return dispatchClient.request<T>("team-accept", { id: body.id });
  if (procedure === "threads/send") {
    if (body.groupId || (Array.isArray(body.artifactIds) && body.artifactIds.length))
      throw new Error("Send files and group tasks from home.");
    const snapshot = snapshots.get(botId);
    const message = snapshot?.messages?.find((m) => m.id === body.replyToMessageId);
    const active =
      snapshot?.activeRuns?.find((run) => run.id === message?.runId) ??
      (snapshot?.run?.id === message?.runId ? snapshot?.run : undefined);
    return (await dispatchClient.send({
      botId,
      text: String(body.text ?? ""),
      ...(active ? { replyToTaskId: active.taskId } : {}),
    })) as T;
  }
  if (procedure === "threads/stop") {
    const snapshot = snapshots.get(botId);
    const tasks = new Set(
      [snapshot?.run?.taskId, ...(snapshot?.activeRuns?.map((run) => run.taskId) ?? [])].filter(
        Boolean,
      ),
    );
    for (const taskId of tasks) await dispatchClient.request("stop", { taskId });
    if (tasks.size) setDispatchStatus("Stopping");
    return { ok: true } as T;
  }
  if (procedure === "threads/answer") {
    if (body.answer === "always") throw new Error("Change approval rules at home.");
    if (body.answer === "remote-retry") {
      await dispatchClient.request("presence");
      return dispatchClient.request<T>("answer", {
        runId: body.runId,
        messageId: body.messageId,
        answer: "remote-retry",
      });
    }
    const message = snapshots.get(botId)?.messages?.find((m) => m.id === body.messageId);
    const effectId = message?.blocks.find((block) => block.kind === "ask")?.approvalEffectId;
    const bindings = await dispatchClient.request<
      Array<{ effectId: string; nonce: string; requestFingerprint: string }>
    >("approvals", { runId: body.runId });
    const binding = bindings.find((b) => b.effectId === effectId);
    if (!binding) throw new Error("This older approval must be answered at home.");
    if (body.answer === "allow") await dispatchClient.request("presence");
    return dispatchClient.request<T>("answer", {
      runId: body.runId,
      messageId: body.messageId,
      answer: body.answer,
      ...binding,
    });
  }
  const result = await dispatchClient.request<T>("rpc", { procedure, input: value });
  if (procedure === "threads/get") {
    snapshots.set(botId, result as never);
    if (!(await dispatchClient.pending())) {
      const tasks = await dispatchClient.request<DispatchReceipt[]>("tasks");
      const task = tasks.find((receipt) => receipt.botId === botId);
      setDispatchStatus(task ? dispatchReceiptLabel(task) : null);
    }
    const summaries =
      await dispatchClient.request<Array<{ taskId: string; messageId: string | null }>>(
        "summaries",
      );
    const messages = snapshots.get(botId)?.messages ?? [];
    for (const summary of summaries) {
      if (summary.messageId && messages.some((message) => message.id === summary.messageId))
        await dispatchClient.request("acknowledge", { taskId: summary.taskId });
    }
  }
  // The paired home owns the selected space; no owner session is involved in these requests.
  void home;
  return result;
}
