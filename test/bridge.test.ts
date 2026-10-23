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
import { createIdGenerator, messageIdOf } from "@chipschat/protocol";
import {
  Bridge,
  type BridgeState,
  cardOf,
  decisionOf,
  forkName,
  freeFolder,
  keyOf,
  questionOf,
  secondLook,
  spoken,
  WANTS,
} from "../src/bridge.ts";
import { OpenCodeClient } from "../src/opencode.ts";
import { AGAIN, type FakeOpenCode, startFakeOpenCode, THOUGHTFUL } from "./fake-opencode.ts";

interface Rig {
  readonly chips: FakeChips;
  readonly client: Chips;
  readonly bridge: Bridge;
  readonly opencode: FakeOpenCode;
  readonly state: BridgeState;
  readonly agentId: string;
  /** What the bridge logged. */
  readonly lines: string[];
}

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0).reverse()) await close();
});

const AGENT = { name: "OpenCode", agent: "build" } as const;

async function rig(
  options: { state?: BridgeState; model?: string; directory?: string; chips?: FakeChips; folder?: string; folders?: string } = {},
): Promise<Rig> {
  const chips = options.chips ?? (await startFakeChips({ capabilities: ["agents"] }));
  if (options.chips === undefined) open.push(() => chips.close());
  const opencode = await startFakeOpenCode(options.folder === undefined ? {} : { directory: options.folder });
  open.push(() => opencode.close());
  const client = await connect({ url: chips.address.url, token: chips.address.token });
  const state = options.state ?? { sessions: {} };
  const lines: string[] = [];
  const bridge = new Bridge({
    chips: client,
    opencode: new OpenCodeClient({ url: opencode.url, password: opencode.password, directory: options.directory }),
    agents: [{ ...AGENT, ...(options.model === undefined ? {} : { model: options.model }) }],
    home: chips.address.spaceId,
    state,
    saveState: () => undefined,
    healthEveryMs: 50,
    reconnectMs: 50,
    log: (line) => lines.push(line),
    ...(options.folders === undefined ? {} : { folders: options.folders }),
  });
  open.push(async () => {
    bridge.stop();
    client.close();
  });
  await bridge.start();
  return { chips, client, bridge, opencode, state, agentId: bridge.mainAgentId ?? "", lines };
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A person's feedback on a message, as Chips hands it to the harness whose message it is, with who
 * gave it (Chips ADR 0200). The fake's door has no `from` to fill in for one, so it goes in past it.
 */
function feedback(chips: FakeChips, fields: Readonly<Record<string, unknown>>): void {
  const { participantId, displayName } = chips.workspace.owner;
  appended(chips, {
    type: "feedback",
    space_id: chips.address.spaceId,
    from: { participant_id: participantId, kind: "person", display_name: displayName, role: "owner" },
    ...fields,
  });
}

/** An event in the fake's log past its door, which fills in what a person may not. */
function appended(chips: FakeChips, event: Readonly<Record<string, unknown>>): StoredEvent {
  return (chips.workspace as unknown as { appendSystem(event: Record<string, unknown>): StoredEvent }).appendSystem({ ...event });
}

/** The message an agent said in a room, as the room's lines name it. */
async function saidBy(client: Chips, spaceId: string, agentId: string): Promise<string> {
  const lines = (await client.roomContext(spaceId, { limit: 200 })).lines;
  return lines.find((line) => line.kind === "said" && line.from.id === agentId)?.message_id ?? "";
}

const count = (chips: FakeChips, type: string) => chips.workspace.log.filter((event) => event.type === type).length;

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

  it("makes each agent's sessions in a folder of its own, named after it, and sends its files from there", async () => {
    const root = mkdtempSync(join(tmpdir(), "chips-opencode-folders-"));
    open.push(async () => rmSync(root, { recursive: true, force: true }));
    const { chips, opencode, state } = await rig({ folders: root });
    const own = join(root, "opencode");
    await chips.say("hello");
    await sent(chips, "run.completed");
    assert.deepEqual(opencode.created[0]?.location, { directory: own });
    assert.deepEqual(Object.values(state.folders ?? {}), [own]);
    writeFileSync(join(own, "page.html"), "<p>play</p>");
    await chips.say("send the page");
    const words = await chips.waitFor(
      (event) => (event.type === "message.post" && (event.payload["attachments"] as unknown[] | undefined)?.length ? event : undefined),
      3000,
    );
    assert.deepEqual(
      (words.payload["attachments"] as { filename: string }[]).map((each) => each.filename),
      ["page.html"],
    );
    assert.equal(opencode.created.length, 1, "the room's one session, in the agent's folder");
  });

  it("names a folder after its agent, and another after a second agent of that name", () => {
    assert.equal(freeFolder("/a", "Planner Two", []), "/a/planner-two");
    assert.equal(freeFolder("/a", "Planner Two", ["/a/planner-two"]), "/a/planner-two-2");
    assert.equal(freeFolder("/a", "🙂", []), "/a/agent");
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
    assert.deepEqual([usage.payload["cache_read_tokens"], usage.payload["cache_write_tokens"]], [200, 0]);
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

  it("hands the agent the message a reply answers, after what was said and before the words (Chips ADR 0219)", async () => {
    const { chips, opencode } = await rig();
    await chips.say("summarise the notes");
    const started = await sent(chips, "run.started");
    const answer = await sent(chips, "message.post", (event) => event.run_id === started.run_id);
    await sent(chips, "run.completed");
    await chips.say("Shorter, please", undefined, { replyTo: messageIdOf(answer.id) });
    await chips.waitFor((event) => (event.type === "run.completed" && opencode.prompts.length === 2 ? event : undefined), 3000);
    const prompt = opencode.prompts[1]?.text ?? "";
    const quote = String(answer.payload["text"])
      .split("\n")
      .map((line) => (line === "" ? ">" : `> ${line}`))
      .join("\n");
    assert.match(prompt, /Arjun is replying to your message from today at \d{1,2}:\d{2} [AP]M\.\nYour message:\n/);
    assert.ok(prompt.includes(`Your message:\n${quote}\n\n`), prompt);
    assert.match(prompt, /Shorter, please$/);
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

// Chips offered Not right? on an agent's message, and only Jacobian answered it (Chips ADR 0200).
describe("a person's Not right?", () => {
  const NOTE = "Missed what I asked. Sunday is our flight home.";

  it("is a run by the agent who said it, in its session for the room, with its reply and the note", async () => {
    const chips = await startFakeChips({ capabilities: ["agents", "new_agents"] });
    open.push(() => chips.close());
    const { client, agentId, opencode, state } = await rig({ chips });
    const room = await chips.openRoom("Trip");
    for (const name of ["Nova", "Vega"]) {
      const { askId } = await chips.askForAgent(room, name);
      await sent(chips, "membership.added", (event) => event.payload["made_for"] === askId);
    }
    const vega = (await client.agents.list()).find((agent) => agent.agentId !== agentId && agent.name === "Vega")?.agentId ?? "";
    await chips.say("when do we fly home?", room);
    await until(() => count(chips, "run.completed") === 2);
    feedback(chips, { space_id: room, message_id: await saidBy(client, room, vega), kind: "correction", text: NOTE });
    const started = await sent(chips, "run.started", (event) => event.payload["goal"] === `Looking again: ${NOTE}`);
    assert.equal(started.actor.id, vega, "the agent who said it");
    assert.equal((await reply(chips, started.run_id)).payload["text"], AGAIN);
    await sent(chips, "run.completed", (event) => event.run_id === started.run_id);
    assert.equal(opencode.created.length, 2, "no new session");
    const again = opencode.prompts.at(-1);
    assert.equal(again?.sessionId, state.sessions[`${vega}|${room}`], "Vega's own in the room");
    assert.match(
      again?.text ?? "",
      new RegExp(
        "(?:^|\n\n)Arjun says your reply in this room wasn't right\\.\n\nYour reply:\n«Here is the answer\\.»\n\n" +
          `What wasn't right: «${NOTE.replace(/\./g, "\\.")}»\n\nLook at it again and answer properly in its place\\.`,
      ),
    );
    assert.doesNotMatch(again?.text ?? "", /Arjun \(owner\): /, "no name in front of words that say who");
    const ordinary = opencode.prompts.find((each) => each.sessionId === again?.sessionId);
    assert.match(ordinary?.text ?? "", /\n\nArjun \(owner\): when do we fly home\?$/, "an ordinary turn's words still say who");
    const posts = chips.workspace.log.filter((event) => event.type === "message.post" && event.run_id === started.run_id);
    assert.equal(posts.length, 1, "nothing said in the room but its answer");
  });

  it("is nothing for a 👍, or any other reaction", async () => {
    const { chips, client, agentId, opencode } = await rig();
    await chips.say("one");
    await sent(chips, "run.completed");
    const messageId = await saidBy(client, chips.address.spaceId, agentId);
    feedback(chips, { message_id: messageId, kind: "reaction", reaction: "👍" });
    feedback(chips, { message_id: messageId, kind: "reaction", reaction: "🎉" });
    await chips.say("two");
    await until(() => count(chips, "run.completed") === 2);
    await sleep(150);
    assert.equal(count(chips, "run.started"), 2);
    assert.equal(opencode.prompts.length, 2);
  });

  it("takes a 👎 from a device from before it as the same, saying they didn't say what", async () => {
    const { chips, client, agentId, opencode } = await rig();
    await chips.say("one");
    await sent(chips, "run.completed");
    feedback(chips, { message_id: await saidBy(client, chips.address.spaceId, agentId), kind: "reaction", reaction: "👎" });
    const started = await sent(chips, "run.started", (event) => event.payload["goal"] === "Looking again at its reply");
    assert.equal((await reply(chips, started.run_id)).payload["text"], AGAIN);
    const again = opencode.prompts[1]?.text ?? "";
    assert.match(again, /«Here is the answer\.»\n\nThey didn't say what\. Read your reply again and find what was wrong\.\n\n/);
    assert.doesNotMatch(again, /What wasn't right/);
    assert.equal(opencode.prompts[1]?.sessionId, opencode.prompts[0]?.sessionId);
  });

  it("answers a feedback once, however often it is heard", async () => {
    const { chips, client, agentId, opencode } = await rig();
    await chips.say("one");
    await sent(chips, "run.completed");
    const same = { id: createIdGenerator().next("event"), message_id: await saidBy(client, chips.address.spaceId, agentId) };
    feedback(chips, { ...same, kind: "correction", text: "Too long." });
    feedback(chips, { ...same, kind: "correction", text: "Too long." });
    const started = await sent(chips, "run.started", (event) => event.payload["goal"] === "Looking again: Too long.");
    await sent(chips, "run.completed", (event) => event.run_id === started.run_id);
    await sleep(150);
    assert.equal(count(chips, "run.started"), 2);
    assert.equal(opencode.prompts.length, 2);
  });

  it("goes to the room's own agent for a message the room doesn't have, with no reply to quote", async () => {
    const { chips, agentId, opencode } = await rig();
    feedback(chips, { message_id: createIdGenerator().next("message"), kind: "correction", text: "Wrong facts." });
    const started = await sent(chips, "run.started");
    assert.equal(started.payload["goal"], "Looking again: Wrong facts.");
    assert.equal(started.actor.id, agentId);
    assert.equal((await reply(chips, started.run_id)).payload["text"], AGAIN);
    const again = opencode.prompts[0]?.text ?? "";
    assert.match(again, /(?:^|\n\n)Arjun says your reply in this room wasn't right\.\n\nWhat wasn't right: «Wrong facts\.»/);
    assert.doesNotMatch(again, /Your reply:|Arjun \(owner\): /);
  });

  it("quotes at most 1500 characters of the reply, and calls the run by the note's first line, at most 120", () => {
    const look = secondLook("Arjun", "a".repeat(2000), `${"b".repeat(200)}\nAnd more.`);
    assert.equal(/«(a+…)»/.exec(look.text)?.[1]?.length, 1500);
    assert.equal(look.goal.length, 120);
    assert.match(look.goal, /^Looking again: b+…$/);
  });
});

// Fork was offered for Jacobian's agents and ACP's, never OpenCode's (Chips ADR 0087).
describe("a copy a person asks for (Chips ADR 0087, Fork)", () => {
  /** Nova, an agent asked for in a room, of a harness that makes copies. */
  async function withNova(options: { folders?: string } = {}) {
    const chips = await startFakeChips({ capabilities: ["agents", "new_agents", "forks"] });
    open.push(() => chips.close());
    const made = await rig({ chips, ...options });
    const room = await chips.openRoom("Trip");
    const { askId } = await chips.askForAgent(room, "Nova");
    await sent(chips, "membership.added", (event) => event.payload["made_for"] === askId);
    const nova = (await made.client.agents.list()).find((agent) => agent.name === "Nova")?.agentId ?? "";
    return { ...made, room, nova };
  }
  const madeCopies = (lines: readonly string[]) => lines.filter((line) => line.includes(", a copy of Nova, made")).length;

  it("is a copy in the room asked for, called after it, in its folder, that remembers what it heard", async () => {
    const root = mkdtempSync(join(tmpdir(), "chips-opencode-fork-"));
    open.push(async () => rmSync(root, { recursive: true, force: true }));
    const { chips, client, opencode, state, room, nova, lines } = await withNova({ folders: root });
    await chips.say("when do we fly home?", room);
    await sent(chips, "run.completed");
    const original = state.sessions[`${nova}|${room}`];
    const second = await chips.openRoom("Second opinion");
    const { forkId } = await chips.askForFork(nova, second);
    const joined = await sent(chips, "membership.added", (event) => event.payload["fork_of"] === forkId);
    await until(() => madeCopies(lines) === 1);
    const copy = (await client.agents.list()).find((agent) => agent.agentId === joined.payload["participant_id"]);
    assert.deepEqual(
      [copy?.key, copy?.name, copy?.forkedFrom, copy?.spaces],
      [`opencode:fork:${forkId}`, "Nova · fork", nova, [second]],
    );
    const copied = state.sessions[`${copy?.agentId}|${second}`];
    assert.deepEqual(opencode.forks, [{ from: original, to: copied }]);
    assert.equal(state.folders?.[copy?.agentId ?? ""], join(root, "nova"), "the original's folder");
    assert.equal(state.folders?.[nova], join(root, "nova"));
    assert.deepEqual(opencode.updates, [
      { sessionId: copied, title: `Chips room ${second}`, metadata: { chips_space: second, chips_agent: copy?.agentId } },
    ]);
    await chips.say("recall", second);
    const started = await sent(chips, "run.started", (event) => event.space_id === second);
    assert.equal(started.actor.id, copy?.agentId);
    assert.equal((await reply(chips, started.run_id)).payload["text"], "First said here: Arjun (owner): when do we fly home?");
    assert.equal(opencode.prompts.at(-1)?.sessionId, copied, "its copied session");
    assert.equal(opencode.created.length, 1, "and no new one");
  });

  it("makes one copy of an ask, however often it is heard", async () => {
    const { chips, client, opencode, state, room, nova, lines } = await withNova();
    await chips.say("one", room);
    await sent(chips, "run.completed");
    const second = await chips.openRoom("Second opinion");
    const { forkId } = await chips.askForFork(nova, second);
    // The same ask again, as a replay brings it: at once, and once the copy is made.
    const { seq: _seq, ...ask } = chips.workspace.log.find((event) => event.id === forkId)?.payload ?? {};
    appended(chips, ask);
    await until(() => madeCopies(lines) >= 1);
    appended(chips, ask);
    await until(() => madeCopies(lines) >= 2);
    await sleep(150);
    assert.equal(opencode.forks.length, 1, "one session copied");
    const copies = (await client.agents.list()).filter((agent) => agent.forkedFrom === nova);
    assert.equal(copies.length, 1, "one copy");
    assert.deepEqual(Object.keys(state.forks ?? {}), [forkId]);
    assert.equal(state.sessions[`${copies[0]?.agentId}|${second}`], opencode.forks[0]?.to);
  });

  it("takes the copy's turns in its own session and the original's in its own, each its own work", async () => {
    const { chips, client, opencode, state, room, nova, lines } = await withNova();
    await chips.say("when do we fly home?", room);
    await sent(chips, "run.completed");
    const second = await chips.openRoom("Second opinion");
    await chips.askForFork(nova, second);
    await until(() => madeCopies(lines) === 1);
    const copy = (await client.agents.list()).find((agent) => agent.forkedFrom === nova)?.agentId ?? "";
    const [mine, its] = [state.sessions[`${nova}|${room}`], state.sessions[`${copy}|${second}`]];
    // The original works slowly while its copy answers beside it.
    await chips.say("slow", room);
    await until(() => opencode.prompts.length === 2);
    await chips.say("recall", second);
    await until(() => count(chips, "run.completed") === 3);
    const runOf = (spaceId: string) =>
      chips.workspace.log.findLast((event) => event.type === "run.started" && event.space_id === spaceId);
    const [slow, recalled] = [runOf(room), runOf(second)];
    assert.deepEqual([slow?.actor.id, recalled?.actor.id], [nova, copy]);
    assert.equal((await reply(chips, slow?.run_id)).payload["text"], "Slowly done.");
    assert.equal((await reply(chips, recalled?.run_id)).payload["text"], "First said here: Arjun (owner): when do we fly home?");
    const usages = (runId: string | null | undefined) =>
      chips.workspace.log.filter((event) => event.type === "usage" && event.run_id === runId).length;
    assert.deepEqual([usages(slow?.run_id), usages(recalled?.run_id)], [1, 1], "each run's cost its own");
    assert.deepEqual(
      opencode.prompts.slice(1).map((each) => [each.sessionId, each.text.split("\n").at(-1)]),
      [
        [mine, "Arjun (owner): slow"],
        [its, "Arjun (owner): recall"],
      ],
    );
    assert.ok(!opencode.historyOf(mine ?? "").includes("Arjun (owner): recall"), "they remember apart");
  });

  it("copies an agent that never spoke as a new one, in the original's folder", async () => {
    const root = mkdtempSync(join(tmpdir(), "chips-opencode-fork-"));
    open.push(async () => rmSync(root, { recursive: true, force: true }));
    const { chips, client, opencode, state, nova, lines } = await withNova({ folders: root });
    const second = await chips.openRoom("Second opinion");
    await chips.askForFork(nova, second);
    await until(() => madeCopies(lines) === 1);
    assert.ok(lines.some((line) => line === "Nova never spoke in its room: its copy starts with nothing to remember"));
    assert.deepEqual(opencode.forks, []);
    const copy = (await client.agents.list()).find((agent) => agent.forkedFrom === nova)?.agentId ?? "";
    assert.equal(state.folders?.[copy], join(root, "nova"));
    await chips.say("hello", second);
    await sent(chips, "run.completed");
    assert.deepEqual(
      opencode.created.map((each) => [each.location, (each.metadata as { chips_agent: string }).chips_agent]),
      [[{ directory: join(root, "nova") }, copy]],
    );
  });

  it("makes no copy of an agent not the harness's, nor for an ask its room stopped waiting for", async () => {
    const { chips, client, opencode, state, nova, lines } = await withNova();
    const before = await client.agents.list();
    const by = chips.workspace.owner.participantId;
    const actor = { kind: "person", id: by };
    // An agent Chips has never had: none of its, nor any other harness's.
    const stranger = createIdGenerator().next("agent");
    appended(chips, { type: "agent.fork", actor, space_id: chips.address.spaceId, agent_id: stranger, by });
    await until(() => lines.some((line) => line === `no copy of ${stranger} for ${chips.address.spaceId}: it isn't one of this harness's agents`));
    const second = await chips.openRoom("Second opinion");
    const ts = new Date(Date.now() - 2 * 60_000).toISOString();
    appended(chips, { type: "agent.fork", actor, space_id: second, agent_id: nova, by, ts });
    await until(() => lines.some((line) => line.endsWith("and the room has stopped waiting")));
    assert.equal((await client.agents.list()).length, before.length);
    assert.deepEqual(opencode.forks, []);
    assert.equal(state.forks, undefined);
  });

  it("asks to make copies when it joins, and calls a copy after its original", () => {
    assert.ok(WANTS.includes("forks"));
    assert.equal(forkName("Nova"), "Nova · fork");
    assert.equal(forkName("Nova · fork 2"), "Nova · fork");
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
