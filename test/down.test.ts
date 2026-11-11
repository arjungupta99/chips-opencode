/**
 * What a person says while the bridge is down is answered when it starts again. The bridge is
 * started as `src/main.ts` starts it: connect with a store, look for git, make the bridge, start
 * it. On the Chips SDK before 1.0.4 what `since` replayed was handed over before the bridge had
 * attached a handler, and the message was never answered (Chips ADR 0289).
 */
import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { startFakeChips } from "@chipschat/conformance";
import { checkGit, connect, fileStore } from "@chipschat/harness";
import { Bridge, type BridgeState } from "../src/bridge.ts";
import { OpenCodeClient } from "../src/opencode.ts";
import { startFakeOpenCode } from "./fake-opencode.ts";

const NO_HOME = join(tmpdir(), "chips-opencode-no-home");

it("answers what was said while it was down, as one turn", async () => {
  const chips = await startFakeChips({ capabilities: ["agents"] });
  const opencode = await startFakeOpenCode({});
  const folder = mkdtempSync(join(tmpdir(), "chips-opencode-down-"));
  const state: BridgeState = { sessions: {} };
  const logs: string[] = [];
  async function start() {
    const client = await connect({
      url: chips.address.url,
      token: chips.address.token,
      store: fileStore(join(folder, "chips-state.json")),
    });
    await checkGit();
    const bridge = new Bridge({
      chips: client,
      opencode: new OpenCodeClient({ url: opencode.url, password: opencode.password, directory: undefined }),
      agents: [{ name: "OpenCode", agent: "build" }],
      home: chips.address.spaceId,
      projects: false,
      state,
      saveState: () => undefined,
      healthEveryMs: 50,
      reconnectMs: 50,
      log: (line) => logs.push(line),
      places: { home: NO_HOME, config: join(NO_HOME, ".config", "opencode") },
    });
    await bridge.start();
    return { client, bridge };
  }
  const answersTo = (after: number) =>
    chips.waitFor(
      (event) => (event.type === "message.post" && event.run_id !== null && event.seq > after ? event : undefined),
      4000,
    );
  const first = await start();
  try {
    const hello = await chips.say("hello");
    await answersTo(hello.seq);
  } finally {
    first.bridge.stop();
    first.client.close();
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  const said = await chips.say("said while you were down");
  await chips.say("and this");
  const newest = await chips.say("and this too");
  const answered = answersTo(newest.seq).catch(() => undefined);
  const second = await start();
  try {
    assert.ok((await answered) !== undefined, `no answer to what was said while it was down\n${logs.join("\n")}`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const turns = chips.workspace.log.filter((event) => event.type === "run.started" && event.seq > said.seq);
    assert.equal(turns.length, 1, `the three that waited are one turn (Chips ADR 0294)\n${logs.join("\n")}`);
    assert.ok(logs.some((line) => /takes 3 messages that waited/.test(line)));
  } finally {
    second.bridge.stop();
    second.client.close();
    await opencode.close();
    await chips.close();
  }
});
