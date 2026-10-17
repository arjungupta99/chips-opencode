/**
 * The bridge between Chips's conformance fake — the wire as Chips speaks it, every event checked
 * against the protocol's schemas — and a scripted OpenCode server.
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type FakeChips, type StoredEvent, startFakeChips } from "@chipschat/conformance";
import { type Chips, connect, type Decision } from "@chipschat/harness";
import { Bridge, type BridgeState, cardOf, decisionOf, keyOf, questionOf, spoken } from "../src/bridge.ts";
import { OpenCodeClient } from "../src/opencode.ts";
import { type FakeOpenCode, startFakeOpenCode, THOUGHTFUL } from "./fake-opencode.ts";

interface Rig {
  readonly chips: FakeChips;
  readonly client: Chips;
  readonly bridge: Bridge;
  readonly opencode: FakeOpenCode;
  readonly state: BridgeState;
  readonly agentId: string;
}

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close();
});

const AGENT = { name: "OpenCode", agent: "build" } as const;

async function rig(
  options: { state?: BridgeState; model?: string; directory?: string; chips?: FakeChips; folder?: string } = {},
): Promise<Rig> {
  const chips = options.chips ?? (await startFakeChips({ capabilities: ["agents"] }));
  if (options.chips === undefined) open.push(() => chips.close());
  const opencode = await startFakeOpenCode(options.folder === undefined ? {} : { directory: options.folder });
  open.push(() => opencode.close());
  const client = await connect({ url: chips.address.url, token: chips.address.token });
  const state = options.state ?? { sessions: {} };
  const bridge = new Bridge({
    chips: client,
    opencode: new OpenCodeClient({ url: opencode.url, password: opencode.password, directory: options.directory }),
    agents: [{ ...AGENT, ...(options.model === undefined ? {} : { model: options.model }) }],
    home: chips.address.spaceId,
    state,
    saveState: () => undefined,
    healthEveryMs: 50,
    reconnectMs: 50,
  });
  open.push(async () => {
    bridge.stop();
    client.close();
  });
  await bridge.start();
  return { chips, client, bridge, opencode, state, agentId: bridge.mainAgentId ?? "" };
}

async function until(done: () => boolean, timeoutMs = 3000): Promise<void> {
  const by = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > by) throw new Error(`not so within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function sent(chips: FakeChips, type: string, more: (event: StoredEvent) => boolean = () => true): Promise<StoredEvent> {
  return chips.waitFor((event) => (event.type === type && more(event) ? event : undefined), 3000);
}

const reply = (chips: FakeChips, runId: string | null | undefined) =>
  sent(chips, "message.post", (event) => event.run_id === runId);

// Its Main agent was "OpenCode 2" beside the "OpenCode" Chips made at the join (Chips ON-10).
describe("its Main agent (Chips ADR 0183)", () => {
  it("is the agent Chips made at the join, called what its config says, with no second", async () => {
    const chips = await startFakeChips({ capabilities: ["agents"], harnessName: AGENT.name });
    open.push(() => chips.close());
    const { client, agentId } = await rig({ chips });
    const agents = await client.agents.list();
    assert.deepEqual(
      agents.map((agent) => [agent.key, agent.name, agent.lead]),
      [[client.harnessId, AGENT.name, true]],
    );
    assert.equal(agentId, agents[0]?.agentId);
    assert.ok(agents[0]?.spaces.includes(chips.address.spaceId), "in its own room");
  });

  it("moves Main from one it made before, which it archives, and takes its room", async () => {
    const chips = await startFakeChips({ capabilities: ["agents"], harnessName: AGENT.name });
    open.push(() => chips.close());
    // As a bridge did before: its own Main, numbered beside the default, in the default's place.
    const before = await connect({ url: chips.address.url, token: chips.address.token });
    const known = await before.agents.list();
    const old = await before.agents.register({ key: keyOf(AGENT), name: AGENT.name, lead: true });
    await before.agents.attach(old.agentId, { spaceId: chips.address.spaceId, replacing: known[0]?.agentId ?? "" });
    before.close();
    assert.equal(old.name, `${AGENT.name} 2`);
    const { client, agentId } = await rig({ chips });
    const agents = await client.agents.list();
    const main = agents.find((agent) => agent.agentId === agentId);
    assert.deepEqual([main?.key, main?.name, main?.lead], [client.harnessId, AGENT.name, true]);
    assert.ok(main?.spaces.includes(chips.address.spaceId), "back in its own room");
    const gone = agents.find((agent) => agent.agentId === old.agentId);
    assert.deepEqual([gone?.lead, gone?.state], [false, "archived"]);
  });
});

// With its one agent Main, a group room could have none of it (Chips ON-12).
describe("a new agent a person asks for (Chips ADR 0108)", () => {
  it("joins the room it was asked for, once, however often the ask is heard", async () => {
    const chips = await startFakeChips({ capabilities: ["agents", "new_agents"] });
    open.push(() => chips.close());
    const { client, agentId } = await rig({ chips });
    const room = await chips.openRoom("Plans");
    const { askId } = await chips.askForAgent(room, "Nova");
    await sent(chips, "membership.added", (event) => event.payload["made_for"] === askId);
    const made = (await client.agents.list()).filter((agent) => agent.agentId !== agentId);
    assert.deepEqual(
      made.map((agent) => [agent.name, agent.lead, agent.spaces]),
      [["Nova", false, [room]]],
    );
  });

  it("answers in a session of its own, beside another asked for in the same room", async () => {
    const chips = await startFakeChips({ capabilities: ["agents", "new_agents"] });
    open.push(() => chips.close());
    const { client, agentId, opencode, state } = await rig({ chips });
    const room = await chips.openRoom("Plans");
    for (const name of ["Nova", "Vega"]) {
      const { askId } = await chips.askForAgent(room, name);
      await sent(chips, "membership.added", (event) => event.payload["made_for"] === askId);
    }
    const made = (await client.agents.list()).filter((agent) => agent.agentId !== agentId).map((agent) => agent.agentId);
    await chips.say("summarise the notes", room);
    await until(() => chips.workspace.log.filter((event) => event.type === "run.completed").length === 2);
    const took = chips.workspace.log.filter((event) => event.type === "run.started").map((event) => event.actor.id);
    assert.deepEqual([...took].sort(), [...made].sort(), "each took its turn as itself");
    assert.equal(opencode.created.length, 2, "two OpenCode sessions");
    assert.deepEqual(
      opencode.created.map((each) => (each.metadata as { chips_agent: string }).chips_agent).sort(),
      [...made].sort(),
    );
    assert.deepEqual(Object.keys(state.sessions).sort(), made.map((id) => `${id}|${room}`).sort());
  });
});

// OpenCode's agents answered with a path on this Mac, which no phone opens (Chips TT-7).
describe("the files an answer names", () => {
  it("sends each file a MEDIA: line names from its session's folder, and says what it couldn't send", async () => {
    const root = mkdtempSync(join(tmpdir(), "chips-opencode-files-"));
    open.push(async () => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "work"));
    writeFileSync(join(root, "work", "page.html"), "<p>play</p>");
    writeFileSync(join(root, "secret.txt"), "not OpenCode's");
    const { chips, opencode } = await rig({ folder: join(root, "work") });
    await chips.say("send the page");
    const started = await sent(chips, "run.started");
    const words = await sent(chips, "message.post", (event) => event.run_id === started.run_id);
    assert.equal(words.payload["text"], "The page is ready.\n\n(secret.txt was not attached: it is outside the agent's folder.)");
    const attachments = words.payload["attachments"] as { filename: string }[];
    assert.deepEqual(
      attachments.map((each) => each.filename),
      ["page.html"],
    );
    assert.match(opencode.prompts[0]?.text ?? "", /MEDIA:<path> on a line of its own/, "it was told how");
  });
});

describe("a turn", () => {
  it("is a run: a status, a step drawn by its kind, its last words, its exact cost and context, and the end", async () => {
    const { chips, agentId, opencode } = await rig({ model: "nous/heron-2", directory: "/work" });
    await chips.say("summarise the notes");
    const started = await sent(chips, "run.started");
    assert.equal(started.actor.id, agentId, "the Main agent took it");
    const status = await sent(chips, "run.status");
    assert.equal(status.payload["verb_phrase"], "Let me look at the notes.");
    const opened = await sent(chips, "step.log", (event) => event.payload["status"] === "started");
    assert.deepEqual(
      [opened.payload["step_id"], opened.payload["kind"], opened.payload["title"]],
      ["call_1", "file", "read · notes.md"],
    );
    const done = await sent(chips, "step.log", (event) => event.payload["status"] === "done");
    assert.equal(done.payload["summary"], "3 lines");
    const words = await reply(chips, started.run_id);
    assert.equal(words.payload["text"], "Here is the answer.", "its last words, not the ones on the way");
    const usage = await sent(chips, "usage");
    assert.deepEqual(
      [usage.payload["model"], usage.payload["input_tokens"], usage.payload["output_tokens"], usage.payload["scope"]],
      ["nous/heron-2", 1200, 50, "step"],
    );
    assert.equal((usage.payload["cost"] as { usd: number }).usd, 0.0042);
    const context = await sent(chips, "context.usage");
    assert.deepEqual([context.payload["used_tokens"], context.payload["limit_tokens"]], [1250, 200_000]);
    await sent(chips, "run.completed");
    assert.deepEqual(opencode.created[0]?.agent, "build");
    assert.deepEqual(opencode.created[0]?.model, { providerID: "nous", id: "heron-2" });
    assert.deepEqual(opencode.created[0]?.location, { directory: "/work" });
    assert.match(opencode.prompts[0]?.text ?? "", /summarise the notes$/);
  });

  it("says its answer without the thinking a model wrote into it (Chips, 17 October 2026)", async () => {
    const { chips } = await rig();
    await chips.say("think it over and make a table");
    const started = await sent(chips, "run.started");
    const words = await reply(chips, started.run_id);
    assert.equal(words.payload["text"], THOUGHTFUL);
    const completed = await sent(chips, "run.completed");
    assert.equal(completed.payload["summary"], THOUGHTFUL);
    assert.equal(spoken("No thinking here."), "No thinking here.");
  });

  it("keeps one OpenCode session per room, and a second message is the same session", async () => {
    const { chips, opencode, state } = await rig();
    await chips.say("one");
    await sent(chips, "run.completed");
    await chips.say("two");
    await chips.waitFor((event) => (event.type === "run.completed" && opencode.prompts.length === 2 ? event : undefined), 3000);
    assert.equal(opencode.created.length, 1);
    const [first, second] = opencode.prompts;
    assert.equal(first?.sessionId, second?.sessionId);
    assert.deepEqual(Object.values(state.sessions), [first?.sessionId]);
  });

  it("makes the room a new session when OpenCode no longer has its own", async () => {
    const { chips, opencode, state } = await rig();
    await chips.say("one");
    await sent(chips, "run.completed");
    opencode.forget(opencode.created[0]?.id ?? "");
    await chips.say("two");
    await until(() => opencode.created.length === 2);
    await chips.waitFor((event) => (event.type === "message.post" && event.payload["text"] === "Here is the answer." && opencode.prompts.length === 2 ? event : undefined), 3000);
    assert.deepEqual(Object.values(state.sessions), [opencode.created[1]?.id]);
  });

  it("counts a sub-agent as a handoff, and its child session's cost as the run's", async () => {
    const { chips } = await rig();
    await chips.say("delegate the quotes");
    const step = await sent(chips, "step.log", (event) => event.payload["status"] === "done");
    assert.deepEqual([step.payload["tool"], step.payload["summary"]], ["subagent", "Three quotes found."]);
    const child = await sent(chips, "usage", (event) => event.payload["model"] === "nous/heron-mini");
    assert.equal(child.payload["scope"], "step");
    const started = await sent(chips, "run.started");
    assert.equal((await reply(chips, started.run_id)).payload["text"], "Quotes are in.");
  });

  it("fails when OpenCode does, saying why", async () => {
    const { chips } = await rig();
    await chips.say("fail");
    const failed = await sent(chips, "run.failed");
    assert.equal(failed.payload["error"], "OpenCode: The model refused.");
  });

  it("reads the end of a run whose events were missed while the stream was down", async () => {
    const { chips } = await rig();
    await chips.say("drop the line");
    const started = await sent(chips, "run.started");
    const words = await reply(chips, started.run_id);
    assert.equal(words.payload["text"], "Here is the answer.");
    await sent(chips, "run.completed");
  });
});

describe("what it asks", () => {
  it("asks on a card by the step, and gives OpenCode the person's always", async () => {
    const { chips, opencode } = await rig();
    await chips.say("ask first");
    const asked = await sent(chips, "approval.request");
    assert.equal(asked.payload["question"], "Run `npm test`?");
    assert.deepEqual(asked.payload["action"], { kind: "shell.exec", input: { command: "npm test" } });
    assert.equal(asked.payload["step_id"], "call_1");
    await chips.decide(String(asked.payload["approval_id"]), "approved", { scope: "always" });
    assert.equal((await reply(chips, asked.run_id)).payload["text"], "Given: always");
    const executed = await sent(chips, "approval.executed");
    assert.equal(executed.payload["outcome"], "executed", "the allowed call said how it went");
    assert.deepEqual(opencode.permissionReplies, [{ requestId: "per_1", decision: "always", message: undefined }]);
  });

  it("gives OpenCode reject, and the person's reason, when they say no", async () => {
    const { chips, opencode } = await rig();
    await chips.say("ask first");
    const asked = await sent(chips, "approval.request");
    await chips.decide(String(asked.payload["approval_id"]), "denied", { reason: "Not on main." });
    assert.equal((await reply(chips, asked.run_id)).payload["text"], "Given: reject");
    assert.deepEqual(opencode.permissionReplies, [{ requestId: "per_1", decision: "reject", message: "Not on main." }]);
  });

  it("settles a card answered in OpenCode's own apps", async () => {
    const { chips } = await rig();
    await chips.say("clean up, answered elsewhere");
    const asked = await sent(chips, "approval.request");
    const settled = await sent(chips, "approval.resolved", (event) => event.payload["approval_id"] === asked.payload["approval_id"]);
    assert.deepEqual(
      [settled.payload["decision"], settled.payload["scope"], settled.payload["reason"]],
      ["approved", "once", "Answered in OpenCode."],
    );
  });

  it("asks OpenCode's question in Chips, and gives it the answer", async () => {
    const { chips, opencode } = await rig();
    await chips.say("a question for you");
    const asked = await sent(chips, "question.ask");
    const [question] = asked.payload["questions"] as Record<string, unknown>[];
    assert.equal(question?.["prompt"], "Which colour?");
    assert.equal(question?.["allow_free_text"], true);
    await chips.answer(String(asked.payload["ask_id"]), { q0: ["Blue"] });
    assert.equal((await reply(chips, asked.run_id)).payload["text"], "Chose: Blue");
    assert.deepEqual(opencode.formReplies, [{ formId: "frm_1", answer: { q0: "Blue" } }]);
  });

  it("picks always only when the person did, and reject for a no", () => {
    const decision = (scope: Decision["scope"], allowed = true) => ({ allowed, scope }) as Decision;
    assert.equal(decisionOf(decision("always")), "always");
    assert.equal(decisionOf(decision("session")), "once");
    assert.equal(decisionOf(decision("once", false)), "reject");
  });

  it("shows an edit's diff, and a yes-or-no field as two choices, and leaves free text to OpenCode", () => {
    const card = cardOf({ action: "edit", resources: ["src/a.ts"], metadata: { files: [{ file: "src/a.ts", patch: "-a\n+b" }] } });
    assert.equal(card.question, "Change a.ts?");
    assert.deepEqual(card.preview, { format: "diff", title: "src/a.ts", body: "-a\n+b" });
    const yes = questionOf({ key: "go", type: "boolean", title: "Go on?" }, "Questions");
    assert.deepEqual(yes?.options.map((option) => option.value), ["yes", "no"]);
    assert.equal(questionOf({ key: "name", type: "string", title: "Your name" }, "Questions"), undefined);
  });
});

describe("what a person does to it", () => {
  it("interrupts the session when a person stops the run", async () => {
    const { chips, opencode } = await rig();
    await chips.say("slow");
    const started = await sent(chips, "run.started");
    await until(() => opencode.prompts.length > 0);
    await chips.asOwner({ type: "run.cancel", space_id: started.space_id, run_id: started.run_id });
    await until(() => opencode.interrupts.length > 0);
    assert.deepEqual(opencode.interrupts, [opencode.prompts[0]?.sessionId]);
  });

  it("steers the session while it goes", async () => {
    const { chips, opencode } = await rig();
    await chips.say("slow");
    const started = await sent(chips, "run.started");
    await until(() => opencode.prompts.length > 0);
    await chips.asOwner({ type: "run.steer", space_id: started.space_id, run_id: started.run_id, text: "Shorter, please.", mode: "steer" });
    await until(() => opencode.prompts.length === 2);
    assert.equal(opencode.prompts[1]?.delivery, "steer");
    assert.match(opencode.prompts[1]?.text ?? "", /adds: Shorter, please\.$/);
    assert.equal((await reply(chips, started.run_id)).payload["text"], "Slowly done.");
  });

  it("queues a follow-up, and the run ends after it", async () => {
    const { chips, opencode } = await rig();
    await chips.say("slow");
    const started = await sent(chips, "run.started");
    await until(() => opencode.prompts.length > 0);
    await chips.asOwner({ type: "run.steer", space_id: started.space_id, run_id: started.run_id, text: "Then the notes.", mode: "followup" });
    assert.equal((await reply(chips, started.run_id)).payload["text"], "Here is the answer.");
    assert.equal(opencode.prompts[1]?.delivery, "queue");
  });

  it("interrupts the session and goes on with the person's words", async () => {
    const { chips, opencode } = await rig();
    await chips.say("slow");
    const started = await sent(chips, "run.started");
    await until(() => opencode.prompts.length > 0);
    await chips.asOwner({ type: "run.steer", space_id: started.space_id, run_id: started.run_id, text: "Just summarise.", mode: "interrupt" });
    assert.equal((await reply(chips, started.run_id)).payload["text"], "Here is the answer.");
    assert.equal(opencode.interrupts.length, 1);
    assert.equal(opencode.prompts[1]?.delivery, undefined);
    assert.match(opencode.prompts[1]?.text ?? "", /adds: Just summarise\.$/);
  });
});

describe("its health", () => {
  it("says it is in trouble while OpenCode doesn't answer, and fine once it does", async () => {
    const { chips, opencode } = await rig();
    opencode.up = false;
    await until(() => chips.statuses().some((status) => status.state === "trouble"));
    assert.equal(chips.statuses().at(-1)?.reason, "OpenCode isn't answering");
    opencode.up = true;
    await until(() => chips.statuses().at(-1)?.state === "ok");
  });
});
