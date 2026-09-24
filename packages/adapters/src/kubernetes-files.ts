/** Descriptor-relative paths prevent a workspace process swapping a parent for a symlink. */
export const KUBERNETES_FILE_SCRIPT = `
import os,json,base64,sys,stat,uuid
root="/home/ardurbot"
operation,relative,unused,limit,executable=sys.argv[1:]
limit=int(limit)
parts=[p for p in relative.split('/') if p]
if any(p in ('.','..') for p in parts): raise ValueError('Path escapes workspace')
flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
fd=os.open(root,flags)
try:
 parents=parts if operation=='list' else parts[:-1]
 for part in parents:
  if operation=='write':
   try: os.mkdir(part,0o755,dir_fd=fd)
   except FileExistsError: pass
  child=os.open(part,flags,dir_fd=fd)
  os.close(fd)
  fd=child
 if operation=='list':
  out=[]
  for name in sorted(os.listdir(fd)):
   info=os.stat(name,dir_fd=fd,follow_symlinks=False)
   if not stat.S_ISDIR(info.st_mode) and not stat.S_ISREG(info.st_mode): continue
   item={'path':'/'.join(parts+[name]),'kind':'dir' if stat.S_ISDIR(info.st_mode) else 'file','size':0 if stat.S_ISDIR(info.st_mode) else info.st_size}
   if stat.S_ISREG(info.st_mode) and info.st_mode & 0o111: item['executable']=True
   out.append(item)
  print(json.dumps(out))
 elif operation=='read':
  f=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
  with os.fdopen(f,'rb') as stream:
   if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode): raise ValueError('Not a regular file')
   data=stream.read(limit+1)
   if len(data)>limit: raise ValueError('File exceeds limit')
   print(base64.b64encode(data).decode())
 elif operation=='write':
  data=sys.stdin.buffer.read(limit+1)
  if len(data)>limit: raise ValueError('File exceeds limit')
  temporary='.ardurbot-transfer-'+uuid.uuid4().hex
  try:
   f=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
   with os.fdopen(f,'wb') as stream:
    stream.write(data)
    stream.flush()
    os.fsync(stream.fileno())
    os.fchmod(stream.fileno(),0o755 if executable=='true' else 0o644)
   os.replace(temporary,parts[-1],src_dir_fd=fd,dst_dir_fd=fd)
  finally:
   try: os.unlink(temporary,dir_fd=fd)
   except FileNotFoundError: pass
finally:
 os.close(fd)
`;
