#!/usr/bin/env node
import { execFileSync, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  appendFileSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, posix, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ensureManagedCrabboxBinary } from "../extensions/crabbox/cli-runtime-api.js";
import {
  prepareCrabboxSourceCapsule,
  type CrabboxSourceCapsule,
} from "./crabbox-source-capsule.mts";
import { remoteSourceBootstrap } from "./crabbox-source-receiver.mts";
import { gitSourceEnvironment } from "./lib/git-source-environment.mts";
import { finalizeManagedChild, loadManagedChildSpawner } from "./lib/managed-child-process.mts";

const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(toolRoot, ".crabbox.remote.yaml");
const identifier = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u);
const targetSchema = z
  .object({
    id: identifier,
    host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/u),
    user: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/u),
    port: z.number().int().min(1).max(65535).default(22),
    workRoot: z
      .string()
      .startsWith("/")
      .refine((value) => value !== "/" && !value.includes("\0")),
  })
  .strict();
const registrySchema = z
  .object({ version: z.literal(1), targets: z.array(targetSchema).min(1) })
  .strict();
const jobSchema = z
  .object({
    id: identifier,
    source: z.string().min(1),
    base: z.string().min(1).optional(),
    target: identifier,
    lane: z.union([z.literal(1), z.literal(2)]).default(1),
    profile: z.enum(["parallel", "exclusive"]),
    timeoutSeconds: z.number().int().min(1).max(21600).default(1800),
    kind: z.enum(["check", "install", "build", "full-types"]).default("check"),
    argv: z.array(z.string().refine((value) => !value.includes("\0"))).min(1),
    dependsOn: z.array(identifier).default([]),
  })
  .strict();
const manifestSchema = z
  .object({ version: z.literal(1), jobs: z.array(jobSchema).min(1).max(256) })
  .strict();
const receiptSchema = z.object({
  status: z.enum(["completed", "failed", "admission-refused", "unknown"]),
  exitCode: z.number().int().min(0).max(255),
  commandStarted: z.boolean(),
  cleanupConfirmed: z.boolean(),
  unit: z.string(),
});
type Target = z.infer<typeof targetSchema>;
type Job = z.infer<typeof jobSchema>;
type Receipt = z.infer<typeof receiptSchema>;
type Status = "QUEUED" | "RUNNING" | "PASS" | "FAIL" | "SKIPPED" | "UNKNOWN";
type Source = { root: string; sourceSha: string; baseSha: string; needsInstall: boolean };
type Attempt = {
  startedAt: string;
  endedAt?: string;
  log: string;
  callerExit?: number | null;
  signal?: string | null;
  remoteExit?: number;
  transportTimedOut?: boolean;
  localCleanupConfirmed?: boolean;
  receipt?: Receipt;
  timing?: Record<string, unknown>;
};
type Result = Job & {
  status: Status;
  reason?: string;
  lease: string;
  attempts: Attempt[];
  queuedAt: string;
};
type Lane = {
  lease: string;
  target: Target;
  source: Source;
  capsule?: CrabboxSourceCapsule;
  ready: boolean;
  unknown: boolean;
};

const env = gitSourceEnvironment();
for (const key of Object.keys(env)) {
  if (key.startsWith("CRABBOX_") || key.startsWith("OPENCLAW_CRABBOX_")) {
    delete env[key];
  }
}
Object.assign(env, {
  CRABBOX_CONFIG: configPath,
  CRABBOX_PROVIDER: "ssh",
  CRABBOX_TARGET: "linux",
  CRABBOX_ENV_ALLOW: "CI",
  OPENCLAW_CRABBOX_WRAPPER_IGNORE_REPO_BINARY: "1",
});
function git(root: string, args: string[]) {
  return execFileSync("git", ["-C", root, ...args], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function readJson(file: string) {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}
function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
function hash(bytes: string | Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}
function sourceInfo(job: Job): Source {
  if (!isAbsolute(job.source)) {
    throw new Error(`${job.id}: source must be an absolute Git top-level`);
  }
  const root = realpathSync(job.source);
  if (realpathSync(git(root, ["rev-parse", "--show-toplevel"])) !== root) {
    throw new Error(`${job.id}: source must be the Git top-level`);
  }
  let baseSha = "";
  if (job.base) {
    baseSha = git(root, ["rev-parse", "--verify", `${job.base}^{commit}`]);
  } else {
    for (const base of ["refs/remotes/upstream/main", "refs/remotes/origin/main"]) {
      try {
        baseSha = git(root, ["merge-base", "HEAD", base]);
        break;
      } catch {
        /* Try the next existing comparison ref. */
      }
    }
    if (!baseSha) {
      throw new Error(`${job.id}: specify a public upstream --base in the manifest`);
    }
  }
  if (!/^[a-f0-9]{40}$/u.test(baseSha)) {
    throw new Error(`${job.id}: base requires a full SHA-1 commit`);
  }
  return {
    root,
    sourceSha: git(root, ["rev-parse", "HEAD"]),
    baseSha,
    needsInstall: existsSync(join(root, "pnpm-lock.yaml")),
  };
}
function keyFor(job: Job) {
  return JSON.stringify([job.target, job.source, job.base, job.lane]);
}
function sourceKey(source: Source) {
  return JSON.stringify([source.root, source.baseSha]);
}
function targetEnv(target: Target, lease: string) {
  return {
    ...env,
    CRABBOX_STATIC_HOST: target.host,
    CRABBOX_STATIC_PORT: String(target.port),
    CRABBOX_STATIC_USER: target.user,
    CRABBOX_STATIC_WORK_ROOT: target.workRoot,
    CRABBOX_STATIC_ID: lease,
    CRABBOX_STATIC_NAME: lease,
  };
}
function parseArgs() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes("--help")) {
    console.log(
      "Usage: node scripts/remote-checks.mjs plan|run --registry <json> --manifest <json> [--results <new-directory>] [--wait-seconds 900]\nplan/--dry-run does not contact targets. run executes trusted source only, inside existing dedicated cgroup limits.",
    );
    return null;
  }
  let mode = args.shift();
  const options = new Map<string, string>();
  while (args.length) {
    const option = args.shift()!;
    if (option === "--dry-run") {
      mode = "plan";
      continue;
    }
    if (
      !["--registry", "--manifest", "--results", "--wait-seconds"].includes(option) ||
      options.has(option)
    ) {
      throw new Error(`unknown or repeated option: ${option}`);
    }
    const value = args.shift();
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for ${option}`);
    }
    options.set(option, value);
  }
  if (
    !["plan", "run"].includes(mode ?? "") ||
    !options.has("--registry") ||
    !options.has("--manifest")
  ) {
    throw new Error("supply plan|run, --registry, and --manifest; see --help");
  }
  const waitSeconds = Number(options.get("--wait-seconds") ?? "900");
  if (!Number.isInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > 86400) {
    throw new Error("--wait-seconds must be 1..86400");
  }
  if (mode === "run" && !options.has("--results")) {
    throw new Error("run requires a new --results directory");
  }
  return {
    mode,
    registry: options.get("--registry")!,
    manifest: options.get("--manifest")!,
    results: options.get("--results"),
    waitSeconds,
  };
}
function preparePlan(registryFile: string, manifestFile: string) {
  const registry = registrySchema.parse(readJson(registryFile));
  const manifest = manifestSchema.parse(readJson(manifestFile));
  const targets = new Map(registry.targets.map((target) => [target.id, target]));
  const jobs = new Map(manifest.jobs.map((job) => [job.id, job]));
  if (targets.size !== registry.targets.length || jobs.size !== manifest.jobs.length) {
    throw new Error("target and job ids must be unique");
  }
  const sources = new Map<string, Source>();
  for (const job of manifest.jobs) {
    if (!targets.has(job.target)) {
      throw new Error(`${job.id}: unknown target ${job.target}`);
    }
    if (!job.argv[0]) {
      throw new Error(`${job.id}: argv requires a command`);
    }
    if (
      job.profile !== "exclusive" &&
      (job.kind !== "check" ||
        job.argv.some((arg) => /^(install|build|check|check:types)$/u.test(arg)))
    ) {
      throw new Error(`${job.id}: install, build, and full graphs require the exclusive profile`);
    }
    const source = sourceInfo(job);
    job.source = source.root;
    job.base = source.baseSha;
    sources.set(sourceKey(source), source);
    for (const dep of job.dependsOn) {
      if (!jobs.has(dep)) {
        throw new Error(`${job.id}: unknown dependency ${dep}`);
      }
    }
  }
  function ancestors(job: Job, visiting = new Set<string>()): Set<string> {
    if (visiting.has(job.id)) {
      throw new Error(`dependency cycle at ${job.id}`);
    }
    const result = new Set<string>();
    for (const id of job.dependsOn) {
      result.add(id);
      for (const ancestor of ancestors(jobs.get(id)!, new Set([...visiting, job.id]))) {
        result.add(ancestor);
      }
    }
    return result;
  }
  for (const job of manifest.jobs) {
    const dependencies = ancestors(job);
    const source = sources.get(JSON.stringify([job.source, job.base]))!;
    if (
      source.needsInstall &&
      job.kind !== "install" &&
      ![...dependencies].some((id) => {
        const dep = jobs.get(id)!;
        return dep.kind === "install" && keyFor(dep) === keyFor(job);
      })
    ) {
      throw new Error(`${job.id}: depend on a passing install job for this source/target/lane`);
    }
  }
  return { targets, sources, jobs: manifest.jobs };
}
function toolingIdentity() {
  const files = [
    "scripts/remote-checks.mjs",
    "scripts/remote-checks.mts",
    "extensions/crabbox/cli-runtime-api.ts",
    "extensions/crabbox/src/crabbox-managed-binary.ts",
    "scripts/crabbox-source-capsule.mts",
    "scripts/crabbox-source-receiver.mts",
    "scripts/lib/git-source-environment.mts",
    "scripts/lib/managed-child-process.mts",
    "scripts/run-bounded.sh",
    ".crabbox.remote.yaml",
  ];
  return {
    root: toolRoot,
    sha: git(toolRoot, ["rev-parse", "HEAD"]),
    files: Object.fromEntries(
      files.map((file) => [file, hash(readFileSync(join(toolRoot, file)))]),
    ),
  };
}
async function crabboxBinary() {
  const candidate = (env.PATH ?? "")
    .split(delimiter)
    .map((dir) => join(dir, "crabbox"))
    .find((file) => {
      try {
        accessSync(file, constants.X_OK);
        return statSync(file).isFile();
      } catch {
        return false;
      }
    });
  return ensureManagedCrabboxBinary({ binary: candidate, env });
}
function remoteScript(
  capsule: CrabboxSourceCapsule,
  job: Job,
  target: Target,
  token: string,
  bounded: string,
  lease: string,
) {
  const bootstrap = remoteSourceBootstrap(capsule, "", false, {
    install: "none",
    command: job.argv,
    publicBaseCacheRoot: posix.join(target.workRoot, ".openclaw-public-bases", "v1"),
    ownedStagingParent: posix.join(target.workRoot, lease),
  });
  const receiver = `#!/usr/bin/env bash\nset -euo pipefail\nexport OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1 OPENCLAW_CHANGED_LANES_RAW_SYNC=1 CI=1\n${bootstrap}\n`;
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "umask 077",
    "command -v timeout >/dev/null",
    'task_dir=$(mktemp -d "${XDG_RUNTIME_DIR:?}/openclaw-remote.XXXXXXXX")',
    "trap 'rm -rf -- \"$task_dir\"' EXIT",
    `printf %s ${quote(Buffer.from(bounded).toString("base64"))} | base64 -d > "$task_dir/bounded.sh"`,
    `printf %s ${quote(Buffer.from(receiver).toString("base64"))} | base64 -d > "$task_dir/receiver.sh"`,
    "code=0",
    `bash "$task_dir/bounded.sh" --profile ${job.profile === "parallel" ? "dedicated-test" : "dedicated-heavy"} --receipt "$task_dir/receipt.json" -- timeout --signal=TERM --kill-after=10s ${job.timeoutSeconds}s bash "$task_dir/receiver.sh" || code=$?`,
    `node -e ${quote('const fs=require("node:fs");const receipt=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write("OPENCLAW_REMOTE_RESULT "+JSON.stringify({token:process.argv[2],receipt})+"\\n");')} "$task_dir/receipt.json" ${quote(token)}`,
    'exit "$code"',
    "",
  ].join("\n");
}

async function runBatch(
  options: NonNullable<ReturnType<typeof parseArgs>>,
  plan: ReturnType<typeof preparePlan>,
) {
  const resultsRoot = resolve(options.results!);
  mkdirSync(resultsRoot, { mode: 0o700 });
  const batchId = randomUUID();
  const tooling = toolingIdentity();
  const bounded = readFileSync(join(toolRoot, "scripts/run-bounded.sh"), "utf8");
  const crabbox = await crabboxBinary();
  const spawnManagedChild = await loadManagedChildSpawner();
  const frozenConfig = join(resultsRoot, "crabbox.yaml");
  writeFileSync(frozenConfig, readFileSync(configPath), { flag: "wx", mode: 0o600 });
  env.CRABBOX_CONFIG = frozenConfig;
  const queuedAt = new Date().toISOString();
  const capsules = new Map<string, CrabboxSourceCapsule>();
  const lanes = new Map<string, Lane>();
  const results: Result[] = plan.jobs.map((job) => {
    const key = keyFor(job);
    if (!lanes.has(key)) {
      const source = plan.sources.get(JSON.stringify([job.source, job.base]))!;
      lanes.set(key, {
        lease: `oc-checks-${batchId.replaceAll("-", "")}-${lanes.size + 1}`,
        target: plan.targets.get(job.target)!,
        source,
        ready: !source.needsInstall,
        unknown: false,
      });
    }
    return { ...job, queuedAt, status: "QUEUED", lease: lanes.get(key)!.lease, attempts: [] };
  });
  const children = new Map<ChildProcess, () => void>();
  let interrupted = false;
  function interrupt() {
    interrupted = true;
    for (const cancel of children.values()) {
      cancel();
    }
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, interrupt);
  }
  function save() {
    const report = {
      version: 1,
      batchId,
      queuedAt,
      updatedAt: new Date().toISOString(),
      tooling,
      crabbox,
      targets: [...plan.targets.values()],
      sources: [...capsules].map(([key, value]) => ({
        key,
        sourceSha: value.sourceSha,
        baseSha: value.baseSha,
        tree: value.tree,
        digest: value.digest,
        directory: value.directory,
      })),
      lanes: [...lanes.values()].map(({ lease, target, source, unknown }) => ({
        lease,
        target: target.id,
        source: source.root,
        unknown,
        leaseDisposition: "retained",
      })),
      jobs: results,
    };
    writeFileSync(join(resultsRoot, "results.json.tmp"), JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
    });
    renameSync(join(resultsRoot, "results.json.tmp"), join(resultsRoot, "results.json"));
  }
  async function invoke(
    args: string[],
    lane: Lane,
    log: string,
    token?: string,
    timeoutSeconds = 60,
  ) {
    writeFileSync(log, "", { flag: "wx", mode: 0o600 });
    const receipts = new Map<string, Receipt>();
    let timing: Record<string, unknown> | undefined;
    // The native CLI owns transport; the receiver owns the already-frozen source.
    // A tooling-root wrapper would resync the wrong checkout or build a second capsule.
    const child = spawnManagedChild(crabbox.binary, args, {
      cwd: lane.capsule!.directory,
      env: targetEnv(lane.target, lane.lease),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let transportTimedOut = false;
    let localCleanupConfirmed = false;
    let cleanupFailed = false;
    let settlement: Promise<void> | undefined;
    const settle = (signal?: NodeJS.Signals) =>
      (settlement ??= finalizeManagedChild(child, signal, {
        platform: process.platform,
        runTaskkill: spawnSync,
        forceKillDelayMs: 15000,
        onTerminated: () => {
          localCleanupConfirmed = true;
        },
      }).catch((error: unknown) => {
        cleanupFailed = true;
        appendFileSync(log, `[remote-checks] local cleanup unconfirmed: ${String(error)}\n`);
      }));
    const cancel = () => {
      void settle("SIGTERM");
    };
    children.set(child, cancel);
    const deadline = setTimeout(() => {
      transportTimedOut = true;
      cancel();
    }, timeoutSeconds * 1000);
    for (const stream of [child.stdout, child.stderr]) {
      let pending = "";
      stream!.setEncoding("utf8");
      stream!.on("data", (text: string) => {
        appendFileSync(log, text);
        pending += text;
        for (;;) {
          const newline = pending.indexOf("\n");
          if (newline < 0) {
            break;
          }
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          try {
            if (token && line.startsWith("OPENCLAW_REMOTE_RESULT ")) {
              const parsed: unknown = JSON.parse(line.slice("OPENCLAW_REMOTE_RESULT ".length));
              const event = z
                .object({ token: z.literal(token), receipt: receiptSchema })
                .safeParse(parsed);
              if (event.success) {
                const receipt = event.data.receipt;
                receipts.set(JSON.stringify(receipt), receipt);
              }
            } else if (line.startsWith("{")) {
              const parsed: unknown = JSON.parse(line);
              const event = z
                .object({
                  provider: z.literal("ssh"),
                  exitCode: z.number().int(),
                  leaseId: z.string().optional(),
                })
                .passthrough()
                .safeParse(parsed);
              if (event.success && (!event.data.leaseId || event.data.leaseId === lane.lease)) {
                timing = event.data;
              }
            }
          } catch {
            /* Command output is not necessarily structured telemetry. */
          }
        }
        if (pending.length > 1024 * 1024) {
          pending = "";
        }
      });
    }
    const exit = await new Promise<{ code: number | null; signal: string | null }>((done) => {
      child.once("error", (error) => {
        appendFileSync(log, String(error) + "\n");
        done({ code: null, signal: null });
      });
      child.once("exit", (code, signal) => done({ code, signal }));
    });
    clearTimeout(deadline);
    await settle();
    children.delete(child);
    return {
      ...exit,
      transportTimedOut,
      localCleanupConfirmed: localCleanupConfirmed && !cleanupFailed,
      receipt: receipts.size === 1 ? receipts.values().next().value : undefined,
      timing,
    };
  }
  const retryAt = new Map<string, number>();
  const admissionDeadline = new Map<string, number>();
  const active = new Map<string, Promise<void>>();
  const byId = new Map(results.map((result) => [result.id, result]));
  try {
    save();
    // Freeze all sources before dispatch; later edits cannot enter an active batch.
    for (const source of plan.sources.values()) {
      const capsule = prepareCrabboxSourceCapsule({
        repoRoot: source.root,
        env,
        syncRoot: join(resultsRoot, "sources"),
        base: source.baseSha,
        syncPlan: {
          command: crabbox.binary,
          args: ["sync-plan", "--json", "--limit", "2147483647"],
        },
      });
      capsules.set(sourceKey(source), capsule);
    }
    for (const lane of lanes.values()) {
      lane.capsule = capsules.get(sourceKey(lane.source))!;
    }
    for (const [key, capsule] of capsules) {
      if (capsule.staging.recorded) {
        capsule.staging.admitted(
          undefined,
          [...lanes.values()]
            .filter((lane) => sourceKey(lane.source) === key)
            .map((lane) => lane.lease),
        );
      }
    }
    save();
    async function execute(result: Result) {
      const lane = lanes.get(keyFor(result))!;
      const attempt: Attempt = {
        startedAt: new Date().toISOString(),
        log: join(resultsRoot, `${result.id}.${result.attempts.length + 1}.log`),
      };
      result.attempts.push(attempt);
      result.status = "RUNNING";
      const token = randomUUID();
      const script = join(resultsRoot, `${result.id}.${result.attempts.length}.sh`);
      writeFileSync(
        script,
        remoteScript(lane.capsule!, result, lane.target, token, bounded, lane.lease),
        {
          flag: "wx",
          mode: 0o600,
        },
      );
      save();
      console.error(
        `[remote-checks] ${result.id} target=${result.target} lane=${result.lane} profile=${result.profile}`,
      );
      const response = await invoke(
        [
          "run",
          "--provider",
          "ssh",
          "--target",
          "linux",
          "--no-hydrate",
          "--stop-after",
          "never",
          "--timing-json",
          "--label",
          `${result.id}:${token}`,
          "--script",
          script,
        ],
        lane,
        attempt.log,
        token,
        result.timeoutSeconds + 120,
      );
      Object.assign(attempt, {
        endedAt: new Date().toISOString(),
        callerExit: response.code,
        signal: response.signal,
        transportTimedOut: response.transportTimedOut,
        localCleanupConfirmed: response.localCleanupConfirmed,
        receipt: response.receipt,
        timing: response.timing,
        remoteExit: response.receipt?.exitCode ?? response.timing?.exitCode,
      });
      const receipt = response.receipt;
      if (
        interrupted ||
        response.transportTimedOut ||
        response.signal ||
        !response.localCleanupConfirmed ||
        !receipt ||
        !receipt.cleanupConfirmed ||
        receipt.status === "unknown"
      ) {
        lane.unknown = true;
        result.status = "UNKNOWN";
        result.reason =
          "execution or scope cleanup is unconfirmed; retain this lane for owner inspection";
      } else if (
        receipt.status === "admission-refused" &&
        !receipt.commandStarted &&
        receipt.exitCode === 75 &&
        [1, 75].includes(response.code ?? -1) &&
        response.timing?.exitCode === 75
      ) {
        const deadline =
          admissionDeadline.get(result.id) ?? Date.now() + options.waitSeconds * 1000;
        admissionDeadline.set(result.id, deadline);
        if (Date.now() >= deadline) {
          result.status = "FAIL";
          result.reason = "admission wait expired without starting the command";
        } else {
          result.status = "QUEUED";
          retryAt.set(result.id, Date.now() + 1000);
        }
      } else if (
        receipt.status === "completed" &&
        receipt.commandStarted &&
        receipt.exitCode === 0 &&
        response.code === 0
      ) {
        result.status = "PASS";
        if (result.kind === "install") {
          lane.ready = true;
        }
      } else {
        result.status = "FAIL";
        result.reason = "command or source verification failed; no automatic retry";
      }
      save();
    }
    while (results.some((result) => result.status === "QUEUED") || active.size) {
      const blockedTargets = new Set<string>();
      for (const result of results) {
        if (result.status !== "QUEUED") {
          continue;
        }
        const lane = lanes.get(keyFor(result))!;
        const dependencies = result.dependsOn.map((id) => byId.get(id)!);
        if (
          interrupted ||
          [...lanes.values()].some((other) => other.target.id === result.target && other.unknown) ||
          dependencies.some((dep) => ["FAIL", "UNKNOWN", "SKIPPED"].includes(dep.status))
        ) {
          result.status = "SKIPPED";
          result.reason = "interrupted, target uncertain, or dependency did not pass";
          save();
          continue;
        }
        if (
          dependencies.some((dep) => dep.status !== "PASS") ||
          (retryAt.get(result.id) ?? 0) > Date.now()
        ) {
          continue;
        }
        if (blockedTargets.has(result.target)) {
          continue;
        }
        const running = results.filter(
          (other) => other.status === "RUNNING" && other.target === result.target,
        );
        if (
          running.some((other) => keyFor(other) === keyFor(result)) ||
          running.some((other) => other.profile === "exclusive") ||
          (result.profile === "exclusive" ? running.length > 0 : running.length >= 2)
        ) {
          if (result.profile === "exclusive") {
            blockedTargets.add(result.target);
          }
          continue;
        }
        if (result.kind !== "install" && !lane.ready) {
          result.status = "SKIPPED";
          result.reason = "lane dependencies were not installed";
          save();
          continue;
        }
        const task = execute(result)
          .catch((error: unknown) => {
            lane.unknown = true;
            result.status = "UNKNOWN";
            result.reason = String(error);
            save();
          })
          .finally(() => active.delete(result.id));
        active.set(result.id, task);
      }
      if (active.size) {
        await Promise.race([...active.values(), delay(1000)]);
      } else if (results.some((result) => result.status === "QUEUED")) {
        await delay(1000);
      }
    }
    // SSH provider stop can terminate host-wide egress workers on shared targets.
    // Keep static lease records; each command receipt owns scope cleanup.
  } finally {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.off(signal, interrupt);
    }
    for (const [key, capsule] of capsules) {
      const sourceLanes = [...lanes.values()].filter((lane) => sourceKey(lane.source) === key);
      if (sourceLanes.some((lane) => lane.unknown)) {
        capsule.staging.hold("writers");
      } else {
        capsule.staging.settled(sourceLanes.map((lane) => lane.lease));
        capsule.cleanup();
      }
    }
    save();
  }
  console.log(
    JSON.stringify({
      batchId,
      results: join(resultsRoot, "results.json"),
      jobs: results.map(({ id, status }) => ({ id, status })),
    }),
  );
  return results.every((result) => result.status === "PASS") &&
    [...lanes.values()].every((lane) => !lane.unknown)
    ? 0
    : 1;
}

try {
  const options = parseArgs();
  if (options) {
    const plan = preparePlan(options.registry, options.manifest);
    if (options.mode === "plan") {
      console.log(
        JSON.stringify(
          {
            version: 1,
            targets: [...plan.targets.values()],
            sources: [...plan.sources.values()],
            jobs: plan.jobs,
            policy: {
              parallel: { slots: 2, memoryGiB: 6 },
              exclusive: { slots: 1, memoryGiB: 14 },
              parentMemoryGiB: 16,
              swap: 0,
            },
            tooling: toolingIdentity(),
          },
          null,
          2,
        ),
      );
    } else {
      process.exitCode = await runBatch(options, plan);
    }
  }
} catch (error) {
  console.error(`[remote-checks] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
