import { execFile } from "node:child_process";
import fs from "node:fs";
import { createServer, request, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateLocalProxyLeaf } from "../../proxy-capture/ca.js";
import { resolveSecretSentinel, sealSecretSentinel } from "../sentinel.js";
import { createSecretEgressCertificates } from "./certificates.js";
import {
  startSecretEgressProxyServer,
  type SecretEgressProxyHandle,
  type SecretEgressProcessGrant,
} from "./proxy-server.js";

const execFileAsync = promisify(execFile);
const dirs: string[] = [];
const servers: Server[] = [];
const proxies: SecretEgressProxyHandle[] = [];
let grant: SecretEgressProcessGrant;
let proxy: SecretEgressProxyHandle;
let env: Record<string, string>;
let port: number;
let originBodies: string[];
let originChunks: Buffer[];
let originHeaders: Record<string, string | string[] | undefined>[];
let seedDir: string;
const resolveSentinel = vi.fn(resolveSecretSentinel);

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-egress-compat-"));
  dirs.push(dir);
  return dir;
}

async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing fixture port");
  }
  return address.port;
}

async function startProxy(allowedHosts?: string[]) {
  const caDir = tempDir();
  for (const name of ["root-ca.pem", "root-ca-key.pem"]) {
    fs.copyFileSync(path.join(seedDir, name), path.join(caDir, name));
  }
  const handle = await startSecretEgressProxyServer({
    caDir,
    allowedHosts,
    resolveSentinel,
    onAudit: () => {},
  });
  proxies.push(handle);
  return handle;
}

function proxyAuth(value: Record<string, string>) {
  const proxyUrl = value.HTTP_PROXY;
  if (!proxyUrl) {
    throw new Error("missing fixture proxy URL");
  }
  return `Basic ${Buffer.from(`openclaw:${new URL(proxyUrl).password}`).toString("base64")}`;
}

async function throughProxy(params: {
  target?: string;
  method?: string;
  headers?: Record<string, string>;
  chunks?: string[];
  auth?: string | false;
}) {
  const url = new URL(proxy.proxyOrigin);
  return await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        agent: false,
        path: params.target ?? `http://127.0.0.1:${port}/health`,
        method: params.method ?? "POST",
        headers: {
          ...(params.auth === false
            ? {}
            : { "Proxy-Authorization": params.auth ?? proxyAuth(env) }),
          ...params.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.once("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.once("error", reject);
    for (const chunk of params.chunks ?? []) {
      req.write(chunk);
    }
    req.end();
  });
}

beforeAll(async () => {
  seedDir = tempDir();
  await createSecretEgressCertificates(seedDir);
});

beforeEach(async () => {
  resolveSentinel.mockClear();
  originBodies = [];
  originChunks = [];
  originHeaders = [];
  port = await listen(
    createServer((req, res) => {
      const chunks: Buffer[] = [];
      originHeaders.push({ ...req.headers });
      req.on("data", (chunk) => {
        chunks.push(Buffer.from(chunk));
        originChunks.push(Buffer.from(chunk));
      });
      req.once("end", () => {
        originBodies.push(Buffer.concat(chunks).toString());
        res.end("healthy");
      });
    }),
  );
  proxy = await startProxy();
  grant = proxy.registerProcess();
  env = grant.env;
});

afterEach(async () => {
  for (const handle of proxies.splice(0)) {
    await handle.stop();
  }
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

afterAll(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("ordinary loopback HTTP through secret egress", () => {
  it.each(["127.0.0.1", "localhost"])(
    "forwards ordinary requests to %s without proxy credentials",
    async (host) => {
      await expect(
        throughProxy({ target: `http://${host}:${port}/health`, chunks: ["plain-body"] }),
      ).resolves.toMatchObject({ status: 200, body: "healthy" });
      expect(originBodies).toEqual(["plain-body"]);
      expect(originHeaders).toHaveLength(1);
      expect(originHeaders[0]).not.toHaveProperty("proxy-authorization");
      expect(resolveSentinel).not.toHaveBeenCalled();
    },
  );

  it("supports native Node fetch with the registered proxy environment", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const r=await fetch(${JSON.stringify(`http://127.0.0.1:${port}/health`)}); console.log(r.status,await r.text());`,
      ],
      { env: { PATH: process.env.PATH, ...env }, timeout: 10_000 },
    );
    expect(stdout.trim()).toBe("200 healthy");
  });

  it.each([false, "Basic invalid"] as const)("rejects invalid HTTP proxy auth %s", async (auth) => {
    await expect(throughProxy({ auth })).resolves.toMatchObject({ status: 407 });
    expect(originHeaders).toEqual([]);
  });

  it("keeps traffic lockdown and run revocation effective for HTTP", async () => {
    proxy = await startProxy([]);
    grant = proxy.registerProcess();
    env = grant.env;
    await expect(throughProxy({})).resolves.toMatchObject({ status: 403 });
    expect(originHeaders).toEqual([]);
    grant.revoke();
    await expect(throughProxy({})).resolves.toMatchObject({ status: 407 });
  });

  it.each(["url", "encoded-url", "header", "header-name", "body"])(
    "never decrypts protected HTTP credentials in %s",
    async (location) => {
      const secret = "synthetic-http-secret";
      const sentinel = sealSecretSentinel(secret, { label: "http-compat" });
      grant = proxy.registerProcess([
        { name: "FIXTURE_KEY", sentinel, allowedHosts: ["127.0.0.1"] },
      ]);
      env = grant.env;
      const encoded = sentinel.replaceAll(".", "%2E");
      const result = await throughProxy({
        target: location.includes("url")
          ? `http://127.0.0.1:${port}/?key=${location === "encoded-url" ? encoded : sentinel}`
          : undefined,
        headers:
          location === "header"
            ? { "X-Key": sentinel }
            : location === "header-name"
              ? { [sentinel]: "value" }
              : undefined,
        chunks: location === "body" ? [sentinel.slice(0, 5), sentinel.slice(5)] : undefined,
      });
      expect(result.status).toBe(502);
      expect(resolveSentinel).not.toHaveBeenCalled();
      expect(JSON.stringify(originHeaders)).not.toContain(secret);
      expect(JSON.stringify(originBodies)).not.toContain(sentinel);
      expect(JSON.stringify(originBodies)).not.toContain(secret);
      expect(Buffer.concat(originChunks).toString()).not.toContain(secret);
      expect(Buffer.concat(originChunks).toString()).not.toContain(sentinel);
      if (location !== "body") {
        expect(originHeaders).toEqual([]);
      }
    },
  );

  it("rejects a protected sentinel after a large ordinary streaming prefix", async () => {
    const secret = "synthetic-late-http-secret";
    const sentinel = sealSecretSentinel(secret, { label: "late-http" });
    grant = proxy.registerProcess([{ name: "FIXTURE_KEY", sentinel, allowedHosts: ["127.0.0.1"] }]);
    env = grant.env;
    const result = await throughProxy({
      chunks: ["x".repeat(100_000), sentinel.slice(0, 7), sentinel.slice(7)],
    });
    expect(result.status).toBe(502);
    expect(resolveSentinel).not.toHaveBeenCalled();
    expect(Buffer.concat(originChunks).toString()).not.toContain(secret);
    expect(Buffer.concat(originChunks).toString()).not.toContain(sentinel);
  });

  it.each(["oc-sent-v2.unfinished", "oc-sent-v2.invalid.end"])(
    "refuses malformed streamed sentinel %s",
    async (body) => {
      await expect(throughProxy({ chunks: [body] })).resolves.toMatchObject({ status: 502 });
      expect(originBodies).toEqual([]);
    },
  );

  it.each(["http://example.invalid/", "http://localhost.example.invalid/"])(
    "continues to refuse non-loopback HTTP %s",
    async (target) => {
      await expect(throughProxy({ target })).resolves.toMatchObject({ status: 502 });
      expect(originHeaders).toEqual([]);
    },
  );

  it("does not turn plain HTTP upgrades into an unscanned tunnel", async () => {
    await expect(
      throughProxy({ method: "GET", headers: { Connection: "Upgrade", Upgrade: "websocket" } }),
    ).resolves.toMatchObject({ status: 502 });
    expect(originHeaders).toEqual([]);
  });
});

describe("Gateway default CA inheritance", () => {
  it("retains accepted extra roots upstream and in the child trust bundle, but rejects unknown roots", async () => {
    const originDir = tempDir();
    const originCa = await createSecretEgressCertificates(originDir);
    const leaf = await generateLocalProxyLeaf({
      certDir: originDir,
      ca: { certPath: originCa.caCertPath, keyPath: path.join(originDir, "root-ca-key.pem") },
      hostname: "localhost",
    });
    const httpsPort = await listen(createHttpsServer(leaf, (_req, res) => res.end("trusted")));
    const target = `https://localhost:${httpsPort}/`;
    await expect(throughProxy({ target })).resolves.toMatchObject({ status: 502 });
    const previous = tls.getCACertificates("default");
    try {
      tls.setDefaultCACertificates([...previous, originCa.caPem]);
      proxy = await startProxy();
      grant = proxy.registerProcess();
      env = grant.env;
      await expect(throughProxy({ target })).resolves.toMatchObject({
        status: 200,
        body: "trusted",
      });
      const trustBundlePath = env.NODE_EXTRA_CA_CERTS;
      if (!trustBundlePath) {
        throw new Error("missing fixture trust bundle");
      }
      expect(fs.readFileSync(trustBundlePath, "utf8")).toContain(originCa.caPem);
    } finally {
      tls.setDefaultCACertificates(previous);
    }
  });
});
