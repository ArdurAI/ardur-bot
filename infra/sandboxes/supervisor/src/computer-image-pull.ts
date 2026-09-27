import { ComputerImageDownloadError } from "@ardurbot/contracts";
import type Docker from "dockerode";

export type ImagePullProgress = (percent: number | null) => Promise<void> | void;

type PullFrame = {
  id?: string;
  status?: string;
  error?: string;
  errorDetail?: { message?: string };
  progressDetail?: { current?: number; total?: number };
};

export function computerImagePullFailure(error: unknown): ComputerImageDownloadError {
  const detail = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string; statusCode?: number })?.code ?? "";
  const status = (error as { statusCode?: number })?.statusCode;
  const reason =
    status === 401 ||
    status === 403 ||
    status === 404 ||
    /manifest unknown|not found|unauthorized|authentication required|denied/i.test(detail)
      ? "not found or private"
      : /^(EAI_|ECONN|ENET|ETIMEDOUT|EHOST)/.test(code) ||
          /network|timeout|timed out|connection|TLS|DNS/i.test(detail)
        ? "network error"
        : "download failed";
  return new ComputerImageDownloadError(reason, { cause: error });
}

/** Parse the engine's newline-delimited progress frames across arbitrary stream chunks. */
export async function readImagePullProgress(
  stream: AsyncIterable<Buffer | string>,
  onProgress: ImagePullProgress,
): Promise<void> {
  const layers = new Map<string, { current: number; total: number }>();
  let pending = "";
  let lastPercent: number | null | undefined;
  const frame = async (line: string) => {
    let value: PullFrame;
    try {
      value = JSON.parse(line) as PullFrame;
    } catch {
      throw new Error("The image download returned invalid progress data");
    }
    if (value.error || value.errorDetail?.message) {
      throw new Error(value.errorDetail?.message ?? value.error);
    }
    const detail = value.progressDetail;
    if (value.id && Number.isFinite(detail?.total) && (detail?.total ?? 0) > 0) {
      const total = detail!.total!;
      const current = Math.max(0, Math.min(total, detail?.current ?? 0));
      layers.set(value.id, { current, total });
    } else if (
      value.id &&
      /^(Pull complete|Download complete|Already exists)$/.test(value.status ?? "")
    ) {
      const previous = layers.get(value.id);
      if (previous) layers.set(value.id, { ...previous, current: previous.total });
    }
    const totals = [...layers.values()];
    const total = totals.reduce((sum, layer) => sum + layer.total, 0);
    const percent = total
      ? Math.floor((100 * totals.reduce((sum, layer) => sum + layer.current, 0)) / total)
      : null;
    if (percent !== lastPercent) {
      lastPercent = percent;
      await onProgress(percent);
    }
  };
  for await (const chunk of stream) {
    pending += chunk.toString();
    if (pending.length > 64 * 1024) throw new Error("The image download progress is too large");
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (line) await frame(line);
      newline = pending.indexOf("\n");
    }
  }
  if (pending.trim()) throw new Error("The image download progress ended unexpectedly");
}

const pulls = new WeakMap<
  Docker,
  Map<string, { task: Promise<void>; listeners: Set<ImagePullProgress> }>
>();

export async function ensureDockerComputerImage(
  engine: Docker,
  image: string,
  onProgress: ImagePullProgress = () => undefined,
): Promise<void> {
  let byImage = pulls.get(engine);
  if (!byImage) {
    byImage = new Map();
    pulls.set(engine, byImage);
  }
  let active = byImage.get(image);
  if (!active) {
    const listeners = new Set<ImagePullProgress>();
    const notify = async (percent: number | null) => {
      // One disconnected waiter must not fail the shared engine pull for other bots.
      await Promise.allSettled(
        [...listeners].map((listener) => Promise.resolve().then(() => listener(percent))),
      );
    };
    const task = (async () => {
      try {
        await engine.getImage(image).inspect();
        return;
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404) throw error;
      }
      try {
        await notify(null);
        // dockerode uses POST /images/create with fromImage and tag for this call.
        const stream = await engine.pull(image, {});
        await readImagePullProgress(stream as AsyncIterable<Buffer | string>, notify);
        await engine.getImage(image).inspect();
      } catch (error) {
        throw computerImagePullFailure(error);
      }
    })();
    active = { task, listeners };
    byImage.set(image, active);
    void task.finally(() => byImage.delete(image)).catch(() => undefined);
  }
  active.listeners.add(onProgress);
  try {
    await active.task;
  } finally {
    active.listeners.delete(onProgress);
  }
}
