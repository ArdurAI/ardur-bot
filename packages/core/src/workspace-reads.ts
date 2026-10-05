import type { WorkspaceContext } from "@ardurbot/contracts";

export const COMPUTER_CHANGED_MESSAGE = "Computer changed. Refresh files.";

/** A read lost its view binding. Callers must discard both its data and its error. */
export class WorkspaceReadCancelled extends Error {}

export function workspaceBindingKey(context: WorkspaceContext): string {
  return JSON.stringify([
    context.botId,
    context.computerId,
    context.rootId,
    context.generation,
    context.files,
  ]);
}

function sameTarget(a: WorkspaceContext, b: WorkspaceContext): boolean {
  return a.botId === b.botId && a.computerId === b.computerId && a.rootId === b.rootId;
}

/** Only reads enter this boundary. Saves retain their original approval and version checks. */
export class WorkspaceReads {
  private active = true;
  private epoch = 0;
  private refresh: Promise<WorkspaceContext> | null = null;

  constructor(
    private context: WorkspaceContext,
    private readonly options: {
      describe(botId: string): Promise<WorkspaceContext>;
      computerChanged(error: unknown): boolean;
      publish(context: WorkspaceContext): void;
    },
  ) {}

  bind(context: WorkspaceContext): number {
    if (workspaceBindingKey(context) === workspaceBindingKey(this.context)) return this.epoch;
    this.context = context;
    this.epoch++;
    this.refresh = null;
    return this.epoch;
  }

  activate(): void {
    this.active = true;
  }

  dispose(): void {
    this.active = false;
    this.epoch++;
    this.refresh = null;
  }

  private check(epoch: number, context?: WorkspaceContext): void {
    if (!this.active || epoch !== this.epoch || (context && context !== this.context))
      throw new WorkspaceReadCancelled();
  }

  async read<T>(request: (context: WorkspaceContext) => Promise<T>): Promise<T> {
    const original = this.context;
    const epoch = this.epoch;
    this.check(epoch);
    try {
      const result = await request(original);
      this.check(epoch, original);
      return result;
    } catch (error) {
      this.check(epoch);
      if (!this.options.computerChanged(error)) {
        this.check(epoch, original);
        throw error;
      }
    }
    // Concurrent failures from the old generation share one describe, even if it
    // has already completed before a slower conflict arrives.
    let next = this.context;
    if (next === original) {
      if (!this.refresh) {
        const pending = this.options.describe(original.botId).then((context) => {
          this.check(epoch, original);
          if (context.botId !== original.botId) throw new WorkspaceReadCancelled();
          this.context = context;
          this.options.publish(context);
          return context;
        });
        this.refresh = pending;
        void pending
          .finally(() => {
            if (this.refresh === pending) this.refresh = null;
          })
          .catch(() => undefined);
      }
      try {
        next = await this.refresh;
      } catch (error) {
        this.check(epoch);
        throw error;
      }
    }
    this.check(epoch, next);
    // Publish a changed target or unavailable state, but never replay the old path there.
    if (
      !sameTarget(original, next) ||
      !next.computerId ||
      next.generation === null ||
      next.files === "unavailable"
    )
      throw new WorkspaceReadCancelled();
    try {
      const result = await request(next);
      this.check(epoch, next);
      return result;
    } catch (error) {
      this.check(epoch, next);
      throw error;
    }
  }
}
