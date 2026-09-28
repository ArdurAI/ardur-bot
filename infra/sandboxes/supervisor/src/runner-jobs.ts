import { RunnerJobRequestSchema } from "@ardurbot/contracts";
import Docker from "dockerode";
import { Hono } from "hono";

export const runnerJobsRouter = new Hono();
const docker = new Docker();

const jobs = new Map<string, { containerId: string }>();

runnerJobsRouter.get("/probe", async (c) => {
  await docker.ping();
  return c.json({ ok: true });
});

runnerJobsRouter.post("/", async (c) => {
  const req = await c.req.json();
  const parsed = RunnerJobRequestSchema.parse(req);
  const providerRef = `runner-job-${Date.now()}`;

  // Create deadline script
  const script = `#!/bin/sh
set -e
trap 'kill -9 $CHILD_PID 2>/dev/null' TERM INT
"$@" &
CHILD_PID=$!
wait $CHILD_PID
`;

  // Start container
  const container = await docker.createContainer({
    Image: "ubuntu:24.04", // basic image for R1 testing
    Entrypoint: ["/bin/sh", "-c", script, "--", ...parsed.command],
    HostConfig: {
      NetworkMode: "none",
      SecurityOpt: ["no-new-privileges"],
      CapDrop: ["ALL"],
      Tmpfs: { "/tmp": "size=512m" },
    },
  });

  await container.start();
  jobs.set(providerRef, { containerId: container.id });
  return c.json({ providerRef });
});

runnerJobsRouter.get("/:ref/inspect", async (c) => {
  const job = jobs.get(c.req.param("ref"));
  if (!job) return c.json({ state: "unknown" }, 404);
  const container = docker.getContainer(job.containerId);
  const info = await container.inspect();
  return c.json({ state: info.State.Status });
});

runnerJobsRouter.get("/:ref/events", async (c) => {
  const job = jobs.get(c.req.param("ref"));
  if (!job) return c.text("Not found", 404);

  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  return c.body('data: {"seq":1,"kind":"output","stream":"stdout","payload":"started\\n"}\n\n');
});

runnerJobsRouter.delete("/:ref", async (c) => {
  const job = jobs.get(c.req.param("ref"));
  if (job) {
    try {
      const container = docker.getContainer(job.containerId);
      await container.stop({ t: 1 }).catch(() => {});
      await container.remove({ force: true }).catch(() => {});
    } catch (e) {}
    jobs.delete(c.req.param("ref"));
  }
  return c.body(null, 204);
});

runnerJobsRouter.post("/:ref/collect", async (c) => {
  const job = jobs.get(c.req.param("ref"));
  if (!job) return c.json({ exitCode: 1, artifacts: [] }, 404);
  const container = docker.getContainer(job.containerId);
  const info = await container.inspect();
  return c.json({ exitCode: info.State.ExitCode ?? 1, artifacts: [] });
});

runnerJobsRouter.post("/:ref/cleanup", async (c) => {
  const job = jobs.get(c.req.param("ref"));
  if (job) {
    try {
      const container = docker.getContainer(job.containerId);
      await container.remove({ force: true }).catch(() => {});
    } catch (e) {}
    jobs.delete(c.req.param("ref"));
  }
  return c.json({ ok: true });
});
