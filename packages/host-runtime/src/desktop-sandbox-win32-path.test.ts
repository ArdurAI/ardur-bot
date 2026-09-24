import {
  constants,
  existsSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  symlinkSync,
} from "node:fs";
import type * as FsPromises from "node:fs/promises";
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import type { Win32NativeApi } from "./desktop-sandbox-win32-path.js";
import {
  createExclusiveChildViaDirectoryFdWin32,
  installWin32NativeApi,
  mkdirChildViaDirectoryFdWin32,
  openChildDirectoryViaDirectoryFdWin32,
  openExistingChildViaDirectoryFdWin32,
  pathFromWindowsHandle,
  win32NtRelativeAvailable,
} from "./desktop-sandbox-win32-path.js";

const handles = vi.hoisted(() => new Map<number, string>());
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof FsPromises>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      handles.set(handle.fd, await actual.realpath(args[0]));
      return handle;
    },
  };
});

const ctx = {
  operationId: "operation",
  traceId: "trace",
  spaceId: "space",
  userId: "owner",
  signal: new AbortController().signal,
};
let root: string;
let beforeCreate: ((parent: number, name: string) => void) | undefined;
const calls: { root: number; name: string; disposition: number; options: number }[] = [];

// The addon is the only substitute. Policy, Node file operations and inode checks are real.
const ntCreate = vi.fn(
  (
    output: unknown[],
    _access: number,
    attributes: { RootDirectory: number; ObjectName: { name: string } },
    _io: unknown,
    _size: unknown,
    _attributes: number,
    _share: number,
    disposition: number,
    options: number,
  ) => {
    const parent = attributes.RootDirectory;
    const name = attributes.ObjectName.name;
    calls.push({ root: parent, name, disposition, options });
    beforeCreate?.(parent, name);
    const parentPath = handles.get(parent);
    if (!parentPath) return -1;
    const target = path.join(parentPath, name);
    try {
      const directory = Boolean(options & 0x1);
      if (directory && disposition === 2) mkdirSync(target);
      const flags = directory
        ? constants.O_RDONLY | (constants.O_DIRECTORY ?? 0)
        : constants.O_RDWR | (disposition === 2 ? constants.O_CREAT | constants.O_EXCL : 0);
      const fd = openSync(target, flags | (constants.O_NOFOLLOW ?? 0));
      handles.set(fd, realpathSync(target));
      output[0] = fd;
      return 0;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return -1073741771;
      if (code === "ENOENT") return -1073741772;
      return -1;
    }
  },
);

const functions: Record<string, (...args: any[]) => unknown> = {
  NtCreateFile: ntCreate,
  RtlInitUnicodeString: (output: { name: string }, buffer: Buffer) => {
    output.name = buffer.toString("utf16le").replace(/\0$/, "");
  },
  _get_osfhandle: (fd: number) => (handles.has(fd) ? fd : -1),
  _open_osfhandle: (handle: number) => handle,
  CloseHandle: vi.fn(),
  GetFinalPathNameByHandleW: (fd: number, buffer: Buffer | null) => {
    const value = handles.get(fd);
    if (!value) return 0;
    buffer?.write(value, "utf16le");
    return value.length;
  },
};
const native: Win32NativeApi = {
  load: vi.fn(() => ({
    func: (prototype: string) => {
      const name = prototype.match(/\s(\w+)\(/)?.[1];
      if (!name || !functions[name]) throw new Error(`Unexpected prototype: ${prototype}`);
      return functions[name];
    },
  })),
  struct: vi.fn((name) => name),
  sizeof: () => 48,
};

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "host-win32-writer-")));
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  handles.clear();
  calls.length = 0;
  beforeCreate = undefined;
  vi.mocked(native.load).mockClear();
  installWin32NativeApi(() => native);
});
afterEach(async () => {
  installWin32NativeApi(() => undefined);
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const desktop = new DesktopSandboxProvider({ root, restricted: true });
  const computer = await desktop.provision({ botId: "bot", homePath: "/unused" }, ctx);
  return { desktop, computer, home: computer.providerRef };
}
async function createDirectory(
  desktop: DesktopSandboxProvider,
  computer: Awaited<ReturnType<typeof fixture>>["computer"],
  directory: string,
) {
  const events = [];
  for await (const event of desktop.execute(computer, { argv: ["mkdir", "-p", directory] }, ctx))
    events.push(event);
  return events;
}

describe("Windows relative-handle writer with a stubbed addon", () => {
  it("creates and replaces files and creates directories through held parent handles", async () => {
    const { desktop, computer, home } = await fixture();
    for (const content of ["first", "second"])
      await desktop.writeFile(computer, {
        path: "notes/result.txt",
        content: Buffer.from(content),
      });
    expect(await readFile(path.join(home, "notes/result.txt"), "utf8")).toBe("second");
    expect(await createDirectory(desktop, computer, "reports/daily")).toEqual([
      { type: "exit", code: 0 },
    ]);
    expect(existsSync(path.join(home, "reports/daily"))).toBe(true);
    expect(calls.some((call) => call.disposition === 1)).toBe(true);
    expect(calls.some((call) => call.disposition === 2)).toBe(true);
    for (const call of calls) {
      expect(handles.has(call.root)).toBe(true);
      expect(call.name).not.toMatch(/[/\\]/);
      expect(call.options & 0x00200000).toBe(0x00200000); // FILE_OPEN_REPARSE_POINT
      expect(call.options & 0x00000020).toBe(0x00000020); // FILE_SYNCHRONOUS_IO_NONALERT
    }
  });

  it.each([
    "../escape.txt",
    "notes/../../escape.txt",
    "notes\\..\\..\\escape.txt",
    "note.txt:stream",
  ])("refuses a non-confined file path: %s", async (file) => {
    const { desktop, computer } = await fixture();
    await expect(
      desktop.writeFile(computer, { path: file, content: Buffer.from("after") }),
    ).rejects.toThrow(/escapes/);
    expect(calls).toEqual([]);
  });

  it.each(["", ".", "..", "a/b", "a\\b"])("refuses a non-leaf NT child name: %s", (name) => {
    for (const operation of [
      openExistingChildViaDirectoryFdWin32,
      createExclusiveChildViaDirectoryFdWin32,
      mkdirChildViaDirectoryFdWin32,
      openChildDirectoryViaDirectoryFdWin32,
    ])
      expect(() => operation(123, name)).toThrow("Path escapes the computer workspace");
    expect(calls).toEqual([]);
  });

  it("rejects final symlinks and hard links without modifying the outside file", async () => {
    const { desktop, computer, home } = await fixture();
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "before");
    await symlink(outside, path.join(home, "symlink.txt"));
    await link(outside, path.join(home, "hardlink.txt"));
    for (const name of ["symlink.txt", "hardlink.txt"])
      await expect(
        desktop.writeFile(computer, { path: name, content: Buffer.from("after") }),
      ).rejects.toThrow(/escapes/);
    expect(await readFile(outside, "utf8")).toBe("before");
  });

  it("refuses writes and directory creation through an outside junction", async () => {
    const { desktop, computer, home } = await fixture();
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(home, "junction"), "junction");
    await expect(
      desktop.writeFile(computer, { path: "junction/result.txt", content: Buffer.from("after") }),
    ).rejects.toThrow(/escapes/);
    await expect(createDirectory(desktop, computer, "junction/new")).rejects.toThrow(/escapes/);
    expect(existsSync(path.join(outside, "result.txt"))).toBe(false);
    expect(existsSync(path.join(outside, "new"))).toBe(false);
  });

  it.each(["file", "directory"])(
    "refuses a parent swap immediately before %s creation and cleans up only the created inode",
    async (kind) => {
      const { desktop, computer, home } = await fixture();
      const parent = path.join(home, "notes");
      const displaced = path.join(root, "displaced");
      await mkdir(parent);
      await writeFile(path.join(parent, "keep.txt"), "before");
      beforeCreate = (_fd, name) => {
        if (name !== "new") return;
        beforeCreate = undefined;
        renameSync(parent, displaced);
        symlinkSync(displaced, parent, "junction");
        for (const [fd, heldPath] of handles)
          if (heldPath === parent || heldPath.startsWith(`${parent}${path.sep}`))
            handles.set(fd, displaced + heldPath.slice(parent.length));
      };
      const operation =
        kind === "file"
          ? desktop.writeFile(computer, { path: "notes/new", content: Buffer.from("after") })
          : createDirectory(desktop, computer, "notes/new");
      await expect(operation).rejects.toThrow(/escapes/);
      expect(existsSync(path.join(displaced, "new"))).toBe(false);
      expect(await readFile(path.join(displaced, "keep.txt"), "utf8")).toBe("before");
    },
  );

  it("retains the exact refusal when the addon or NT functions are unavailable", async () => {
    const { desktop, computer } = await fixture();
    for (const loader of [
      () => undefined,
      () => {
        throw new Error("Addon unavailable");
      },
      () => ({
        ...native,
        load: () => {
          throw new Error("NT functions unavailable");
        },
      }),
    ]) {
      installWin32NativeApi(loader);
      const message = "Host file writes require native directory handles on Windows.";
      await expect(
        desktop.writeFile(computer, { path: "file.txt", content: Buffer.from("after") }),
      ).rejects.toThrow(message);
      await expect(createDirectory(desktop, computer, "new")).rejects.toThrow(message);
    }
    expect(calls).toEqual([]);
  });

  it.each(["darwin", "linux"] as const)("does not request the addon on %s", (platform) => {
    const loader = vi.fn(() => native);
    installWin32NativeApi(loader);
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    expect(win32NtRelativeAvailable()).toBe(false);
    expect(loader).not.toHaveBeenCalled();
  });

  it("normalizes final DOS and UNC paths and rejects invalid handles", () => {
    handles.set(7, "\\\\?\\C:\\Workspace\\file.txt");
    handles.set(8, "\\\\?\\UNC\\server\\share\\file.txt");
    expect(pathFromWindowsHandle(7)).toBe("C:\\Workspace\\file.txt");
    expect(pathFromWindowsHandle(8)).toBe("\\\\server\\share\\file.txt");
    expect(() => pathFromWindowsHandle(-1)).toThrow(/escapes/);
    expect(() => pathFromWindowsHandle(-1n)).toThrow(/escapes/);
  });
});
