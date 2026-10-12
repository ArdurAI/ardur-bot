import { GIT_OBSERVATION_CONFIG } from "@ardurbot/adapter-kit";

/**
 * Container counterpart of the host reader's private metadata view. Open every
 * source without following links; only observation formatting enters the view's
 * config. Git never loads the repository config or its executable drivers.
 * Temporary metadata is private and removed; the repository is only read.
 */
export const CONTAINER_GIT_SCRIPT = `
import os, sys, stat, subprocess, tempfile

LIMIT = 1024 * 1024
SETTINGS = ${JSON.stringify(GIT_OBSERVATION_CONFIG)}
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
FILE = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK

def refuse():
 raise ValueError("unsafe Git metadata")

def read_file(fd, name):
 expected = os.stat(name, dir_fd=fd, follow_symlinks=False)
 handle = os.open(name, FILE, dir_fd=fd)
 try:
  info = os.fstat(handle)
  if not stat.S_ISREG(info.st_mode) or info.st_size > LIMIT:
   refuse()
  if (info.st_dev, info.st_ino, info.st_ctime_ns, info.st_size) != (expected.st_dev, expected.st_ino, expected.st_ctime_ns, expected.st_size):
   refuse()
  data = os.read(handle, LIMIT + 1)
  if len(data) > LIMIT:
   refuse()
  return data, expected
 finally:
  os.close(handle)

def copy_file(fd, name, destination):
 data, info = read_file(fd, name)
 with open(destination, "wb") as target:
  target.write(data)
 # Preserve nanoseconds: Git uses the index mtime to detect racily clean files.
 os.utime(destination, ns=(info.st_atime_ns, info.st_mtime_ns), follow_symlinks=False)

def open_directory(fd, name):
 return os.open(name, DIRECTORY, dir_fd=fd)

def check_tree(fd, budget):
 for name in os.listdir(fd):
  budget[0] -= 1
  if budget[0] < 0:
   refuse()
  info = os.stat(name, dir_fd=fd, follow_symlinks=False)
  if stat.S_ISDIR(info.st_mode):
   child = open_directory(fd, name)
   try:
    check_tree(child, budget)
   finally:
    os.close(child)
  elif not stat.S_ISREG(info.st_mode):
   refuse()

def main():
 root, args = sys.argv[1], sys.argv[2:]
 # Ignore inherited Git, Python and helper configuration before any Git starts.
 env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LC_ALL": "C",
        "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_OPTIONAL_LOCKS": "0", "GIT_ATTR_NOSYSTEM": "1",
        "GIT_TERMINAL_PROMPT": "0", "GIT_PAGER": "cat"}
 if not os.path.isabs(root) or os.path.normpath(root) != root:
  refuse()
 root_fd = os.open("/", DIRECTORY)
 try:
  for part in root.split("/"):
   if not part:
    continue
   child = open_directory(root_fd, part)
   os.close(root_fd)
   root_fd = child
 except BaseException:
  os.close(root_fd)
  raise
 descriptors = [root_fd]
 try:
  try:
   metadata = open_directory(root_fd, ".git")
  except FileNotFoundError:
   # Do not discover or load an ancestor's config.
   parent = os.path.dirname(root)
   while True:
    if os.path.lexists(os.path.join(parent, ".git")):
     refuse()
    next_parent = os.path.dirname(parent)
    if next_parent == parent:
     break
    parent = next_parent
   sys.stderr.write("fatal: not a git repository\\n")
   return 128
  descriptors.append(metadata)
  for name in ("commondir",):
   if name in os.listdir(metadata):
    refuse()
  config = os.open("config", FILE, dir_fd=metadata)
  descriptors.append(config)
  if not stat.S_ISREG(os.fstat(config).st_mode) or os.fstat(config).st_size > LIMIT:
   refuse()
  fd_root = "/proc/self/fd" if os.path.isdir("/proc/self/fd") else "/dev/fd"
  # --file and --no-includes parse only the pinned local file, outside discovery.
  parsed = subprocess.run(["git", "config", "--null", "--list", "--no-includes",
                           "--file", fd_root + "/" + str(config)],
                          cwd="/", env=env, pass_fds=(config,), capture_output=True)
  if parsed.returncode or len(parsed.stdout) > LIMIT:
   refuse()
  settings = []
  for record in parsed.stdout.decode("utf-8").split("\\0"):
   if not record:
    continue
   key, separator, value = record.partition("\\n")
   if not separator:
    value = "true"
   if key.startswith(("include.", "includeif.", "extensions.")):
    refuse()
   if key == "core.worktree" and os.path.normpath(os.path.join(root, ".git", value)) != root:
    refuse()
   if key == "core.repositoryformatversion" and value != "0":
    refuse()
   if key in SETTINGS:
    settings.extend(["-c", key + "=" + value])
  with tempfile.TemporaryDirectory(prefix="git-observation-") as view:
   with open(os.path.join(view, "config"), "w") as target:
    target.write('[core]\\nrepositoryformatversion=0\\nbare=false\\nfsmonitor=false\\n'
                 'hooksPath=/dev/null\\nattributesFile=/dev/null\\nexcludesFile=/dev/null\\npager=false\\n')
   for name in ("HEAD", "index", "packed-refs", "shallow"):
    if name in os.listdir(metadata):
     copy_file(metadata, name, os.path.join(view, name))
   for name in ("objects", "refs"):
    directory = open_directory(metadata, name)
    descriptors.append(directory)
    check_tree(directory, [100000])
    if name == "objects" and "info" in os.listdir(directory):
     info = open_directory(directory, "info")
     try:
      for alternate in ("alternates", "http-alternates"):
       if alternate in os.listdir(info):
        refuse()
     finally:
      os.close(info)
    # Pin directory identity across a rename rather than link a mutable path.
    source = fd_root + "/" + str(directory) if fd_root == "/proc/self/fd" else os.path.join(root, ".git", name)
    os.symlink(source, os.path.join(view, name))
   if "info" in os.listdir(metadata):
    info = open_directory(metadata, "info")
    descriptors.append(info)
    os.mkdir(os.path.join(view, "info"))
    for name in ("attributes", "exclude"):
     if name in os.listdir(info):
      copy_file(info, name, os.path.join(view, "info", name))
   if args == ["rev-parse", "--absolute-git-dir"]:
    print(os.path.join(root, ".git"))
    return 0
   pinned_root = fd_root + "/" + str(root_fd) if fd_root == "/proc/self/fd" else root
   command = ["git", "--no-pager", "--no-optional-locks", "--git-dir", view,
              "--work-tree", pinned_root, "-c", "core.hooksPath=/dev/null",
              "-c", "core.fsmonitor=false", "-c", "diff.external=",
              "-c", "credential.helper=", "-c", "core.sshCommand=",
              *settings, *args]
   return subprocess.run(command, cwd=pinned_root, env=env, pass_fds=descriptors).returncode
 finally:
  for fd in reversed(descriptors):
   os.close(fd)

try:
 sys.exit(main())
except (OSError, ValueError, UnicodeError):
 sys.stderr.write("Git observation unavailable\\n")
 sys.exit(128)
`.trim();
