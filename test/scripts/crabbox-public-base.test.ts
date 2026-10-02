import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, onTestFinished } from "vitest";
import type { CrabboxSourceCapsule } from "../../scripts/crabbox-source-capsule.mts";
import { remoteSourceBootstrap } from "../../scripts/crabbox-source-receiver.mts";

const canonical = "https://github.com/openclaw/openclaw.git";
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
type Outcome = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};
type Run = { child: ChildProcess; done: Promise<Outcome>; directory: string };
type SourcePhase = { name: string; status: string; elapsedMs: number };

function sourcePhases(stderr: string): SourcePhase[] {
  return stderr
    .split("\n")
    .filter((line) => line.startsWith("OPENCLAW_SOURCE_PHASE "))
    .map((line) => JSON.parse(line.slice("OPENCLAW_SOURCE_PHASE ".length)) as SourcePhase);
}

function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = join(root, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}
async function waitFor(produced: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!produced()) {
    if (Date.now() >= deadline) {
      throw new Error("Fixture did not produce its readiness signal");
    }
    await delay(10);
  }
}
function stop(run: Run, signal: NodeJS.Signals = "SIGTERM") {
  if (!run.child.pid) {
    return;
  }
  try {
    process.kill(-run.child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openclaw-public-base-"));
  const active = new Set<Run>();
  onTestFinished(async () => {
    for (const run of active) {
      stop(run);
    }
    await Promise.allSettled([...active].map((run) => run.done));
    rmSync(root, { recursive: true, force: true });
  });
  const realGit = (process.env.PATH ?? "")
    .split(delimiter)
    .map((directory) => join(directory, "git"))
    .find((file) => {
      try {
        accessSync(file, constants.X_OK);
        return statSync(file).isFile();
      } catch {
        return false;
      }
    });
  if (!realGit) {
    throw new Error("Git is required for the receiver contract fixture");
  }
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) {
      delete env[key];
    }
  }
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Public base fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Public base fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  });
  const git = (directory: string, args: string[], input?: string) =>
    execFileSync(realGit, ["-C", directory, ...args], {
      env,
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  const origin = join(root, "canonical");
  mkdirSync(origin);
  git(origin, ["init", "-q", "--template=", "--initial-branch=main"]);
  for (let revision = 1; revision <= 3; revision++) {
    writeFileSync(join(origin, "public.txt"), `public revision ${revision}\n`);
    git(origin, ["add", "public.txt"]);
    git(origin, ["commit", "-qm", `Public revision ${revision}`]);
  }
  const base = git(origin, ["rev-parse", "HEAD"]);
  const cacheRoot = join(root, "work", ".openclaw-public-bases", "v1");
  const seed = join(cacheRoot, digest(canonical), "depth-2", base);
  const log = join(root, "fetches");
  const blocked = join(root, "network-blocked");
  const gate = join(root, "fetch-gate");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const shim = join(bin, "git");
  // Only the canonical transport is replaced. Git parses and stores every real object.
  writeFileSync(
    shim,
    `#!${process.execPath}\n` +
      String.raw`
const fs = require("node:fs"), cp = require("node:child_process"), path = require("node:path");
const args = process.argv.slice(2), root = process.env.PUBLIC_BASE_FIXTURE;
const realGit = process.env.PUBLIC_BASE_REAL_GIT;
async function main() {
  if (args.includes("fetch")) {
    let remote = args.indexOf("https://github.com/openclaw/openclaw.git");
    if (remote === -1) remote = args.indexOf("origin");
    if (remote !== -1) {
      fs.appendFileSync(path.join(root, "fetches"), String(process.pid) + "\n");
      if (fs.existsSync(path.join(root, "network-blocked"))) process.exit(90);
      const gate = path.join(root, "fetch-gate");
      if (fs.existsSync(gate)) {
        fs.writeFileSync(path.join(gate, "ready-" + process.pid), "");
        const deadline = Date.now() + 10000;
        while (!fs.existsSync(path.join(gate, "release"))) {
          if (Date.now() >= deadline) throw new Error("fetch fixture was never released");
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
      args[remote] = require("node:url").pathToFileURL(path.join(root, "canonical")).href;
    } else if (!args.some(arg => arg.endsWith(".bundle"))) {
      throw new Error("Unexpected remote transport in receiver fixture");
    }
  }
  const result = cp.spawnSync(realGit, args, { env: process.env, stdio: "inherit" });
  process.exitCode = result.status ?? 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
`,
    { mode: 0o700 },
  );
  const remoteEnv = {
    ...env,
    PATH: [bin, dirname(process.execPath), env.PATH].join(delimiter),
    PUBLIC_BASE_FIXTURE: root,
    PUBLIC_BASE_REAL_GIT: realGit,
  };
  let sequence = 0;
  const capsule = (privateText: string, extraFiles: Record<string, string> = {}) => {
    const directory = join(root, `candidate-${++sequence}`);
    git(root, ["clone", "-q", "--no-hardlinks", origin, directory]);
    writeFileSync(join(directory, "private.txt"), privateText);
    for (const [file, bytes] of Object.entries(extraFiles)) {
      mkdirSync(dirname(join(directory, file)), { recursive: true });
      writeFileSync(join(directory, file), bytes);
    }
    git(directory, ["add", "."]);
    const privateBlob = git(directory, ["hash-object", "private.txt"]);
    const tree = git(directory, ["write-tree"]);
    const carrier = git(directory, ["commit-tree", tree, "-p", base], '{"deleted":[]}\n');
    git(directory, ["update-ref", "refs/openclaw/source-capsule", carrier]);
    const bundlePath = join(root, `source-${sequence}.bundle`);
    git(directory, ["bundle", "create", bundlePath, `${base}..refs/openclaw/source-capsule`]);
    const value: CrabboxSourceCapsule = {
      sourceSha: base,
      baseSha: base,
      tree,
      carrier,
      digest: digest(readFileSync(bundlePath)),
      bundlePath,
      directory,
      cleanup: () => rmSync(directory, { recursive: true, force: true }),
      staging: {
        recorded: false,
        root: directory,
        payload: directory,
        prepared: () => {},
        admitted: () => {},
        settled: () => {},
        preserved: () => {},
        hold: () => {},
        dispose: () => {},
      },
    };
    return { value, privateBlob };
  };
  const receive = (
    source: CrabboxSourceCapsule,
    options: {
      cache?: boolean;
      install?: "default" | "none";
      command?: string[];
      env?: NodeJS.ProcessEnv;
      directory?: string;
      ownedStagingParent?: string;
    } = {},
  ): Run => {
    const directory = options.directory ?? join(root, `receiver-${++sequence}`);
    if (!options.directory) {
      mkdirSync(directory);
    }
    copyFileSync(source.bundlePath, join(directory, ".openclaw-crabbox-changed-gate.bundle"));
    const command = remoteSourceBootstrap(source, "", false, {
      install: options.install ?? "none",
      command: options.command ?? [
        process.execPath,
        "-e",
        'process.stdout.write(require("node:fs").readFileSync("private.txt", "utf8"))',
      ],
      ...(options.cache === false ? {} : { publicBaseCacheRoot: cacheRoot }),
      ...(options.ownedStagingParent === undefined
        ? {}
        : { ownedStagingParent: options.ownedStagingParent }),
    });
    const child = spawn("bash", ["-c", "exec " + command], {
      cwd: directory,
      env: { ...remoteEnv, ...options.env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const done = new Promise<Outcome>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
    const run = { child, done, directory };
    active.add(run);
    void done.then(
      () => active.delete(run),
      () => active.delete(run),
    );
    return run;
  };
  const fetches = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0);
  const snapshot = () =>
    Object.fromEntries(
      files(seed)
        .toSorted()
        .map((file) => [relative(seed, file), digest(readFileSync(file))]),
    );
  const cachedObject = (oid: string) => {
    const inspection = join(root, `inspection-${++sequence}`);
    mkdirSync(inspection);
    git(inspection, ["init", "-q", "--bare", "--template="]);
    cpSync(join(seed, "objects"), join(inspection, "objects"), { recursive: true });
    if (existsSync(join(seed, "shallow"))) {
      copyFileSync(join(seed, "shallow"), join(inspection, "shallow"));
    }
    return spawnSync(realGit, ["-C", inspection, "cat-file", "-e", oid], { env }).status === 0;
  };
  return {
    root,
    seed,
    cacheRoot,
    base,
    blocked,
    gate,
    capsule,
    receive,
    fetches,
    snapshot,
    cachedObject,
    git,
  };
}

describe.skipIf(process.platform !== "linux")("trusted SSH public base receiver", () => {
  it.each([true, false])(
    "privatizes only the exact owned lane parent (matched=%s)",
    async (matched) => {
      const f = fixture();
      const source = f.capsule("private lane payload\n");
      const parent = join(f.root, "owned-lane");
      const directory = join(parent, "source");
      mkdirSync(directory, { recursive: true });
      chmodSync(parent, 0o775);
      const result = await f.receive(source.value, {
        directory,
        ownedStagingParent: matched ? parent : f.root,
      }).done;
      expect(statSync(f.root).mode & 0o777).toBe(0o700);
      if (matched) {
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toBe("private lane payload\n");
        expect(statSync(parent).mode & 0o777).toBe(0o700);
      } else {
        expect(result.code).toBe(2);
        expect(result.stderr).toContain("does not match the owned SSH lane");
        expect(statSync(parent).mode & 0o777).toBe(0o775);
        expect(f.fetches()).toBe(0);
      }
    },
  );

  it.each([
    { mode: 0o777, accepted: false },
    { mode: 0o775, accepted: false },
    { mode: 0o700, accepted: true },
    { mode: 0o1777, accepted: true },
  ])("enforces staging parent ownership for mode $mode", async ({ mode, accepted }) => {
    const f = fixture();
    const source = f.capsule("owned staging payload\n");
    const parent = join(f.root, "staging-parent");
    const directory = join(parent, "source");
    mkdirSync(directory, { recursive: true });
    chmodSync(parent, mode);
    const result = await f.receive(source.value, { directory }).done;
    if (accepted) {
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe("owned staging payload\n");
    } else {
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("shared writers without sticky protection");
      expect(result.stdout).toBe("");
      expect(f.fetches()).toBe(0);
      expect(existsSync(join(directory, ".git"))).toBe(false);
    }
  });

  it("uses one canonical fetch across private sources and gives every job independent Git objects", async () => {
    const f = fixture();
    const first = f.capsule("private source one\n");
    const cold = await f.receive(first.value, {
      env: {
        GIT_DIR: "/missing/inherited-repository",
        GIT_OBJECT_DIRECTORY: "/missing/inherited-objects",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "url.file:///missing/redirected-canonical.insteadOf",
        GIT_CONFIG_VALUE_0: `file://${join(f.root, "canonical")}`,
      },
    }).done;
    expect(cold.code, cold.stderr).toBe(0);
    expect(cold.stdout).toBe("private source one\n");
    expect(f.fetches()).toBe(1);
    expect(existsSync(f.seed), "Cold acquisition must publish a complete public seed").toBe(true);
    const seedBefore = f.snapshot();
    expect(f.cachedObject(f.base)).toBe(true);
    expect(f.cachedObject(first.privateBlob)).toBe(false);
    expect(f.cachedObject(first.value.carrier)).toBe(false);
    writeFileSync(f.blocked, "");
    const second = f.capsule("private source two\n");
    const warm = f.receive(second.value);
    const result = await warm.done;
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe("private source two\n");
    expect(f.fetches()).toBe(1);
    expect(f.snapshot()).toEqual(seedBefore);
    expect(f.cachedObject(second.privateBlob)).toBe(false);
    const phases = sourcePhases(result.stderr);
    expect(phases.map((phase) => phase.name)).toEqual(
      expect.arrayContaining([
        "public-base.copy",
        "public-base.verify",
        "source.materialize",
        "source.verify",
        "payload",
      ]),
    );
    expect(phases.some((phase) => phase.name === "public-base.fetch")).toBe(false);
    expect(phases.every((phase) => phase.elapsedMs >= 0)).toBe(true);
    const payloadStart = phases.findIndex(
      (phase) => phase.name === "payload" && phase.status === "started",
    );
    const verified = phases.findIndex(
      (phase) => phase.name === "source.verify" && phase.status === "completed",
    );
    expect(verified).toBeGreaterThanOrEqual(0);
    expect(payloadStart).toBeGreaterThan(verified);
    const independent = await f.receive(second.value, {
      command: [
        process.execPath,
        "-e",
        `
const fs = require("node:fs"), cp = require("node:child_process");
fs.rmSync(${JSON.stringify(f.cacheRoot)}, { recursive: true });
if (fs.existsSync(".git/objects/info/alternates")) throw new Error("dependent object store");
cp.execFileSync("git", ["fsck", "--connectivity-only"], { stdio: "pipe" });
process.stdout.write(cp.execFileSync("git", ["show", "HEAD:private.txt"]));
`,
      ],
    }).done;
    expect(independent.code, independent.stderr).toBe(0);
    expect(independent.stdout).toBe("private source two\n");
    expect(existsSync(f.cacheRoot)).toBe(false);
    expect(f.fetches()).toBe(1);
  });

  it("atomically publishes concurrent cold fetches and reuses the complete winner", async () => {
    const f = fixture();
    const source = f.capsule("parallel source\n");
    mkdirSync(f.gate);
    const first = f.receive(source.value);
    const second = f.receive(source.value);
    await waitFor(
      () => readdirSync(f.gate).filter((name) => name.startsWith("ready-")).length === 2,
    );
    expect(existsSync(f.seed)).toBe(false);
    writeFileSync(join(f.gate, "release"), "");
    for (const result of await Promise.all([first.done, second.done])) {
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe("parallel source\n");
    }
    expect(f.fetches()).toBe(2);
    expect(f.cachedObject(f.base)).toBe(true);
    expect(f.cachedObject(source.value.carrier)).toBe(false);
    writeFileSync(f.blocked, "");
    const warm = await f.receive(source.value).done;
    expect(warm.code, warm.stderr).toBe(0);
    expect(f.fetches()).toBe(2);
  });

  it("never publishes an interrupted fetch and permits a fresh attempt", async () => {
    const f = fixture();
    const source = f.capsule("after interruption\n");
    mkdirSync(f.gate);
    const interrupted = f.receive(source.value);
    await waitFor(() => readdirSync(f.gate).some((name) => name.startsWith("ready-")));
    stop(interrupted);
    const stopped = await interrupted.done;
    expect(stopped.signal).toBe("SIGTERM");
    expect(stopped.stdout).toBe("");
    const phases = sourcePhases(stopped.stderr);
    expect(
      phases.some((phase) => phase.name === "public-base.fetch" && phase.status === "started"),
    ).toBe(true);
    expect(phases.some((phase) => phase.name === "payload" && phase.status === "started")).toBe(
      false,
    );
    expect(existsSync(f.seed)).toBe(false);
    writeFileSync(join(f.gate, "release"), "");
    const fresh = await f.receive(source.value, { directory: interrupted.directory }).done;
    expect(fresh.code, fresh.stderr).toBe(0);
    expect(fresh.stdout).toBe("after interruption\n");
    expect(f.fetches()).toBe(2);
    expect(f.cachedObject(source.privateBlob)).toBe(false);
  });

  it.each(["SIGINT", "SIGKILL"] as const)(
    "reuses a checkout after %s interrupts its payload without accepting unexpected source",
    async (signal) => {
      const f = fixture();
      const source = f.capsule("reused source\n");
      const ready = join(f.root, "payload-ready");
      const interrupted = f.receive(source.value, {
        command: [
          process.execPath,
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(ready)}, ""); setInterval(() => {}, 1000);`,
        ],
      });
      await waitFor(() => existsSync(ready));
      stop(interrupted, signal);
      const stopped = await interrupted.done;
      expect(stopped.signal).toBe(signal);
      expect(
        sourcePhases(stopped.stderr).some(
          (phase) => phase.name === "payload" && phase.status === "started",
        ),
      ).toBe(true);

      const resumed = await f.receive(source.value, { directory: interrupted.directory }).done;
      expect(resumed.code, resumed.stderr).toBe(0);
      expect(resumed.stdout).toBe("reused source\n");
      expect(f.git(interrupted.directory, ["rev-parse", "HEAD^{tree}"])).toBe(source.value.tree);
      expect(f.git(interrupted.directory, ["ls-files", "--others", "--exclude-standard"])).toBe("");

      const unknown = join(interrupted.directory, ".openclaw-source-unowned", "blobs");
      mkdirSync(dirname(unknown));
      writeFileSync(unknown, "unowned source must remain\n");
      const rejected = await f.receive(source.value, { directory: interrupted.directory }).done;
      expect(rejected.code).toBe(2);
      expect(rejected.stderr).toContain("unexpected source entry: .openclaw-source-unowned/blobs");
      expect(rejected.stdout).toBe("");
      expect(
        sourcePhases(rejected.stderr).some(
          (phase) => phase.name === "payload" && phase.status === "started",
        ),
      ).toBe(false);
      expect(readFileSync(unknown, "utf8")).toBe("unowned source must remain\n");
    },
  );

  it.each([
    "symlink",
    "hardlink",
    "alternates",
    "promisor",
    "corrupt-object",
    "shallow",
    "private-object",
  ] as const)(
    "rejects a %s cache alteration before payload execution without refetching",
    async (mutation) => {
      const f = fixture();
      const source = f.capsule("payload must not run\n");
      const cold = await f.receive(source.value).done;
      expect(cold.code, cold.stderr).toBe(0);
      const object = files(join(f.seed, "objects")).find((file) => !file.endsWith(".idx"));
      if (!object) {
        throw new Error("Fixture lacks a public Git object to alter");
      }
      if (mutation === "symlink" || mutation === "hardlink") {
        const outside = join(f.root, "outside-object");
        copyFileSync(object, outside);
        rmSync(object);
        if (mutation === "symlink") {
          symlinkSync(outside, object);
        } else {
          linkSync(outside, object);
        }
      } else if (mutation === "alternates") {
        mkdirSync(join(f.seed, "objects", "info"), { recursive: true });
        writeFileSync(
          join(f.seed, "objects", "info", "alternates"),
          join(source.value.directory, ".git", "objects") + "\n",
        );
      } else if (mutation === "promisor") {
        mkdirSync(join(f.seed, "objects", "pack"), { recursive: true });
        writeFileSync(join(f.seed, "objects", "pack", `pack-${"a".repeat(40)}.promisor`), "");
      } else if (mutation === "corrupt-object") {
        chmodSync(object, 0o600);
        writeFileSync(object, "corrupted object\n");
      } else if (mutation === "shallow") {
        chmodSync(join(f.seed, "shallow"), 0o600);
        writeFileSync(join(f.seed, "shallow"), f.base + "\n");
      } else {
        const relativeObject = join(source.privateBlob.slice(0, 2), source.privateBlob.slice(2));
        const destination = join(f.seed, "objects", relativeObject);
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(join(source.value.directory, ".git", "objects", relativeObject), destination);
      }
      writeFileSync(f.blocked, "");
      const rejected = await f.receive(source.value).done;
      expect(rejected.code).toBe(2);
      expect(rejected.stderr).toContain("source verification failed:");
      expect(rejected.stdout).toBe("");
      expect(
        sourcePhases(rejected.stderr).some(
          (phase) => phase.name === "payload" && phase.status === "started",
        ),
      ).toBe(false);
      expect(f.fetches()).toBe(1);
    },
  );

  it("skips hydration only when explicitly requested and retains the selected installer otherwise", async () => {
    const f = fixture();
    const marker = join(f.root, "installed");
    const source = f.capsule("selected source\n", {
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      ".github/actions/setup-node-env/install-dependencies.sh": `#!/usr/bin/env bash\nprintf installed > '${marker}'\n`,
    });
    const skipped = await f.receive(source.value).done;
    expect(skipped.code, skipped.stderr).toBe(0);
    expect(existsSync(marker)).toBe(false);
    const installed = await f.receive(source.value, { install: "default" }).done;
    expect(installed.code, installed.stderr).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("installed");
    expect(installed.stderr).toContain("reconciling selected-source dependencies");
  });

  it("propagates payload failure and rejects source edits after a failing payload", async () => {
    const f = fixture();
    const source = f.capsule("immutable source\n");
    const failed = await f.receive(source.value, {
      command: [process.execPath, "-e", "process.exitCode = 7"],
    }).done;
    expect(failed.code, failed.stderr).toBe(7);
    const changed = await f.receive(source.value, {
      command: [
        process.execPath,
        "-e",
        'require("node:fs").writeFileSync("private.txt", "changed"); process.exitCode = 7',
      ],
    }).done;
    expect(changed.code).toBe(2);
    expect(changed.stderr).toContain("source bytes mismatch: private.txt");
  });

  it("refuses Testbox public-cache requests before constructing a remote command", () => {
    const f = fixture();
    const source = f.capsule("source\n");
    expect(() =>
      remoteSourceBootstrap(source.value, "", true, {
        publicBaseCacheRoot: f.cacheRoot,
      }),
    ).toThrow("limited to trusted SSH remote checks");
  });

  it("keeps callers without a cache request on canonical per-run acquisition", async () => {
    const f = fixture();
    const source = f.capsule("uncached source\n");
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await f.receive(source.value, { cache: false }).done;
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toBe("uncached source\n");
      expect(result.stderr).not.toContain("OPENCLAW_SOURCE_PHASE");
    }
    expect(f.fetches()).toBe(2);
    expect(existsSync(f.cacheRoot)).toBe(false);
  });
});
