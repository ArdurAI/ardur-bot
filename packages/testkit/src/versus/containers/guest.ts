/** Trusted PID 1 and loopback HTTP relay. Source is part of the executed TypeScript inventory.
 * It never accepts a command to execute from the guest network; only the host owns exec admission. */
export const CONTAINER_GUEST = String.raw`
import base64, http.server, json, os, queue, stat, sys, threading, time, uuid
ROOT = '/opt/data'
LIMIT = 2 * 1024 * 1024
os.umask(0o007)
write_lock = threading.Lock()
pending = {}
pending_lock = threading.Lock()
def emit(value):
    wire = json.dumps(value, separators=(',', ':'))
    if len(wire) > LIMIT * 2: raise ValueError('response limit')
    with write_lock:
        sys.stdout.write(wire + '\n'); sys.stdout.flush()
def safe(name):
    if not isinstance(name, str) or name.startswith('/') or '..' in name.split('/') or '\x00' in name:
        raise ValueError('invalid trial path')
    value = os.path.realpath(os.path.join(ROOT, name))
    if not value.startswith(ROOT + '/'): raise ValueError('outside trial')
    return value
def files(operation):
    name = operation.get('path', '')
    target = safe(name)
    if operation['op'] == 'write':
        data = base64.b64decode(operation['data'], validate=True)
        if len(data) > LIMIT: raise ValueError('file limit')
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, 'wb') as out: out.write(data)
        return {'bytes': len(data)}
    if operation['op'] == 'read':
        with open(target, 'rb') as inp: data = inp.read(LIMIT + 1)
        if len(data) > LIMIT: raise ValueError('file limit')
        return base64.b64encode(data).decode()
    if operation['op'] == 'mkdir':
        os.makedirs(target, exist_ok=True); return True
    if operation['op'] == 'list':
        info = os.lstat(target)
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            raise ValueError('not a directory')
        entries = []
        for child in sorted(os.listdir(target)):
            if child == '.ardurbot-runtime': continue
            child_path = os.path.join(target, child)
            child_info = os.lstat(child_path)
            if stat.S_ISLNK(child_info.st_mode): continue
            if stat.S_ISDIR(child_info.st_mode):
                kind, size, executable = 'dir', 0, False
            elif stat.S_ISREG(child_info.st_mode):
                kind, size, executable = 'file', child_info.st_size, bool(child_info.st_mode & 0o111)
            else:
                continue
            item = {'name': child, 'kind': kind, 'size': size}
            if executable: item['executable'] = True
            entries.append(item)
            if len(entries) > 4096: raise ValueError('directory limit')
        return entries
    if operation['op'] == 'snapshot':
        result = {}; total = 0
        if not os.path.isdir(target): return result
        for directory, dirs, names in os.walk(target, followlinks=False):
            if any(os.path.islink(os.path.join(directory, d)) for d in dirs):
                raise ValueError('symlink in snapshot')
            for file in names:
                p = os.path.join(directory, file)
                if os.path.islink(p) or not os.path.isfile(p): raise ValueError('nonregular snapshot file')
                with open(p, 'rb') as inp: data = inp.read(LIMIT + 1)
                total += len(data)
                if total > LIMIT: raise ValueError('snapshot limit')
                result[os.path.relpath(p, target)] = data.decode('utf8')
        return result
    raise ValueError('unknown file operation')
class Relay(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def forward(self):
        length = int(self.headers.get('Content-Length', '0'))
        if length < 0 or length > LIMIT or self.headers.get('Transfer-Encoding'):
            self.send_error(413); return
        if self.path not in ('/provider/chat/completions', '/provider/models', '/broker'):
            self.send_error(403); return
        q = queue.Queue(maxsize=64); request_id = uuid.uuid4().hex
        with pending_lock:
            if len(pending) >= 8: self.send_error(429); return
            pending[request_id] = q
        try:
            emit({'kind': 'http', 'id': request_id, 'path': self.path, 'method': self.command,
                  'headers': {k: self.headers[k] for k in ('Content-Type', 'Accept', 'Mcp-Session-Id', 'Mcp-Protocol-Version') if k in self.headers},
                  'body': base64.b64encode(self.rfile.read(length)).decode()})
            first = q.get(timeout=120)
            self.send_response(first['status'])
            for key, value in first.get('headers', {}).items(): self.send_header(key, value)
            self.send_header('Connection', 'close'); self.end_headers()
            while True:
                message = q.get(timeout=120)
                if message.get('end'): break
                self.wfile.write(base64.b64decode(message['chunk'])); self.wfile.flush()
        except Exception:
            self.close_connection = True
        finally:
            with pending_lock: pending.pop(request_id, None)
    do_GET = forward
    do_POST = forward
    do_DELETE = forward
for directory in ('home', 'state', 'workspace', 'tmp'):
    os.makedirs(os.path.join(ROOT, directory), exist_ok=True)
server = http.server.ThreadingHTTPServer(('127.0.0.1', 18080), Relay)
server.daemon_threads = True
threading.Thread(target=server.serve_forever, daemon=True).start()
# PID 1 exit destroys the entire PID namespace, including detached children. It accepts no extension.
threading.Thread(target=lambda: (time.sleep(int(os.environ['VERSUS_WALL_MS']) / 1000), os._exit(124)), daemon=True).start()
cgroup = {}
for name in ('cgroup.controllers', 'memory.max', 'memory.swap.max', 'pids.max', 'cpu.max'):
    with open('/sys/fs/cgroup/' + name) as file: cgroup[name] = file.read().strip()
emit({'kind': 'ready', 'cgroup': cgroup})
while True:
    line = sys.stdin.readline(LIMIT * 2 + 1)
    if not line: break
    if len(line) > LIMIT * 2: break
    try:
        value = json.loads(line)
        if value.get('kind') == 'http-result':
            with pending_lock: q = pending.get(value['id'])
            if q is not None: q.put(value, timeout=1)
        elif value.get('kind') == 'file':
            try: emit({'kind': 'result', 'id': value['id'], 'value': files(value)})
            except Exception as error: emit({'kind': 'result', 'id': value['id'], 'error': type(error).__name__})
        else: break
    except Exception:
        break
os._exit(0)
`;
