import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { python, type WorktreeRecord } from "./store.js";

// Copy and hash only enumerated unique local roots. Committed source, caches,
// repository history and agent session directories are never scanned here.
const LOCAL_STATE = String.raw`
import hashlib,json,os,shutil,stat,sys
x=json.load(sys.stdin);root=x['root'];directory=x['directory']
def safe(base,rel):
 parts=rel.split('/')
 if not rel or os.path.isabs(rel) or any(p in ('','.','..','.git') for p in parts):raise RuntimeError('Invalid local-state path')
 current=base
 if os.path.realpath(base)!=base:raise RuntimeError('Redirected state root')
 for part in parts[:-1]:
  current=os.path.join(current,part)
  if os.path.islink(current):raise RuntimeError('Symlink in local-state ancestor')
 return os.path.join(base,rel)
def ancestors(roots):
 result=set()
 for rel in roots:
  parent=os.path.dirname(rel)
  while parent:result.add(parent);parent=os.path.dirname(parent)
 return result
def manifest(base,roots,limit,include_parents=True):
 result={};total=0
 if include_parents:
  for parent in ancestors(roots):
   p=safe(base,parent);s=os.lstat(p)
   if not stat.S_ISDIR(s.st_mode):raise RuntimeError('Local-state parent is not a directory')
   result[parent]=['directory',stat.S_IMODE(s.st_mode)]
 def visit(rel):
  nonlocal total
  if len(result)>=50000:raise RuntimeError('Local-state file limit exceeded; checkout retained')
  p=safe(base,rel);s=os.lstat(p)
  if stat.S_ISLNK(s.st_mode):result[rel]=['link',os.readlink(p)]
  elif stat.S_ISREG(s.st_mode):
   total+=s.st_size
   if total>limit:raise RuntimeError('Local-state size limit exceeded; checkout retained')
   h=hashlib.sha256()
   with open(p,'rb') as f:
    for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
   result[rel]=['file',h.hexdigest(),s.st_size,stat.S_IMODE(s.st_mode)]
  elif stat.S_ISDIR(s.st_mode):
   result[rel]=['directory',stat.S_IMODE(s.st_mode)]
   for name in sorted(os.listdir(p)):visit(rel+'/'+name)
  else:raise RuntimeError('Special local-state file; checkout retained')
 for rel in roots:visit(rel)
 return result,total
def copy_roots(source,dest,roots):
 parents=set()
 for rel in roots:
  a=safe(source,rel);b=safe(dest,rel)
  if os.path.lexists(b):raise RuntimeError('Local-state restore path already exists')
  os.makedirs(os.path.dirname(b),exist_ok=True)
  if os.path.islink(a):os.symlink(os.readlink(a),b)
  elif os.path.isdir(a):shutil.copytree(a,b,symlinks=True)
  else:shutil.copy2(a,b,follow_symlinks=False)
  parent=os.path.dirname(rel)
  while parent:parents.add(parent);parent=os.path.dirname(parent)
 # Set ancestor modes only after copying all leaves, including read-only dirs.
 for parent in sorted(parents,key=lambda p:p.count('/'),reverse=True):
  os.chmod(safe(dest,parent),stat.S_IMODE(os.lstat(safe(source,parent)).st_mode))
files=os.path.join(directory,'files')
if x['op']=='save':
 roots=sorted(set(x['roots']));limit=x['limit']
 for a in roots:
  if any(a!=b and a.startswith(b+'/') for b in roots):raise RuntimeError('Overlapping local-state roots')
 before,total=manifest(root,roots,limit)
 os.mkdir(files,0o700)
 copy_roots(root,files,roots)
 after,_=manifest(files,roots,limit)
 if before!=after or before!=manifest(root,roots,limit)[0]:raise RuntimeError('Local state changed while copying; originals retained')
 with open(os.path.join(directory,'manifest.json'),'x') as f:
  json.dump({'version':2,'roots':roots,'entries':before,'bytes':total},f);f.flush();os.fsync(f.fileno())
 os.chmod(os.path.join(directory,'manifest.json'),0o600)
 print(json.dumps({'bytes':total}))
else:
 with open(os.path.join(directory,'manifest.json')) as f:m=json.load(f)
 roots=m['roots'];limit=max(m['bytes'],1)
 # Earlier snapshots recorded leaves/root contents without ancestor modes.
 # Preserve their restoration contract, including unversioned v2 snapshots.
 include_parents=ancestors(roots).issubset(m['entries'])
 if manifest(files,roots,limit,include_parents)[0]!=m['entries']:raise RuntimeError('Retained local-state verification failed')
 if x['op']=='verify':
  try:current=manifest(root,roots,limit,include_parents)[0]
  except Exception as error:raise RuntimeError('Local state changed after preservation') from error
  if current!=m['entries']:raise RuntimeError('Local state changed after preservation')
 elif x['op']=='restore':
  # Check every collision before copying anything. Never traverse a link or
  # overwrite files already present in the newly created Git checkout.
  for rel in roots:
   if os.path.lexists(safe(root,rel)):raise RuntimeError('Local-state restore path already exists')
  copy_roots(files,root,roots)
  if manifest(root,roots,limit,include_parents)[0]!=m['entries']:raise RuntimeError('Restored local state does not match retained files')
 else:raise RuntimeError('Unknown local-state operation')
 print(json.dumps({'bytes':m['bytes']}))
`;

export function preserveLocalState(record: WorktreeRecord, roots: string[], registryPath: string, maxMB = 256): { directory: string; bytes: number } {
  const parent = join(dirname(registryPath), "retained-state");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (realpathSync(parent) !== parent) throw new Error("Local-state destination must not be redirected");
  chmodSync(parent, 0o700);
  const directory = join(parent, `${record.id}-${randomUUID()}`);
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, "record.json"), JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  const result = python<{ bytes: number }>(LOCAL_STATE, { op: "save", root: record.path, directory, roots, limit: maxMB * 1024 ** 2 }, 180_000);
  writeFileSync(join(directory, "RESTORE.txt"), `Unique local files only. Committed source is pinned in ${record.repo} at ${record.recoveryRef || `refs/workit-gc/retired/${record.id}`}.\nRestore into a new checkout:\nworkit gc restore --state '${directory.replace(/'/g, "'\\''")}' --worktree /path/to/new-checkout\nDependencies must be reinstalled. Keep this directory until its local files are no longer needed.\n`, { mode: 0o600 });
  return { directory, bytes: result.bytes };
}

export function verifyLocalState(path: string, directory: string): void {
  python(LOCAL_STATE, { op: "verify", root: path, directory }, 180_000);
}

export function restoreLocalState(path: string, directory: string): void {
  python(LOCAL_STATE, { op: "restore", root: path, directory }, 180_000);
}
