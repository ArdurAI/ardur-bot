import type { JobPublisher } from "@ardurbot/adapter-kit";
import type { MessagingInstallationSettings, ReceiverState } from "@ardurbot/adapters";
import {
  createChatTransport,
  createMessagingDispatch,
  deliverChatOutbox,
  drainChatInbox,
  transportIO,
} from "@ardurbot/adapters";
import type { Pool, PrismaClient, ThreadEvents } from "@ardurbot/db";

/** One elected worker owns all installation receivers, inbox consumers and delivery queues. */
export function createMessagingReceivers(deps: {
  prisma: PrismaClient;
  pool: Pool;
  jobs: JobPublisher;
  events: ThreadEvents;
  settings: MessagingInstallationSettings;
}) {
  const dispatch = createMessagingDispatch(deps);
  let controller: AbortController | undefined;
  let running: Promise<void> | undefined;
  const receivers = new Map<
    string,
    { revision: number; abort: AbortController; task: Promise<void> }
  >();
  async function stopReceivers() {
    for (const receiver of receivers.values()) receiver.abort.abort();
    await Promise.allSettled([...receivers.values()].map((receiver) => receiver.task));
    receivers.clear();
  }
  async function own(signal: AbortSignal) {
    const client = await deps.pool.connect();
    const lost = new AbortController();
    const active = AbortSignal.any([signal, lost.signal]);
    const onLost = () => lost.abort();
    client.once("error", onLost);
    let locked = false;
    try {
      const lock = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(1380019075, 2) AS acquired",
      );
      locked = lock.rows[0]?.acquired === true;
      if (!locked) return;
      await deps.prisma.chatOutbox.updateMany({
        where: { state: "sending" },
        data: { state: "uncertain" },
      });
      while (!active.aborted) {
        const installations = await deps.prisma.chatInstallation.findMany({
          where: { enabled: true },
        });
        for (const [id, receiver] of receivers)
          if (
            !installations.some((item) => item.id === id && item.revision === receiver.revision)
          ) {
            receiver.abort.abort();
            await receiver.task;
            receivers.delete(id);
          }
        for (const installation of installations) {
          if (!receivers.has(installation.id)) {
            const abort = new AbortController();
            const receiverSignal = AbortSignal.any([active, abort.signal]);
            const config = deps.settings.load(installation);
            const transport = createChatTransport({ ...config, accountId: installation.accountId });
            const task = (async () => {
              let failures = 0;
              while (!receiverSignal.aborted) {
                try {
                  await transport.receive({
                    signal: receiverSignal,
                    load: async () =>
                      ((
                        await deps.prisma.messagingReceiverState.findUnique({
                          where: { installationId: installation.id },
                        })
                      )?.state as ReceiverState) ?? {},
                    save: async (state) => {
                      await deps.prisma.messagingReceiverState.upsert({
                        where: { installationId: installation.id },
                        create: { installationId: installation.id, state },
                        update: { state },
                      });
                    },
                    accept: async (event) => {
                      await dispatch.receive(installation, event, [
                        config.botToken,
                        config.appToken ?? "",
                        config.webhookSecret ?? "",
                      ]);
                      failures = 0;
                    },
                  });
                  failures++;
                } catch {
                  failures++;
                }
                if (!receiverSignal.aborted)
                  await transportIO
                    .sleep(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)), receiverSignal)
                    .catch(() => undefined);
              }
            })();
            receivers.set(installation.id, { revision: installation.revision, abort, task });
          }
          await drainChatInbox(deps.prisma, installation, dispatch);
          await dispatch.notifications(installation);
          const config = deps.settings.load(installation);
          await deliverChatOutbox(
            deps.prisma,
            installation,
            createChatTransport({ ...config, accountId: installation.accountId }),
            active,
            [config.botToken, config.appToken ?? "", config.webhookSecret ?? ""],
          );
        }
        await transportIO.sleep(1000, active).catch(() => undefined);
      }
    } finally {
      await stopReceivers();
      client.removeListener("error", onLost);
      if (locked && !lost.signal.aborted)
        await client.query("SELECT pg_advisory_unlock(1380019075, 2)").catch(() => lost.abort());
      client.release(lost.signal.aborted);
    }
  }
  return {
    start() {
      if (running) return;
      controller = new AbortController();
      const signal = controller.signal;
      running = (async () => {
        while (!signal.aborted) {
          await own(signal).catch(() => undefined);
          if (!signal.aborted) await transportIO.sleep(2000, signal).catch(() => undefined);
        }
      })();
    },
    async stop() {
      controller?.abort();
      await running;
      running = undefined;
      controller = undefined;
    },
  };
}
