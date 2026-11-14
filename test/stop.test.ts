/**
 * A stop while the bridge is still starting, as `kill` or the service that keeps it running sends
 * one. The bridge is run as it runs for real, `src/main.ts` as a process of its own, with a key it
 * kept before, and is stopped while it waits for a Chips that is down, its own OpenCode server
 * already running or not yet answering, and while `bridge.start()` waits for OpenCode. Either way
 * what the start had opened is closed first: a stop used to be heard only once the start was done,
 * and one before then left the server it started running and nothing saved. A start that was
 * stopped still ends as the signal, so `chips connect`, which reads an exit of 0 as connected,
 * never takes it for one that worked; once it has started, a stop is a clean end.
 *
 * Nothing of this machine's is read or written: its home, its config and its key are in a folder
 * made for the test, Chips is the conformance kit's fake, and `opencode` is the tests' own, on a
 * PATH of its own.
 */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { type FakeChips, startFakeChips } from "@chipschat/conformance";
import { join as joinChips } from "@chipschat/harness";
import { startFakeOpenCode } from "./fake-opencode.ts";

const here = join(import.meta.dirname, "..");

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

/** Once `check` holds, looked at every few milliseconds; `why` it didn't is said when it never does. */
async function until(check: () => boolean, why: () => string, ms = 15_000): Promise<void> {
  for (const by = Date.now() + ms; !check(); await new Promise((done) => setTimeout(done, 10))) {
    if (Date.now() > by) assert.fail(why());
  }
}

/**
 * A home of its own for the bridge, with the key a first run keeps, its config, and `opencode` on
 * its PATH: the fake, which writes each process it starts as in `starts`.
 */
async function scratch(chips: FakeChips, config: Record<string, unknown> = {}) {
  const home = mkdtempSync(join(tmpdir(), "chips-opencode-stop-"));
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "opencode"),
    `#!/bin/sh\nexec "${process.execPath}" --import "${import.meta.resolve("tsx")}" "${join(here, "test", "fake-serve.ts")}" "$@"\n`,
  );
  chmodSync(join(bin, "opencode"), 0o755);
  const starts = join(home, "starts");
  const env = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: home,
    CHIPS_URL: chips.address.url,
    CHIPS_CONFIG_HOME: join(home, "config"),
    CHIPS_NO_KEYCHAIN: "true",
    CHIPS_KEEP: "off",
    FAKE_SERVE_STARTS: starts,
  };
  await joinChips({ link: chips.makeJoinLink(["agents"]), name: "OpenCode", env });
  const kept = join(home, "bridge");
  mkdirSync(kept);
  const path = join(kept, "config.json");
  writeFileSync(path, JSON.stringify({ folders: join(home, "agents"), ...config }));
  return {
    home,
    env,
    config: path,
    kept,
    /** The servers it has started, each by its process. */
    started: () => (existsSync(starts) ? readFileSync(starts, "utf8").trim().split("\n").map(Number) : []),
  };
}

/** `src/main.ts` as a process: what it has said, a stop sent to it, and how it ended. */
function run(config: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts", config], {
    cwd: here,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let said = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (data) => (said += String(data)));
  let over = false;
  const ended = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
    child.once("exit", (code, signal) => {
      over = true;
      done({ code, signal });
    });
  });
  return {
    said: () => said,
    ended,
    /** Once it has got to `what`; failing, with what it said, when it ended first or never did. */
    until: async (what: string, check: () => boolean) => {
      await until(() => check() || over, () => `it never ${what}:\n${said}`);
      assert.ok(check(), `it ended before it ${what}:\n${said}`);
    },
    stop: () => child.kill("SIGTERM"),
    /** However the test went, no bridge is left running. */
    gone: () => {
      if (!over) child.kill("SIGKILL");
      return ended;
    },
  };
}

it("stops the server it started when it is stopped while it waits for Chips", async () => {
  const chips = await startFakeChips({ capabilities: ["agents"] });
  const { home, env, config, kept, started } = await scratch(chips);
  // Its server on a port of the test's: 4096, a first start's, is where the server's own tests start theirs.
  writeFileSync(join(kept, "server.json"), JSON.stringify({ port: await freePort(), password: "kept-for-the-test" }));
  // Chips is down, and this is the copy the machine keeps running, which waits for it.
  await chips.close();
  const bridge = run(config, { ...env, XPC_SERVICE_NAME: "chat.chips.opencode" });
  try {
    await bridge.until("said it waits for Chips", () => /waiting for Chips/.test(bridge.said()));
    const [server] = started();
    assert.ok(server !== undefined && alive(server), `its own server is running:\n${bridge.said()}`);
    bridge.stop();
    assert.deepEqual(await bridge.ended, { code: null, signal: "SIGTERM" }, bridge.said());
    await until(() => !alive(server), () => "the server it started is still running");
  } finally {
    await bridge.gone();
    for (const server of started()) if (alive(server)) process.kill(server, "SIGKILL");
    rmSync(home, { recursive: true, force: true });
  }
});

it("saves what it keeps when it is stopped while it starts", async () => {
  const [chips, opencode] = await Promise.all([startFakeChips({ capabilities: ["agents"] }), startFakeOpenCode()]);
  // A person's own server, so the test can hold its answers.
  const { home, env, config, kept } = await scratch(chips, { url: opencode.url });
  // OpenCode says how it is until the bridge is connected to Chips; asked after that, by
  // `bridge.start()`, it keeps the bridge waiting.
  let asked = false;
  let answer = () => {};
  const later = new Promise<void>((done) => {
    answer = done;
  });
  Object.defineProperty(opencode, "held", {
    get: () => {
      if (chips.connections() === 0) return undefined;
      asked = true;
      return later;
    },
  });
  const bridge = run(config, { ...env, OPENCODE_PASSWORD: opencode.password });
  try {
    await bridge.until("asked OpenCode how it is, connected", () => asked);
    // What the SDK keeps is saved by the stop itself: taken away here, it is written again.
    const state = join(kept, "chips-state.json");
    rmSync(state, { force: true });
    bridge.stop();
    assert.deepEqual(await bridge.ended, { code: null, signal: "SIGTERM" }, bridge.said());
    assert.ok(existsSync(state), "the SDK's state was saved as it stopped");
  } finally {
    await bridge.gone();
    answer();
    await Promise.all([opencode.close(), chips.close()]);
    rmSync(home, { recursive: true, force: true });
  }
});

it("stops the server it started when it is stopped before that server has answered", async () => {
  const chips = await startFakeChips({ capabilities: ["agents"] });
  const { home, env, config, kept, started } = await scratch(chips);
  writeFileSync(join(kept, "server.json"), JSON.stringify({ port: await freePort(), password: "kept-for-the-test" }));
  // Its server starts, and is in no hurry to answer: the bridge is still inside `ownServer()`.
  const bridge = run(config, { ...env, FAKE_SERVE_SLOW_MS: "60000" });
  try {
    await bridge.until("started its own server", () => started().length > 0);
    const [server] = started();
    assert.ok(server !== undefined && alive(server), `its own server is running:\n${bridge.said()}`);
    bridge.stop();
    assert.deepEqual(await bridge.ended, { code: null, signal: "SIGTERM" }, bridge.said());
    await until(() => !alive(server), () => "the server it started is still running");
  } finally {
    await bridge.gone();
    for (const server of started()) if (alive(server)) process.kill(server, "SIGKILL");
    await chips.close();
    rmSync(home, { recursive: true, force: true });
  }
});

it("ends cleanly, with what it keeps saved and its server stopped, when it is stopped once it has started", async () => {
  const chips = await startFakeChips({ capabilities: ["agents"] });
  const { home, env, config, kept, started } = await scratch(chips);
  writeFileSync(join(kept, "server.json"), JSON.stringify({ port: await freePort(), password: "kept-for-the-test" }));
  const bridge = run(config, env);
  try {
    await bridge.until("said it answers through OpenCode", () => /answering for .* through OpenCode/.test(bridge.said()));
    const [server] = started();
    assert.ok(server !== undefined && alive(server), `its own server is running:\n${bridge.said()}`);
    const state = join(kept, "chips-state.json");
    rmSync(state, { force: true });
    bridge.stop();
    assert.deepEqual(await bridge.ended, { code: 0, signal: null }, bridge.said());
    assert.ok(existsSync(state), "the SDK's state was saved as it stopped");
    await until(() => !alive(server), () => "the server it started is still running");
  } finally {
    await bridge.gone();
    for (const server of started()) if (alive(server)) process.kill(server, "SIGKILL");
    await chips.close();
    rmSync(home, { recursive: true, force: true });
  }
});
