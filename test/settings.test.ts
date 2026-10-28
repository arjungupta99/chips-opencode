/**
 * What a person sees and changes of the harness's agents from their pages (Chips ADR 0241): their
 * models. Against Chips's conformance fake, which checks every copy against the protocol's schemas,
 * and the scripted OpenCode.
 */

import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
import { type FakeChips, type StoredEvent, startFakeChips } from "@chipschat/conformance";
import { type Chips, connect } from "@chipschat/harness";
import { createIdGenerator } from "@chipschat/protocol";
import { type AgentConfig, Bridge, type BridgeState, settingsFor } from "../src/bridge.ts";
import { modelCopy, pickOf } from "../src/models.ts";
import { OpenCodeClient } from "../src/opencode.ts";
import { CATALOGUE, type FakeOpenCode, startFakeOpenCode } from "./fake-opencode.ts";

const CAPABILITIES = ["agents", "new_spaces", "new_agents", "forks", "models"];

type Body = Record<string, unknown>;

interface Rig {
  readonly chips: FakeChips;
  readonly client: Chips;
  readonly bridge: Bridge;
  readonly opencode: FakeOpenCode;
  readonly state: BridgeState;
  /** The harness's Main agent. */
  readonly agentId: string;
  readonly lines: string[];
}

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close();
});

async function rig(options: { agent?: AgentConfig; state?: BridgeState; chips?: FakeChips; opencode?: FakeOpenCode } = {}): Promise<Rig> {
  const chips = options.chips ?? (await startFakeChips({ capabilities: CAPABILITIES }));
  if (options.chips === undefined) open.push(() => chips.close());
  const opencode = options.opencode ?? (await startFakeOpenCode());
  if (options.opencode === undefined) open.push(() => opencode.close());
  let made: Bridge | undefined;
  const client = await connect({ url: chips.address.url, token: chips.address.token, settings: settingsFor(() => made) });
  const state = options.state ?? { sessions: {} };
  const lines: string[] = [];
  const bridge = new Bridge({
    chips: client,
    opencode: new OpenCodeClient({ url: opencode.url, password: opencode.password }),
    agents: [options.agent ?? { name: "OpenCode", agent: "build" }],
    home: chips.address.spaceId,
    state,
    saveState: () => undefined,
    healthEveryMs: 50,
    reconnectMs: 50,
    log: (line) => lines.push(line),
  });
  made = bridge;
  open.push(async () => {
    bridge.stop();
    client.close();
  });
  await bridge.start();
  return { chips, client, bridge, opencode, state, agentId: bridge.mainAgentId ?? "", lines };
}

async function until<T>(done: () => T | undefined | false, timeoutMs = 3000): Promise<T> {
  const by = Date.now() + timeoutMs;
  for (;;) {
    const value = done();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > by) throw new Error(`not so within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A turn in a room, once it is over. */
async function turn(chips: FakeChips, text: string, spaceId?: string): Promise<StoredEvent> {
  const said = await chips.say(text, spaceId);
  const started = await chips.waitFor((event) => (event.type === "run.started" && event.seq > said.seq ? event : undefined), 3000);
  return chips.waitFor((event) => (event.type === "run.completed" && event.run_id === started.run_id ? event : undefined), 3000);
}

const ids = createIdGenerator();

/** A frame as Chips sends it down the harness's socket, heard by the SDK as it hears one, and answered. */
async function hear(rig: Rig, frame: Body): Promise<string> {
  const changeId = ids.next("change");
  await rig.client.settings.hear({
    change_id: changeId,
    harness_id: rig.chips.address.harnessId,
    asked_by: rig.chips.workspace.owner.participantId,
    asked_at: new Date().toISOString(),
    ...frame,
  });
  return changeId;
}

const modelOf = (rig: Rig, agentId = rig.agentId) => rig.chips.settings.copy("model", agentId) as Body | undefined;
const answerTo = (rig: Rig, changeId: string) => rig.chips.settings.answerTo(changeId);

describe("an agent's model (Chips ADR 0241)", () => {
  it("is what OpenCode runs it on, among the models OpenCode runs, each with its levels", async () => {
    const opencode = await startFakeOpenCode();
    open.push(() => opencode.close());
    const main = await rig({ opencode });
    const copy = await until(() => modelOf(main));
    assert.deepEqual(copy, {
      model: "nous/heron-2",
      own: false,
      default: { label: "OpenCode's default", model: "nous/heron-2" },
      choices: [
        {
          id: "nous/heron-2",
          label: "Heron 2",
          efforts: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
            { id: "xhigh", label: "Extra high" },
          ],
        },
        { id: "nous/heron-mini", label: "Heron Mini", efforts: [] },
      ],
      editable: true,
    });
    // OpenCode's own agent's model, or the one the bridge's config names, is its default instead.
    const plan = await rig({ opencode, agent: { name: "Planner", agent: "plan" } });
    assert.deepEqual((await until(() => modelOf(plan)))["default"], { label: "OpenCode's default", model: "nous/heron-mini" });
    const configured = await rig({ opencode, agent: { name: "OpenCode", agent: "build", model: "nous/heron-mini" } });
    assert.deepEqual((await until(() => modelOf(configured)))["default"], { label: "As in config.json", model: "nous/heron-mini" });
  });

  it("keeps a person's pick, and puts the agent's session on it before its next message, and back", async () => {
    const main = await rig();
    const { chips, opencode, state, agentId } = main;
    await turn(chips, "one");
    const session = opencode.created[0]?.id ?? "";
    assert.equal(opencode.created[0]?.model, undefined, "OpenCode's own until a person picks");
    const picked = await hear(main, { frame: "model.change", agent_id: agentId, model: "nous/heron-2", effort: "high" });
    assert.equal(answerTo(main, picked)?.made, true);
    assert.deepEqual([modelOf(main)?.["model"], modelOf(main)?.["effort"], modelOf(main)?.["own"]], ["nous/heron-2", "high", true]);
    assert.deepEqual(state.models, { "opencode:build:opencode": { model: "nous/heron-2", effort: "high" } });
    await turn(chips, "two");
    assert.deepEqual(opencode.switched, [{ sessionId: session, model: { providerID: "nous", id: "heron-2", variant: "high" } }]);
    // Already on it: nothing more.
    await turn(chips, "three");
    assert.equal(opencode.switched.length, 1);
    // A session made anew is made on it.
    opencode.forget(session);
    await turn(chips, "again");
    assert.deepEqual(opencode.created[1]?.model, { providerID: "nous", id: "heron-2", variant: "high" });
    const again = opencode.created[1]?.id ?? "";
    // Its default again: the session that was put on the pick goes back to OpenCode's.
    const back = await hear(main, { frame: "model.change", agent_id: agentId, model: null, effort: null });
    assert.equal(answerTo(main, back)?.made, true);
    assert.equal(modelOf(main)?.["own"], false);
    await turn(chips, "four");
    assert.deepEqual(opencode.switched.at(-1), { sessionId: again, model: { providerID: "nous", id: "heron-2" } });
    const usage = chips.workspace.log.findLast((event) => event.type === "usage");
    assert.equal(usage?.payload["model"], "nous/heron-2");
  });

  it("is the same after the bridge starts again, and a copy of the agent runs on its original's", async () => {
    const chips = await startFakeChips({ capabilities: CAPABILITIES });
    open.push(() => chips.close());
    const opencode = await startFakeOpenCode();
    open.push(() => opencode.close());
    const state: BridgeState = { sessions: {}, models: { "opencode:build:opencode": { model: "nous/heron-mini" } } };
    const main = await rig({ chips, opencode, state });
    assert.deepEqual([modelOf(main)?.["model"], modelOf(main)?.["own"]], ["nous/heron-mini", true]);
    const room = await chips.openRoom("Trip");
    const { askId } = await chips.askForAgent(room, "Nova");
    await chips.waitFor((event) => (event.type === "membership.added" && event.payload["made_for"] === askId ? event : undefined), 3000);
    const nova = (await main.client.agents.list()).find((agent) => agent.name === "Nova")?.agentId ?? "";
    assert.deepEqual((await until(() => modelOf(main, nova)))["own"], false, "a new agent runs on OpenCode's");
    await hear(main, { frame: "model.change", agent_id: nova, model: "nous/heron-mini", effort: null });
    await turn(chips, "one", room);
    const second = await chips.openRoom("Second opinion");
    const { forkId } = await chips.askForFork(nova, second);
    const joined = await chips.waitFor(
      (event) => (event.type === "membership.added" && event.payload["fork_of"] === forkId ? event : undefined),
      3000,
    );
    const copy = String(joined.payload["participant_id"]);
    assert.deepEqual(await until(() => state.models?.[copy]), { model: "nous/heron-mini" });
    assert.deepEqual((await until(() => modelOf(main, copy)))["model"], "nous/heron-mini");
  });

  it("refuses a model OpenCode doesn't run, and a level its model doesn't have, saying so", async () => {
    const main = await rig();
    await until(() => modelOf(main));
    const off = await hear(main, { frame: "model.change", agent_id: main.agentId, model: "lathe/quill-1", effort: null });
    assert.deepEqual(answerTo(main, off), {
      kind: "model",
      id: main.agentId,
      changeId: off,
      made: false,
      message: "OpenCode doesn't run lathe/quill-1 here.",
    });
    const level = await hear(main, { frame: "model.change", agent_id: main.agentId, model: "nous/heron-mini", effort: "high" });
    assert.equal(answerTo(main, level)?.message, "Heron Mini has no High level.");
    assert.equal(main.state.models, undefined, "nothing kept");
  });

  it("names a model it runs on that the catalogue lacks, and tells two of the same name apart", () => {
    const twin = { ...CATALOGUE[0], providerID: "relay", name: "Heron 2" } as (typeof CATALOGUE)[number];
    const copy = modelCopy({
      catalogue: [...CATALOGUE, twin],
      pick: { model: "gone/old-1", effort: "high" },
      fallback: { model: { providerID: "nous", id: "heron-mini" }, label: "OpenCode's default" },
    });
    assert.deepEqual(
      copy?.choices.map((choice) => [choice.id, choice.label]),
      [
        ["nous/heron-2", "Heron 2 · nous"],
        ["nous/heron-mini", "Heron Mini"],
        ["relay/heron-2", "Heron 2 · relay"],
        ["gone/old-1", "old-1"],
      ],
    );
    assert.deepEqual([copy?.model, copy?.effort, copy?.own], ["gone/old-1", "high", true]);
    assert.deepEqual(pickOf({ model: null, effort: null }, CATALOGUE), null);
    assert.deepEqual(pickOf({ model: "nous/heron-2", effort: "xhigh" }, CATALOGUE), { model: "nous/heron-2", effort: "xhigh" });
  });
});
