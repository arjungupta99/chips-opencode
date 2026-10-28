/**
 * What a person sees and changes of the harness's agents from their pages (Chips ADR 0241): their
 * models, their files and their context windows. Against Chips's conformance fake, which checks every copy against the
 * protocol's schemas, and the scripted OpenCode, with a home of the test's own, so nobody's own
 * OpenCode files are read.
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type FakeChips, type StoredEvent, startFakeChips } from "@chipschat/conformance";
import { type Chips, connect } from "@chipschat/harness";
import { createIdGenerator } from "@chipschat/protocol";
import { type AgentConfig, Bridge, type BridgeState, settingsFor } from "../src/bridge.ts";
import { before, hashOf, namedFiles, upTo } from "../src/context.ts";
import { modelCopy, pickOf } from "../src/models.ts";
import { compactedTo, OWN_LIMIT } from "../src/windows.ts";
import { OpenCodeClient } from "../src/opencode.ts";
import { CATALOGUE, type FakeOpenCode, startFakeOpenCode } from "./fake-opencode.ts";

const CAPABILITIES = ["agents", "new_spaces", "new_agents", "forks", "models", "context_files", "context_windows"];

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
  /** The test's own home, and the folder the agents' folders are made in. */
  readonly home: string;
  readonly folders: string;
}

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close();
});

async function rig(
  options: { agent?: AgentConfig; state?: BridgeState; chips?: FakeChips; opencode?: FakeOpenCode; home?: string } = {},
): Promise<Rig> {
  const home = options.home ?? homeOfItsOwn();
  const folders = join(home, "chips-opencode", "agents");
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
    folders,
    places: { home, config: join(home, ".config", "opencode") },
  });
  made = bridge;
  open.push(async () => {
    bridge.stop();
    client.close();
  });
  await bridge.start();
  return { chips, client, bridge, opencode, state, agentId: bridge.mainAgentId ?? "", lines, home, folders };
}

function homeOfItsOwn(): string {
  const home = mkdtempSync(join(tmpdir(), "chips-opencode-home-"));
  open.push(async () => rmSync(home, { recursive: true, force: true }));
  return home;
}

const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

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
  const edit = frame["frame"] === "context.edit";
  const changeId = ids.next(edit ? "edit" : "change");
  await rig.client.settings.hear({
    [edit ? "edit_id" : "change_id"]: changeId,
    harness_id: rig.chips.address.harnessId,
    asked_by: rig.chips.workspace.owner.participantId,
    asked_at: new Date().toISOString(),
    ...frame,
  });
  return changeId;
}

const modelOf = (rig: Rig, agentId = rig.agentId) => rig.chips.settings.copy("model", agentId) as Body | undefined;
const filesOf = (rig: Rig, agentId = rig.agentId) => rig.chips.settings.copy("context", agentId) as { files: Body[] } | undefined;
const windowOf = (rig: Rig, agentId = rig.agentId) => rig.chips.settings.copy("context-window", agentId) as Body | undefined;
const answersTo = (rig: Rig, changeId: string) => rig.chips.settings.answers.filter((answer) => answer.changeId === changeId);
const sharedOf = (rig: Rig) => rig.chips.settings.copy("harness-context", rig.chips.address.harnessId) as { shared: Body[] } | undefined;
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

describe("an agent's files (Chips ADRs 0134, 0241)", () => {
  it("lists the AGENTS.md files OpenCode reads for it: its own, every agent's, one above, and yours read only", async () => {
    const home = homeOfItsOwn();
    write(join(home, ".config", "opencode", "AGENTS.md"), "Answer briefly.\n");
    write(join(home, "chips-opencode", "AGENTS.md"), "Work in British English.\n");
    const main = await rig({ home });
    const files = await until(() => filesOf(main));
    assert.deepEqual(files, {
      files: [
        { name: "AGENTS.md", title: "How it works", role: "instructions", text: "", hash: hashOf(""), editable: true },
        {
          name: "~ › chips-opencode › agents › AGENTS.md",
          title: "For every OpenCode agent",
          role: "instructions",
          about: "~/chips-opencode/agents/AGENTS.md",
          shared: "every-agent",
          replaceable: false,
          editable: false,
        },
        {
          name: "~ › chips-opencode › AGENTS.md",
          title: "From ~/chips-opencode",
          role: "instructions",
          about: "~/chips-opencode/AGENTS.md",
          shared: files.files[2]?.["shared"],
          replaceable: false,
          editable: false,
        },
        {
          name: "~ › .config › opencode › AGENTS.md",
          title: "For all your OpenCode",
          role: "instructions",
          about: "~/.config/opencode/AGENTS.md",
          shared: "yours",
          replaceable: false,
          editable: false,
        },
      ],
    });
    const shared = await until(() => sharedOf(main));
    assert.deepEqual(
      shared.shared.map((file) => [file["id"], file["text"], file["editable"], file["why_read_only"], file["used_by"]]),
      [
        ["every-agent", "", true, undefined, 1],
        [files.files[2]?.["shared"], "Work in British English.\n", false, "It sits above the agents' folders.", 1],
        ["yours", "Answer briefly.\n", false, "Your own OpenCode reads it too.", 1],
      ],
    );
  });

  it("saves a person's edit where OpenCode reads it, only if the file is still the one they changed", async () => {
    const main = await rig();
    await until(() => filesOf(main));
    const own = join(main.folders, "opencode", "AGENTS.md");
    const saved = await hear(main, { frame: "context.edit", agent_id: main.agentId, name: "AGENTS.md", text: "Be kind.\n", base_hash: hashOf("") });
    assert.equal(answerTo(main, saved)?.made, true);
    assert.equal(readFileSync(own, "utf8"), "Be kind.\n");
    assert.equal(filesOf(main)?.files[0]?.["text"], "Be kind.\n");
    // Changed meanwhile, in OpenCode or by the agent: refused, and the file left as it is.
    write(own, "Be very kind.\n");
    const stale = await hear(main, { frame: "context.edit", agent_id: main.agentId, name: "AGENTS.md", text: "Be curt.\n", base_hash: hashOf("Be kind.\n") });
    assert.equal(answerTo(main, stale)?.made, false);
    assert.equal(readFileSync(own, "utf8"), "Be very kind.\n");
    // Every agent's file, from the harness's page; yours is not the bridge's to change.
    const every = await hear(main, { frame: "context.edit", name: "~ › chips-opencode › agents › AGENTS.md", text: "Say who you are.\n", base_hash: hashOf("") });
    assert.equal(answerTo(main, every)?.made, true);
    assert.equal(readFileSync(join(main.folders, "AGENTS.md"), "utf8"), "Say who you are.\n");
    write(join(main.home, ".config", "opencode", "AGENTS.md"), "Mine.\n");
    const yours = await hear(main, { frame: "context.edit", name: "~ › .config › opencode › AGENTS.md", text: "Not mine.\n", base_hash: hashOf("Mine.\n") });
    assert.deepEqual([answerTo(main, yours)?.made, answerTo(main, yours)?.message], [false, "Your own OpenCode reads it too."]);
    const theirs = await hear(main, { frame: "context.edit", agent_id: main.agentId, name: "~ › chips-opencode › agents › AGENTS.md", text: "x", base_hash: hashOf("Say who you are.\n") });
    assert.equal(answerTo(main, theirs)?.message, "Every agent reads this one. Change it on OpenCode's page.");
  });

  it("gives a new agent a folder and a file of its own, and counts it among those reading every agent's", async () => {
    const main = await rig();
    const room = await main.chips.openRoom("Trip");
    const { askId } = await main.chips.askForAgent(room, "Nova");
    await main.chips.waitFor((event) => (event.type === "membership.added" && event.payload["made_for"] === askId ? event : undefined), 3000);
    const nova = (await main.client.agents.list()).find((agent) => agent.name === "Nova")?.agentId ?? "";
    await until(() => filesOf(main, nova));
    await hear(main, { frame: "context.edit", agent_id: nova, name: "AGENTS.md", text: "You are Nova.\n", base_hash: hashOf("") });
    assert.equal(readFileSync(join(main.folders, "nova", "AGENTS.md"), "utf8"), "You are Nova.\n");
    assert.equal(filesOf(main)?.files[0]?.["text"], "", "Main's own is its own");
    await until(() => sharedOf(main)?.shared[0]?.["used_by"] === 2);
  });

  it("from OpenCode 2.0.30, lists the files its config's instructions names: the agent's own, and the rest read only", async () => {
    const home = homeOfItsOwn();
    const folder = join(home, "chips-opencode", "agents", "opencode");
    write(join(folder, "RULES.md"), "Use tabs.\n");
    write(join(home, "notes", "STYLE.md"), "Short lines.\n");
    const instructions = ["RULES.md", "~/notes/STYLE.md", "https://example.com/rules.md"];
    const opencode = await startFakeOpenCode({ version: "2.0.30", instructions });
    open.push(() => opencode.close());
    const main = await rig({ home, opencode });
    const files = await until(() => filesOf(main));
    assert.deepEqual(
      files.files.map((file) => [file["name"], file["title"], file["editable"], file["text"]]),
      [
        ["AGENTS.md", "How it works", true, ""],
        ["RULES.md", "Named in OpenCode's config", true, "Use tabs.\n"],
        ["~ › chips-opencode › agents › AGENTS.md", "For every OpenCode agent", false, undefined],
        ["~ › notes › STYLE.md", "Named in OpenCode's config", false, undefined],
      ],
    );
    const named = (await until(() => sharedOf(main))).shared.find((file) => file["name"] === "~ › notes › STYLE.md");
    assert.deepEqual([named?.["text"], named?.["why_read_only"]], ["Short lines.\n", "OpenCode's config names it for every session."]);
    const ruled = await hear(main, { frame: "context.edit", agent_id: main.agentId, name: "RULES.md", text: "Use spaces.\n", base_hash: hashOf("Use tabs.\n") });
    assert.equal(answerTo(main, ruled)?.made, true);
    assert.equal(readFileSync(join(folder, "RULES.md"), "utf8"), "Use spaces.\n");
    // OpenCode 2.0.25 doesn't read them: none is shown.
    const older = await startFakeOpenCode({ version: "2.0.25", instructions });
    open.push(() => older.close());
    const before25 = await rig({ home: homeOfItsOwn(), opencode: older });
    assert.deepEqual((await until(() => filesOf(before25))).files.map((file) => file["name"]), ["AGENTS.md", "~ › chips-opencode › agents › AGENTS.md"]);
  });

  it("finds the files OpenCode would: up to the home folder, the config's in turn, and versions in order", () => {
    const home = homeOfItsOwn();
    const folder = join(home, "a", "b");
    write(join(folder, "docs", "one.md"), "1");
    write(join(folder, "docs", "two.md"), "2");
    write(join(home, "x.md"), "x");
    assert.deepEqual(upTo(folder, home), [folder, join(home, "a"), home]);
    assert.deepEqual(upTo("/elsewhere/c", home), ["/elsewhere/c"]);
    assert.deepEqual(namedFiles(["docs/*.md", `${home}/x.md`, "docs/one.md", "http://example.com/a.md"], folder, folder, home), [
      join(folder, "docs", "one.md"),
      join(folder, "docs", "two.md"),
      join(home, "x.md"),
    ]);
    assert.equal(existsSync(join(folder, "AGENTS.md")), false);
    assert.equal(before("2.0.25", "2.0.30"), true);
    assert.equal(before("2.1.0", "2.0.30"), false);
    assert.equal(before("2.0.30", "2.0.30"), false);
  });
});

describe("an agent's context window (Chips ADRs 0146, 0241)", () => {
  it("says how full its session is after a turn, of its model's window, and how full a long turn got", async () => {
    const main = await rig();
    assert.equal(windowOf(main), undefined, "nothing until it has said");
    await turn(main.chips, "one");
    const first = await until(() => windowOf(main));
    assert.deepEqual(
      { ...first, as_of: "" },
      { used: 1250, window: 200_000, model: "nous/heron-2", as_of: "", compacts: true, editable: false, why_read_only: OWN_LIMIT },
    );
    // Nearly full: OpenCode compacts it itself, and goes on.
    await turn(main.chips, "read the full logs");
    const after = await until(() => (windowOf(main)?.["long_turn"] === undefined ? undefined : windowOf(main)));
    assert.equal(after["used"], 1250);
    assert.deepEqual({ ...(after["last"] as Body), at: "" }, { at: "", from: 150_250, to: 1000, by: "itself" });
    assert.deepEqual({ ...(after["long_turn"] as Body), at: "" }, { at: "", peak: 150_250, folds: 1 });
    assert.ok(main.state.windows?.["opencode:build:opencode"] !== undefined, "kept for a restart");
  });

  it("compacts the session it said last from Chips: at once when idle, after its step when working", async () => {
    const main = await rig();
    const { chips, opencode, agentId } = main;
    await turn(chips, "one");
    await until(() => windowOf(main));
    const now = await hear(main, { frame: "context_window.compact", agent_id: agentId });
    assert.equal(answerTo(main, now)?.made, true);
    const done = await until(() => (windowOf(main)?.["last"] === undefined ? undefined : windowOf(main)));
    assert.deepEqual({ ...(done["last"] as Body), at: "" }, { at: "", from: 1250, to: 1000, by: "asked" });
    assert.equal(done["compacting"], undefined);
    assert.equal(done["used"], 1000);
    // Working: it waits for the step the session is on.
    const said = await chips.say("slow");
    const started = await chips.waitFor((event) => (event.type === "run.started" && event.seq > said.seq ? event : undefined), 3000);
    await until(() => opencode.prompts.length === 2);
    const later = await hear(main, { frame: "context_window.compact", agent_id: agentId });
    assert.equal(answerTo(main, later)?.made, true);
    assert.equal(windowOf(main)?.["compacting"], "queued");
    await chips.waitFor((event) => (event.type === "run.completed" && event.run_id === started.run_id ? event : undefined), 3000);
    const again = await until(() => {
      const copy = windowOf(main);
      return copy?.["compacting"] === undefined && (copy?.["last"] as Body)["at"] !== (done["last"] as Body)["at"] && copy;
    });
    assert.deepEqual([(again["last"] as Body)["from"], (again["last"] as Body)["by"]], [1250, "asked"]);
  });

  it("keeps OpenCode's own limit, and says why a compaction OpenCode didn't make failed", async () => {
    const opencode = await startFakeOpenCode({ compactFails: "Nothing to compact yet." });
    open.push(() => opencode.close());
    const main = await rig({ opencode });
    await turn(main.chips, "one");
    await until(() => windowOf(main));
    const limit = await hear(main, { frame: "context_window.change", agent_id: main.agentId, at: 80 });
    assert.deepEqual([answerTo(main, limit)?.made, answerTo(main, limit)?.message], [false, OWN_LIMIT]);
    const compact = await hear(main, { frame: "context_window.compact", agent_id: main.agentId });
    await until(() => answersTo(main, compact).length === 2);
    assert.deepEqual(
      answersTo(main, compact).map((answer) => [answer.made, answer.message]),
      [
        [true, undefined],
        [false, "Nothing to compact yet."],
      ],
    );
  });

  it("sends at start what an agent last said, from its sessions where the bridge kept nothing", async () => {
    const opencode = await startFakeOpenCode();
    open.push(() => opencode.close());
    const before = await rig({ opencode });
    await turn(before.chips, "one");
    const session = opencode.created[0]?.id ?? "";
    // A bridge from before it kept windows, on the same OpenCode.
    const after = await rig({ opencode, state: { sessions: { "opencode:build:opencode|spc_earlier": session } } });
    const copy = await until(() => windowOf(after));
    assert.deepEqual([copy["used"], copy["window"], copy["model"]], [1250, 200_000, "nous/heron-2"]);
    assert.equal(after.state.windows?.["opencode:build:opencode"]?.session, session);
  });

  it("counts what a compaction kept: the summary's tokens, and the recent words at four characters a token", () => {
    assert.equal(compactedTo({ tokens: { input: 1, output: 900, reasoning: 0, cache: { read: 0, write: 0 } }, recent: "r".repeat(400) }), 1000);
    assert.equal(compactedTo({}), 0);
  });
});
