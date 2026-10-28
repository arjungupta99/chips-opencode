/**
 * OpenCode's server run by the bridge (Chips's setup audit HS-5): started on a port and password
 * it keeps, taken up again when it is still answering, started again when it stops, and stopped
 * with the bridge; what to do when OpenCode isn't installed or won't start. A person's Restart
 * (Chips ADR 0094) stops it, the one taken up from before included, and starts it again on the
 * same port and password, or says why it didn't. `opencode` here is the fake, on a PATH of its own.
 */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ownServer, ServerError } from "../src/server.ts";

const here = fileURLToPath(new URL("..", import.meta.url));
let root: string;
let env: NodeJS.ProcessEnv;
const starts = () => (existsSync(join(root, "starts")) ? readFileSync(join(root, "starts"), "utf8").trim().split("\n") : []);

async function until(done: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
  const by = Date.now() + ms;
  while (!(await done())) {
    if (Date.now() > by) throw new Error(`not so within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const answering = async (url: string, password: string) => {
  try {
    const answer = await fetch(`${url}/api/info`, {
      headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
    });
    return answer.ok;
  } catch {
    return false;
  }
};

/** Whether a process is still there. */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A port nothing listens on now. */
const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

before(() => {
  root = mkdtempSync(join(tmpdir(), "chips-opencode-server-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "opencode"),
    `#!/bin/sh\nexec "${process.execPath}" --import "${import.meta.resolve("tsx")}" "${join(here, "test", "fake-serve.ts")}" "$@"\n`,
  );
  chmodSync(join(bin, "opencode"), 0o755);
  env = { PATH: `${bin}:/usr/bin:/bin`, FAKE_SERVE_STARTS: join(root, "starts") };
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("the bridge's own OpenCode server", () => {
  it("starts one on a port and password it keeps, readable by its user only, and stops it", async () => {
    const folder = mkdtempSync(join(root, "a-"));
    const server = await ownServer({ folder, cwd: folder, env });
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(await answering(server.url, server.password));
    const kept = JSON.parse(readFileSync(join(folder, "server.json"), "utf8")) as { port: number; password: string };
    assert.equal(server.url, `http://127.0.0.1:${kept.port}`);
    assert.equal(kept.password, server.password);
    assert.ok(kept.password.length >= 32);
    assert.equal(statSync(join(folder, "server.json")).mode & 0o777, 0o600);
    server.stop();
    await until(async () => !(await answering(server.url, server.password)));
  });

  it("takes up the one it started before while it still answers, and starts no other", async () => {
    const folder = mkdtempSync(join(root, "b-"));
    const first = await ownServer({ folder, cwd: folder, env });
    const before = starts().length;
    const again = await ownServer({ folder, cwd: folder, env });
    assert.equal(again.url, first.url);
    assert.equal(starts().length, before, "nothing more started");
    again.stop();
    assert.ok(await answering(first.url, first.password), "taken up, not stopped by the second");
    first.stop();
    await until(async () => !(await answering(first.url, first.password)));
  });

  it("starts it again when it stops while the bridge runs", async () => {
    const folder = mkdtempSync(join(root, "c-"));
    const lines: string[] = [];
    const server = await ownServer({ folder, cwd: folder, env, log: (line) => lines.push(line) });
    const before = starts();
    process.kill(Number(before.at(-1)), "SIGTERM");
    await until(() => lines.some((line) => /stopped .*starting it again in 2 s/.test(line)));
    await until(() => starts().length > before.length);
    await until(() => answering(server.url, server.password));
    server.stop();
  });

  it("restarts the one it started on the same port and password, and still stops it with the bridge", async () => {
    const folder = mkdtempSync(join(root, "f-"));
    const server = await ownServer({ folder, cwd: folder, env });
    const first = Number(starts().at(-1));
    const kept = readFileSync(join(folder, "server.json"), "utf8");
    await server.restart();
    const second = Number(starts().at(-1));
    assert.notEqual(second, first, "started again");
    assert.ok(!alive(first), "the one before stopped");
    assert.ok(await answering(server.url, server.password));
    assert.equal(readFileSync(join(folder, "server.json"), "utf8"), kept, "the same port and password");
    server.stop();
    await until(() => !alive(second));
  });

  it("restarts one it took up from before, by the process it says it is", async () => {
    const folder = mkdtempSync(join(root, "g-"));
    const port = await freePort();
    const password = "left-running-by-a-bridge-stopped-hard";
    writeFileSync(join(folder, "server.json"), JSON.stringify({ port, password }), { mode: 0o600 });
    // A server a bridge stopped hard left running: no process of this one's.
    const left = spawn(join(root, "bin", "opencode"), ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      env: { ...env, OPENCODE_PASSWORD: password },
      stdio: "ignore",
    });
    const gone = new Promise((resolve) => left.once("exit", resolve));
    const url = `http://127.0.0.1:${port}`;
    await until(() => answering(url, password));
    const server = await ownServer({ folder, cwd: folder, env });
    assert.equal(server.url, url, "taken up");
    const before = starts().length;
    await server.restart();
    await gone;
    assert.equal(starts().length, before + 1, "started again, by this bridge");
    assert.ok(await answering(url, password));
    server.stop();
    await until(async () => !(await answering(url, password)));
  });

  it("says why when it doesn't come back from a restart, and comes back from the next", async () => {
    const folder = mkdtempSync(join(root, "h-"));
    const own = { ...env };
    const server = await ownServer({ folder, cwd: folder, env: own, waitMs: 1500 });
    // OpenCode broke between the two: its config lost a provider, say.
    own["FAKE_SERVE_FAIL"] = "1";
    await assert.rejects(
      server.restart(),
      (error: unknown) =>
        error instanceof ServerError &&
        /^OpenCode's server didn't start again at http:\/\/127\.0\.0\.1:\d+: Error: no provider is configured$/.test(error.message),
    );
    assert.ok(!(await answering(server.url, server.password)), "nothing answering");
    delete own["FAKE_SERVE_FAIL"];
    await server.restart();
    assert.ok(await answering(server.url, server.password));
    server.stop();
    await until(async () => !(await answering(server.url, server.password)));
  });

  it("says to install OpenCode when it isn't on the PATH", async () => {
    const folder = mkdtempSync(join(root, "d-"));
    await assert.rejects(
      ownServer({ folder, cwd: folder, env: { PATH: "/usr/bin:/bin" } }),
      (error: unknown) => error instanceof ServerError && /OpenCode isn't installed on this machine: install it \(opencode\.ai\)/.test(error.message),
    );
  });

  it("says what OpenCode said when its server won't start", async () => {
    const folder = mkdtempSync(join(root, "e-"));
    await assert.rejects(
      ownServer({ folder, cwd: folder, env: { ...env, FAKE_SERVE_FAIL: "1" }, waitMs: 1500 }),
      (error: unknown) =>
        error instanceof ServerError && /OpenCode's server didn't start at http:\/\/127\.0\.0\.1:\d+: Error: no provider is configured/.test(error.message),
    );
  });
});
