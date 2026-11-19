/**
 * What the bridge checks before it takes up a link (Chips ADR 0122): a link works once, so a
 * password left as the command's `…`, a wrong one, or OpenCode not answering stops it first.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import { OpenCodeClient, OpenCodeError } from "../src/opencode.ts";
import { checkOpenCode, readConfig, SetupError, STILL_GOOD } from "../src/setup.ts";
import { startFakeOpenCode } from "./fake-opencode.ts";

const none = join(tmpdir(), "chips-opencode-no-config.json");

const stopsWith = (pattern: RegExp) => (error: unknown) =>
  error instanceof SetupError && pattern.test(error.message) && error.message.includes(STILL_GOOD);

describe("before the link is taken up", () => {
  it("runs its own server with no password and no server named, the placeholder counting as none (HS-5)", () => {
    for (const env of [{}, { OPENCODE_PASSWORD: "…" }]) {
      const read = readConfig(none, env);
      assert.equal(read.ownServer, true);
      assert.equal(read.password, undefined);
    }
  });

  it("takes a person's own server with the password filled in, as before", () => {
    const read = readConfig(none, { OPENCODE_PASSWORD: "hunter22" });
    assert.deepEqual([read.ownServer, read.url, read.agents[0]?.agent], [false, "http://127.0.0.1:4096", "build"]);
  });

  it("stops on a server named in the config with no password for it", () => {
    const named = join(mkdtempSync(join(tmpdir(), "chips-opencode-named-")), "config.json");
    writeFileSync(named, JSON.stringify({ url: "http://127.0.0.1:4097" }));
    assert.throws(() => readConfig(named, { OPENCODE_PASSWORD: "…" }), stopsWith(/isn't in \$OPENCODE_PASSWORD: give it the one `opencode serve` at http:\/\/127\.0\.0\.1:4097/));
  });

  it("stops on a password OpenCode refuses, or OpenCode not answering, and goes on when it answers", async () => {
    const read = readConfig(none, { OPENCODE_PASSWORD: "hunter22" });
    await assert.rejects(
      checkOpenCode(read, { agents: () => Promise.reject(new OpenCodeError("no", 401)) }),
      stopsWith(/refused the password in \$OPENCODE_PASSWORD/),
    );
    await assert.rejects(
      checkOpenCode(read, { agents: () => Promise.reject(new TypeError("fetch failed")) }),
      stopsWith(/isn't answering at http:\/\/127\.0\.0\.1:4096/),
    );
    const offered = await checkOpenCode(read, { agents: async () => [{ id: "build" }] as never });
    assert.equal(offered.length, 1);
  });

  // OpenCode's older install line gives OpenCode 1, and four in five of its npm installs were
  // still OpenCode 1 on 18 November 2026. Its server started, listed its agents and said hello,
  // and the first message failed with `Missing key at ["prompt"] (400)`.
  it("stops on OpenCode 1, by its version, with the line that installs OpenCode 2", async () => {
    const one = await startFakeOpenCode({ older: "1.19.6" });
    try {
      const own = readConfig(none, {});
      const stopped = await checkOpenCode(own, new OpenCodeClient({ url: one.url, password: one.password })).then(
        () => undefined,
        (error: unknown) => error,
      );
      assert.ok(stopped instanceof SetupError);
      assert.equal(
        stopped.message,
        `OpenCode 1.19.6 is on this machine, and Chips needs OpenCode 2: install it with \`curl -fsSL https://opencode.ai/v2/install | bash\`, then open a new terminal. ${STILL_GOOD}`,
      );
      assert.deepEqual(stopped.words, {
        detail: "OpenCode 1.19.6 is on this Mac",
        says: "Chips needs OpenCode 2.",
        doing: "Run this in Terminal, then try again.",
        copy: "curl -fsSL https://opencode.ai/v2/install | bash",
      });
      // A server a person runs somewhere is named by where it answers.
      const named = { ...readConfig(none, { OPENCODE_PASSWORD: one.password }), url: one.url };
      await assert.rejects(
        checkOpenCode(named, new OpenCodeClient({ url: one.url, password: one.password })),
        stopsWith(/^OpenCode 1\.19\.6 answers at http:\/\/127\.0\.0\.1:\d+, and Chips needs OpenCode 2: install it there with `curl -fsSL https:\/\/opencode\.ai\/v2\/install \| bash`, then start its server again\./),
      );
    } finally {
      await one.close();
    }
  });

  it("goes on with OpenCode 2, which has no such route, and when nothing says which it is", async () => {
    const two = await startFakeOpenCode();
    try {
      const client = new OpenCodeClient({ url: two.url, password: two.password });
      assert.equal(await client.older(), undefined);
      assert.ok((await checkOpenCode(readConfig(none, {}), client)).length > 0);
      // Down, or a password it refuses: not OpenCode 1, and the stops for those say so as before.
      two.up = false;
      assert.equal(await client.older(), undefined);
      two.up = true;
      assert.equal(await new OpenCodeClient({ url: two.url, password: "another" }).older(), undefined);
    } finally {
      await two.close();
    }
  });

  // Chips for Mac's sheet (Chips ADR 0218, phase 5): a few words under the step, the sentence,
  // what to do, and a line to copy; the terminal keeps the whole sentence.
  it("says where it stopped in a few words for Chips for Mac's sheet", async () => {
    const read = readConfig(none, { OPENCODE_PASSWORD: "hunter22" });
    const stopped = await checkOpenCode(read, { agents: () => Promise.reject(new TypeError("fetch failed")) }).then(
      () => undefined,
      (error: unknown) => error,
    );
    assert.ok(stopped instanceof SetupError);
    assert.deepEqual(stopped.words, {
      detail: "Nothing answers at 127.0.0.1:4096",
      says: "OpenCode's server isn't answering.",
      doing: "Start it with a password in $OPENCODE_PASSWORD, then try again.",
      copy: "opencode serve",
    });
  });
});

describe("OpenCode's catalogues", () => {
  // Setup audit S12: an empty first answer made every start say "has no agent build: it has ".
  it("asks again when the first answer for a project it hasn't loaded is empty", async () => {
    const fake = await startFakeOpenCode({ cold: true });
    try {
      const client = new OpenCodeClient({ url: fake.url, password: fake.password });
      assert.deepEqual((await client.agents()).map((each) => each.id), ["build", "plan"]);
    } finally {
      await fake.close();
    }
  });
});
