/**
 * What OpenCode's own config lets through, as the copy for the harness's Permissions page in Chips
 * (Chips ADR 0299): read through its server, never written.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { ownRules } from "@chipschat/protocol";
import { OpenCodeClient } from "../src/opencode.ts";
import { joinedPermission, NOTE, opencodeOwnRules, patternWords, sendOwnRules } from "../src/own-rules.ts";

const HOME = "/Users/dana";

describe("OpenCode's permission, as entries", () => {
  it("reads how a bash pattern's commands start", () => {
    assert.deepEqual(patternWords("git *"), ["git"]);
    assert.deepEqual(patternWords("git push"), ["git", "push"]);
    assert.equal(patternWords("*"), undefined);
  });

  it("lays the person's config and the project's one over another, as OpenCode does", () => {
    const joined = joinedPermission([
      { path: `${HOME}/.config/opencode/opencode.json`, info: { permission: { edit: "ask", bash: { "*": "ask", "git *": "allow" } } } },
      { path: "/work/app/opencode.json", info: { permission: { edit: "allow", bash: { "git *": "ask", "npm test": "allow" } } } },
    ]);
    assert.ok(joined instanceof Map);
    assert.equal(joined.get("edit"), "allow");
    assert.deepEqual(joined.get("bash"), [
      ["*", "ask"],
      ["git *", "ask"],
      ["npm test", "allow"],
    ]);
    assert.equal(joinedPermission([{ path: "/a", info: { permission: { bash: "deny" } } }, { path: "/b", info: { permission: "allow" } }]), "allow");
    assert.equal(joinedPermission([{ path: "/a", info: {} }]), undefined);
  });

  it("reads OpenCode 2's list of rules, which its server hands back for each document, the last that matches deciding", () => {
    // As OpenCode 2.0.25 answered GET /api/config for a document that wrote `permission` the old way,
    // with `permissions` beside it, on 19 November 2026.
    const joined = joinedPermission([
      {
        path: `${HOME}/.config/opencode/opencode.json`,
        info: {
          permissions: [
            { action: "edit", resource: "*", effect: "ask" },
            { action: "shell", resource: "*", effect: "ask" },
            { action: "shell", resource: "git *", effect: "allow" },
            { action: "webfetch", resource: "*", effect: "deny" },
          ],
        },
      },
      {
        path: "/work/app/opencode.json",
        info: {
          permissions: [
            { action: "shell", resource: "git *", effect: "ask" },
            { action: "edit", resource: "src/*", effect: "allow" },
            { action: "webfetch", resource: "*", effect: "allow" },
            { action: "read", resource: "*", effect: "maybe" },
          ],
        },
      },
    ]);
    assert.ok(joined instanceof Map);
    assert.deepEqual(joined.get("edit"), [
      ["*", "ask"],
      ["src/*", "allow"],
    ]);
    assert.deepEqual(joined.get("shell"), [
      ["*", "ask"],
      ["git *", "ask"],
    ]);
    assert.equal(joined.get("webfetch"), "allow");
    assert.equal(joined.has("read"), false, "not a rule OpenCode takes");
    assert.equal(joinedPermission([{ path: "/a", info: { permissions: [{ action: "*", resource: "*", effect: "allow" }] } }]), "allow");
    // The old key and the new one in one document: the old first, as OpenCode 2 reads them.
    const both = joinedPermission([{ path: "/a", info: { permission: { bash: "ask" }, permissions: [{ action: "shell", resource: "*", effect: "allow" }] } }]);
    assert.ok(both instanceof Map);
    assert.deepEqual([...both], [["bash", "ask"], ["shell", "allow"]]);
  });
});

describe("OpenCode's copy", () => {
  it("says what runs, what asks and what it refuses, and where it read them", () => {
    const copy = opencodeOwnRules(
      [
        {
          path: `${HOME}/.config/opencode/opencode.json`,
          info: {
            permission: {
              read: "allow",
              edit: "allow",
              webfetch: "deny",
              bash: { "*": "ask", "git *": "allow", "git push": "ask", "rm *": "deny" },
              external_directory: "ask",
            },
          },
        },
      ],
      HOME,
    );
    assert.deepEqual(copy.read_from, ["~/.config/opencode/opencode.json"]);
    assert.deepEqual(
      copy.runs.map((entry) => [entry.kind, entry.name, entry.words]),
      [
        ["read", "read", undefined],
        ["write", "edit", undefined],
        ["command", "bash", ["git"]],
      ],
    );
    // The leading `*` is the fallback, which asks anyway: only `git push` is said to ask.
    assert.deepEqual(copy.asks?.map((entry) => entry.raw), ["bash: git push", "external_directory"]);
    assert.deepEqual(copy.refuses?.map((entry) => [entry.kind, entry.raw]), [
      ["web", "webfetch"],
      ["command", "bash: rm *"],
    ]);
    assert.equal(copy.note, NOTE);
    assert.equal(ownRules.safeParse(copy).success, true);
  });

  it("says commands and edits as OpenCode 2's list names them", () => {
    const copy = opencodeOwnRules(
      [
        {
          path: `${HOME}/.config/opencode/opencode.json`,
          info: {
            permissions: [
              { action: "shell", resource: "*", effect: "ask" },
              { action: "shell", resource: "git *", effect: "allow" },
              { action: "edit", resource: "*", effect: "deny" },
            ],
          },
        },
      ],
      HOME,
    );
    assert.deepEqual(copy.runs.map((entry) => [entry.kind, entry.name, entry.words, entry.raw]), [["command", "shell", ["git"], "shell: git *"]]);
    assert.deepEqual(copy.refuses?.map((entry) => [entry.kind, entry.raw]), [["write", "edit"]]);
  });

  it("says OpenCode runs what its config doesn't make ask or refuse, as its build agent allows everything", () => {
    // OpenCode 2.0.25's build agent: allow everything, then ask before reading `.env` files.
    assert.match(NOTE, /runs whatever its config and the agent's own rules don't make ask or refuse/);
    assert.match(NOTE, /build agent asks only before reading \.env files/);
    assert.doesNotMatch(NOTE, /falls? back to asking|asks before anything/);
    // An Always is OpenCode's own only while Chips's rules are off (`decisionOf`).
    assert.match(NOTE, /kept by Chips while its rules are on, and saved by OpenCode when they're off/);
  });

  it("says the modes a person may pick in Chips, the one its sessions run in, and what that mode adds", () => {
    const plain = opencodeOwnRules([], HOME);
    assert.equal(plain.modes, undefined);
    for (const running of ["default", "ask-changes", "read-only"]) {
      const copy = opencodeOwnRules([{ path: "/a/opencode.json", info: { permissions: [{ action: "*", resource: "*", effect: "allow" }] } }], HOME, running);
      assert.equal(ownRules.safeParse(copy).success, true, running);
      assert.deepEqual([copy.modes?.base, copy.modes?.running], ["default", running]);
      assert.deepEqual(copy.modes?.offers.map((mode) => mode.name), ["Default", "Ask before changes", "Read-only"]);
      assert.equal(copy.mode, undefined, "no mode the page reads as asking for whatever isn't listed");
    }
    assert.equal(opencodeOwnRules([], HOME, "default").note, NOTE);
    assert.equal(opencodeOwnRules([], HOME, "ask-changes").note, `${NOTE} In Ask before changes, Chips's rules come after these: edits and commands ask, apart from any it was told Always for.`);
    assert.equal(opencodeOwnRules([], HOME, "read-only").note, `${NOTE} In Read-only, Chips's rules come after these: edits are refused and commands ask.`);
  });

  it("says it runs everything when its config allows everything, and nothing when it says nothing", () => {
    assert.equal(opencodeOwnRules([{ path: "/a/opencode.json", info: { permission: "allow" } }], HOME).everything, true);
    const empty = opencodeOwnRules([], HOME);
    assert.deepEqual(empty.read_from, ["~/.config/opencode/opencode.json"]);
    assert.deepEqual(empty.runs, []);
    const many = Array.from({ length: 12 }, (_, at) => ({ path: `/p${at}/opencode.json`, info: {} }));
    assert.equal(opencodeOwnRules(many, HOME).read_from.length, 8);
  });
});

describe("reading the config through OpenCode's server", () => {
  it("asks for the folder's documents and keeps their path and what they say", async () => {
    const asked: string[] = [];
    const fake = (async (url: string | URL) => {
      asked.push(String(url));
      return new Response(
        JSON.stringify([
          { type: "document", path: "/config/opencode.json", info: { permission: { bash: "ask" } } },
          { type: "directory", path: "/config" },
        ]),
        { status: 200 },
      );
    }) as typeof fetch;
    const client = new OpenCodeClient({ url: "http://127.0.0.1:4096/", password: "pw", directory: "/work" }, fake);
    assert.deepEqual(await client.configDocuments(), [{ path: "/config/opencode.json", info: { permission: { bash: "ask" } } }]);
    assert.equal(asked[0], "http://127.0.0.1:4096/api/config?location%5Bdirectory%5D=%2Fwork");
  });
});

describe("sending the copy", () => {
  it("sends where the connection takes it, and does nothing on an older SDK or a refusal", async () => {
    const copy = opencodeOwnRules([], HOME);
    const sent: unknown[] = [];
    assert.equal(await sendOwnRules({ ownRules: (body: unknown) => Promise.resolve(sent.push(body)) }, copy), true);
    assert.deepEqual(sent, [copy]);
    assert.equal(await sendOwnRules({}, copy), false);
    assert.equal(await sendOwnRules({ ownRules: () => Promise.reject(new Error("refused")) }, copy), false);
  });
});
