import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  ComputerRef,
  TerminalContext,
  TerminalOutput,
  TerminalProvider,
} from "@ardurbot/adapter-kit";
import { RuntimeQueue, stopNative } from "../runtimes/native-process.js";
import { fleetPath } from "./archive.js";
import { LINUX_ROOT } from "./linux-scripts.js";

const PTY_SCRIPT = `${LINUX_ROOT}
import pty,select,fcntl,termios,struct,base64
target=directory(sys.argv[4]); os.fchdir(target); os.close(target)
pid,master=pty.fork()
if pid==0:
 os.environ['HOME']=root; os.environ['TERM']='xterm-256color'
 os.execvp('bash',['bash','--noprofile','--norc'])
def resize(cols,rows):
 if not 1<=cols<=500 or not 1<=rows<=500: raise ValueError('Invalid terminal size')
 fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',rows,cols,0,0))
def stop(*unused):
 try: os.killpg(pid,signal.SIGKILL)
 except ProcessLookupError: pass
for sig in (signal.SIGHUP,signal.SIGTERM,signal.SIGINT): signal.signal(sig,lambda *args: sys.exit(1))
resize(int(sys.argv[2]),int(sys.argv[3])); pending=b''
try:
 while True:
  ready,_,_=select.select([0,master],[],[],1)
  if master in ready:
   try: data=os.read(master,16384)
   except OSError: break
   if not data: break
   print(json.dumps({'bytes':base64.b64encode(data).decode()}),flush=True)
  if 0 in ready:
   data=os.read(0,32768)
   if not data: break
   pending+=data
   if len(pending)>131072: raise ValueError('Terminal input exceeds limit')
   while b'\\n' in pending:
    line,pending=pending.split(b'\\n',1); frame=json.loads(line)
    if 'bytes' in frame: os.write(master,base64.b64decode(frame['bytes'],validate=True))
    elif 'cols' in frame: resize(frame['cols'],frame['rows'])
    else: raise ValueError('Invalid terminal input')
finally: stop(); os.close(master)
`;

type Session = {
  computerId: string;
  spaceId: string;
  leaseId: string;
  expiresAt: number;
  child: ChildProcessWithoutNullStreams;
  cleanup(): Promise<void>;
  queue: RuntimeQueue<TerminalOutput>;
  timer: ReturnType<typeof setTimeout>;
};
export class FleetTerminal implements TerminalProvider {
  private sessions = new Map<string, Session>();
  constructor(
    private readonly start: (
      computer: ComputerRef,
      argv: string[],
      context: AdapterContext,
    ) => Promise<{ child: ChildProcessWithoutNullStreams; cleanup(): Promise<void> }>,
    private readonly root: (computer: ComputerRef, context: AdapterContext) => Promise<string>,
  ) {}
  async open(
    computer: ComputerRef,
    options: { cols: number; rows: number; shellProfileId: string },
    context: TerminalContext,
  ) {
    if (this.sessions.size >= 16 || context.expiresAt <= Date.now() || !context.leaseId)
      throw new Error("Terminal lease is unavailable.");
    this.size(options.cols, options.rows);
    const root = await this.root(computer, context);
    const cwd =
      context.workingRoot === root
        ? ""
        : context.workingRoot?.startsWith(`${root}/`)
          ? context.workingRoot.slice(root.length + 1)
          : (context.workingRoot ?? "");
    const opened = await this.start(
      computer,
      [
        "python3",
        "-c",
        PTY_SCRIPT,
        root,
        String(options.cols),
        String(options.rows),
        fleetPath(cwd),
      ],
      context,
    );
    const id = randomUUID();
    const queue = new RuntimeQueue<TerminalOutput>();
    const timer = setTimeout(
      () => void this.close(id, "expired"),
      Math.min(context.expiresAt - Date.now(), 30 * 60_000),
    );
    timer.unref();
    this.sessions.set(id, {
      ...opened,
      computerId: computer.id,
      spaceId: context.spaceId,
      leaseId: context.leaseId,
      expiresAt: context.expiresAt,
      queue,
      timer,
    });
    let pending = "",
      sequence = 0;
    opened.child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      try {
        pending += chunk;
        if (pending.length > 256 * 1024) throw new Error();
        while (pending.includes("\n")) {
          const index = pending.indexOf("\n");
          const frame = JSON.parse(pending.slice(0, index)) as { bytes: string };
          pending = pending.slice(index + 1);
          if (typeof frame.bytes !== "string" || frame.bytes.length > 32768) throw new Error();
          queue.push({ seq: sequence++, bytes: Buffer.from(frame.bytes, "base64") });
        }
      } catch {
        queue.end(new Error("Terminal output is invalid."));
        void this.close(id, "invalid");
      }
    });
    opened.child.stderr.resume();
    opened.child.stdin.on("error", () => undefined);
    opened.child.once("error", () => {
      queue.end(new Error("Terminal could not start."));
      void this.close(id, "failed");
    });
    opened.child.once("close", () => {
      queue.end();
      void this.close(id, "closed");
    });
    return { id, generation: context.generation };
  }
  private session(id: string) {
    const session = this.sessions.get(id);
    if (!session || session.expiresAt <= Date.now())
      throw new Error("Terminal lease is unavailable.");
    return session;
  }
  private size(cols: number, rows: number) {
    if (![cols, rows].every((n) => Number.isInteger(n) && n >= 1 && n <= 500))
      throw new Error("Invalid terminal size.");
  }
  async write(id: string, bytes: Uint8Array) {
    if (bytes.length > 32768) throw new Error("Terminal input exceeds limit.");
    this.session(id).child.stdin.write(
      `${JSON.stringify({ bytes: Buffer.from(bytes).toString("base64") })}\n`,
    );
  }
  async resize(id: string, cols: number, rows: number) {
    this.size(cols, rows);
    this.session(id).child.stdin.write(`${JSON.stringify({ cols, rows })}\n`);
  }
  async close(id: string, _reason: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    clearTimeout(session.timer);
    session.child.stdin.end();
    await stopNative(session.child);
    await session.cleanup();
    session.queue.end();
  }
  async *output(id: string) {
    yield* this.session(id).queue;
  }
  async closeAll() {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id, "disconnected")));
  }
  async revoke(computer: ComputerRef, leaseId: string, context: AdapterContext) {
    await Promise.all(
      [...this.sessions]
        .filter(
          ([, session]) =>
            session.computerId === computer.id &&
            session.spaceId === context.spaceId &&
            (leaseId === "*" || session.leaseId === leaseId),
        )
        .map(([id]) => this.close(id, "revoked")),
    );
  }
}
