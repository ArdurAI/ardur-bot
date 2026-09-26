import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { GUEST_FILE_OPERATIONS } from "./guest.js";

const exec = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "guest-walker-"));
  directories.push(root);
  for (const directory of ["home", "state", "workspace", "tmp"])
    await mkdir(path.join(root, directory));
  return root;
}

/** The walker runs against a temporary root by substituting the guest's fixed root in its source. */
function walkerSource(root: string) {
  const fixed = "ROOT = '/opt/data'\n";
  if (!GUEST_FILE_OPERATIONS.includes(fixed)) throw new Error("The guest root moved");
  return GUEST_FILE_OPERATIONS.replace(fixed, `ROOT = ${JSON.stringify(root)}\n`);
}

async function operation(root: string, value: Record<string, unknown>) {
  const source = `${walkerSource(root)}
try:
    print(json.dumps({'value': files(json.loads(sys.argv[1]))}, separators=(',', ':')))
except Refused as error:
    print(json.dumps({'refused': str(error)}, separators=(',', ':')))
`;
  const result = await exec("python3", ["-I", "-S", "-c", source, JSON.stringify(value)], {
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(result.stdout) as {
    value?: unknown;
    refused?: string;
  };
}

it("reads no environment for its root", () => {
  expect(GUEST_FILE_OPERATIONS).toContain("ROOT = '/opt/data'\n");
  expect(GUEST_FILE_OPERATIONS).not.toMatch(/environ/);
});

it("normalizes dot components while the descriptor walker refuses parent and link traversal", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "workspace/notes.txt"), "notes");
  await writeFile(path.join(root, "state/private.txt"), "private");
  await symlink(path.join(root, "state"), path.join(root, "workspace/leak"));

  expect(await operation(root, { op: "read", path: "workspace/./notes.txt" })).toHaveProperty(
    "value",
    Buffer.from("notes").toString("base64"),
  );
  expect(await operation(root, { op: "list", path: "workspace/." })).toMatchObject({
    value: [
      { name: "leak", kind: "link", size: 0 },
      { name: "notes.txt", kind: "file", size: 5 },
    ],
  });
  expect(await operation(root, { op: "read", path: "workspace/leak/private.txt" })).toHaveProperty(
    "refused",
  );
  await expect(
    operation(root, { op: "read", path: "workspace/../state/private.txt" }),
  ).rejects.toThrow();
});

it("records snapshot links without following or exporting their content", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "workspace/result.txt"), "safe");
  await writeFile(path.join(root, "state/private.txt"), "private");
  await symlink(path.join(root, "state/private.txt"), path.join(root, "workspace/leak"));

  expect(await operation(root, { op: "snapshot", path: "workspace" })).toEqual({
    value: {
      leak: { kind: "link" },
      "result.txt": "safe",
    },
  });
});
