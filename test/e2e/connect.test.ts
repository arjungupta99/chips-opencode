/**
 * The gallery's OpenCode card, run as a person runs it, against a scratch Chips and the fake
 * OpenCode (Chips ADRs 0122, 0171; its findings' ON-8): what isn't set up stops it before the link
 * is spent; then it joins with what the card grants and says hello once; started again it says
 * nothing more; and a new link is taken up in place of the key it kept.
 *
 * The card's line carries no password and keeps the bridge running (`npm run keep`; Chips's setup
 * audit HS-5, HS-15): the bridge runs OpenCode's server itself, here the fake as `opencode` on a
 * PATH of its own, and the kit's `CHIPS_KEEP=off` keeps it in the foreground, never a launch agent.
 */

import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { STILL_GOOD } from "../../src/setup.ts";
import { type FakeOpenCode, startFakeOpenCode } from "../fake-opencode.ts";
import { type CardLink, here, type ScratchChips, scratchChips, skip } from "./kit.ts";

const HELLO = /^Hi, I'm OpenCode, here through OpenCode\. Ask me anything\.$/;
const ANSWERING = /answering for OpenCode through OpenCode at http:\/\/127\.0\.0\.1:\d+/;

describe("OpenCode's card, from a link to its hello", { skip, timeout: 180_000 }, () => {
  let chips: ScratchChips;
  /** A person's own server, for the one stop that names it. */
  let opencode: FakeOpenCode;
  let home: string;
  let card: CardLink;
  /** A PATH with OpenCode installed on it (the fake), and one whose OpenCode won't start. */
  let installed: string;
  let broken: string;
  const kept = () =>
    Object.values(JSON.parse(readFileSync(join(home, ".config/chips/harness-keys.json"), "utf8")) as Record<string, string>).map(
      (record) => JSON.parse(record) as { harnessId: string; hello: string },
    );
  const hellos = async (spaceId: string) => (await chips.said(spaceId)).filter((each) => HELLO.test(each.text));
  /** The command run to its end: what not being set up stops it with. */
  const stopped = async (command: string, says: RegExp, path?: string) => {
    const run = chips.run(command, { folder: here, home, ...(path === undefined ? {} : { path }) });
    assert.equal(await run.exited, 1, run.output());
    assert.match(run.output(), says);
    assert.ok(run.output().includes(STILL_GOOD), run.output());
    assert.equal((await chips.request(card.requestId)).state, "allowed", "the link is still good");
  };

  before(async () => {
    [chips, opencode] = await Promise.all([scratchChips(), startFakeOpenCode()]);
    home = mkdtempSync(join(tmpdir(), "chips-opencode-home-"));
    card = await chips.card("opencode");
    const shim = (folder: string, script: string) => {
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "opencode"), script);
      chmodSync(join(folder, "opencode"), 0o755);
      return `${folder}${delimiter}${process.env["PATH"] ?? ""}`;
    };
    installed = shim(
      join(home, "bin"),
      `#!/bin/sh\nexec "${process.execPath}" --import "${import.meta.resolve("tsx")}" "${join(here, "test", "fake-serve.ts")}" "$@"\n`,
    );
    broken = shim(join(home, "broken"), "#!/bin/sh\necho 'Error: no provider is configured' >&2\nexit 1\n");
  });

  after(async () => {
    await Promise.all([chips?.stop(), opencode?.close()]);
    rmSync(home, { recursive: true, force: true });
  });

  it("stops on each thing not set up, and leaves the link good", async () => {
    // No OpenCode on a PATH of node and the system's.
    const bare = [process.execPath.replace(/\/node$/, ""), "/usr/bin", "/bin"].join(delimiter);
    await stopped(card.command, /OpenCode isn't installed on this machine: install it \(opencode\.ai\)/, bare);
    await stopped(card.command, /OpenCode's server didn't start at http:\/\/127\.0\.0\.1:\d+: Error: no provider is configured/, broken);
    // A person's own server named in the config, without its password; then the config gone again.
    mkdirSync(join(home, ".chips-opencode"), { recursive: true });
    const config = join(home, ".chips-opencode", "config.json");
    writeFileSync(config, JSON.stringify({ url: opencode.url }));
    await stopped(card.command, /isn't in \$OPENCODE_PASSWORD: give it the one `opencode serve` at http:\/\/127\.0\.0\.1:\d+/, installed);
    rmSync(config);
  });

  it("joins with what the card grants, and says hello once in its room", async () => {
    const run = chips.run(card.command, { folder: here, home, path: installed });
    try {
      const request = await chips.until("the link taken up", async () => {
        const read = await chips.request(card.requestId);
        return read.state === "redeemed" && read;
      });
      assert.ok(request.harness_id !== undefined && request.space_id !== undefined);
      assert.deepEqual([...(await chips.capabilities(request.harness_id))].sort(), [...card.capabilities].sort());
      await chips.until("its hello", async () => (await hellos(request.space_id!)).length > 0);
      await run.saw(ANSWERING);
      assert.match(run.output(), /OpenCode's own server answering at http:\/\/127\.0\.0\.1:\d+/);
      assert.match(run.output(), /Keeping it running is off here \(CHIPS_KEEP=off\)/);
      assert.equal((await hellos(request.space_id)).length, 1);
      // Marked said once it is: the key it kept is the one the link handed it.
      await chips.until("its hello marked said", async () => kept()[0]?.hello === "said");
      assert.deepEqual(
        kept().map((each) => each.harnessId),
        [request.harness_id],
      );
      // One agent, called what its config says, as its Main: no "OpenCode 2" beside it (Chips ON-10).
      assert.deepEqual(await chips.agents(request.harness_id), [{ name: "OpenCode", lead: true }]);
    } finally {
      await run.stop();
    }
  });

  it("started again with the same command, says nothing more", async () => {
    const { space_id } = await chips.request(card.requestId);
    const run = chips.run(card.command, { folder: here, home, path: installed });
    try {
      await run.saw(ANSWERING);
      // Its hello, were it to say one, comes straight after.
      await new Promise((done) => setTimeout(done, 1500));
      assert.equal((await hellos(space_id!)).length, 1, run.output());
    } finally {
      await run.stop();
    }
  });

  it("takes up a new link in place of the key it kept, and says hello in the new room", async () => {
    const first = await chips.request(card.requestId);
    const again = await chips.card("opencode");
    const run = chips.run(again.command, { folder: here, home, path: installed });
    try {
      const request = await chips.until("the new link taken up", async () => {
        const read = await chips.request(again.requestId);
        return read.state === "redeemed" && read;
      });
      assert.notEqual(request.harness_id, first.harness_id);
      await chips.until("its hello in the new room", async () => (await hellos(request.space_id!)).length === 1);
      assert.deepEqual(
        kept().map((each) => each.harnessId),
        [request.harness_id],
      );
      // One agent, as its Main. The first harness's agent still holds "OpenCode" (ADR 0091).
      assert.deepEqual(await chips.agents(String(request.harness_id)), [{ name: "OpenCode 2", lead: true }]);
    } finally {
      await run.stop();
    }
  });
});
