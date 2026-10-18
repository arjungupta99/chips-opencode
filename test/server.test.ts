/**
 * OpenCode's server run by the bridge (Chips's setup audit HS-5): started on a port and password
 * it keeps, taken up again when it is still answering, started again when it stops, and stopped
 * with the bridge; what to do when OpenCode isn't installed or won't start. `opencode` here is the
 * fake, on a PATH of its own.
 */

import { strict as assert } from "node:assert";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
