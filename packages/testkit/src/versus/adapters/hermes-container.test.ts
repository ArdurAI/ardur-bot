import { EventEmitter } from "node:events";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { qualifyContainers, retainsReceiptsWithoutWorkspace } from "../containers/qualification.js";
import { RECEIPTS_NOT_READ, WORKSPACE_NOT_INSPECTED } from "./hermes-container.js";

const inspectImage = vi.hoisted(() => vi.fn());
const open = vi.hoisted(() => vi.fn());
vi.mock("../containers/session.js", () => ({
  inspectImage,
  ContainerSession: { open },
}));
vi.mock("../containers/ordinary.js", () => ({
  qualifyOrdinaryExecution: vi.fn(async () => []),
  qualifyCancellation: vi.fn(async () => []),
}));
vi.mock("../containers/command-probe.js", () => ({
  probeBudgetAdmission: vi.fn(async () => ({ passed: true, evidence: {} })),
}));
vi.mock("../containers/product-roundtrip.js", () => ({
  assessAggregateDisk: vi.fn(() => ({ passed: true, evidence: {} })),
  qualifyHermesProduct: vi.fn(),
}));
vi.mock("../provenance.js", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  inspectBuild: async () => ({ build: { commit: "synthetic-build", dirty: false } }),
}));

type Entry = string | { kind: "link" };
/** What a cancel or loss probe's guest holds, and what the loss does to the receipt journal. */
type Probe = {
  extra?: Record<string, Entry>;
  snapshotError?: string;
  unreadableJournal?: boolean;
};

const outputs: string[] = [];
afterEach(async () => {
  for (const output of outputs.splice(0)) await rm(output, { recursive: true, force: true });
});

const HERMES_REPLY = "╭─⚕ Hermes──╮\n  Saved the requested result.\n╰────────────╯\n";

/** Python probes answer benignly; the scripted stand-in speaks to the real broker and gateway. */
class GuestSession {
  readonly policy = {};
  readonly proof = {};
  private readonly files = new Map<string, string>();
  private active = true;
  private probe = false;
  constructor(
    private readonly root: string,
    private readonly scenario: Probe,
  ) {}
  async write(file: string, content: string | Uint8Array) {
    this.assertActive();
    const text = typeof content === "string" ? content : Buffer.from(content).toString("utf8");
    this.files.set(file, text);
    // The cancel and loss probes install a stand-in that must never start.
    if (file === "state/standin.py" && text.includes("must not start")) this.probe = true;
  }
  async read(file: string) {
    this.assertActive();
    return Buffer.from(this.files.get(file) ?? "");
  }
  async snapshot(directory = "workspace") {
    this.assertActive();
    if (this.probe && this.scenario.snapshotError) throw new Error(this.scenario.snapshotError);
    const entries: Record<string, Entry> = {};
    for (const [name, content] of this.files)
      if (name.startsWith(`${directory}/`)) entries[name.slice(directory.length + 1)] = content;
    return this.probe ? { ...entries, ...this.scenario.extra } : entries;
  }
  bindRelay(providerUrl: string, brokerUrl: string) {
    return { providerUrl, brokerUrl };
  }
  async destroy() {
    if (this.active && this.probe && this.scenario.unreadableJournal)
      await appendFile(path.join(this.root, "broker-receipts.jsonl"), "{unreadable\n");
    this.active = false;
  }
  async exec(argv: string[]) {
    this.assertActive();
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    setImmediate(() => {
      void this.run(argv).then(
        ({ code, stdout }) => {
          if (stdout) child.stdout.emit("data", Buffer.from(stdout));
          child.emit("close", code);
        },
        (error) => child.emit("error", error),
      );
    });
    return child;
  }
  private async run(argv: string[]): Promise<{ code: number; stdout: string }> {
    if (!argv.includes("/opt/data/state/standin.py")) {
      const script = argv.at(-1) ?? "";
      return { code: 0, stdout: script.includes("provider/models") ? "200" : "{}" };
    }
    const config = JSON.parse(this.files.get("state/config.yaml")!) as {
      model: { base_url: string; default: string };
      mcp_servers: Record<string, { url: string }>;
    };
    const post = async (url: string, value: unknown) =>
      (
        await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(value),
        })
      ).json() as Promise<Record<string, unknown>>;
    const broker = config.mcp_servers["mcp-scoreboard"]!.url;
    const input = /config\.get\('fixture_input', (".+?")\)/.exec(
      this.files.get("state/standin.py") ?? "",
    )?.[1];
    await post(broker, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await post(broker, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "read_file", arguments: { path: JSON.parse(input ?? '"brief.md"') } },
    });
    const response = (await post(`${config.model.base_url}/chat/completions`, {
      model: config.model.default,
      messages: [{ role: "user", content: this.files.get("state/query.txt") }],
    })) as { choices: { message: { content: string } }[] };
    const saved = (await post(broker, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "write_file",
        arguments: { path: "result.json", content: response.choices[0]!.message.content },
      },
    })) as { result?: { isError?: boolean } };
    return saved.result?.isError ? { code: 1, stdout: "" } : { code: 0, stdout: HERMES_REPLY };
  }
  private assertActive() {
    if (!this.active) throw new Error("Container closed");
  }
}

async function qualify(scenario: Probe) {
  inspectImage.mockResolvedValue({ id: `sha256:${"ab".repeat(32)}`, revision: null });
  open.mockImplementation(async ({ root }: { root: string }) => new GuestSession(root, scenario));
  const output = await mkdtemp(path.join(tmpdir(), "container-qualification-"));
  outputs.push(output);
  const report = await qualifyContainers(output, true);
  const retention = (id: string) => {
    const check = report.checks.find(
      (item) => item.name === `${id}-retains-receipts-and-nonsuccess`,
    );
    if (!check) throw new Error(`${id} did not run: ${report.failures.join("; ")}`);
    return check as { passed: boolean; evidence: Record<string, unknown> };
  };
  return {
    report,
    cancel: retention("container-cancel"),
    loss: retention("container-loss"),
  };
}

it("passes cancel and loss when the workspace holds only the task inputs and the receipts survive", async () => {
  const { cancel, loss } = await qualify({});
  for (const check of [cancel, loss]) {
    expect(check.passed).toBe(true);
    expect(check.evidence.workspace).toEqual({
      files: { "case.json": expect.any(String) },
      links: [],
    });
    expect((check.evidence.observation as { effects: unknown[] }).effects).toHaveLength(1);
  }
});

it("fails both probes when the receipts cannot be read after the loss", async () => {
  const { report, cancel, loss } = await qualify({ unreadableJournal: true });
  for (const check of [cancel, loss]) {
    expect(check.passed).toBe(false);
    expect(check.evidence.failure).toBe(RECEIPTS_NOT_READ);
  }
  expect(report.failures.filter((failure) => failure === RECEIPTS_NOT_READ)).toHaveLength(2);
});

it("fails both probes when the workspace contains an undeclared symlink", async () => {
  const { cancel, loss } = await qualify({ extra: { leak: { kind: "link" } } });
  for (const check of [cancel, loss]) {
    expect(check.passed).toBe(false);
    expect(check.evidence.workspace).toMatchObject({ links: ["leak"] });
  }
});

it("fails both probes when the workspace cannot be read before the loss", async () => {
  const { cancel, loss } = await qualify({
    snapshotError: "Container operation refused: UnicodeDecodeError",
  });
  for (const check of [cancel, loss]) {
    expect(check.passed).toBe(false);
    expect(check.evidence.failure).toBe(WORKSPACE_NOT_INSPECTED);
  }
});

it("fails a probe whose workspace was not listed or changed a task input", () => {
  const base = {
    cancelled: true,
    terminal: "cancelled",
    effects: [{}],
    inputs: { "case.json": "{}" },
    links: [],
    providerRequests: 0,
    gradedPassed: false,
  };
  expect(retainsReceiptsWithoutWorkspace({ ...base, files: { "case.json": "{}" } })).toBe(true);
  expect(
    retainsReceiptsWithoutWorkspace({ ...base, files: { "case.json": "{}" }, links: undefined }),
  ).toBe(false);
  expect(retainsReceiptsWithoutWorkspace({ ...base, files: { "case.json": "[]" } })).toBe(false);
  expect(
    retainsReceiptsWithoutWorkspace({ ...base, files: { "case.json": "{}", "result.json": "{}" } }),
  ).toBe(false);
});
