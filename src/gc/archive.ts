import { execFileSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { python, type WorktreeRecord } from "./store.js";
import { CACHE_NAMES } from "./metadata.js";
export { CACHE_NAMES, readJSON } from "./metadata.js";

// Never excludes local databases, environment files, or arbitrary ignored files.
// Tracked files in a cache-shaped path are also retained.
export const ARCHIVE = String.raw`
import hashlib,json,os,stat,sys,tarfile,tempfile,shutil
x=json.load(sys.stdin);root=x['root'];dest=x['destination'];tracked=set(x['tracked']);exclude=set(x['cacheNames'])
def cached(rel):
 if x.get('preserveAll'):return False
 parts=rel.split('/')
 candidates=[('/'.join(parts[:i+1])) for i,p in enumerate(parts) if p in exclude]
 if rel=='.direnv/nix-sources' or rel.startswith('.direnv/nix-sources/'): candidates.append('.direnv/nix-sources')
 # A tracked marker does not make its generated siblings valuable. Keep only
 # tracked entries and their ancestors within a rebuildable cache directory.
 return bool(candidates) and not any(t==rel or t.startswith(rel+'/') for t in tracked)
def manifest(base):
 result={}
 for directory,dirs,files in os.walk(base,followlinks=False):
  rel=os.path.relpath(directory,base)
  for name in list(dirs)+files:
   path=os.path.join(directory,name);key=os.path.normpath(os.path.join(rel,name)).replace(os.sep,'/')
   if key=='.git' or cached(key):
    if name in dirs:dirs.remove(name)
    continue
   s=os.lstat(path)
   if stat.S_ISLNK(s.st_mode):
    result[key]=['link',os.readlink(path)]
    if name in dirs:dirs.remove(name)
   elif stat.S_ISREG(s.st_mode):
    h=hashlib.sha256()
    with open(path,'rb') as f:
     for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
    result[key]=['file',h.hexdigest(),s.st_size,stat.S_IMODE(s.st_mode)]
   elif stat.S_ISDIR(s.st_mode):result[key]=['directory',stat.S_IMODE(s.st_mode)]
   else:raise RuntimeError('Unsupported special file: '+key)
 return result
before=manifest(root)
with tarfile.open(dest+'.partial','w:gz',compresslevel=3,dereference=False) as tar:
 for rel in sorted(before):tar.add(os.path.join(root,rel),arcname=rel,recursive=False)
test=tempfile.mkdtemp(prefix='.verify-',dir=os.path.dirname(dest))
try:
 with tarfile.open(dest+'.partial','r:gz') as tar:tar.extractall(test,filter='fully_trusted')
 # Entries originate in a local manifest; symlinks are never traversed. Directories
 # are restored before their children by the depth-first lexical tar order.
 after=manifest(test)
 if before!=after:raise RuntimeError('Archive restore does not match source manifest')
 if before!=manifest(root):raise RuntimeError('Source changed during archive verification')
finally:
 for directory,dirs,files in os.walk(test):
  if not os.path.islink(directory):os.chmod(directory,0o700)
 shutil.rmtree(test)
os.replace(dest+'.partial',dest)
with open(dest+'.manifest.json','w') as f:json.dump(before,f)
print(json.dumps({'files':len(before),'bytes':os.path.getsize(dest)}))
`;

export function assertArchiveDestination(directory: string, expectedUUID?: string): void {
  if (!existsSync(directory)) throw new Error(`Archive destination is not mounted/created: ${directory}`);
  if (realpathSync(directory) !== directory) throw new Error("Archive destination must be a canonical path, without redirects");
  if (expectedUUID) {
    if (process.platform !== "darwin") throw new Error("Volume UUID verification requires macOS");
    // diskutil accepts a mount point/device, not an arbitrary nested archive
    // directory. df resolves the device without guessing mount-path prefixes.
    const row = execFileSync("df", ["-P", directory], { encoding: "utf8" }).trim().split("\n").at(-1)!;
    const device = row.trim().split(/\s+/)[0];
    if (!device.startsWith("/dev/")) throw new Error("Archive destination is not on a local disk volume");
    const plist = execFileSync("diskutil", ["info", "-plist", device], { encoding: "utf8" });
    const match = plist.match(/<key>VolumeUUID<\/key>\s*<string>([^<]+)<\/string>/);
    if (match?.[1].toUpperCase() !== expectedUUID.toUpperCase()) throw new Error("Archive volume UUID does not match configured SSD");
  }
  const disk = statfsSync(directory);
  if (disk.bavail * disk.bsize < 2 * 1024 ** 3) throw new Error("Archive destination has less than 2 GiB free");
}

export function archiveWorktree(record: WorktreeRecord, directory: string, tracked: string[], expectedUUID?: string, sharedHeads?: string[]): string {
  assertArchiveDestination(directory, expectedUUID);
  const destination = join(directory, `${record.id}-${Date.now()}`);
  mkdirSync(destination, { mode: 0o700 });
  const checkpoint = `refs/workit-gc/${record.id}`;
  const bundleRef = `refs/workit-gc/archive/${record.head}`;
  if (!record.remnant && existsSync(record.repo)) {
    execFileSync("git", ["-C", record.repo, "update-ref", checkpoint, record.head], { stdio: "pipe" });
    execFileSync("git", ["-C", record.repo, "update-ref", bundleRef, record.head], { stdio: "pipe" });
    // Checkouts share a self-contained bundle on the archive volume. Hard
    // links avoid copying a repository's history for every archived checkout.
    const shared = join(directory, ".git-history", createHash("sha256").update(record.repo).digest("hex"));
    mkdirSync(shared, { recursive: true, mode: 0o700 });
    // A sweep shares one self-contained history bundle for its repository's
    // pinned revisions, instead of duplicating full history for every branch.
    const heads = [...new Set([record.head, ...(sharedHeads || [])])].sort();
    if (heads.some(head => !/^[a-f0-9]{40,64}$/.test(head))) throw new Error("Invalid pinned Git revision");
    const bundleKey = createHash("sha256").update(heads.join("\n")).digest("hex");
    const bundle = join(shared, `${bundleKey}.bundle`);
    if (!existsSync(bundle)) {
      execFileSync("git", ["-C", record.repo, "update-ref", "--stdin"], { input: heads.map(head => `update refs/workit-gc/archive/${head} ${head}\n`).join(""), stdio: ["pipe", "pipe", "pipe"] });
      const temporary = `${bundle}.${process.pid}.partial`;
      execFileSync("git", ["-C", record.repo, "bundle", "create", temporary, ...heads.map(head => `refs/workit-gc/archive/${head}`)], { stdio: "pipe", timeout: 300_000 });
      execFileSync("git", ["-C", record.repo, "bundle", "verify", temporary], { stdio: "pipe" });
      try { linkSync(temporary, bundle); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      finally { rmSync(temporary, { force: true }); }
    }
    try { linkSync(bundle, join(destination, "history.bundle")); }
    catch { copyFileSync(bundle, join(destination, "history.bundle")); }
    execFileSync("git", ["-C", record.repo, "bundle", "verify", join(destination, "history.bundle")], { stdio: "pipe" });
    const listedHeads = execFileSync("git", ["bundle", "list-heads", join(destination, "history.bundle")], { encoding: "utf8" });
    if (!listedHeads.split("\n").some(line => line === `${record.head} ${bundleRef}`)) throw new Error("Archive history does not contain the pinned revision");
    const descriptor = openSync(join(destination, "history.bundle"), "r");
    const header = Buffer.alloc(64 * 1024);
    try { readSync(descriptor, header); } finally { closeSync(descriptor); }
    const end = header.indexOf("\n\n");
    if (end < 0 || header.subarray(0, end).toString().split("\n").some(line => line.startsWith("-"))) throw new Error("Archive history has external prerequisites; checkout retained");
  }
  python(ARCHIVE, { root: record.path, destination: join(destination, "checkout.tar.gz"), tracked, cacheNames: [...CACHE_NAMES], preserveAll: !!record.remnant }, 600_000);
  writeFileSync(join(destination, "record.json"), JSON.stringify(record, null, 2), { mode: 0o600 });
  writeFileSync(join(destination, "RESTORE.txt"), `Repository: ${record.repo}\nCheckout: ${record.path}\nRevision: ${record.head}\nBranch: ${record.branch || "detached"}\n\nImport history.bundle with git fetch <bundle> ${bundleRef} when present.\nCreate a clean checkout at the saved revision using git worktree add (use --detach for detached revisions).\nApply nonempty worktree.patch with git apply <archive>/worktree.patch first; this restores tracked deletions and edits.\nThen extract checkout.tar.gz into that checkout; .git is deliberately excluded.\nThe archive preserves source, staged/unstaged file contents and ignored local state.\nApply nonempty index.patch with git apply --cached <archive>/index.patch to restore the original staging split.\nReinstall dependencies separately.\nResidual folders whose .git was already lost have source contents but no recoverable original index.\n`, { mode: 0o600 });
  if (record.remnant) writeFileSync(join(destination, "RESTORE.txt"), `Original folder: ${record.path}\nRepository directory: ${record.repo}\n\nThis folder had no Git registration or .git file. Its original revision is unknown.\nAll remaining files, links, modes and cache contents were archived and restore-verified.\nExtract checkout.tar.gz into a new empty directory to recover the folder.\nDo not infer an original commit or index from the containing repository.\n`, { mode: 0o600 });
  if (existsSync(join(record.path, ".git"))) {
    for (const [name, args] of [["index.patch", ["diff", "--cached", "--binary"]], ["worktree.patch", ["diff", "HEAD", "--binary"]]] as const) {
      const fd = openSync(join(destination, name), "wx", 0o600);
      try { execFileSync("git", ["-C", record.path, ...args], { stdio: ["ignore", fd, "pipe"], timeout: 300_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }); }
      finally { closeSync(fd); }
    }
  }
  return destination;
}

export function verifyArchiveSource(path: string, directory: string, tracked: string[], preserveAll = false): void {
  const script = ARCHIVE.slice(0, ARCHIVE.indexOf("before=manifest(root)")) + String.raw`
with open(dest+'.manifest.json') as f:before=json.load(f)
if before!=manifest(root):raise RuntimeError('Local state changed after archiving')
print('{}')
`;
  python(script, { root: path, destination: join(directory, "checkout.tar.gz"), tracked, cacheNames: [...CACHE_NAMES], preserveAll }, 300_000);
}
