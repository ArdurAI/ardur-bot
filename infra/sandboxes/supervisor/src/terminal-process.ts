import type { Duplex } from "node:stream";
import type Docker from "dockerode";

/** Subreaper stays outside the interactive shell's job-control process group. */
export const TERMINAL_GUARDIAN = `
import ctypes, os, signal, subprocess, sys, time
if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
    sys.exit(70)
closing = False
def stop(*args):
    global closing
    closing = True
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGHUP, stop)
signal.signal(signal.SIGINT, signal.SIG_IGN)
def child_signals():
    signal.signal(signal.SIGINT, signal.SIG_DFL)
    signal.signal(signal.SIGTERM, signal.SIG_DFL)
    signal.signal(signal.SIGHUP, signal.SIG_DFL)
child = subprocess.Popen(['/bin/bash', '--noprofile', '--norc', '-i'], preexec_fn=child_signals,
    env={'HOME':'/home/ardurbot','PATH':'/home/ardurbot/.local/bin:/usr/local/bin:/usr/bin:/bin','TERM':'xterm-256color','LANG':'C.UTF-8'}, cwd=sys.argv[2])
while not closing and child.poll() is None and time.time()*1000 < int(sys.argv[3]):
    time.sleep(.05)
# Adopt double-forked children too; stop parents before enumerating descendants again.
def descendants():
    parents = {}
    for name in os.listdir('/proc'):
        if not name.isdigit(): continue
        try:
            stat = open('/proc/'+name+'/stat').read().rsplit(')',1)[1].split()
            parents[int(name)] = (int(stat[1]), stat[19])
        except (OSError, ValueError, IndexError): pass
    owned = {os.getpid()}
    while True:
        more = {pid for pid, (ppid, stamp) in parents.items() if ppid in owned}
        if more <= owned: return {pid: parents[pid][1] for pid in owned - {os.getpid()}}
        owned |= more
for attempt in range(100):
    pids = descendants()
    for sig in (signal.SIGSTOP, signal.SIGKILL):
        for pid, stamp in pids.items():
            fd = None
            try:
                fd = os.pidfd_open(pid)
                current = open('/proc/'+str(pid)+'/stat').read().rsplit(')',1)[1].split()[19]
                if current == stamp: signal.pidfd_send_signal(fd, sig)
            except OSError: pass
            finally:
                if fd is not None: os.close(fd)
    try:
        while os.waitpid(-1, os.WNOHANG)[0]: pass
    except ChildProcessError:
        sys.exit(0)
    time.sleep(.02)
sys.exit(71)
`;

export interface TerminalProcess {
  stream: Duplex;
  resize(cols: number, rows: number): Promise<void>;
  close(): Promise<void>;
}
export async function openDockerTerminal(
  container: Docker.Container,
  user: string,
  root: string,
  id: string,
  cols: number,
  rows: number,
  expiresAt: number,
): Promise<TerminalProcess> {
  const exec = await container.exec({
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    User: user,
    WorkingDir: root,
    Cmd: [
      "/usr/bin/env",
      "-i",
      "PATH=/usr/bin:/bin",
      "/usr/bin/python3",
      "-c",
      TERMINAL_GUARDIAN,
      id,
      root,
      String(expiresAt),
    ],
  });
  let stream: Duplex;
  try {
    stream = (await exec.start({ hijack: true, stdin: true, Tty: true })) as Duplex;
  } catch (error) {
    await container.stop({ t: 0 });
    throw error;
  }
  const process: TerminalProcess = {
    stream,
    resize: (w, h) => exec.resize({ w, h }),
    async close() {
      // Locate only the immutable guardian command, never use shell interpolation.
      const signal = await container.exec({
        AttachStdout: true,
        AttachStderr: true,
        User: user,
        Cmd: [
          "/usr/bin/python3",
          "-c",
          String.raw`import os,signal,sys
for name in os.listdir('/proc'):
 if name.isdigit():
  try:
   args=open('/proc/'+name+'/cmdline','rb').read().split(b'\0')
   if len(args)>6 and args[1]==b'-c' and args[3]==sys.argv[1].encode() and b'prctl(36' in args[2]: os.kill(int(name),signal.SIGTERM)
  except (OSError,ValueError): pass`,
          id,
        ],
      });
      const signalStream = await signal.start({});
      signalStream.resume();
      for (let attempt = 0; attempt < 60; attempt++) {
        const status = await exec.inspect();
        if (!status.Running) {
          stream.destroy();
          // An interrupted guardian cannot prove cleanup. Stopping this computer is the fail-closed fallback.
          if (status.ExitCode !== 0) await container.stop({ t: 0 });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await container.stop({ t: 0 });
      stream.destroy();
    },
  };
  try {
    await process.resize(cols, rows);
    return process;
  } catch (error) {
    await process.close();
    throw error;
  }
}

/** A restarted supervisor must not admit work past a guardian it no longer owns. */
export async function assertNoDockerTerminals(container: Docker.Container, stopOrphans = false) {
  const probe = await container.exec({
    AttachStdout: true,
    AttachStderr: true,
    Cmd: [
      "/usr/bin/python3",
      "-c",
      String.raw`import os,sys
for name in os.listdir('/proc'):
 if name.isdigit():
  try:
   args=open('/proc/'+name+'/cmdline','rb').read().split(b'\0')
   if len(args)>5 and args[1]==b'-c' and b'prctl(36' in args[2]: sys.exit(42)
  except (OSError,ValueError): pass
sys.exit(0)`,
    ],
  });
  const stream = await probe.start({});
  await new Promise<void>((resolve, reject) => {
    stream.on("error", reject);
    stream.on("end", resolve);
    stream.resume();
  });
  const status = await probe.inspect();
  if (status.ExitCode === 0) return;
  if (status.ExitCode === 42 && stopOrphans) {
    await container.stop({ t: 0 });
    return;
  }
  throw new Error("A person has control of this computer; wait until they release it.");
}
