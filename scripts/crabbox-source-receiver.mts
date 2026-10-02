import type { CrabboxSourceCapsule } from "./crabbox-source-capsule.mts";

// This program travels in the locally constructed command, independently of the
// uploaded files. Neither receiver Git metadata nor the capsule can choose its identity.
const receiver = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { isUtf8 } = require("node:buffer");
const { spawnSync } = require("node:child_process");
const { getSystemErrorMap } = require("node:util");
const expected = JSON.parse(process.argv[1]);
const syncRoot = process.cwd();
const cwd = process.argv[2] ?? syncRoot;
let temporary;
let activePhase;
function finishPhase(status = "completed") {
  if (!activePhase) return;
  process.stderr.write("OPENCLAW_SOURCE_PHASE " + JSON.stringify({
    name: activePhase.name, status, elapsedMs: Math.round(performance.now() - activePhase.started),
  }) + "\n");
  activePhase = undefined;
}
function phase(name) {
  if (!expected.publicBaseCacheRoot) return;
  finishPhase();
  activePhase = { name, started: performance.now() };
  process.stderr.write("OPENCLAW_SOURCE_PHASE " + JSON.stringify({ name, status: "started", elapsedMs: 0 }) + "\n");
}
function fail(message) { throw new Error(message); }
function stat(file) {
  try { return fs.lstatSync(file); } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
}
function safePath(file) {
  if (!file || file.includes("\\") || file.split("/").some(part =>
    !part || part === "." || part === ".." || part.toLowerCase() === ".git")) fail("unsafe source path");
  return file;
}
function hashFile(file, algorithm, blob = false) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile()) fail("source entry is not a regular file");
    const hash = createHash(algorithm);
    if (blob) hash.update("blob " + info.size + "\0");
    const buffer = Buffer.alloc(65536);
    let size;
    while ((size = fs.readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, size));
    return hash.digest("hex");
  } finally { fs.closeSync(fd); }
}
const gitFailureCause = Object.freeze({
  noSpace: "no-space", permissionDenied: "permission-denied",
  commandUnavailable: "command-unavailable", outputLimit: "output-limit",
  terminated: "terminated", remoteRefMissing: "remote-ref-missing",
  invalidObjectData: "invalid-object-data", dns: "dns", connection: "connection",
  auth: "auth", unknown: "unknown",
});
function gitFailure(phase, result) {
  const errors = getSystemErrorMap();
  const rawCode = result.error?.code;
  const code = [...errors.values()].some(([name]) => name === rawCode) ? rawCode : null;
  const text = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8").trim() : "";
  const cause = code === "ENOSPC" ? gitFailureCause.noSpace
    : code === "EACCES" || code === "EPERM" ? gitFailureCause.permissionDenied
    : code === "ENOENT" ? gitFailureCause.commandUnavailable
    : code === "ENOBUFS" ? gitFailureCause.outputLimit
    : result.signal !== null ? gitFailureCause.terminated
    : /^fatal: couldn't find remote ref [^\r\n]+$/u.test(text) ? gitFailureCause.remoteRefMissing
    : /^fatal: (?:pack has bad object(?: at offset \d+)?|bad object [a-f0-9]+|index-pack failed|fetch-pack: invalid index-pack output)$/u.test(text) ? gitFailureCause.invalidObjectData
    : /^fatal: unable to access '[^'\r\n]+': Could not resolve (?:host|proxy): [^\r\n]+$/u.test(text) ? gitFailureCause.dns
    : /^fatal: unable to access '[^'\r\n]+': (?:Failed to connect to [^\r\n]+|Recv failure: Connection reset by peer)$/u.test(text) ? gitFailureCause.connection
    : /^fatal: (?:Authentication failed for '[^'\r\n]+'|could not read Username for '[^'\r\n]+': [^\r\n]+)$/u.test(text) ? gitFailureCause.auth
    : gitFailureCause.unknown;
  return { phase, baseSha: /^[a-f0-9]{40}$/u.test(expected.baseSha) ? expected.baseSha : null,
    status: result.status, signal: result.signal, spawnError: Boolean(result.error),
    code, errno: errors.has(result.error?.errno) ? result.error.errno : null, cause };
}
try {
  if (process.argv[2] && (cwd === syncRoot || cwd.startsWith(syncRoot + path.sep) || syncRoot.startsWith(cwd + path.sep)))
    fail("Testbox execution and sync workspaces overlap; stop this lease and warm a fresh one");
  const capsule = path.join(syncRoot, ".openclaw-crabbox-changed-gate.bundle");
  if (!stat(capsule)?.isFile() || hashFile(capsule, "sha256") !== expected.digest)
    fail("missing or mismatched source capsule; rerun from the local candidate");
  // Native cleanup owns only syncRoot. Source application and the payload share
  // the prepared workspace, so ignored runtime never enters the native delete walk.
  process.chdir(cwd);
  // A killed receiver must not leave staging inside the next job's source inventory.
  // The sibling stays on the workspace filesystem so publishing .git remains a rename.
  const temporaryParent = path.dirname(cwd);
  let parentInfo = stat(temporaryParent);
  if (!parentInfo?.isDirectory() || temporaryParent === cwd || parentInfo.dev !== fs.statSync(cwd).dev)
    fail("source staging requires a separate parent on the workspace filesystem");
  if (expected.ownedStagingParent !== undefined) {
    if (process.platform !== "linux" || expected.ownedStagingParent !== temporaryParent ||
        fs.realpathSync(temporaryParent) !== temporaryParent || parentInfo.uid !== process.getuid())
      fail("source staging parent does not match the owned SSH lane");
    const parent = fs.openSync(temporaryParent,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      const opened = fs.fstatSync(parent);
      if (opened.dev !== parentInfo.dev || opened.ino !== parentInfo.ino || opened.uid !== process.getuid())
        fail("source staging parent changed before private preparation");
      fs.fchmodSync(parent, 0o700);
      parentInfo = stat(temporaryParent);
      if (!parentInfo?.isDirectory() || parentInfo.dev !== opened.dev || parentInfo.ino !== opened.ino ||
          (parentInfo.mode & 0o777) !== 0o700)
        fail("source staging parent changed during private preparation");
    } finally { fs.closeSync(parent); }
  }
  if (
    process.platform !== "win32" &&
    (parentInfo.mode & 0o022) &&
    !(parentInfo.mode & 0o1000)
  )
    fail("source staging parent allows shared writers without sticky protection");
  temporary = fs.mkdtempSync(path.join(temporaryParent, ".openclaw-source-"));
  const bundle = path.join(temporary, "source.bundle");
  fs.copyFileSync(capsule, bundle);
  if (hashFile(bundle, "sha256") !== expected.digest) fail("source capsule changed during import");
  const gitDir = path.join(temporary, "git");
  const env = { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: cwd,
    GIT_INDEX_FILE: path.join(gitDir, "index"), GIT_OPTIONAL_LOCKS: "0" };
  delete env.GIT_COMMON_DIR;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  delete env.GIT_SHALLOW_FILE;
  if (expected.publicBaseCacheRoot) {
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    Object.assign(env, {
      GIT_DIR: gitDir, GIT_WORK_TREE: cwd, GIT_INDEX_FILE: path.join(gitDir, "index"),
      GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0",
      GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false", GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "https:file",
    });
  }
  function git(args, options = {}) {
    const { encoding, phase = args[0], config = [], ...spawnOptions } = options;
    const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...config, ...args],
      { cwd, env, maxBuffer: 64 * 1024 * 1024, ...spawnOptions });
    if (result.status !== 0) fail("source Git operation failed: " + JSON.stringify(gitFailure(phase, result)));
    if (encoding === "buffer") return result.stdout;
    if (result.stdout === null) return "";
    if (!isUtf8(result.stdout)) fail("unsupported non-UTF-8 Git metadata");
    return result.stdout.toString("utf8");
  }
  const canonical = "https://github.com/openclaw/openclaw.git";
  function publicGit(directory, args) {
    const publicEnv = { ...env, GIT_DIR: directory };
    delete publicEnv.GIT_WORK_TREE;
    delete publicEnv.GIT_INDEX_FILE;
    const previousUmask = process.umask(0o077);
    try {
      return git(args, { env: publicEnv, config: [
        "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "fetch.writeCommitGraph=false",
        "-c", "pack.writeReverseIndex=false",
      ] });
    } finally {
      process.umask(previousUmask);
    }
  }
  function publicDirectory(file) {
    const info = stat(file);
    if (!info?.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o022))
      fail("public base cache requires an owned directory without symlinks or shared writers");
  }
  function copyPublicFile(source, destination) {
    const before = stat(source);
    if (!before?.isFile() || before.nlink !== 1 || before.uid !== process.getuid() || (before.mode & 0o022))
      fail("public base cache requires owned regular files without symlinks, hardlinks, or shared writers");
    const input = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let output;
    try {
      const opened = fs.fstatSync(input);
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino)
        fail("public base cache changed while opening a file");
      output = fs.openSync(destination, "wx", 0o600);
      const buffer = Buffer.alloc(65536);
      let count;
      while ((count = fs.readSync(input, buffer)) > 0) {
        let written = 0;
        while (written < count) written += fs.writeSync(output, buffer, written, count - written);
      }
      const after = fs.fstatSync(input);
      if (after.nlink !== 1 || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs)
        fail("public base cache changed while copying a file");
      fs.fchmodSync(output, 0o444);
    } finally {
      fs.closeSync(input);
      if (output !== undefined) fs.closeSync(output);
    }
  }
  function copyPublicObjects(source, destination, relative = "objects") {
    publicDirectory(source);
    if (!stat(destination)) fs.mkdirSync(destination, { mode: 0o700 });
    for (const name of fs.readdirSync(source)) {
      const entry = relative + "/" + name;
      const from = path.join(source, name), to = path.join(destination, name);
      if (/^objects\/(info|pack|[a-f0-9]{2})$/.test(entry)) {
        copyPublicObjects(from, to, entry);
      } else if (/^objects\/[a-f0-9]{2}\/[a-f0-9]{38}$/.test(entry) ||
          /^objects\/pack\/pack-[a-f0-9]{40}\.(pack|idx)$/.test(entry)) {
        copyPublicFile(from, to);
      } else {
        fail("public base cache contains unsupported object metadata: " + entry);
      }
    }
  }
  function copyPublicStore(source, destination, published) {
    publicDirectory(source);
    if (published && fs.readdirSync(source).some(name => name !== "objects" && name !== "shallow"))
      fail("public base cache contains unexpected metadata");
    copyPublicObjects(path.join(source, "objects"), path.join(destination, "objects"));
    if (stat(path.join(source, "shallow"))) copyPublicFile(path.join(source, "shallow"), path.join(destination, "shallow"));
  }
  function verifyPublicBase(directory) {
    phase("public-base.verify");
    if (publicGit(directory, ["cat-file", "-t", expected.baseSha]).trim() !== "commit")
      fail("public base cache does not contain the requested commit");
    const header = publicGit(directory, ["cat-file", "commit", expected.baseSha]).split("\n\n", 1)[0];
    const parents = new Set(header.split("\n").filter(line => line.startsWith("parent ")).map(line => line.slice(7)));
    const shallow = stat(path.join(directory, "shallow"))
      ? fs.readFileSync(path.join(directory, "shallow"), "utf8").trim().split("\n") : [];
    if (shallow.some(oid => !parents.has(oid))) fail("public base cache has an invalid shallow boundary");
    const commits = publicGit(directory, ["rev-list", expected.baseSha]).trim().split("\n").sort();
    const expectedCommits = [...new Set([expected.baseSha, ...parents])].sort();
    if (JSON.stringify(commits) !== JSON.stringify(expectedCommits))
      fail("public base cache does not match the requested depth-2 history");
    if (publicGit(directory, ["fsck", "--full", "--strict", "--no-reflogs", "--unreachable", expected.baseSha]).trim())
      fail("public base cache contains unrelated objects");
  }
  function acquirePublicBase() {
    if (process.platform !== "linux" || !path.isAbsolute(expected.publicBaseCacheRoot) ||
        !/^[a-f0-9]{40}$/.test(expected.baseSha)) fail("invalid trusted SSH public base cache request");
    const cacheRoot = path.resolve(expected.publicBaseCacheRoot);
    for (const workspace of [syncRoot, cwd]) {
      if (cacheRoot === workspace || cacheRoot.startsWith(workspace + path.sep) || workspace.startsWith(cacheRoot + path.sep))
        fail("public base cache and source workspaces must not overlap");
    }
    const parent = path.join(cacheRoot, createHash("sha256").update(canonical).digest("hex"), "depth-2");
    let ancestor = path.parse(parent).root;
    for (const segment of parent.slice(ancestor.length).split(path.sep)) {
      ancestor = path.join(ancestor, segment);
      if (!stat(ancestor)) {
        try { fs.mkdirSync(ancestor, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
      }
      if (!stat(ancestor)?.isDirectory()) fail("public base cache path contains a symlink or non-directory");
      if (ancestor === cacheRoot || ancestor.startsWith(cacheRoot + path.sep)) publicDirectory(ancestor);
    }
    const seed = path.join(parent, expected.baseSha);
    if (!stat(seed)) {
      const building = fs.mkdtempSync(path.join(parent, "." + expected.baseSha + "-"));
      try {
        const fetched = path.join(building, "git");
        publicGit(fetched, ["init", "-q", "--bare", "--template="]);
        phase("public-base.fetch");
        publicGit(fetched, ["fetch", "-q", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head",
          "--depth=2", canonical, expected.baseSha + ":refs/heads/base"]);
        verifyPublicBase(fetched);
        phase("public-base.publish");
        const ready = path.join(building, "seed");
        fs.mkdirSync(ready, { mode: 0o700 });
        copyPublicStore(fetched, ready, false);
        try { fs.renameSync(ready, seed); } catch (error) {
          if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
          // A concurrent builder published first. Its complete seed is verified below.
        }
      } finally { fs.rmSync(building, { recursive: true, force: true }); }
    }
    phase("public-base.copy");
    copyPublicStore(seed, gitDir, true);
    verifyPublicBase(gitDir);
    git(["update-ref", "refs/remotes/origin/main", expected.baseSha]);
  }
  git(["init", "-q", ...(expected.publicBaseCacheRoot ? ["--template="] : [])]);
  git(["remote", "add", "origin", canonical]);
  if (expected.publicBaseCacheRoot) acquirePublicBase();
  else git(["fetch", "-q", "--depth=2", "origin", expected.baseSha + ":refs/remotes/origin/main"],
    { phase: "base-fetch" });
  if (git(["rev-parse", "refs/remotes/origin/main"]).trim() !== expected.baseSha)
    fail("source base mismatch");
  phase("source.materialize");
  git(["fetch", "-q", bundle, "refs/openclaw/source-capsule:refs/heads/openclaw-source"],
    { phase: "capsule-fetch" });
  for (const [ref, value] of [
    ["refs/heads/openclaw-source", expected.carrier],
    ["refs/heads/openclaw-source^{tree}", expected.tree],
    ["refs/heads/openclaw-source^", expected.baseSha],
  ]) if (git(["rev-parse", ref]).trim() !== value) fail("source capsule identity mismatch");
  function entries(tree, directory = gitDir) {
    const output = git(["ls-tree", "-r", "-z", tree], { encoding: "buffer",
      env: { ...env, GIT_DIR: directory, GIT_INDEX_FILE: path.join(directory, "index") } });
    if (!isUtf8(output)) fail("unsupported non-UTF-8 source paths");
    return output.subarray(0, -1).toString("utf8")
      .split("\0").filter(Boolean).map(row => {
        const match = /^(100644|100755|120000) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(row);
        if (!match) fail("unsupported source tree entry");
        return { mode: match[1], oid: match[2], file: safePath(match[3]) };
      });
  }
  // The prepared workspace can contain newer workflow source. Its committed tree
  // owns only cleanup candidates; the capsule alone selects the executed source.
  const previous = new Map((process.argv[2] ? entries("HEAD", path.join(cwd, ".git")) : [])
    .map(entry => [entry.file, entry]));
  const files = entries(expected.tree);
  const metadata = JSON.parse(git(["show", "-s", "--format=%B", expected.carrier]));
  if (!Array.isArray(metadata.deleted) || metadata.deleted.some(file => typeof file !== "string"))
    fail("invalid source deletion inventory");
  const deleted = new Set(metadata.deleted.map(safePath));
  const selected = new Set(files.map(entry => entry.file));
  const directories = new Set();
  for (const { file } of files) {
    let parent = path.posix.dirname(file);
    while (parent !== ".") { directories.add(parent); parent = path.posix.dirname(parent); }
  }
  // Never follow an old directory symlink while removing or creating source entries.
  function reachable(file) {
    let parent = path.posix.dirname(file);
    while (parent !== ".") {
      if (!stat(parent)?.isDirectory()) return false;
      parent = path.posix.dirname(parent);
    }
    return true;
  }
  function remove(file) {
    safePath(file);
    if (reachable(file)) fs.rmSync(file, { recursive: true, force: true });
  }
  // The producer owns privacy-filtered deletions, including ignored entries lost
  // from old indexes. A directory with unknown contents is not ours to erase.
  for (const file of [...deleted].sort((a, b) => b.split("/").length - a.split("/").length)) {
    if (selected.has(file) || directories.has(file)) fail("conflicting source deletion");
    if (reachable(file)) {
      if (stat(file)?.isDirectory()) fs.rmdirSync(file);
      else fs.rmSync(file, { force: true });
    }
  }
  for (const directory of [...directories].sort((a, b) => a.split("/").length - b.split("/").length)) {
    if (!stat(directory)?.isDirectory()) {
      remove(directory);
      fs.mkdirSync(directory);
    }
  }
  // Batch raw blobs once; checkout/archive would apply attributes or export rules.
  const blobPath = path.join(temporary, "blobs");
  const output = fs.openSync(blobPath, "wx");
  try { git(["cat-file", "--batch"], {
    input: files.map(entry => entry.oid + "\n").join(""), stdio: ["pipe", output, "pipe"]
  }); } finally { fs.closeSync(output); }
  const input = fs.openSync(blobPath, "r");
  const buffer = Buffer.alloc(65536);
  let cursor = 0;
  let end = 0;
  function take(count) {
    if (cursor === end) { end = fs.readSync(input, buffer); cursor = 0; }
    if (end === 0) fail("truncated source blobs");
    const chunk = buffer.subarray(cursor, Math.min(end, cursor + count));
    cursor += chunk.length;
    return chunk;
  }
  try {
    for (const entry of files) {
      let header = "";
      for (;;) {
        const byte = take(1)[0];
        if (byte === 10) break;
        header += String.fromCharCode(byte);
        if (header.length > 100) fail("invalid source blob header");
      }
      const match = /^([a-f0-9]{40}) blob (\d+)$/.exec(header);
      if (!match || match[1] !== entry.oid) fail("source blob identity mismatch");
      let remaining = Number(match[2]);
      remove(entry.file);
      const fd = entry.mode === "120000" ? null : fs.openSync(entry.file, "wx", 0o600);
      const target = [];
      try {
        while (remaining > 0) {
          const bytes = take(remaining);
          remaining -= bytes.length;
          if (fd === null) target.push(Buffer.from(bytes));
          else fs.writeFileSync(fd, bytes);
        }
      } finally { if (fd !== null) fs.closeSync(fd); }
      if (take(1)[0] !== 10) fail("invalid source blob terminator");
      if (fd === null) fs.symlinkSync(Buffer.concat(target), entry.file);
      else fs.chmodSync(entry.file, entry.mode === "100755" ? 0o755 : 0o644);
    }
  } finally { fs.closeSync(input); }
  git(["read-tree", expected.tree]);
  fs.rmSync(capsule);
  for (;;) {
    const extras = git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0")
      .filter(Boolean);
    if (extras.length === 0) break;
    // Settle ancestor ignore rules first: removing a negated rule can protect
    // descendant rules already listed, while removing an exclusion can reveal more.
    const ignore = extras.filter(file => path.posix.basename(file) === ".gitignore")
      .sort((a, b) => a.split("/").length - b.split("/").length)[0];
    for (const file of ignore ? [ignore] : extras) {
      const entry = previous.get(file);
      if (!entry) fail("unexpected source entry: " + file);
      // Preserve untracked, ignored, and modified runtime state. Only unchanged
      // committed extras may be retired after the new source's ignore rules apply.
      verify(entry);
      fs.unlinkSync(file);
      deleted.add(file);
    }
    // Each pass removes committed files. Retiring their .gitignore rules can
    // expose more entries, so verification ends only with an empty inventory.
  }
  for (const file of deleted) {
    if (reachable(file) && stat(file)) fail("source deletion mismatch: " + file);
  }
  phase("source.verify");
  // Verify filesystem bytes, kind, and executable bit independently of either index.
  function verify({ file, mode, oid }) {
    if (!reachable(file)) fail("source parent mismatch: " + file);
    const info = stat(file);
    let actual;
    if (mode === "120000") {
      if (!info?.isSymbolicLink()) fail("source kind mismatch: " + file);
      const target = fs.readlinkSync(file, { encoding: "buffer" });
      actual = createHash("sha1").update("blob " + target.length + "\0").update(target).digest("hex");
    } else {
      if (!info?.isFile() || Boolean(info.mode & 0o100) !== (mode === "100755"))
        fail("source mode mismatch: " + file);
      actual = hashFile(file, "sha1", true);
    }
    if (actual !== oid) fail("source bytes mismatch: " + file);
  }
  for (const entry of files) verify(entry);
  if (expected.alias) git(["update-ref", expected.alias, expected.baseSha]);
  git(["symbolic-ref", "HEAD", "refs/heads/openclaw-source"]);
  const sourceIndex = git(["ls-files", "--stage", "-v", "-z"], { encoding: "buffer" });
  fs.rmSync(".git", { recursive: true, force: true });
  fs.renameSync(gitDir, path.join(cwd, ".git"));
  env.GIT_DIR = path.join(cwd, ".git");
  env.GIT_INDEX_FILE = path.join(env.GIT_DIR, "index");
  const sourceGit = stat(env.GIT_DIR);
  // The payload consumes Git identity as well as bytes. Lifecycle hooks may refresh
  // index caches or hooksPath, but cannot change source membership or comparison refs.
  function verifySource() {
    const currentGit = stat(env.GIT_DIR);
    if (!currentGit?.isDirectory() || currentGit.dev !== sourceGit.dev || currentGit.ino !== sourceGit.ino ||
        !stat(env.GIT_INDEX_FILE)?.isFile() || stat(path.join(env.GIT_DIR, "commondir")))
      fail("source Git owner mismatch");
    for (const entry of files) verify(entry);
    for (const file of deleted) {
      if (reachable(file) && stat(file)) fail("source deletion mismatch: " + file);
    }
    if (!git(["ls-files", "--stage", "-v", "-z"], { encoding: "buffer" }).equals(sourceIndex))
      fail("source index mismatch");
    if (git(["symbolic-ref", "HEAD"]).trim() !== "refs/heads/openclaw-source")
      fail("source HEAD mismatch");
    for (const [ref, value] of [
      ["HEAD", expected.carrier], ["refs/remotes/origin/main", expected.baseSha],
      ...(expected.alias ? [[expected.alias, expected.baseSha]] : []),
    ]) if (git(["rev-parse", ref]).trim() !== value) fail("source comparison ref mismatch: " + ref);
    const extras = git(["ls-files", "--others", "--exclude-standard", "-z"])
      .split("\0").filter(Boolean);
    if (extras.length) fail("unexpected source entry: " + extras[0]);
  }
  verifySource();
  if (expected.install !== "none" && selected.has("pnpm-lock.yaml")) {
    const installer = ".github/actions/setup-node-env/install-dependencies.sh";
    if (!selected.has(installer) || !stat(installer)?.isFile())
      fail("selected source lacks a regular dependency install owner");
    // Hydration belongs to workflow source. Reconcile through the selected
    // source's install owner before any caller payload can run.
    const installEnv = { ...env, CI: "true", GITHUB_WORKSPACE: cwd,
      NODE_BIN: path.dirname(process.execPath), FROZEN_LOCKFILE: "true",
      DEPENDENCY_CACHE: "false", DEPENDENCY_CACHE_HIT: "false" };
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete installEnv[key];
    process.stderr.write("[crabbox] reconciling selected-source dependencies\n");
    const install = spawnSync("bash", [installer], { cwd, env: installEnv, stdio: ["inherit", 2, 2] });
    if (install.status !== 0) fail("selected-source frozen install failed; payload was not run");
    verifySource();
  }
  if (expected.command) {
    phase("payload");
    const result = spawnSync(expected.command[0], expected.command.slice(1), {
      cwd, env: process.env, stdio: "inherit",
    });
    finishPhase(result.status === 0 ? "completed" : "failed");
    phase("source.verify");
    verifySource();
    process.exitCode = result.status ?? 1;
  }
  finishPhase();
  process.stderr.write("[crabbox] verified source=" + expected.sourceSha + " tree=" + expected.tree + " carrier=" + expected.carrier + "\n");
} catch (error) {
  finishPhase("failed");
  process.stderr.write("[crabbox] source verification failed: " + error.message + "\n");
  process.exitCode = 2;
} finally {
  if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
}
`;

export function remoteSourceBootstrap(
  capsule: CrabboxSourceCapsule,
  alias: string,
  testboxWorkspace: boolean,
  options: {
    install?: "default" | "none";
    command?: string[];
    publicBaseCacheRoot?: string;
    ownedStagingParent?: string;
  } = {},
) {
  if (testboxWorkspace && options.ownedStagingParent !== undefined) {
    throw new Error("private staging preparation is limited to owned SSH lanes");
  }
  if (testboxWorkspace && options.publicBaseCacheRoot) {
    throw new Error("public base caching is limited to trusted SSH remote checks");
  }
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const { sourceSha, baseSha, tree, carrier, digest } = capsule;
  const command = `node -e ${quote(receiver)} ${quote(JSON.stringify({ sourceSha, baseSha, tree, carrier, digest, alias, ...options }))}`;
  if (!testboxWorkspace) {
    return command;
  }
  return [
    'openclaw_source_root="$(cd ./.git/crabbox-artifact-root && pwd -P)" || { echo "[crabbox] missing prepared Testbox execution workspace; stop this lease and warm a fresh one" >&2; exit 2; };',
    `${command} "$openclaw_source_root" && cd "$openclaw_source_root"`,
  ].join(" ");
}
