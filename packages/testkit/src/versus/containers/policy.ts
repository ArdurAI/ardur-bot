import { contentDigest } from "../../scoreboard/manifest.js";
import type { Budget } from "../budget.js";
import { requireValue } from "../budget.js";

export const COMPUTER_IMAGE =
  "sha256:89fb39ae7db9d66941ab9e8943ca8878a9ece8d0883bfc34ea222be4dbb95fa5";
export const HERMES_IMAGE =
  "nousresearch/hermes-agent@sha256:c64666f62179b6cd7d2df3348a30907b383a82a8e0d2400083b8004e24615780";
export const HERMES_CONTAINER_REVISION = "29112bef099274229cadff79cdff7bf7b99c4b77";
/** This image's agent_init rejects a declared context below this token count. */
export const HERMES_MINIMUM_CONTEXT_TOKENS = 64_000;
export const HERMES_IMAGE_PAYLOAD_BYTES = 938742461;
export const HERMES_PULL = `docker pull --platform linux/arm64 ${HERMES_IMAGE}`;
export const CONTAINER_ROOT = "/opt/data";

/** No agent fork/exec chain can evade descendant admission: processes enter through docker exec.
 * Threads are permitted and charged to the kernel pids/memory/CPU cgroup. */
export const CONTAINER_SECCOMP = {
  defaultAction: "SCMP_ACT_ERRNO",
  defaultErrnoRet: 1,
  syscalls: [
    {
      names:
        `open openat openat2 read write readv writev pread64 pwrite64 preadv pwritev preadv2 pwritev2 close close_range
        fstat newfstatat stat lstat statx statfs fstatfs lseek mmap mmap2 mprotect munmap brk
        rt_sigaction rt_sigprocmask rt_sigreturn rt_sigsuspend rt_sigtimedwait sigaltstack
        ioctl access faccessat faccessat2 pipe pipe2 select pselect6 poll ppoll sched_yield
        mremap msync mincore madvise dup dup2 dup3 nanosleep clock_nanosleep getitimer setitimer alarm
        getpid gettid getppid getpgrp getpgid getsid setsid setpgid socket connect accept accept4
        bind listen sendto recvfrom sendmsg recvmsg sendmmsg recvmmsg shutdown getsockname getpeername
        socketpair setsockopt getsockopt exit exit_group wait4 waitid kill tkill tgkill uname
        fcntl flock fsync fdatasync sync_file_range truncate ftruncate fallocate getdents getdents64
        getcwd chdir fchdir rename renameat renameat2 mkdir mkdirat rmdir link linkat unlink unlinkat
        symlink symlinkat readlink readlinkat chmod fchmod fchmodat chown fchown fchownat lchown umask
        gettimeofday getrlimit getrusage sysinfo times getuid getgid geteuid getegid getresuid getresgid
        getgroups setgroups setuid setgid setresuid setresgid setreuid setregid prctl prlimit64
        setrlimit arch_prctl futex futex_waitv set_tid_address set_robust_list get_robust_list restart_syscall
        epoll_create epoll_create1 epoll_ctl epoll_wait epoll_pwait epoll_pwait2 eventfd eventfd2
        signalfd signalfd4 timerfd_create timerfd_settime timerfd_gettime clock_gettime clock_getres
        sched_getaffinity sched_setaffinity sched_getparam sched_getscheduler sched_get_priority_max
        sched_get_priority_min getrandom memfd_create membarrier rseq capget capset execve execveat
        getxattr lgetxattr fgetxattr listxattr llistxattr flistxattr setxattr fsetxattr removexattr
        fadvise64 utime utimes utimensat inotify_init inotify_init1 inotify_add_watch inotify_rm_watch
        sendfile copy_file_range`
          .split(/\s+/)
          .filter(Boolean),
      action: "SCMP_ACT_ALLOW",
    },
    {
      names: ["clone"],
      action: "SCMP_ACT_ALLOW",
      args: [{ index: 0, value: 65536, valueTwo: 65536, op: "SCMP_CMP_MASKED_EQ" }],
    },
    // glibc falls back to clone for threads. Other clone modes, fork and vfork stay denied.
    { names: ["clone3"], action: "SCMP_ACT_ERRNO", errnoRet: 38 },
  ],
} as const;

export interface ContainerPolicy {
  version: 1;
  image: string;
  imageId: string;
  platform: "linux/arm64";
  user: "65531:65532";
  productUser: "65532:65532";
  network: "none";
  memoryBytes: number;
  diskBytes: number;
  processes: number;
  cpuPeriodUs: number;
  cpuQuotaUs: number;
  wallMs: number;
  cpuMs: number;
  seccompHash: string;
}
export function containerPolicy(
  image: string,
  imageId: string,
  budget: Budget,
  wallMs: number,
): Readonly<ContainerPolicy> {
  requireValue(
    /^(?:[a-z0-9./-]+@)?sha256:[a-f0-9]{64}$/.test(image) && /^sha256:[a-f0-9]{64}$/.test(imageId),
    "Container requires immutable image identity",
  );
  const resources = budget.resources;
  requireValue(
    Object.values(resources).every((value) => Number.isSafeInteger(value) && value > 0),
    "Container resource limits must be finite positive safe integers",
  );
  requireValue(
    Number.isSafeInteger(wallMs) && wallMs > 0 && wallMs <= budget.perTrial.wallMs,
    "Invalid container deadline",
  );
  requireValue(
    resources.diskBytes >= 1048576 &&
      resources.diskBytes <= 2147483648 &&
      resources.memoryBytes >= 67108864 &&
      resources.processes >= 8,
    "Container requires bounded usable resources",
  );
  const cpuPeriodUs = 100000;
  // Reserve startup/deadline margin as well as one scheduling period. Never increase the CPU envelope.
  const cpuQuotaUs = Math.floor(
    Math.min(1, resources.cpuMs / (budget.perTrial.wallMs + 2000)) * 0.9 * cpuPeriodUs,
  );
  requireValue(cpuQuotaUs >= 1000, "CPU envelope too small for a cgroup quota");
  return Object.freeze({
    version: 1,
    image,
    imageId,
    platform: "linux/arm64",
    user: "65531:65532",
    productUser: "65532:65532",
    network: "none",
    memoryBytes: resources.memoryBytes,
    diskBytes: resources.diskBytes,
    processes: resources.processes,
    cpuPeriodUs,
    cpuQuotaUs,
    wallMs,
    cpuMs: resources.cpuMs,
    seccompHash: contentDigest(CONTAINER_SECCOMP),
  });
}

export interface ContainerInspection {
  Id: string;
  Image: string;
  Config: { User: string; Labels: Record<string, string>; Env: string[] };
  HostConfig: {
    NetworkMode: string;
    ReadonlyRootfs: boolean;
    Privileged: boolean;
    CapAdd: string[] | null;
    CapDrop: string[];
    Memory: number;
    MemorySwap: number;
    PidsLimit: number;
    CpuPeriod: number;
    CpuQuota: number;
    Tmpfs: Record<string, string>;
    SecurityOpt: string[];
    IpcMode: string;
    CgroupnsMode: string;
    PidMode: string;
    Binds: string[] | null;
    Devices: unknown[];
    LogConfig: { Type: string };
  };
  Mounts: { Type: string; Destination: string; RW: boolean }[];
}
export function validateContainerInspection(
  p: ContainerPolicy,
  value: ContainerInspection,
  owner: string,
) {
  const h = value.HostConfig;
  requireValue(
    value.Config.Labels["ardur.versus.owner"] === owner &&
      value.Config.Labels["ardur.versus.policy"] === contentDigest(p),
    "Container ownership or policy drift",
  );
  requireValue(
    value.Image === p.imageId && value.Config.User === p.user,
    "Container image or user drift",
  );
  requireValue(
    h.Memory === p.memoryBytes &&
      h.MemorySwap === p.memoryBytes &&
      h.PidsLimit === p.processes &&
      h.CpuPeriod === p.cpuPeriodUs &&
      h.CpuQuota === p.cpuQuotaUs,
    "Container cgroup drift",
  );
  requireValue(
    h.ReadonlyRootfs &&
      !h.Privileged &&
      !h.CapAdd?.length &&
      h.CapDrop.length === 1 &&
      h.CapDrop[0]!.toUpperCase() === "ALL",
    "Container privilege drift",
  );
  requireValue(
    h.NetworkMode === "none" &&
      h.IpcMode === "none" &&
      h.CgroupnsMode === "private" &&
      !h.PidMode &&
      !h.Binds?.length &&
      !h.Devices?.length &&
      h.LogConfig.Type === "none",
    "Container namespace, mount or log drift",
  );
  requireValue(
    Object.keys(h.Tmpfs).length === 1 &&
      h.Tmpfs[CONTAINER_ROOT] ===
        `rw,nosuid,nodev,noexec,size=${p.diskBytes},mode=770,uid=65531,gid=65532`,
    "Aggregate writable storage drift",
  );
  requireValue(
    value.Mounts.every((mount) => mount.Type === "tmpfs" && mount.Destination === CONTAINER_ROOT),
    "Unexpected container mount",
  );
  requireValue(
    h.SecurityOpt.some(
      (option) => option === "no-new-privileges" || option === "no-new-privileges=true",
    ) &&
      h.SecurityOpt.some(
        (option) =>
          option.startsWith("seccomp=") &&
          contentDigest(JSON.parse(option.slice(8))) === p.seccompHash,
      ),
    "Container seccomp drift",
  );
}

export interface ContainerProof {
  readonly mechanism: "linux-cgroup-v2";
  readonly policyHash: string;
  readonly containerHash: string;
  readonly ownership: Readonly<{ id: string; label: string }>;
  readonly cgroup: Readonly<Record<string, string>>;
}
