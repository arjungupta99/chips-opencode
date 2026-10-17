/**
 * OpenCode as one Chips harness, on its V2 server. Each configured OpenCode agent (`build`, `plan`,
 * or one of the person's own) is a Chips agent (ADR 0087), registered by its own key. The first is
 * the harness's Main agent, in the harness's own room in the place of the default agent Chips gave
 * the harness there, and it answers for that default agent, and for any other of the harness's
 * Chips doesn't name here: a new agent a person asks for in a room (Chips ADR 0108) is one. A room
 * an agent is in is one OpenCode session of that agent, made the first time somebody there speaks
 * to it, and kept across restarts: it shows in OpenCode's own apps too.
 *
 * A message for an agent is a run:
 * - The words go to the session's inbox (`POST …/prompt`): the room note, what was said, and the
 *   words. The run is the session's work from the moment it takes them until it is idle again.
 * - Its reasoning, interim words and retries are the run's status.
 * - Its tool calls are steps, drawn by kind. A sub-agent is a step, and its child session's cost
 *   and asks are the run's.
 * - What it asks before acting is an approval card, and its questions are Chips questions.
 * - Each model call says its exact cost and tokens, and how full the context is.
 * - At the end come its last words in the room.
 * - Stop interrupts the session. A steer, a follow-up and an interrupt are OpenCode's own `steer`,
 *   `queue`, and interrupt-then-prompt.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Agent, ApprovalInput, Chips, Decision, Run, Speaker } from "@chipschat/harness";
import { promptFor, sendAnswer } from "@chipschat/harness";
import { type AgentAsked, createIdGenerator, type MessageNew, type StepKind } from "@chipschat/protocol";
import {
  type FormAnswer,
  type ModelRef,
  modelRefOf,
  type OpenCodeClient,
  OpenCodeError,
  type OpenCodeEvent,
  type PermissionDecision,
} from "./opencode.js";

export interface AgentConfig {
  /** What a person sees, and its @handle: `OpenCode`. */
  readonly name: string;
  /** The OpenCode agent: `build`, `plan`, or one of the person's own. */
  readonly agent: string;
  /** `provider/model` for its sessions, when not the agent's own. */
  readonly model?: string | undefined;
}

/** What the bridge keeps across restarts beside the SDK's own store. */
export interface BridgeState {
  /**
   * `<agent key>|<space id>` → the OpenCode session that room is; for an agent not configured here,
   * its Chips id in the place of the key.
   */
  sessions: Record<string, string>;
  /** Each agent's own folder, by whose sessions they are (`Room.who`), made the first time it is needed. */
  folders?: Record<string, string>;
}

export interface BridgeOptions {
  readonly chips: Chips;
  readonly opencode: OpenCodeClient;
  readonly agents: readonly AgentConfig[];
  /** The harness's own room, where its Main agent lives. */
  readonly home?: string | undefined;
  readonly state: BridgeState;
  readonly saveState: (state: BridgeState) => void;
  readonly log?: ((line: string) => void) | undefined;
  /**
   * Where each agent gets a folder of its own, named after it, that its sessions work in. Without
   * it every session works in the project: the config's `directory`, else the server's own.
   */
  readonly folders?: string | undefined;
  /** How often the server is asked whether it is up. */
  readonly healthEveryMs?: number | undefined;
  /** How long after the event stream drops it is opened again, at first. */
  readonly reconnectMs?: number | undefined;
}

/** A folder under `root` named after an agent, `-2` and on when another agent has that one. */
export function freeFolder(root: string, name: string, taken: readonly string[]): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "agent";
  for (let count = 1; ; count += 1) {
    const folder = join(root, count === 1 ? slug : `${slug}-${count}`);
    if (!taken.includes(folder)) return folder;
  }
}

/** Ids for the cards asked here, made before the ask so OpenCode's own answer can find its card. */
const ids = createIdGenerator();

/** How often a run's status may change, so a stream of thoughts isn't a stream of events. */
const QUIET_MS = 1500;
/** Held in a turn's waiting words while an interrupt stops the session, so its end isn't the turn's. */
const INTERRUPTING = "interrupting";

/**
 * What kind of call each of OpenCode's own tools is, in Chips's words (Chips ADR 0162). A tool not
 * here, an MCP server's say, is left to Chips to read by its name.
 */
const KINDS: Readonly<Record<string, StepKind>> = {
  shell: "shell",
  read: "file",
  list_mcp_resources: "file",
  read_mcp_resource: "file",
  glob: "search",
  grep: "search",
  websearch: "search",
  webfetch: "web",
  edit: "edit",
  write: "edit",
  patch: "edit",
  subagent: "handoff",
};

/** A Chips agent's key for a configured OpenCode agent. */
export function keyOf(agent: Pick<AgentConfig, "name" | "agent">): string {
  return `opencode:${agent.agent.toLowerCase()}:${agent.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

interface Running {
  readonly config: AgentConfig;
  readonly key: string;
  readonly model: ModelRef | undefined;
  agentId: string;
}

/** A message for one of the harness's Chips agents, and which: the one that answers it. */
interface Asked {
  readonly message: MessageNew;
  /** The Chips agent it was for, or none where Chips named only the harness. */
  readonly speakerId: string | undefined;
}

interface Room {
  /** Which agent's session in which room: its key in `BridgeState.sessions`. */
  readonly id: string;
  /** Whose session it is: the agent's key, or the Chips id of one not configured here. */
  readonly who: string;
  readonly agent: Running;
  readonly spaceId: string;
  readonly queue: Asked[];
  busy: boolean;
}

/** How the session's work ended. */
interface End {
  readonly outcome: "succeeded" | "failed" | "interrupted";
  readonly why?: string | undefined;
}

/** A card for something OpenCode asked, and whether the answer came from here. */
interface Pending {
  readonly approvalId: string;
  answered: boolean;
}

/** The turn going in a room: the Chips run, the OpenCode session, and what has come back. */
interface Turn {
  readonly run: Run;
  readonly speaker: Speaker;
  readonly agent: Running;
  readonly sessionId: string;
  /** Inbox items given and not yet taken: the turn ends only once all are, and the session is idle. */
  readonly waiting: Set<string>;
  /** Inbox items the session took before the bridge heard their ids back. */
  readonly taken: Set<string>;
  /** Whether the session has taken any of the turn's words: until then its work is somebody else's. */
  started: boolean;
  readonly end: (end: End) => void;
  /** The words of each answer, by its message, in order. */
  readonly words: { readonly message: string; readonly text: string }[];
  /** The newest answer's words, read from the session when its events were missed. */
  recovered: string | undefined;
  saidAt: number;
  cancelled: boolean;
  /** Tool calls by OpenCode's id: their tool, and whether Chips has a step for them. */
  readonly tools: Map<string, { name: string; open: boolean }>;
  /** Each answer's model, by its message. */
  readonly models: Map<string, ModelRef>;
  /** Cards by OpenCode's permission id. */
  readonly approvals: Map<string, Pending>;
  /** Approvals a person allowed, by the tool call they were for: its end says how it went. */
  readonly allowed: Map<string, string>;
  /** Everything heard for the turn, in order. */
  chain: Promise<void>;
}

export class Bridge {
  private readonly agents: Running[] = [];
  private readonly rooms = new Map<string, Room>();
  /** The turn going in each OpenCode session. */
  private readonly turns = new Map<string, Turn>();
  /**
   * What a session said while it was being given a turn's words, before the turn was known: OpenCode
   * may say it took them before it answers that it has them. Heard by the turn once it is.
   */
  private readonly early = new Map<string, OpenCodeEvent[]>();
  /** Each session's folder, as OpenCode said it, once asked. */
  private readonly folders = new Map<string, string>();
  /** A sub-agent's child session → the session it works for. */
  private readonly parents = new Map<string, string>();
  /** Each model's context window, by `provider/model`. */
  private windows: Map<string, number> | undefined;
  /** Models the catalogue was read again for and still lacked. */
  private readonly unlisted = new Set<string>();
  /** Every Chips agent of the harness's, configured here or not. */
  private ours = new Set<string>();
  private readonly log: (line: string) => void;
  private health: ReturnType<typeof setInterval> | undefined;
  private readonly listening = new AbortController();
  private connections = 0;

  constructor(private readonly options: BridgeOptions) {
    this.log = options.log ?? (() => undefined);
  }

  /** Register the agents, start hearing OpenCode and what is said in Chips, and say how it is. */
  async start(): Promise<void> {
    const { chips } = this.options;
    const known = await chips.agents.list();
    for (const [index, config] of this.options.agents.entries()) {
      const key = keyOf(config);
      const registered =
        index === 0 ? await this.seatMain(config, known) : await chips.agents.register({ key, name: config.name });
      const model = config.model === undefined ? undefined : modelRefOf(config.model);
      this.agents.push({ config, key, model, agentId: registered.agentId });
    }
    this.ours = new Set([...known.map((agent) => agent.agentId), ...this.agents.map((agent) => agent.agentId)]);
    void this.listen();
    chips.on("message.new", (message) => void this.hear(message));
    chips.on("agent.asked", (asked) => {
      this.make(asked).catch((error: unknown) => this.log(`a new agent went wrong: ${messageOf(error)}`));
    });
    await this.sayHowItIs();
    this.health = setInterval(() => void this.sayHowItIs(), this.options.healthEveryMs ?? 30_000);
    this.health.unref();
  }

  stop(): void {
    if (this.health !== undefined) clearInterval(this.health);
    this.listening.abort();
  }

  /** The Main agent, the first registered, once started: who says the harness's first words. */
  get mainAgentId(): string | undefined {
    return this.agents[0]?.agentId;
  }

  /**
   * The Main agent: the one Chips made for the harness when it joined, keyed by the harness's own
   * id, registered as Main (Chips ADR 0183), so it is called what the config says and has no
   * second beside it. It goes home, and a Main of ours from before that, out of its room now, is
   * archived, which gives its name up. With no such agent (a harness from before them), the Main
   * Chips has is kept: a harness has one at most.
   */
  private async seatMain(config: AgentConfig, known: readonly Agent[]): Promise<Agent> {
    const { chips } = this.options;
    const before = known.find((agent) => agent.lead);
    const made = known.some((agent) => agent.key === chips.harnessId);
    if (!made && before !== undefined) {
      await this.goHome(before, known);
      return before;
    }
    const main = await chips.agents.register({ key: chips.harnessId, name: config.name, lead: true });
    await this.goHome(main, known);
    if (before !== undefined && before.agentId !== main.agentId) {
      await chips.agents
        .register({ key: before.key, name: before.name, state: "archived" })
        .catch((error: unknown) => this.log(`${before.name} stays: ${String(error)}`));
    }
    return main;
  }

  /** The Main agent into the harness's own room, in the place of whichever of ours is there. */
  private async goHome(main: Agent, known: readonly Agent[]): Promise<void> {
    const { chips, home } = this.options;
    if (home === undefined || main.spaces.includes(home)) return;
    const there = known.find((agent) => agent.agentId !== main.agentId && agent.spaces.includes(home));
    await chips.agents
      .attach(main.agentId, { spaceId: home, replacing: there?.agentId ?? chips.harnessId })
      .catch((error: unknown) => this.log(`${main.name} stays out of its home: ${String(error)}`));
  }

  /** Trouble while the server doesn't answer, and fine once it does (ADR 0083). */
  private async sayHowItIs(): Promise<void> {
    const up = await this.options.opencode.healthy();
    const chips = this.options.chips;
    await (up ? chips.reportOk() : chips.reportTrouble("OpenCode isn't answering")).catch(() => undefined);
  }

  /** OpenCode's event stream, opened again whenever it drops, a little later each time it fails. */
  private async listen(): Promise<void> {
    const first = this.options.reconnectMs ?? 1000;
    let wait = first;
    while (!this.listening.signal.aborted) {
      try {
        await this.options.opencode.events((event) => this.heard(event), this.listening.signal);
        wait = first;
      } catch (error) {
        if (this.listening.signal.aborted) return;
        this.log(`OpenCode's events: ${messageOf(error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, wait));
      wait = Math.min(wait * 2, 15_000);
    }
  }

  /**
   * A person asked for a new agent in a room (Chips ADR 0108): one of the harness's, keyed by the
   * ask so an ask heard twice makes one, registered for the room, which Chips puts it in while the
   * room waits. It answers as the first OpenCode agent, in a session of its own.
   */
  private async make(asked: AgentAsked): Promise<void> {
    const { chips } = this.options;
    if (asked.harness_id !== chips.harnessId || asked.space_id === undefined) return;
    const agent = await chips.agents.register({
      key: `opencode:asked:${asked.id}`,
      name: asked.name,
      madeFor: asked.id,
      spaceId: asked.space_id,
    });
    this.ours.add(agent.agentId);
    this.log(`${agent.name} made${agent.attached === false ? `, not in the room: ${agent.why ?? "too late"}` : ""}`);
  }

  // ------------------------------------------------------------------ what is said to it

  /** A message for some of its agents: each takes a turn in its room, one after another there. */
  private async hear(message: MessageNew): Promise<void> {
    const spaceId = message.space_id;
    if (spaceId === undefined) return;
    const harnessId = this.options.chips.harnessId;
    for (const taker of message.for ?? [harnessId]) {
      const agent = await this.runnerOf(taker);
      if (agent === undefined) continue;
      const room = this.roomOf(agent, taker, spaceId);
      room.queue.push({ message, speakerId: taker === harnessId ? undefined : taker });
      void this.pump(room);
    }
  }

  /**
   * Which OpenCode agent answers for a Chips agent: its own, or the first for the harness itself
   * and for any other of the harness's, read afresh once when a name is new.
   */
  private async runnerOf(taker: string): Promise<Running | undefined> {
    const own = this.agents.find((agent) => agent.agentId === taker);
    if (own !== undefined) return own;
    if (taker !== this.options.chips.harnessId && !this.ours.has(taker)) {
      const listed = await this.options.chips.agents.list().catch(() => []);
      for (const agent of listed) this.ours.add(agent.agentId);
    }
    return taker === this.options.chips.harnessId || this.ours.has(taker) ? this.agents[0] : undefined;
  }

  /**
   * The session a turn is taken in: the OpenCode agent's own in the room, for its Chips agent or
   * the harness itself, and one of its own for any other of the harness's, so two in a room are two.
   */
  private roomOf(agent: Running, taker: string, spaceId: string): Room {
    const own = taker === agent.agentId || taker === this.options.chips.harnessId;
    const who = own ? agent.key : taker;
    const id = `${who}|${spaceId}`;
    let room = this.rooms.get(id);
    if (room === undefined) {
      room = { id, who, agent, spaceId, queue: [], busy: false };
      this.rooms.set(id, room);
    }
    return room;
  }

  private async pump(room: Room): Promise<void> {
    if (room.busy) return;
    const asked = room.queue.shift();
    if (asked === undefined) return;
    room.busy = true;
    try {
      await this.turn(room, asked);
    } catch (error) {
      this.log(`a turn of ${room.agent.config.name} went wrong: ${messageOf(error)}`);
    } finally {
      room.busy = false;
      void this.pump(room);
    }
  }

  private async turn(room: Room, { message, speakerId }: Asked): Promise<void> {
    const { agent, spaceId } = room;
    const speaker = speakerId === undefined ? this.options.chips : this.options.chips.as(speakerId);
    const run = await speaker.runs.start({ spaceId, goal: goalOf(message, agent.config.name) });
    const text = promptFor(message, { ...(speakerId === undefined ? {} : { taker: speakerId }), sendsFiles: true });
    let sessionId: string;
    let given: string;
    try {
      ({ sessionId, given } = await this.give(room, text));
    } catch (error) {
      await this.failed(run, `${agent.config.name} couldn't reach OpenCode: ${messageOf(error)}`, true);
      return;
    }
    let end: (end: End) => void = () => undefined;
    const ended = new Promise<End>((resolve) => {
      end = resolve;
    });
    const turn: Turn = {
      run,
      speaker,
      agent,
      sessionId,
      waiting: new Set(),
      taken: new Set(),
      started: false,
      end,
      words: [],
      recovered: undefined,
      saidAt: 0,
      cancelled: false,
      tools: new Map(),
      models: new Map(),
      approvals: new Map(),
      allowed: new Map(),
      chain: Promise.resolve(),
    };
    const held = this.early.get(sessionId) ?? [];
    this.early.delete(sessionId);
    this.turns.set(sessionId, turn);
    this.wait(turn, given);
    for (const event of held) this.heard(event);
    run.on("cancel", () => void this.cancel(turn));
    run.on("steer", (steer) => {
      const words = `${steer.from?.display_name ?? "The person"} adds: ${steer.text}`;
      void this.steered(turn, words, steer.mode);
    });
    const last = await ended;
    await turn.chain;
    if (this.turns.get(sessionId) === turn) this.turns.delete(sessionId);
    if (last.outcome === "succeeded") await this.finish(turn);
    else await this.ended(turn, last);
  }

  /** The words into the room's session: the one it had, or a new one when OpenCode no longer has it. */
  private async give({ id, who, agent, spaceId }: Room, text: string): Promise<{ sessionId: string; given: string }> {
    const { opencode, state, saveState } = this.options;
    const kept = state.sessions[id];
    if (kept !== undefined) {
      try {
        return { sessionId: kept, given: await this.prompted(kept, text) };
      } catch (error) {
        if (!(error instanceof OpenCodeError && error.tag === "SessionNotFoundError")) throw error;
        this.log(`${agent.config.name}'s session for ${spaceId} is gone from OpenCode: a new one`);
      }
    }
    const made = await opencode.newSession({
      title: `Chips room ${spaceId}`,
      agent: agent.config.agent,
      model: agent.model,
      directory: await this.folderFor({ id, who, agent, spaceId } as Room),
      metadata: { chips_space: spaceId, chips_agent: who },
    });
    state.sessions[id] = made;
    saveState(state);
    return { sessionId: made, given: await this.prompted(made, text) };
  }

  /**
   * The folder an agent's new sessions work in, its own: made the first time, named after it, and
   * kept by whose it is, so a rename doesn't move it. None without `folders`: the project's.
   */
  private async folderFor({ who, agent }: Room): Promise<string | undefined> {
    const { folders: root, state, saveState } = this.options;
    if (root === undefined) return undefined;
    let folder = state.folders?.[who];
    if (folder === undefined) {
      const name =
        who === agent.key
          ? agent.config.name
          : ((await this.options.chips.agents.list().catch(() => [])).find((each) => each.agentId === who)?.name ?? "agent");
      folder = freeFolder(root, name, Object.values(state.folders ?? {}));
      state.folders = { ...state.folders, [who]: folder };
      saveState(state);
    }
    mkdirSync(folder, { recursive: true });
    return folder;
  }

  /** A turn's first words into a session, what it says meanwhile held for the turn. */
  private async prompted(sessionId: string, text: string): Promise<string> {
    this.early.set(sessionId, []);
    try {
      return await this.options.opencode.prompt(sessionId, text);
    } catch (error) {
      this.early.delete(sessionId);
      throw error;
    }
  }

  /** An inbox item of the turn's: waited for, unless the session took it already. */
  private wait(turn: Turn, item: string): void {
    if (turn.taken.delete(item)) turn.started = true;
    else turn.waiting.add(item);
  }

  /** Stop: whatever of the turn's words OpenCode hasn't taken is withdrawn, and the session interrupted. */
  private async cancel(turn: Turn): Promise<void> {
    turn.cancelled = true;
    const { opencode } = this.options;
    for (const item of turn.waiting) {
      if (item !== INTERRUPTING) await opencode.withdraw(turn.sessionId, item).catch(() => undefined);
    }
    turn.waiting.clear();
    await opencode.interrupt(turn.sessionId).catch(() => undefined);
    turn.end({ outcome: "interrupted", why: "user" });
  }

  /**
   * A person's words for a run that is going. A steer is read at the session's next step, a
   * follow-up when what it is doing ends, and an interrupt stops it and starts it on the words.
   */
  private async steered(turn: Turn, text: string, mode: string): Promise<void> {
    const { opencode } = this.options;
    try {
      if (mode === "interrupt") {
        turn.waiting.add(INTERRUPTING);
        await opencode.interrupt(turn.sessionId).catch(() => undefined);
        this.wait(turn, await opencode.prompt(turn.sessionId, text));
        turn.waiting.delete(INTERRUPTING);
        return;
      }
      this.wait(turn, await opencode.prompt(turn.sessionId, text, mode === "steer" ? "steer" : "queue"));
    } catch (error) {
      turn.waiting.delete(INTERRUPTING);
      this.log(`OpenCode didn't take a person's words mid-run: ${messageOf(error)}`);
    }
  }

  // ------------------------------------------------------------------ what OpenCode says

  /** One event from OpenCode, handed to the turn it is about, in order. */
  private heard(event: OpenCodeEvent): void {
    if (event.type === "server.connected") {
      this.connections += 1;
      if (this.connections > 1) void this.caughtUp();
      return;
    }
    const sessionId = sessionOf(event);
    if (sessionId === undefined) return;
    if (event.type === "session.created") {
      const parent = text(event.data["parentID"]);
      if (parent !== undefined && this.rootOf(parent) !== undefined) this.parents.set(sessionId, parent);
      return;
    }
    const own = this.turns.get(sessionId);
    if (own === undefined && this.early.has(sessionId)) {
      this.early.get(sessionId)?.push(event);
      return;
    }
    const root = own ?? this.rootOf(sessionId);
    if (root === undefined) return;
    root.chain = root.chain
      .then(() => (own === undefined ? this.ofChild(root, sessionId, event) : this.ofTurn(root, event)))
      .catch((error: unknown) => this.log(`${event.type}: ${messageOf(error)}`));
  }

  /** The turn a session works for: its own, or its parent's for a sub-agent's. */
  private rootOf(sessionId: string): Turn | undefined {
    let at: string | undefined = sessionId;
    for (let depth = 0; at !== undefined && depth < 8; depth += 1) {
      const turn = this.turns.get(at);
      if (turn !== undefined) return turn;
      at = this.parents.get(at);
    }
    return undefined;
  }

  private async ofTurn(turn: Turn, event: OpenCodeEvent): Promise<void> {
    const data = event.data;
    if (event.type === "session.inbox.delivered") {
      const item = text(data["inboxID"]) ?? "";
      if (turn.waiting.delete(item)) turn.started = true;
      else turn.taken.add(item);
      return;
    }
    // Until the session takes the turn's words, what it does is somebody else's.
    if (!turn.started || turn.run.over) return;
    switch (event.type) {
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        if (turn.waiting.size === 0) turn.end(endOf(event));
        return;
      case "session.reasoning.ended":
        this.sayThought(turn, text(data["text"]) ?? "", "thinking");
        return;
      case "session.text.ended": {
        const words = text(data["text"]) ?? "";
        if (words.trim() === "") return;
        turn.words.push({ message: text(data["assistantMessageID"]) ?? "", text: words });
        this.sayThought(turn, words, "writing");
        return;
      }
      case "session.status": {
        const status = (data["status"] ?? {}) as Record<string, unknown>;
        if (status["type"] === "retry") this.sayNow(turn, `Retrying: ${text(status["message"]) ?? "the model didn't answer"}`, "waiting");
        return;
      }
      case "session.step.started": {
        const model = data["model"] as ModelRef | undefined;
        const message = text(data["assistantMessageID"]);
        if (model !== undefined && message !== undefined) turn.models.set(message, model);
        return;
      }
      case "session.step.ended":
      case "session.step.failed":
      case "session.compaction.ended":
        await this.counted(turn, event, true);
        return;
      default:
        await this.ofEither(turn, event, true);
    }
  }

  /** A sub-agent's child session: its cost and its asks are the run's; its steps are inside the handoff's. */
  private async ofChild(turn: Turn, _sessionId: string, event: OpenCodeEvent): Promise<void> {
    if (!turn.started || turn.run.over) return;
    if (event.type === "session.step.started") {
      const model = event.data["model"] as ModelRef | undefined;
      const message = text(event.data["assistantMessageID"]);
      if (model !== undefined && message !== undefined) turn.models.set(message, model);
      return;
    }
    if (event.type === "session.step.ended" || event.type === "session.step.failed") {
      await this.counted(turn, event, false);
      return;
    }
    if (event.type.startsWith("permission.") || event.type.startsWith("form.")) await this.ofEither(turn, event, false);
  }

  /** What the session or one of its sub-agents does that shows the same either way. */
  private async ofEither(turn: Turn, event: OpenCodeEvent, own: boolean): Promise<void> {
    const data = event.data;
    switch (event.type) {
      case "session.tool.input.started":
        turn.tools.set(text(data["id"]) ?? "", { name: text(data["name"]) ?? "tool", open: false });
        return;
      case "session.tool.called":
        await this.called(turn, data);
        return;
      case "session.tool.success":
      case "session.tool.failed":
        await this.toolEnded(turn, data, event.type === "session.tool.failed");
        return;
      case "permission.asked":
        void this.asked(turn, data, own);
        return;
      case "permission.replied":
        await this.settled(turn, data);
        return;
      case "form.created":
        void this.questioned(turn, (data["form"] ?? {}) as Record<string, unknown>);
        return;
      default:
        return;
    }
  }

  private sayThought(turn: Turn, said: string, phase: string): void {
    const now = Date.now();
    if (now - turn.saidAt < QUIET_MS) return;
    this.sayNow(turn, lastLine(said), phase);
  }

  private sayNow(turn: Turn, line: string, phase: string): void {
    if (line === "") return;
    turn.saidAt = Date.now();
    void turn.run.status({ phase, verbPhrase: line.slice(0, 200) }).catch(() => undefined);
  }

  private async called(turn: Turn, data: Readonly<Record<string, unknown>>): Promise<void> {
    const id = text(data["id"]) ?? "";
    const tool = turn.tools.get(id) ?? { name: "tool", open: false };
    tool.open = true;
    turn.tools.set(id, tool);
    const said = detailOf(tool.name, (data["input"] ?? {}) as Record<string, unknown>);
    await turn.run
      .step({
        stepId: id,
        status: "started",
        title: `${tool.name}${said === "" ? "" : ` · ${said}`}`.slice(0, 300),
        tool: tool.name,
        ...(KINDS[tool.name] === undefined ? {} : { kind: KINDS[tool.name] }),
      })
      .catch(() => undefined);
  }

  private async toolEnded(turn: Turn, data: Readonly<Record<string, unknown>>, failed: boolean): Promise<void> {
    const id = text(data["id"]) ?? "";
    const tool = turn.tools.get(id);
    if (tool === undefined || !tool.open) return;
    tool.open = false;
    // The call a person allowed has ended: the card says how it went.
    const approvalId = turn.allowed.get(id);
    if (approvalId !== undefined) {
      turn.allowed.delete(id);
      await turn.run.executed(approvalId, failed ? "failed" : "executed").catch(() => undefined);
    }
    const error = (data["error"] ?? {}) as Record<string, unknown>;
    const summary = failed ? text(error["message"]) : firstText(data["content"]);
    await turn.run
      .step({
        stepId: id,
        status: failed ? "failed" : "done",
        tool: tool.name,
        ...(summary === undefined || summary === "" ? {} : failed ? { error: summary.slice(0, 2000) } : { summary: summary.slice(0, 2000) }),
      })
      .catch(() => undefined);
  }

  /** A model call's exact cost and tokens, as a step's share; for the session's own, how full its context is. */
  private async counted(turn: Turn, event: OpenCodeEvent, own: boolean): Promise<void> {
    const data = event.data;
    const tokens = (data["tokens"] ?? undefined) as Tokens | undefined;
    const cost = typeof data["cost"] === "number" ? data["cost"] : undefined;
    if (tokens === undefined && cost === undefined) return;
    const ref = turn.models.get(text(data["assistantMessageID"]) ?? "") ?? (data["model"] as ModelRef | undefined) ?? turn.agent.model;
    const model = ref === undefined ? "opencode" : `${ref.providerID}/${ref.id}`;
    const prompt = tokens === undefined ? undefined : tokens.input + tokens.cache.read + tokens.cache.write;
    const written = tokens === undefined ? undefined : tokens.output + tokens.reasoning;
    await turn.run
      .usage({
        scope: "step",
        model,
        ...(prompt === undefined ? {} : { inputTokens: prompt }),
        ...(written === undefined ? {} : { outputTokens: written }),
        ...(cost === undefined || cost <= 0 ? {} : { costUsd: cost }),
      })
      .catch(() => undefined);
    if (!own || event.type !== "session.step.ended" || prompt === undefined || written === undefined) return;
    const limit = await this.windowOf(model);
    if (limit === undefined) return;
    await turn.run.context({ usedTokens: prompt + written, limitTokens: limit, model }).catch(() => undefined);
  }

  /** A model's context window, from OpenCode's catalogue, read once (and once more for each it lacked). */
  private async windowOf(model: string): Promise<number | undefined> {
    if (this.windows === undefined || (!this.windows.has(model) && !this.unlisted.has(model))) {
      if (this.windows !== undefined) this.unlisted.add(model);
      const listed = await this.options.opencode.models().catch(() => []);
      this.windows = new Map(listed.map((each) => [`${each.providerID}/${each.id}`, each.limit.context]));
    }
    return this.windows.get(model);
  }

  // ------------------------------------------------------------------ what OpenCode asks

  /** A permission OpenCode wants before it acts, as a card; the answer is OpenCode's decision. */
  private async asked(turn: Turn, data: Readonly<Record<string, unknown>>, own: boolean): Promise<void> {
    const requestId = text(data["id"]);
    const askingSession = text(data["sessionID"]);
    if (requestId === undefined || askingSession === undefined || turn.approvals.has(requestId)) return;
    const approvalId = ids.next("approval");
    turn.approvals.set(requestId, { approvalId, answered: false });
    const source = (data["source"] ?? {}) as Record<string, unknown>;
    const toolCall = source["type"] === "tool" ? text(source["id"]) : undefined;
    const card = cardOf(data);
    const asking = turn.run.approval({
      approvalId,
      ...card,
      lasts: "once",
      ...(own && toolCall !== undefined && turn.tools.get(toolCall)?.open === true ? { stepId: toolCall } : {}),
    });
    const stopped = new Promise<undefined>((resolve) => turn.run.on("cancel", () => resolve(undefined)));
    const decision = await Promise.race([asking, stopped]);
    const pending = turn.approvals.get(requestId);
    if (decision === undefined || pending === undefined || pending.answered) return;
    pending.answered = true;
    if (decision.allowed && toolCall !== undefined) turn.allowed.set(toolCall, approvalId);
    await this.options.opencode
      .replyPermission(askingSession, requestId, decisionOf(decision), decision.allowed ? undefined : decision.reason)
      .catch((error: unknown) => this.log(`OpenCode didn't take the answer: ${messageOf(error)}`));
  }

  /** A permission answered in OpenCode's own apps: settled in Chips, once, so the card cools (ADR 0079). */
  private async settled(turn: Turn, data: Readonly<Record<string, unknown>>): Promise<void> {
    const requestId = text(data["requestID"]);
    const pending = requestId === undefined ? undefined : turn.approvals.get(requestId);
    if (pending === undefined || pending.answered) return;
    pending.answered = true;
    const denied = data["reply"] === "reject";
    await this.options.chips
      .send(
        "approval.resolved",
        { run_id: turn.run.id },
        {
          approval_id: pending.approvalId,
          decision: denied ? "denied" : "approved",
          scope: "once",
          reason: "Answered in OpenCode.",
        },
        `opencode-permission:${requestId}:settled`,
      )
      .catch(() => undefined);
  }

  /**
   * A form OpenCode wants filled, its question tool's or an MCP server's, as Chips questions when
   * each of its fields is a choice or a yes or no, and at most four. Any other is left to
   * OpenCode's own apps.
   */
  private async questioned(turn: Turn, form: Readonly<Record<string, unknown>>): Promise<void> {
    const formId = text(form["id"]);
    const askingSession = text(form["sessionID"]);
    const fields = Array.isArray(form["fields"]) ? (form["fields"] as Field[]) : [];
    const questions = fields.map((field) => questionOf(field, text(form["title"]) ?? "OpenCode asks"));
    if (formId === undefined || askingSession === undefined) return;
    if (questions.length === 0 || questions.length > 4 || questions.some((question) => question === undefined)) {
      this.log(`a form of OpenCode's Chips can't show (${formId}): answer it in OpenCode`);
      return;
    }
    const asking = turn.run.question({ questions: questions as NonNullable<(typeof questions)[number]>[] });
    const stopped = new Promise<undefined>((resolve) => turn.run.on("cancel", () => resolve(undefined)));
    const answer = await Promise.race([asking, stopped]);
    if (answer === undefined || answer.timedOut) return;
    const filled: Record<string, FormAnswer[string]> = {};
    for (const field of fields) {
      const given = answer.answers[field.key];
      if (given === undefined) continue;
      if (field.type === "boolean") filled[field.key] = given.values[0] === "yes";
      else if (field.type === "multiselect") filled[field.key] = [...given.values, ...(given.freeText === undefined ? [] : [given.freeText])];
      else filled[field.key] = given.freeText ?? given.values[0] ?? "";
    }
    await this.options.opencode
      .replyForm(askingSession, formId, filled)
      .catch((error: unknown) => this.log(`OpenCode didn't take the answers: ${messageOf(error)}`));
  }

  // ------------------------------------------------------------------ after the stream was down

  /**
   * Back on the stream after it dropped: what was missed is read from each turn's session. Words
   * no longer in its inbox were taken, and a session that has gone idle has ended its turn.
   */
  private async caughtUp(): Promise<void> {
    const { opencode } = this.options;
    const active = await opencode.active().catch(() => undefined);
    if (active === undefined) return;
    for (const turn of [...this.turns.values()]) {
      const waiting = new Set(await opencode.waiting(turn.sessionId).catch(() => [...turn.waiting]));
      for (const item of [...turn.waiting]) {
        if (item !== INTERRUPTING && !waiting.has(item)) {
          turn.waiting.delete(item);
          turn.started = true;
        }
      }
      if (!turn.started || turn.waiting.size > 0 || active.has(turn.sessionId)) continue;
      const session = await opencode.session(turn.sessionId).catch(() => ({}) as Record<string, unknown>);
      turn.recovered = await opencode.lastWords(turn.sessionId).catch(() => undefined);
      const outcome = session["outcome"];
      turn.end({
        outcome: outcome === "failed" || outcome === "interrupted" ? outcome : "succeeded",
        why: outcome === "failed" ? "it failed in OpenCode while the bridge wasn't listening" : undefined,
      });
    }
  }

  // ------------------------------------------------------------------ the end

  /** The turn is over: its last words in the room, and the run ended. */
  private async finish(turn: Turn): Promise<void> {
    const { run, agent } = turn;
    if (run.over) return;
    await this.closeSteps(turn, "done");
    for (const approvalId of turn.allowed.values()) {
      await run.executed(approvalId, "executed", "OpenCode didn't say how it went.").catch(() => undefined);
    }
    turn.allowed.clear();
    const answer = spoken(turn.recovered ?? lastWordsOf(turn.words)).trim();
    // The files its `MEDIA:` lines name go with its words, from its session's folder (Chips TT-7).
    const folder = await this.folderOf(turn.sessionId);
    const { chips } = this.options;
    const post = await sendAnswer(answer, {
      folders: folder === undefined ? [] : [folder],
      upload: (input) => chips.upload(input),
    });
    const reply = post.text;
    if (reply !== "" || post.uploadIds.length > 0) {
      await turn.speaker.post({ spaceId: run.spaceId, runId: run.id, text: reply, uploadIds: post.uploadIds });
    }
    const said = post.summary;
    const summary = said === "" ? "Done." : said.length <= 2000 ? said : `${said.slice(0, 1990)}…`;
    await run.complete({ summary });
    this.log(`${agent.config.name} answered in ${run.spaceId}`);
  }

  /** Where a session works, as OpenCode says: the one folder its answers' files are sent from. */
  private async folderOf(sessionId: string): Promise<string | undefined> {
    const known = this.folders.get(sessionId);
    if (known !== undefined) return known;
    const session = await this.options.opencode.session(sessionId).catch(() => ({}) as Record<string, unknown>);
    const location = (session["location"] ?? {}) as Record<string, unknown>;
    const folder = [session["directory"], location["directory"]].find((each): each is string => typeof each === "string");
    if (folder !== undefined) this.folders.set(sessionId, folder);
    return folder;
  }

  /** A run that failed, was interrupted, or stopped. */
  private async ended(turn: Turn, end: End): Promise<void> {
    await this.closeSteps(turn, "failed");
    if (turn.cancelled || turn.run.over) return;
    const name = turn.agent.config.name;
    if (end.outcome === "interrupted") {
      if (end.why === "shutdown") await this.failed(turn.run, `OpenCode shut down during ${name}'s run.`, true);
      else await this.failed(turn.run, `${name}'s run was stopped in OpenCode.`, false);
      return;
    }
    await this.failed(turn.run, `${name}: ${end.why ?? "it failed in OpenCode"}`, true);
  }

  private async closeSteps(turn: Turn, status: "done" | "failed"): Promise<void> {
    for (const [stepId, tool] of turn.tools) {
      if (tool.open) await turn.run.step({ stepId, status }).catch(() => undefined);
      tool.open = false;
    }
  }

  private async failed(run: Run, error: string, retryable: boolean): Promise<void> {
    if (!run.over) await run.fail({ error, retryable }).catch(() => undefined);
    if (retryable) void this.sayHowItIs();
  }
}

// ------------------------------------------------------------------ small words

interface Tokens {
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cache: { readonly read: number; readonly write: number };
}

interface Field {
  readonly key: string;
  readonly type: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly options?: readonly { value: string; label: string; description?: string | undefined }[] | undefined;
  readonly custom?: boolean | undefined;
  readonly default?: unknown;
}

/** OpenCode's decision for a person's answer: always where they said so, else once; a no is reject. */
export function decisionOf(decision: Decision): PermissionDecision {
  if (!decision.allowed) return "reject";
  return decision.scope === "always" ? "always" : "once";
}

/** A form field as a Chips question, or nothing for one Chips can't ask: free text, numbers, a link. */
export function questionOf(field: Field, title: string) {
  const prompt = (field.description ?? field.title ?? title).slice(0, 500);
  const base = { questionId: field.key, prompt };
  if (field.type === "boolean") {
    return {
      ...base,
      options: [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ],
      ...(typeof field.default === "boolean" ? { defaultValue: field.default ? "yes" : "no" } : {}),
    };
  }
  if ((field.type !== "string" && field.type !== "multiselect") || field.options === undefined || field.options.length === 0) {
    return undefined;
  }
  return {
    ...base,
    options: field.options.map((option) => ({
      value: option.value,
      label: option.label,
      ...(option.description === undefined ? {} : { description: option.description }),
    })),
    ...(field.type === "multiselect" ? { multiSelect: true } : {}),
    ...(field.custom === true ? { allowFreeText: true } : {}),
  };
}

/** The card for a permission: what it would do, in a person's words, and what to look at. */
export function cardOf(
  data: Readonly<Record<string, unknown>>,
): Pick<ApprovalInput, "action" | "question" | "effect" | "risk" | "preview"> {
  const action = text(data["action"]) ?? "act";
  const resources = Array.isArray(data["resources"]) ? (data["resources"] as unknown[]).map(String) : [];
  const said = text(data["message"]);
  const metadata = (data["metadata"] ?? {}) as Record<string, unknown>;
  const one = resources.length === 1 ? resources[0] : undefined;
  const effect = said === undefined ? {} : { effect: said.slice(0, 500) };
  if (action === "shell") {
    const command = resources.join("\n");
    return {
      action: { kind: "shell.exec", input: { command } },
      question: one !== undefined && one.length <= 80 ? `Run \`${one}\`?` : "Run these commands?",
      risk: [],
      preview: { format: "markdown" as const, title: "Run a command", body: `\`\`\`sh\n${command}\n\`\`\`` },
      ...effect,
    };
  }
  if (action === "edit") {
    const files = Array.isArray(metadata["files"]) ? (metadata["files"] as Record<string, unknown>[]) : [];
    const patch = files.map((file) => text(file["patch"]) ?? "").filter((each) => each !== "").join("\n");
    return {
      action: { kind: "file.edit", input: { files: resources } },
      question: one === undefined ? "Change these files?" : `Change ${baseName(one)}?`,
      risk: [],
      ...(patch === "" ? {} : { preview: { format: "diff" as const, title: one ?? "Changes", body: patch.slice(0, 200_000) } }),
      ...effect,
    };
  }
  const plain: Record<string, string> = {
    read: "Read",
    external_directory: "Work outside the project, in",
    webfetch: "Open",
    websearch: "Search the web for",
    subagent: "Hand work to",
    question: "Ask you",
  };
  const verb = plain[action] ?? `${action} on`;
  const what = resources.filter((each) => each !== "*").join(", ");
  return {
    action: { kind: `opencode.${action.toLowerCase().replace(/[^a-z0-9_]+/g, "_") || "act"}`, input: { resources } },
    question: `${verb}${what === "" ? "" : ` ${what}`}?`.slice(0, 300),
    risk: action === "webfetch" || action === "websearch" ? ["external"] : [],
    ...effect,
  };
}

/** What a tool call is about, for its step's title. */
function detailOf(tool: string, input: Readonly<Record<string, unknown>>): string {
  const first = (...keys: string[]) => keys.map((key) => input[key]).find((value) => typeof value === "string");
  const said = first("command", "description", "path", "pattern", "url", "query", "id");
  return typeof said === "string" ? (tool === "shell" ? said.split("\n")[0] ?? "" : said) : "";
}

/** The words of the newest answer that had any: what came before were its words on the way. */
/**
 * An answer's words without the thinking some models write into them. A model that thinks in
 * `<think>` tags, whose opening tag the prompt has already given it, answers with its thinking, a
 * `</think>`, and then its answer: big-pickle did (Chips, 17 October 2026), and its draft of a
 * table, with no line of dashes under the heading, drew in the room as rows of pipes above the
 * real one.
 */
export function spoken(words: string): string {
  const end = words.indexOf(THOUGHT_ENDS);
  return end === -1 ? words : words.slice(end + THOUGHT_ENDS.length);
}

const THOUGHT_ENDS = "</think>";

function lastWordsOf(words: Turn["words"]): string {
  const last = words.at(-1);
  if (last === undefined) return "";
  return words
    .filter((each) => each.message === last.message)
    .map((each) => each.text)
    .join("\n\n");
}

function endOf(event: OpenCodeEvent): End {
  if (event.type === "session.execution.succeeded") return { outcome: "succeeded" };
  if (event.type === "session.execution.interrupted") return { outcome: "interrupted", why: text(event.data["reason"]) };
  const error = (event.data["error"] ?? {}) as Record<string, unknown>;
  return { outcome: "failed", why: text(error["message"]) };
}

function sessionOf(event: OpenCodeEvent): string | undefined {
  const own = text(event.data["sessionID"]);
  if (own !== undefined) return own;
  const form = event.data["form"] as Record<string, unknown> | undefined;
  return form === undefined ? undefined : text(form["sessionID"]);
}

function firstText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const part = (content as Record<string, unknown>[]).find((each) => each["type"] === "text");
  return part === undefined ? undefined : text(part["text"])?.trim();
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function baseName(path: string): string {
  return path.split("/").filter((part) => part !== "").at(-1) ?? path;
}

function messageOf(error: unknown): string {
  if (error instanceof OpenCodeError) return `${error.message} (${error.status})`;
  return error instanceof Error ? error.message : String(error);
}

/** The run's goal: the message's first line, without the @ it opened with — the agent's whole name. */
export function goalOf(message: MessageNew, name: string): string {
  const first = message.text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
  const named = first.toLowerCase().startsWith(`@${name.toLowerCase()}`);
  const goal = named ? first.slice(name.length + 1).trim() : first.replace(/^@\S+\s*/, "");
  return (goal === "" ? `Answer ${message.from.display_name}` : goal).slice(0, 300);
}

function lastLine(said: string): string {
  const lines = said.split(/(?<=[.!?])\s+|\n+/).map((line) => line.trim()).filter((line) => line !== "");
  return lines.at(-1) ?? "";
}
