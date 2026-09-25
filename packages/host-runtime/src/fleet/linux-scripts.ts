/** All file traversals use directory descriptors. Shell commands retain the remote account's permissions. */
export const LINUX_ROOT = `
import os,sys,json,stat,uuid,shutil,signal,time
root=sys.argv[1]
parts=root.split('/')
if not root.startswith('/') or any(p in ('.','..') for p in parts): raise ValueError('Invalid computer home')
flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
fd=os.open('/',flags)
for part in filter(None,parts):
 child=os.open(part,flags,dir_fd=fd)
 os.close(fd)
 fd=child
def directory(relative,create=False):
 parts=relative.split('/') if relative else []
 if relative.startswith('/') or any(p in ('','.','..') for p in parts): raise ValueError('Path escapes computer')
 target=os.dup(fd)
 for part in parts:
  if create:
   try: os.mkdir(part,0o700,dir_fd=target)
   except FileExistsError: pass
  child=os.open(part,flags,dir_fd=target)
  os.close(target)
  target=child
 return target
`;

export const SSH_HOME_SCRIPT = `
import os,sys,json
base=os.path.expanduser(sys.argv[1]); key=sys.argv[2]
if base in ('/',os.path.expanduser('~')) or not base.startswith('/') or not key.isalnum(): raise ValueError('Invalid computer home')
flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
fd=os.open('/',flags)
fresh=False
for part in [p for p in base.split('/') if p]+[key]:
 if part in ('.','..'): raise ValueError('Invalid computer home')
 try:
  os.mkdir(part,0o700,dir_fd=fd)
  if part==key: fresh=True
 except FileExistsError: pass
 child=os.open(part,flags,dir_fd=fd)
 os.close(fd); fd=child
print(json.dumps({'root':base+'/'+key,'fresh':fresh}))
`;

export const LINUX_FILE_SCRIPT = `${LINUX_ROOT}
import base64
operation,relative,limit,executable=sys.argv[2:6]
stage=sys.argv[6] if len(sys.argv)>6 else None
limit=int(limit)
parts=relative.split('/') if relative else []
if relative.startswith('/') or any(p in ('','.','..') for p in parts): raise ValueError('Path escapes computer')
parent=directory(relative if operation=='list' else '/'.join(parts[:-1]),operation in ('write','stage-write'))
try:
 if operation=='list':
  out=[]
  for name in sorted(os.listdir(parent)):
   if name=='.ardurbot-runtime': continue
   info=os.stat(name,dir_fd=parent,follow_symlinks=False)
   if not stat.S_ISDIR(info.st_mode) and not stat.S_ISREG(info.st_mode): continue
   out.append({'path':'/'.join(parts+[name]),'kind':'dir' if stat.S_ISDIR(info.st_mode) else 'file','size':0 if stat.S_ISDIR(info.st_mode) else info.st_size,**({'executable':True} if stat.S_ISREG(info.st_mode) and info.st_mode & 0o111 else {})})
   if len(out)>4096: raise ValueError('Directory too large')
  print(json.dumps(out))
 elif operation in ('read','stage-read','preview','stage-preview'):
  f=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
  with os.fdopen(f,'rb') as stream:
   if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode): raise ValueError('Not a regular file')
   data=stream.read(limit+1)
   if len(data)>limit and operation not in ('preview','stage-preview'): raise ValueError('File exceeds limit')
   data=data[:limit]
   if stage:
    staged=os.open(stage,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(staged,'wb') as output: output.write(data)
   else: sys.stdout.buffer.write(data)
 elif operation in ('write','stage-write'):
  if stage:
   staged=os.open(stage,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
   with os.fdopen(staged,'rb') as source:
    if not stat.S_ISREG(os.fstat(source.fileno()).st_mode): raise ValueError('Invalid transfer')
    data=source.read(limit+1)
  else: data=sys.stdin.buffer.read(limit+1)
  if len(data)>limit: raise ValueError('File exceeds limit')
  temporary='.ardurbot-transfer-'+uuid.uuid4().hex
  try:
   f=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=parent)
   with os.fdopen(f,'wb') as stream:
    stream.write(data); stream.flush(); os.fsync(stream.fileno()); os.fchmod(stream.fileno(),0o755 if executable=='true' else 0o644)
   os.replace(temporary,parts[-1],src_dir_fd=parent,dst_dir_fd=parent)
  finally:
   try: os.unlink(temporary,dir_fd=parent)
   except FileNotFoundError: pass
finally: os.close(parent); os.close(fd)
`;

export const LINUX_EXEC_SCRIPT = `${LINUX_ROOT}
import subprocess,pty,select
request=json.loads(sys.argv[2]); argv=request['argv']; cwd=request.get('cwd','')
target=directory(cwd)
os.fchdir(target); os.close(target)
env=dict(os.environ); env['HOME']=root
for key,value in request.get('env',{}).items():
 if not key or not key.replace('_','a').isalnum() or key[0].isdigit() or key in ('HOME','LD_PRELOAD','BASH_ENV','ENV','PYTHONPATH'): raise ValueError('Invalid environment')
 env[key]=value
state=directory('.ardurbot-runtime',True)
master,slave=pty.openpty() if request.get('pty',False) else (None,None)
child=subprocess.Popen(argv,env=env,start_new_session=True,**({'stdin':slave,'stdout':slave,'stderr':slave} if slave is not None else {}))
if slave is not None: os.close(slave)
marker=str(child.pid)
start=open('/proc/'+marker+'/stat').read().split(') ',1)[1].split()[19]
record=os.open(marker,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=state)
os.write(record,start.encode()); os.close(record)
def stop(*unused):
 try: os.killpg(child.pid,signal.SIGKILL)
 except ProcessLookupError: pass
for sig in (signal.SIGHUP,signal.SIGTERM,signal.SIGINT): signal.signal(sig,stop)
try:
 try:
  deadline=time.monotonic()+request.get('timeoutMs',300000)/1000
  if master is not None:
   while True:
    if time.monotonic()>deadline: raise subprocess.TimeoutExpired(argv,0)
    ready,_,_=select.select([master],[],[],0.1)
    if ready:
     try: data=os.read(master,16384)
     except OSError: break
     if not data: break
     sys.stdout.buffer.write(data); sys.stdout.buffer.flush()
    elif child.poll() is not None: break
  code=child.wait(timeout=max(0.01,deadline-time.monotonic()))
 except subprocess.TimeoutExpired: stop(); child.wait(); code=124
finally:
 if master is not None: os.close(master)
 # Background descendants remain tracked until sleep or destroy.
 try: os.killpg(child.pid,0)
 except ProcessLookupError: os.unlink(marker,dir_fd=state)
 os.close(state)
sys.exit(code if code>=0 else 128-code)
`;

export const LINUX_STOP_SCRIPT = `${LINUX_ROOT}
try: state=directory('.ardurbot-runtime')
except FileNotFoundError: sys.exit(0)
for pid in os.listdir(state):
 if not pid.isdigit(): continue
 try:
  record=os.open(pid,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=state)
  with os.fdopen(record) as stream: expected=stream.read(64)
  try:
   actual=open('/proc/'+pid+'/stat').read().split(') ',1)[1].split()[19]
   valid=expected==actual
  except FileNotFoundError:
   valid=False
   for member in os.listdir('/proc'):
    if not member.isdigit(): continue
    try:
     values=open('/proc/'+member+'/stat').read().split(') ',1)[1].split()
     if values[2]==pid and values[3]==pid and int(values[19])>=int(expected): valid=True; break
    except (FileNotFoundError,PermissionError): pass
  if valid: os.killpg(int(pid),signal.SIGKILL)
 except (FileNotFoundError,ProcessLookupError): pass
 os.unlink(pid,dir_fd=state)
os.close(state)
`;

export const LINUX_ARCHIVE_SCRIPT = `${LINUX_ROOT}
import tarfile
with tarfile.open(fileobj=sys.stdout.buffer,mode='w|',format=tarfile.USTAR_FORMAT) as archive:
 def walk(parent,prefix):
  for name in sorted(os.listdir(parent)):
   if name=='.ardurbot-runtime': continue
   info=os.stat(name,dir_fd=parent,follow_symlinks=False)
   rel=prefix+name
   if stat.S_ISDIR(info.st_mode):
    child=os.open(name,flags,dir_fd=parent)
    try: walk(child,rel+'/')
    finally: os.close(child)
   elif stat.S_ISREG(info.st_mode):
    source=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
    with os.fdopen(source,'rb') as stream:
     actual=os.fstat(stream.fileno())
     if not stat.S_ISREG(actual.st_mode) or actual.st_size>16*1024*1024: raise ValueError('File exceeds limit')
     entry=tarfile.TarInfo(rel); entry.size=actual.st_size; entry.mode=0o755 if actual.st_mode & 0o111 else 0o644
     archive.addfile(entry,stream)
 walk(fd,'')
`;

export const LINUX_RESTORE_SCRIPT = `${LINUX_ROOT}
import tarfile
seen=set(); total=0
with tarfile.open(fileobj=sys.stdin.buffer,mode='r|') as archive:
 for entry in archive:
  if not entry.isfile() or entry.size>16*1024*1024 or entry.name in seen: raise ValueError('Invalid checkpoint')
  seen.add(entry.name); total+=entry.size
  if total>64*1024*1024 or len(seen)>10000: raise ValueError('Checkpoint exceeds limit')
  parts=entry.name.split('/')
  if entry.name.startswith('/') or any(p in ('','.','..','.ardurbot-runtime') for p in parts): raise ValueError('Path escapes computer')
  parent=directory('/'.join(parts[:-1]),True)
  temporary='.ardurbot-transfer-'+uuid.uuid4().hex
  try:
   dest=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=parent)
   with os.fdopen(dest,'wb') as stream:
    shutil.copyfileobj(archive.extractfile(entry),stream); stream.flush(); os.fsync(stream.fileno()); os.fchmod(stream.fileno(),0o755 if entry.mode & 0o111 else 0o644)
   os.replace(temporary,parts[-1],src_dir_fd=parent,dst_dir_fd=parent)
  finally:
   try: os.unlink(temporary,dir_fd=parent)
   except FileNotFoundError: pass
   os.close(parent)
`;
