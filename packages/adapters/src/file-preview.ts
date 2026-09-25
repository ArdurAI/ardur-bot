import type { AdapterContext, ComputerRef, SandboxProvider } from "@ardurbot/adapter-kit";

// All path components are opened relative to held directory descriptors. No shell interpolation.
export const FILE_PREVIEW_SCRIPT = `
import os,sys,stat,base64
root,relative,limit=sys.argv[1:]
limit=int(limit)
if limit<1 or limit>2097153: raise ValueError('Invalid preview limit')
parts=relative.split('/')
if any(p in ('','..','.') for p in parts): raise ValueError('Path escapes workspace')
fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 for part in parts[:-1]:
  child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
  os.close(fd)
  fd=child
 f=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
 with os.fdopen(f,'rb') as stream:
  if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode): raise ValueError('Not a regular file')
  print(base64.b64encode(stream.read(limit)).decode())
finally:
 os.close(fd)
`;

export async function readFilePreview(
  provider: Pick<SandboxProvider, "execute">,
  computer: ComputerRef,
  root: string,
  relative: string,
  context: AdapterContext,
  maxBytes: number,
) {
  let stdout = "";
  let exited = false;
  for await (const event of provider.execute(
    computer,
    { argv: ["python3", "-c", FILE_PREVIEW_SCRIPT, root, relative, String(maxBytes)] },
    context,
  )) {
    if (event.type === "stdout") {
      stdout += event.data;
      if (stdout.length > Math.ceil(maxBytes / 3) * 4 + 16)
        throw new Error("File preview exceeds limit.");
    }
    if (event.type === "exit") {
      if (event.code !== 0) throw new Error("File preview is unavailable.");
      exited = true;
    }
  }
  if (!exited) throw new Error("File preview is unavailable.");
  return new Uint8Array(Buffer.from(stdout.trim(), "base64"));
}
