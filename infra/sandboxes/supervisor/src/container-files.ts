/** Read, list, and write a workspace without following a symlink out of `root`. */
export const CONTAINER_FILE_SCRIPT = `
import os, sys, json, stat, base64, uuid

def fail():
 sys.stderr.write("file not available\\n")
 sys.exit(1)

def main():
 if not hasattr(os, "O_NOFOLLOW"):
  fail()
 if len(sys.argv) < 4:
  fail()
 operation, root, relative = sys.argv[1], sys.argv[2], sys.argv[3]
 if operation not in ("read", "list", "write"):
  fail()
 parts = [part for part in relative.split("/") if part]
 if any(part in (".", "..") for part in parts):
  fail()
 if operation != "list" and not parts:
  fail()
 directory = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
 fd = os.open(root, directory)
 try:
  parents = parts if operation == "list" else parts[:-1]
  for part in parents:
   if operation == "write":
    try:
     info = os.lstat(part, dir_fd=fd)
    except FileNotFoundError:
     try:
      os.mkdir(part, 0o755, dir_fd=fd)
     except FileExistsError:
      pass
     info = os.lstat(part, dir_fd=fd)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
     fail()
   child = os.open(part, directory, dir_fd=fd)
   os.close(fd)
   fd = child
  if operation == "list":
   out = []
   for name in os.listdir(fd):
    info = os.stat(name, dir_fd=fd, follow_symlinks=False)
    if stat.S_ISLNK(info.st_mode):
     continue
    child = "/".join(item for item in (relative, name) if item)
    item = {"path": child, "kind": "dir" if stat.S_ISDIR(info.st_mode) else "file", "size": info.st_size}
    if stat.S_ISREG(info.st_mode) and info.st_mode & stat.S_IXUSR:
     item["executable"] = True
    out.append(item)
   print(json.dumps(sorted(out, key=lambda item: item["path"])))
  elif operation == "read":
   if len(sys.argv) != 6:
    fail()
   limit = int(sys.argv[4])
   preview = sys.argv[5] == "preview"
   if sys.argv[5] not in ("preview", "read"):
    fail()
   handle = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
   try:
    if not stat.S_ISREG(os.fstat(handle).st_mode):
     fail()
    stream = os.fdopen(handle, "rb")
    handle = -1
    with stream:
     data = stream.read() if limit < 0 else stream.read(limit + 1)
     if limit >= 0 and len(data) > limit and not preview:
      sys.exit(42)
     if limit >= 0:
      data = data[:limit]
     sys.stdout.write(base64.b64encode(data).decode())
   finally:
    if handle >= 0:
     os.close(handle)
  elif operation == "write":
   if len(sys.argv) != 5 or sys.argv[4] not in ("true", "false"):
    fail()
   name = parts[-1]
   try:
    info = os.lstat(name, dir_fd=fd)
   except FileNotFoundError:
    info = None
   if info is not None and not stat.S_ISREG(info.st_mode):
    fail()
   temporary = ".ardurbot-transfer-" + uuid.uuid4().hex
   written = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
   try:
    stream = os.fdopen(written, "wb")
    written = -1
    with stream:
     stream.write(sys.stdin.buffer.read())
     stream.flush()
     os.fsync(stream.fileno())
     os.fchmod(stream.fileno(), 0o700 if sys.argv[4] == "true" else 0o600)
    os.replace(temporary, name, src_dir_fd=fd, dst_dir_fd=fd)
   finally:
    if written >= 0:
     os.close(written)
    try:
     os.unlink(temporary, dir_fd=fd)
    except FileNotFoundError:
     pass
  else:
   fail()
 finally:
  os.close(fd)

try:
 main()
except OSError:
 sys.stderr.write("file not available\\n")
 sys.exit(1)
except ValueError:
 sys.stderr.write("file not available\\n")
 sys.exit(1)
`.trim();
