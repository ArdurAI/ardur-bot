import { resolveSupervisorToken } from "@ardurbot/core";
import { describe, expect, it, vi } from "vitest";

const created = vi.hoisted(() => [] as (string | undefined)[]);
vi.mock("dockerode", () => ({
  default: class {
    constructor(private readonly options: { socketPath?: string }) {
      created.push(options.socketPath);
    }
    async version() {
      if (this.options.socketPath?.includes("stopped"))
        throw Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" });
      await Promise.resolve();
      return {
        Components: [
          { Name: this.options.socketPath?.includes("podman") ? "Podman Engine" : "Engine" },
        ],
      };
    }
    async info() {
      return {
        SecurityOptions: this.options.socketPath?.includes("podman") ? ["name=rootless"] : [],
      };
    }
  },
}));

import { supervisorApp } from "./index.js";

describe("engine connection routing", () => {
  it("keeps simultaneous Docker and Podman requests on their selected sockets", async () => {
    const inspect = async (socket: string) => {
      const response = await supervisorApp.request("/computers/engine", {
        headers: {
          authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
          "x-ardurbot-engine-socket": socket,
        },
      });
      return response.json();
    };
    const [podman, docker] = await Promise.all([
      inspect("unix:///tmp/podman-route.sock"),
      inspect("/tmp/docker-route.sock"),
    ]);
    expect(podman).toEqual({ name: "podman", rootless: true });
    expect(docker).toEqual({ name: "docker", rootless: false });
    expect(created).toContain("/tmp/podman-route.sock");
  });

  it("authenticates before opening an engine connection", async () => {
    const before = created.length;
    const response = await supervisorApp.request("/computers/engine", {
      headers: { "x-ardurbot-engine-socket": "/tmp/unauthorized.sock" },
    });
    expect(response.status).toBe(401);
    expect(created.length).toBe(before);
  });
});

it.each(["docker", "podman"])(
  "reports a stopped %s socket as a bounded, typed failure",
  async (engine) => {
    const response = await supervisorApp.request("/computers/engine", {
      headers: {
        authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
        "x-ardurbot-engine-socket": "/fixture/stopped.sock",
        "x-ardurbot-engine": engine,
      },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "engine-unavailable",
      engine,
      socket: "/fixture/stopped.sock",
    });
  },
);
