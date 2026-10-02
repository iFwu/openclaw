import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

const root = process.cwd();
const cli = join(root, "scripts/remote-checks.mjs");
type Job = {
  id: string;
  source: string;
  target: string;
  lane?: number;
  profile: string;
  kind?: "check" | "install" | "build" | "full-types";
  argv: string[];
  dependsOn?: string[];
};
type Report = {
  jobs: Array<{
    id: string;
    status: string;
    attempts: Array<{ callerExit: number; remoteExit: number; localCleanupConfirmed: boolean }>;
  }>;
  sources: Array<{ sourceSha: string; tree: string; digest: string }>;
  lanes: Array<{ lease: string; unknown: boolean }>;
};
type Event = {
  type: string;
  id: string;
  lease: string;
  host: string;
  owner?: string;
  secret?: boolean;
  at: number;
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "openclaw-remote-checks-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    REMOTE_FIXTURE: dir,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const git = (cwd: string, args: string[], input?: string) =>
    execFileSync("git", ["-C", cwd, ...args], { env, encoding: "utf8", input }).trim();
  const source = join(dir, "candidate");
  mkdirSync(source);
  git(source, ["init", "--quiet", "--initial-branch=main", "--template="]);
  writeFileSync(join(source, "owner.txt"), "committed source\n");
  writeFileSync(join(source, "fixture.mjs"), "process.exitCode = 0;\n");
  writeFileSync(join(source, ".gitignore"), ".env\n");
  git(source, ["add", "."]);
  const sha = git(source, ["commit-tree", git(source, ["write-tree"])], "Fixture\n");
  git(source, ["update-ref", "HEAD", sha]);
  git(source, ["update-ref", "refs/remotes/origin/main", sha]);
  git(source, ["remote", "add", "origin", source]);
  writeFileSync(join(source, "owner.txt"), "uncommitted reviewed source\n");
  writeFileSync(join(source, ".env"), "synthetic private configuration\n");
  writeFileSync(join(source, "private.secret"), "synthetic excluded candidate\n");
  const fake = join(bin, "crabbox");
  writeFileSync(
    fake,
    String.raw`#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const args = process.argv.slice(2), root = process.env.REMOTE_FIXTURE;
const option = (name) => args[args.indexOf("--" + name) + 1];
const event = (value) => fs.appendFileSync(path.join(root, "events"), JSON.stringify({...value, at:Date.now(), lease:process.env.CRABBOX_STATIC_ID,host:process.env.CRABBOX_STATIC_HOST})+"\n");
async function main() {
  if(args[0] === "--version") return console.log("crabbox 0.67.0");
  if(args[0] === "run" && args[1] === "--help") return console.log("provider: ssh\n  -provider string\n  -target string\n  -script string\n  -label string\n  -stop-after string\n  -id string\n  -no-hydrate\n  -timing-json");
  if(args[0] === "config") return console.log(JSON.stringify({provider:"ssh",target:"linux"}));
  if(args[0] === "sync-plan") {
    const files=cp.execFileSync("git",["ls-files","--cached","--others","--exclude-standard","-z"],{encoding:"utf8"}).split("\0").filter(Boolean);
    const selected=[...new Set(files)].filter(file=>!file.endsWith(".secret") && fs.existsSync(file) && !fs.lstatSync(file).isDirectory());
    return console.log(JSON.stringify({candidate:{files:selected.length},topFiles:selected.map(path=>({path}))}));
  }
  if(args[0] === "stop") { event({type:"stop",id:"stop"}); return; }
  if(args[0] !== "run") throw new Error("unexpected Crabbox command " + args[0]);
  const label=option("label"), id=label.slice(0,label.indexOf(":")), token=label.slice(label.indexOf(":")+1);
  const payload=JSON.parse(fs.readFileSync(path.join(root,"jobs.json"),"utf8")).jobs.find(job=>job.id===id).argv, scenario=payload[2];
  event({type:"start",id,owner:fs.readFileSync("owner.txt","utf8"),secret:fs.existsSync(".env") || fs.existsSync("private.secret")});
  const count=path.join(root,"count-"+id); const attempt=fs.existsSync(count)?Number(fs.readFileSync(count,"utf8"))+1:1; fs.writeFileSync(count,String(attempt));
  if(scenario === "overlap") {
    fs.writeFileSync(path.join(root,"ready-"+id), "");
    const deadline=Date.now()+5000;
    while(!fs.existsSync(path.join(root,"ready-first")) || !fs.existsSync(path.join(root,"ready-second"))) {
      if(Date.now()>deadline) throw new Error("second remote command never overlapped");
      await new Promise(done=>setTimeout(done,10));
    }
  }
  if(scenario === "local-orphan") {
    cp.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio:"inherit"}).unref();
  }
  const refused=scenario === "admission-once" && attempt === 1;
  const exitCode=refused || scenario === "business75" ? 75 : 0;
  if(scenario !== "missing-receipt") {
    const evidence = "OPENCLAW_REMOTE_RESULT " + JSON.stringify({token,receipt:{status:scenario==="unknown-receipt"?"unknown":refused?"admission-refused":exitCode?"failed":"completed",exitCode,commandStarted:!refused,cleanupConfirmed:scenario!=="unclean-receipt",unit:refused?"":"fixture.scope"}});
    console.log(evidence);
    if(scenario === "business75") console.error(evidence);
    if(scenario === "conflicting-receipts") console.error(evidence.replace("fixture.scope", "different.scope"));
  }
  console.error(JSON.stringify({provider:"ssh",leaseId:process.env.CRABBOX_STATIC_ID,exitCode}));
  event({type:"end",id});
  process.exitCode=exitCode?1:0;
}
main().catch(error=>{console.error(error);process.exitCode=1;});
`,
  );
  chmodSync(fake, 0o700);
  const registry = join(dir, "targets.json");
  writeFileSync(
    registry,
    JSON.stringify({
      version: 1,
      targets: [
        { id: "one", host: "host-one", user: "fixture", workRoot: "/work/checks" },
        { id: "two", host: "host-two", user: "fixture", workRoot: "/work/checks" },
      ],
    }),
  );
  const job = (id: string, scenario = "success", overrides: Partial<Job> = {}): Job => ({
    id,
    source,
    target: "one",
    lane: 1,
    profile: "parallel",
    argv: ["node", "fixture.mjs", scenario, id],
    ...overrides,
  });
  const run = (jobs: Job[], mode = "run", extraEnv: NodeJS.ProcessEnv = {}) => {
    const manifest = join(dir, "jobs.json");
    writeFileSync(manifest, JSON.stringify({ version: 1, jobs }));
    const results = join(dir, "results");
    const result = spawnSync(
      process.execPath,
      [
        cli,
        mode,
        "--registry",
        registry,
        "--manifest",
        manifest,
        "--results",
        results,
        "--wait-seconds",
        "2",
      ],
      { cwd: root, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 20_000 },
    );
    const report = existsSync(join(results, "results.json"))
      ? (JSON.parse(readFileSync(join(results, "results.json"), "utf8")) as Report)
      : undefined;
    return { result, report };
  };
  const events = () =>
    existsSync(join(dir, "events"))
      ? readFileSync(join(dir, "events"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Event)
      : [];
  return { dir, source, sha, job, run, events };
}

describe("remote-checks public CLI", () => {
  it("plans explicit source roots without contacting targets and rejects dependency cycles", () => {
    const f = fixture();
    const planned = f.run([f.job("first")], "plan", { GIT_DIR: "/missing/inherited-git-dir" });
    expect(planned.result.status, planned.result.stderr).toBe(0);
    expect(JSON.parse(planned.result.stdout).sources[0]).toMatchObject({
      root: f.source,
      sourceSha: f.sha,
    });
    expect(f.events()).toEqual([]);
    const cyclic = f.run(
      [
        f.job("first", "success", { dependsOn: ["second"] }),
        f.job("second", "success", { dependsOn: ["first"] }),
      ],
      "plan",
    );
    expect(cyclic.result.status).toBe(2);
    expect(cyclic.result.stderr).toContain("dependency cycle");
    writeFileSync(join(f.source, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    const unprepared = f.run([f.job("unprepared")], "plan");
    expect(unprepared.result.status).toBe(2);
    expect(unprepared.result.stderr).toContain("passing install job");
    expect(f.events()).toEqual([]);
  });

  it.each(["install", "build", "full-types"] as const)(
    "rejects parallel %s jobs without contacting targets",
    (kind) => {
      const f = fixture();
      const rejected = f.run([f.job("heavy", "success", { kind })], "plan");
      expect(rejected.result.status).toBe(2);
      expect(rejected.result.stderr).toContain("require the exclusive profile");
      expect(f.events()).toEqual([]);
    },
  );

  it("overlaps source lanes, then admits an exclusive job, using distinct privacy-filtered dirty snapshots", () => {
    const f = fixture();
    const secondSource = join(f.dir, "second-candidate");
    execFileSync("git", ["clone", "--quiet", "--no-hardlinks", f.source, secondSource]);
    writeFileSync(join(secondSource, "owner.txt"), "second reviewed source\n");
    const { result, report } = f.run(
      [
        f.job("first", "overlap"),
        f.job("second", "overlap", { source: secondSource, lane: 2 }),
        f.job("heavy", "success", { profile: "exclusive" }),
      ],
      "run",
      { GIT_DIR: "/missing/inherited-git-dir", GIT_WORK_TREE: "/missing/inherited-work-tree" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(report?.jobs.map((job) => job.status)).toEqual(["PASS", "PASS", "PASS"]);
    expect(
      report?.jobs.every((job) => job.attempts.every((attempt) => attempt.localCleanupConfirmed)),
    ).toBe(true);
    expect(report?.sources[0]).toMatchObject({
      sourceSha: f.sha,
      tree: expect.stringMatching(/^[a-f0-9]{40}$/u),
      digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    const events = f.events();
    const starts = events.filter((event) => event.type === "start");
    expect(events.filter((event) => event.type === "stop")).toEqual([]);
    expect(starts.every((event) => event.secret === false)).toBe(true);
    expect(new Set(starts.map((event) => event.owner))).toEqual(
      new Set(["uncommitted reviewed source\n", "second reviewed source\n"]),
    );
    expect(report?.sources[0]?.sourceSha).toBe(report?.sources[1]?.sourceSha);
    expect(report?.sources[0]?.tree).not.toBe(report?.sources[1]?.tree);
    expect(events.findIndex((event) => event.type === "end")).toBeGreaterThan(
      events.findIndex((event) => event.type === "start" && event.id === "second"),
    );
    const heavy = events.findIndex((event) => event.type === "start" && event.id === "heavy");
    expect(heavy).toBeGreaterThan(
      events.findIndex((event) => event.type === "end" && event.id === "first"),
    );
    expect(heavy).toBeGreaterThan(
      events.findIndex((event) => event.type === "end" && event.id === "second"),
    );
    expect(new Set(starts.map((event) => event.lease)).size).toBe(2);
    expect(readFileSync(join(f.source, "owner.txt"), "utf8")).toBe("uncommitted reviewed source\n");
  });

  it("runs exclusive jobs concurrently on independent configured targets", () => {
    const f = fixture();
    const { result } = f.run([
      f.job("first", "overlap", { profile: "exclusive" }),
      f.job("second", "overlap", { profile: "exclusive", target: "two" }),
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(
      new Set(
        f
          .events()
          .filter((event) => event.type === "start")
          .map((event) => event.host),
      ),
    ).toEqual(new Set(["host-one", "host-two"]));
  });

  it("requeues only an admission refusal and blocks dependents after a started exit 75", () => {
    const f = fixture();
    const { result, report } = f.run([
      f.job("retry", "admission-once"),
      f.job("failure", "business75", { dependsOn: ["retry"] }),
      f.job("dependent", "success", { dependsOn: ["failure"] }),
    ]);
    expect(result.status, result.stderr).toBe(1);
    expect(report?.jobs.map((job) => [job.id, job.status, job.attempts.length])).toEqual([
      ["retry", "PASS", 2],
      ["failure", "FAIL", 1],
      ["dependent", "SKIPPED", 0],
    ]);
    expect(report?.jobs[1]?.attempts[0]).toMatchObject({ callerExit: 1, remoteExit: 75 });
    expect(
      f.events().filter((event) => event.type === "start" && event.id === "failure"),
    ).toHaveLength(1);
  });

  it("runs an already frozen changed-check command without preparing it again", () => {
    const f = fixture();
    const { result, report } = f.run([
      f.job("changed", "success", { argv: ["node", "scripts/check-changed.mjs", "--dry-run"] }),
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(report?.jobs[0]?.status).toBe("PASS");
    expect(f.events().filter((event) => event.type === "start")).toHaveLength(1);
  });

  it.each([
    "missing-receipt",
    "conflicting-receipts",
    "unknown-receipt",
    "unclean-receipt",
    "local-orphan",
  ])("retains an uncertain lane after %s and blocks the target", (scenario) => {
    const f = fixture();
    const { result, report } = f.run([
      f.job("uncertain", scenario),
      f.job("later", "success", { dependsOn: ["uncertain"] }),
    ]);
    expect(result.status, result.stderr).toBe(1);
    expect(report?.jobs.map((job) => job.status)).toEqual(["UNKNOWN", "SKIPPED"]);
    expect(report?.lanes[0]?.unknown).toBe(true);
    if (scenario === "local-orphan") {
      expect(report?.jobs[0]?.attempts[0]?.localCleanupConfirmed).toBe(false);
    }
    expect(f.events().map((event) => event.type)).toEqual(["start", "end"]);
  });
});
