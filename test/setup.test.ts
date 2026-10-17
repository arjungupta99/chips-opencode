/**
 * What the bridge checks before it takes up a link (Chips ADR 0122): a link works once, so a
 * password left as the command's `…`, a wrong one, or OpenCode not answering stops it first.
 */

import { strict as assert } from "node:assert";
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
  it("stops on a password left as the command's placeholder, or not set", () => {
    assert.throws(() => readConfig(none, { OPENCODE_PASSWORD: "…" }), stopsWith(/isn't in \$OPENCODE_PASSWORD/));
    assert.throws(() => readConfig(none, {}), stopsWith(/isn't in \$OPENCODE_PASSWORD/));
  });

  it("takes the defaults with no config, and the password filled in", () => {
    const read = readConfig(none, { OPENCODE_PASSWORD: "hunter22" });
    assert.deepEqual([read.url, read.agents[0]?.agent], ["http://127.0.0.1:4096", "build"]);
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
