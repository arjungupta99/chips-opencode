/**
 * An install from before 1.0.15 brought across to ~/Chips (Chips ADR 0283): the config, sessions,
 * password and state, the agents' folders, the folder paths saved, and each session of a folder that
 * moved, moved by OpenCode once it answers. Nothing copied, nothing done twice.
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import type { BridgeState } from "../src/bridge.ts";
import { moveOld, moveSessions } from "../src/move.ts";
import { OpenCodeError } from "../src/opencode.ts";
import { configPathOf, configTargetOf } from "../src/places.ts";
import { readConfig } from "../src/setup.ts";

// Every default path is under a home of the test's own, never the person's.
let home = "";
const put = (path: string, text: string) => {
  mkdirSync(dirname(join(home, path)), { recursive: true });
  writeFileSync(join(home, path), text);
};
const at = (path: string) => join(home, path);
const json = (path: string) => JSON.parse(readFileSync(at(path), "utf8")) as BridgeState;

let said: string[] = [];
const log = (line: string) => said.push(line);
const move = (word?: string) => moveOld(configTargetOf(word, home), log, home);

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "chips-opencode-move-")));
  process.env["HOME"] = home;
  said = [];
});

/** The bridge as it was kept before 1.0.15, running OpenCode's server itself. */
function oldInstall(): void {
  put(".chips-opencode/server.json", JSON.stringify({ port: 4096, password: "p" }));
  put(".chips-opencode/chips-state.json", "{}");
  put(
    ".chips-opencode/sessions.json",
    JSON.stringify({
      sessions: { "opencode:build:opencode|spc_1": "ses_a", "agt_2|spc_2": "ses_b", "agt_gone|spc_3": "ses_c" },
      folders: { "opencode:build:opencode": at("chips-opencode/agents/opencode"), agt_2: at("chips-opencode/agents/jens") },
      forks: { evt_1: { session: "ses_f", folder: at("chips-opencode/agents/jens") } },
    }),
  );
  put("chips-opencode/agents/AGENTS.md", "Plain words.\n");
  put("chips-opencode/agents/jens/notes.txt", "Jens's\n");
  mkdirSync(at("chips-opencode/agents/opencode"), { recursive: true });
}

describe("where things are kept", () => {
  it("reads a config named in the old place as the same one in the new", () => {
    assert.equal(configPathOf(undefined, home), at("Chips/.bridges/opencode/config.json"));
    assert.equal(configPathOf("~/.chips-opencode/config.json", home), at("Chips/.bridges/opencode/config.json"));
  });

  it("uses the old place while its file is there and the new one isn't", () => {
    put(".chips-opencode/config.json", "{}");
    assert.equal(configPathOf(undefined, home), at(".chips-opencode/config.json"));
  });

  it("uses the old place while its folder is there, with no config in it", () => {
    put(".chips-opencode/server.json", "{}");
    assert.equal(configPathOf(undefined, home), at(".chips-opencode/config.json"));
  });

  it("gives the agents their folders in ~/Chips/Agents/opencode", () => {
    assert.equal(readConfig(at("Chips/.bridges/opencode/config.json"), {}).folders, at("Chips/Agents/opencode"));
  });
  it("keeps the agents' folders where they were until they move", () => {
    put("chips-opencode/agents/jens/notes.txt", "Jens's\n");
    assert.equal(readConfig(at("Chips/.bridges/opencode/config.json"), {}).folders, at("chips-opencode/agents"));
  });
});

describe("an install from before 1.0.15", () => {
  it("moves the settings and folders, and notes each session to move with its folder", () => {
    oldInstall();
    put("chips-opencode/work/opencode.json", "{}");
    move();

    assert.deepEqual(JSON.parse(readFileSync(at("Chips/.bridges/opencode/server.json"), "utf8")), { port: 4096, password: "p" });
    assert.ok(existsSync(at("Chips/.bridges/opencode/chips-state.json")));
    assert.ok(existsSync(at("Chips/Agents/opencode/AGENTS.md")));
    assert.equal(readFileSync(at("Chips/Agents/opencode/jens/notes.txt"), "utf8"), "Jens's\n");
    const state = json("Chips/.bridges/opencode/sessions.json");
    assert.deepEqual(state.folders, { "opencode:build:opencode": at("Chips/Agents/opencode/opencode"), agt_2: at("Chips/Agents/opencode/jens") });
    assert.deepEqual(state.forks, { evt_1: { session: "ses_f", folder: at("Chips/Agents/opencode/jens") } });
    assert.deepEqual(state.moving, {
      ses_a: at("Chips/Agents/opencode/opencode"),
      ses_b: at("Chips/Agents/opencode/jens"),
      ses_f: at("Chips/Agents/opencode/jens"),
    });
    assert.ok(!existsSync(at(".chips-opencode")));
    assert.ok(!existsSync(at("chips-opencode/agents")));
    assert.ok(existsSync(at("chips-opencode/work/opencode.json")), "a folder the bridge didn't make stays");
  });

  it("names the new place where the config named the old one", () => {
    oldInstall();
    put(".chips-opencode/config.json", JSON.stringify({ folders: "~/chips-opencode/agents", agents: [{ name: "OpenCode", agent: "build" }] }));
    move();
    assert.equal((json("Chips/.bridges/opencode/config.json") as unknown as Record<string, unknown>)["folders"], "~/Chips/Agents/opencode");
    assert.ok(!existsSync(at("chips-opencode")));
  });

  it("does nothing the second time, or on a new install", () => {
    oldInstall();
    move();
    said = [];
    move();
    assert.deepEqual(said, []);

    home = realpathSync(mkdtempSync(join(tmpdir(), "chips-opencode-move-")));
    move();
    assert.deepEqual(said, []);
  });
});

describe("the sessions of folders that moved", () => {
  it("are moved by OpenCode, and one it refuses is said and dropped, one it didn't answer for kept", async () => {
    const asked: [string, string][] = [];
    const opencode = {
      moveSession: async (session: string, folder: string) => {
        asked.push([session, folder]);
        if (session === "ses_gone") throw new OpenCodeError("Session not found", 404);
        if (session === "ses_later") throw new TypeError("fetch failed");
      },
    };
    const state: BridgeState = { sessions: {}, moving: { ses_a: "/a", ses_gone: "/b", ses_later: "/c" } };
    let saved: BridgeState | undefined;
    await moveSessions(state, opencode, (next) => (saved = structuredClone(next)), log, home);

    assert.deepEqual(asked.map(([session]) => session), ["ses_a", "ses_gone", "ses_later"]);
    assert.deepEqual(saved?.moving, { ses_later: "/c" });
    assert.ok(said.some((line) => line.startsWith("moved OpenCode's session ses_a")));
    assert.ok(said.some((line) => line.startsWith("OpenCode wouldn't move its session ses_gone")));

    state.moving = { ses_later: "/c" };
    await moveSessions(state, { moveSession: async () => undefined }, (next) => (saved = structuredClone(next)), log, home);
    assert.equal(saved?.moving, undefined);
  });

  it("asks nothing when none moved", async () => {
    const state: BridgeState = { sessions: {} };
    let saves = 0;
    await moveSessions(state, { moveSession: async () => assert.fail("asked") }, () => saves++, log, home);
    assert.equal(saves, 0);
  });
});
