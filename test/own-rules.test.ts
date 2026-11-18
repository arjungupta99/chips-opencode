/**
 * What OpenCode's own config lets through, as the copy for the harness's Permissions page in Chips
 * (Chips ADR 0299): read through its server, never written.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { OpenCodeClient } from "../src/opencode.ts";
import { joinedPermission, opencodeOwnRules, patternWords, sendOwnRules } from "../src/own-rules.ts";

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
    assert.match(copy.note ?? "", /asks before anything its config doesn't allow/);
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
