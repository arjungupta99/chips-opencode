/**
 * OpenCode as one Chips harness, on its V2 server. Each configured OpenCode agent (`build`, `plan`,
 * or one of the person's own) is a Chips agent (ADR 0087), registered by its own key. The first is
 * the harness's Main agent, in the harness's own room in the place of the default agent Chips gave
 * the harness there, and it answers for that default agent, and for any other of the harness's
 * Chips doesn't name here: a new agent a person asks for in a room (Chips ADR 0108) is one, and so
 * is the new agent a space a person asks for from Chips's + is claimed under, which answers its
 * first words (Chips ADR 0241). A room an agent is in is one OpenCode session of that agent, made
 * the first time somebody there speaks to it, and kept across restarts: it shows in OpenCode's own
 * apps too.
 *
 * A message for an agent is a run:
 * - The words go to the session's inbox (`POST …/prompt`): the room note, what was said, and the
 *   words; the room's rules once a session, and again after it compacts (Chips ADR 0250). The
 *   run is the session's work from the moment it takes them until it is idle again.
 * - Its reasoning, interim words and retries are the run's status.
 * - Its tool calls are steps, drawn by kind. A sub-agent is a step, and its child session's cost
 *   and asks are the run's.
 * - What it asks before acting is an approval card, and its questions are Chips questions.
 * - Each model call says its exact cost and tokens, and how full the context is.
 * - At the end come its last words in the room.
 * - Stop interrupts the session. A steer, a follow-up and an interrupt are OpenCode's own `steer`,
 *   `queue`, and interrupt-then-prompt.
 *
 * A person's Not right? on an agent's message (Chips ADR 0200) is a run too: the agent who said
 * it looks again, in its session for the room, and its answer goes in the reply's place.
 *
 * A person's Fork (Chips ADR 0087) is a copy of an agent in another room: its session in its room,
 * copied in OpenCode, is the copy's session there, in the original's folder. From then on the two
 * remember apart.
 *
 * A person's Restart (Chips ADR 0094), where the bridge runs OpenCode's server itself, stops that
 * server and starts it again on the same port and password: the client, the rooms' sessions and
 * the agents go on as they were, and the bridge says how it is once the server is back, or why it
 * isn't.
 *
 * Each agent's page in Chips shows its model (Chips ADR 0241, `models.ts`): one of the models
 * OpenCode's server runs, at one of its levels, picked there and kept here, and given to each
 * session of the agent's before its next message. It shows the files OpenCode builds the agent
 * from too (`context.ts`), which a person may change there, and how full its session is, which a
 * person may compact from there (`windows.ts`).
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  Agent,
  AgentContextCopy,
  AgentContextWindowCopy,
  AgentModelCopy,
  ApprovalInput,
  Chips,
  Decision,
  HarnessContextCopy,
  Project,
  Run,
  SettingsHandlers,
  SpaceAsked,
  Speaker,
} from "@chipschat/harness";
import {
  heldNote,
  promptFor,
  pushedInWords,
  Refuse,
  rulesFor,
  SessionRules,
  sendAnswer,
} from "@chipschat/harness";
import {
  type AgentAsked,
  type AgentFork,
  type ContextEditFrame,
  createIdGenerator,
  FORK_WAIT_MS,
  type Feedback,
  type MessageNew,
  type ModelChangeFrame,
  type ProjectFacts,
  type StepKind,
  type WindowChangeFrame,
  type WindowCompactFrame,
} from "@chipschat/protocol";
import { before, ContextFiles, namedFiles, type Places, placesOf, READS_NAMED, type Reading, within } from "./context.js";
import { type Fallback, type ModelPick, modelCopy, pickOf, refOf, sameModel, writtenOf } from "./models.js";
import { compactedTo, type KeptWindow, type Tokens, usedOf, windowCopy } from "./windows.js";
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
  /**
   * The copies made for a person's Fork, by the ask's id: the session copied for it, where the
   * original had one, and the folder it works in. Kept before the copy is registered, so an ask
   * heard again copies nothing more.
   */
  forks?: Record<string, { readonly session?: string; readonly folder?: string }>;
  /** Each agent's own model and level, picked in Chips (Chips ADR 0241), by whose sessions they are. */
  models?: Record<string, ModelPick>;
  /** How full each agent last said it was, by whose sessions they are (Chips ADRs 0146, 0241). */
  windows?: Record<string, KeptWindow>;
}

/**
 * What the harness asks Chips to let it do, when it joins with a code: have agents of its own
 * (Chips ADR 0087), take a space a person asks for from the + (ADR 0241), make a new one a person
 * asks for in a room (ADR 0108), copy one for a person's Fork, and show each one's model, files and
 * context window (ADR 0241). A link carries what the person chose instead.
 */
export const WANTS = ["agents", "new_spaces", "new_agents", "forks", "models", "context_files", "context_windows"] as const;

/**
 * What it asks for when it joins: `WANTS`, and `restarts` where the bridge runs OpenCode's server
 * itself (Chips ADR 0094). A server a person runs themselves isn't the bridge's to restart.
 */
export function wantsFor(ownServer: boolean): readonly string[] {
  return ownServer ? [...WANTS, "restarts"] : WANTS;
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
  /**
   * The one project every session works in, where the config names one instead of `folders`: the
   * files OpenCode reads there are each agent's.
   */
  readonly directory?: string | undefined;
  /** Where OpenCode's home and its own folder are, for the files it reads beside an agent's: this machine's. */
  readonly places?: Places | undefined;
  /**
   * Whether each agent works on its room's project in a copy in its own folder (Chips ADR 0221):
   * true when this machine has a git new enough. Only with `folders`: sessions that work in the
   * person's own project work there as they always have.
   */
  readonly projects?: boolean | undefined;
  /** How often the server is asked whether it is up. */
  readonly healthEveryMs?: number | undefined;
  /** How long after the event stream drops it is opened again, at first. */
  readonly reconnectMs?: number | undefined;
  /**
   * OpenCode's server stopped and started again on the same port and password, for a person's
   * Restart (Chips ADR 0094): only where the bridge runs it. Throws, in words, when it isn't back.
   */
  readonly restartServer?: (() => Promise<void>) | undefined;
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
/** The most a harness's trouble says (Chips ADR 0083). */
const TROUBLE_CHARS = 200;
/** How many feedbacks answered are remembered, so one heard again is nothing: a replay comes soon. */
const LOOKS_KEPT = 500;
/** How much of a reply a second look quotes. */
const REPLY_CHARS = 1500;

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
  /** What the run is called, where not the message's first line: a second look's (Chips ADR 0200). */
  readonly goal?: string | undefined;
  /** Its words name who said them already, so nobody's name goes in front of them: a second look's. */
  readonly saysWho?: boolean | undefined;
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
  /** Whose session it is (`Room.who`), and the Chips agent taking the turn. */
  readonly who: string;
  readonly agentId: string;
  /** The most the session held at once during the turn, and how often it compacted itself. */
  peak: number;
  folds: number;
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
  /** The agent's copy of the room's project, brought up to date as the turn began, and its name (Chips ADR 0221). */
  readonly project: { readonly copy: Project; readonly name: string } | undefined;
}

export class Bridge {
  private readonly agents: Running[] = [];
  private readonly rooms = new Map<string, Room>();
  /** The turn going in each OpenCode session. */
  private readonly turns = new Map<string, Turn>();
  /** The room's rules each session holds (Chips ADR 0250): said once, and again after it compacts. */
  private readonly rules = new SessionRules();
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
  /** The feedbacks a second look was asked for, by their ids, the newest `LOOKS_KEPT`. */
  private readonly looked = new Set<string>();
  /** Copies being made, by the Fork they answer: a room's first session waits for them. */
  private readonly copying = new Map<string, Promise<void>>();
  private readonly log: (line: string) => void;
  private health: ReturnType<typeof setInterval> | undefined;
  private readonly listening = new AbortController();
  private connections = 0;
  /** Opens the event stream again now, rather than once its wait is over. */
  private wake: (() => void) | undefined;
  /** A person's Restart under way: nothing is said of how it is meanwhile (Chips ADR 0094). */
  private restarting: Promise<void> | undefined;
  /** Restarts begun, so a health check asked before one, and answered after, is let go. */
  private restarts = 0;
  /** Why OpenCode's server isn't there, where the bridge knows more than that it doesn't answer. */
  private why: string | undefined;

  /** The files OpenCode builds each agent from, where the bridge knows each agent's folder. */
  private readonly files: ContextFiles | undefined;
  private readonly places: Places;
  /** Each folder's project root, as OpenCode said it. */
  private readonly roots = new Map<string, string>();
  /** Whether the server reads the files its config's `instructions` names, asked once a start or a restart. */
  private readsNamed: Promise<boolean> | undefined;
  /** Agents compacting now, by whose sessions they are: waiting for their session's next step, or under way, and the ask from Chips. */
  private readonly compacting = new Map<string, { state: "queued" | "running"; changeId?: string | undefined }>();

  constructor(private readonly options: BridgeOptions) {
    this.log = options.log ?? (() => undefined);
    this.places = options.places ?? placesOf(process.env, homedir());
    const known = options.folders !== undefined || options.directory !== undefined;
    this.files = known ? new ContextFiles(this.places, options.folders) : undefined;
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
    chips.on("agent.fork", (fork) => {
      this.copy(fork).catch((error: unknown) => this.log(`a copy went wrong: ${messageOf(error)}`));
    });
    chips.onSpaceAsked((asked) => {
      this.claim(asked).catch((error: unknown) => this.log(`a space from the + went wrong: ${messageOf(error)}`));
    });
    chips.on("feedback", (feedback) => {
      this.notRight(feedback).catch((error: unknown) => this.log(`a second look went wrong: ${messageOf(error)}`));
    });
    // Each agent's model and files as OpenCode has them now (Chips ADR 0241).
    for (const agent of await chips.agents.list().catch(() => [])) {
      if (agent.state !== "archived") await this.sendModel(agent.agentId);
    }
    await this.sendContexts();
    await this.sendWindows();
    await this.sayHowItIs();
    this.health = setInterval(() => void this.sayHowItIs(), this.options.healthEveryMs ?? 30_000);
    this.health.unref();
  }

  stop(): void {
    if (this.health !== undefined) clearInterval(this.health);
    this.listening.abort();
  }

  /**
   * A person's Restart (Chips ADR 0094): the server stopped and started again, then how it is,
   * fine or why not. Asked again meanwhile, it is the same restart. Nothing where the bridge
   * doesn't run the server, which never says it hears restarts.
   */
  restart(): Promise<void> {
    if (this.restarting === undefined) this.restarts += 1;
    this.restarting ??= (async () => {
      try {
        await this.restartServer();
      } finally {
        this.restarting = undefined;
      }
      await this.sayHowItIs();
    })();
    return this.restarting;
  }

  private async restartServer(): Promise<void> {
    const again = this.options.restartServer;
    if (again === undefined) return;
    this.log("a person asked for a restart");
    try {
      await again();
      this.why = undefined;
      // The same OpenCode, or one upgraded meanwhile: what it reads is asked again.
      this.readsNamed = undefined;
      // The event stream opened again now; what was missed meanwhile is read once it is.
      this.wake?.();
    } catch (error) {
      const why = messageOf(error).replace(/\s+/g, " ").trim();
      this.why = why.length <= TROUBLE_CHARS ? why : `${why.slice(0, TROUBLE_CHARS - 1)}…`;
      this.log(`OpenCode's server isn't back: ${why}`);
      // Nothing will answer the turns going: each ends, and says why.
      for (const turn of this.turns.values()) turn.end({ outcome: "failed", why: "OpenCode didn't come back after a restart" });
    }
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

  /**
   * Trouble while the server doesn't answer, and fine once it does (ADR 0083). Nothing while a
   * restart is under way: its end says (ADR 0094). Nor an answer to a check asked before a restart
   * began, even one over by now: it is of the server before, and a failed restart's words would go.
   */
  private async sayHowItIs(): Promise<void> {
    if (this.restarting !== undefined) return;
    const restarts = this.restarts;
    const up = await this.options.opencode.healthy();
    if (this.restarts !== restarts) return;
    if (up) this.why = undefined;
    const chips = this.options.chips;
    await (up ? chips.reportOk() : chips.reportTrouble(this.why ?? "OpenCode isn't answering")).catch(() => undefined);
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
      const woken = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), wait);
        this.wake = () => {
          clearTimeout(timer);
          resolve(true);
        };
      });
      this.wake = undefined;
      wait = woken ? first : Math.min(wait * 2, 15_000);
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
    await this.sendModel(agent.agentId);
    await this.sendContexts();
  }

  /**
   * A space a person asked for from Chips's + (Chips ADR 0241), or beside another harness: claimed
   * under a key of its own, named from its first words, and Chips makes the new agent the key is
   * for and puts it in the space. That agent answers the first words, which are the ask's and are
   * not heard again as a message, as the first OpenCode agent, in a session and a folder of its
   * own. A claim heard again finds the space claimed already, and the agent the same.
   */
  private async claim(asked: SpaceAsked): Promise<void> {
    const { chips } = this.options;
    const { spaceId, firstMessage } = asked;
    const key = `opencode:space:${spaceId}`;
    await chips.claimSpace(spaceId, key, titleFrom(firstMessage.text));
    const agent = (await chips.agents.list()).find((each) => each.key === key);
    if (agent === undefined) {
      this.log(`claimed ${spaceId}, and Chips put no agent there`);
      return;
    }
    this.ours.add(agent.agentId);
    this.log(`${agent.name} claimed ${spaceId}`);
    await this.sendModel(agent.agentId);
    await this.sendContexts();
    // Who said them, as the space's lines name them, with their standing (Chips SEC-49).
    const context = await chips.roomContext(spaceId, { limit: 20 }).catch(() => undefined);
    const said = context?.lines.find((line) => line.message_id === firstMessage.messageId)?.from;
    const message = {
      type: "message.new",
      space_id: spaceId,
      message_id: firstMessage.messageId,
      text: firstMessage.text,
      from: {
        participant_id: asked.askedBy,
        kind: "person",
        display_name: said?.name ?? "Someone",
        role: said?.role ?? "member",
        ...(said?.workspace_role === undefined ? {} : { workspace_role: said.workspace_role }),
      },
      for: [agent.agentId],
    } as unknown as MessageNew;
    await this.hear(message);
  }

  /** A person's Fork, made once however often it is heard at a time. */
  private copy(fork: AgentFork): Promise<void> {
    const going = this.copying.get(fork.id);
    if (going !== undefined) return going;
    const made = this.makeCopy(fork).finally(() => this.copying.delete(fork.id));
    this.copying.set(fork.id, made);
    return made;
  }

  /**
   * A person asked for a copy of one of its agents in another room (Chips ADR 0087, Fork). The
   * agent's session in the room it is in is copied in OpenCode, renamed and marked for the room
   * and the copy, and is the copy's session there. The copy works in the original's folder and is
   * keyed by the ask, which keeps what it copied before the copy is registered, so an ask heard
   * again registers the same copy and copies nothing more. An agent that never spoke in its room
   * has nothing to copy: its copy starts a session of its own there, in the same folder. An agent
   * that isn't one of the harness's has no copy, nor has an ask the room stopped waiting for.
   */
  private async makeCopy(fork: AgentFork): Promise<void> {
    const { chips, opencode, state, saveState } = this.options;
    const spaceId = fork.space_id;
    if (spaceId === undefined) return;
    const late = Date.now() - Date.parse(fork.ts);
    if (late >= FORK_WAIT_MS) {
      this.log(`no copy of ${fork.agent_id} for ${spaceId}: asked ${Math.round(late / 1000)} s ago, and the room has stopped waiting`);
      return;
    }
    const agent = await this.runnerOf(fork.agent_id);
    if (agent === undefined) {
      this.log(`no copy of ${fork.agent_id} for ${spaceId}: it isn't one of this harness's agents`);
      return;
    }
    // Whose its sessions are, as `roomOf` says: the key of one configured here, else its Chips id.
    const who = fork.agent_id === agent.agentId ? agent.key : fork.agent_id;
    const original = (await chips.agents.list().catch(() => [])).find((each) => each.agentId === fork.agent_id);
    const name = original?.name ?? agent.config.name;
    let kept = state.forks?.[fork.id];
    let copied: Awaited<ReturnType<OpenCodeClient["fork"]>> | undefined;
    if (kept === undefined) {
      const from = this.sessionToCopy(who, original?.room);
      if (from === undefined) this.log(`${name} never spoke in its room: its copy starts with nothing to remember`);
      else {
        copied = await opencode.fork(from).catch((error: unknown) => {
          if (!nothingToCopy(error)) throw error;
          this.log(`${name}'s session has nothing in OpenCode to copy: its copy starts with nothing to remember`);
          return undefined;
        });
      }
      const folder = await this.folderFor({ who, agent });
      kept = { ...(copied === undefined ? {} : { session: copied.id }), ...(folder === undefined ? {} : { folder }) };
      state.forks = { ...state.forks, [fork.id]: kept };
      saveState(state);
    }
    const copy = await chips.agents.register({
      key: `opencode:fork:${fork.id}`,
      name: forkName(name),
      forkedFrom: fork.agent_id,
      spaceId,
    });
    // Saved before anything else is heard; a room's first session waits for the copy besides.
    this.ours.add(copy.agentId);
    if (kept.session !== undefined) state.sessions[`${copy.agentId}|${spaceId}`] = kept.session;
    if (kept.folder !== undefined) state.folders = { ...state.folders, [copy.agentId]: kept.folder };
    // It runs on what its original runs on: a session copied keeps its model, and so does the agent.
    const pick = state.models?.[who];
    if (pick !== undefined) state.models = { ...state.models, [copy.agentId]: pick };
    saveState(state);
    if (copied !== undefined) {
      // The copy came with the original's room and name: it is called and marked for its own.
      await opencode
        .update(copied.id, {
          title: `Chips space ${spaceId}`,
          metadata: { ...copied.metadata, chips_space: spaceId, chips_agent: copy.agentId },
        })
        .catch((error: unknown) => this.log(`${copy.name}'s session keeps ${name}'s title: ${messageOf(error)}`));
    }
    this.log(
      `${copy.name}, a copy of ${name}, made${kept.session === undefined ? " new" : ` from ${kept.session}`}` +
        // Not in the room, and no why: it is there already, from the ask heard before.
        `${copy.attached === false && copy.why !== undefined ? `; not in the room: ${copy.why}` : ""}`,
    );
    void this.sendModel(copy.agentId).then(() => this.sendContexts());
  }

  /** The session of an agent's to copy: its room's, or where it is in none, the last it had. */
  private sessionToCopy(who: string, room: string | null | undefined): string | undefined {
    const { sessions } = this.options.state;
    if (room !== undefined && room !== null) return sessions[`${who}|${room}`];
    return Object.entries(sessions).findLast(([id]) => id.startsWith(`${who}|`))?.[1];
  }

  // ------------------------------------------------------------------ what a person changes from an agent's page

  /**
   * Which OpenCode agent a Chips agent of the harness's runs as, and whose its sessions and its
   * pick are, as `roomOf` says: the key of one configured here, else its Chips id. Nothing for an
   * agent not the harness's.
   */
  private async whoseIs(agentId: string): Promise<{ agent: Running; who: string } | undefined> {
    const agent = await this.runnerOf(agentId);
    if (agent === undefined || agentId === this.options.chips.harnessId) return undefined;
    return { agent, who: agentId === agent.agentId ? agent.key : agentId };
  }

  /**
   * What an agent runs on with no pick of its own: its model in the bridge's config, else its
   * OpenCode agent's, else the server's default.
   */
  private async fallbackOf(agent: Running): Promise<Fallback | undefined> {
    if (agent.model !== undefined) return { model: agent.model, label: "As in config.json" };
    const { opencode } = this.options;
    const own = (await opencode.agents().catch(() => [])).find((each) => each.id === agent.config.agent)?.model;
    if (own !== undefined) return { model: own, label: "OpenCode's default" };
    const model = await opencode.defaultModel();
    return model === undefined ? undefined : { model: { providerID: model.providerID, id: model.id }, label: "OpenCode's default" };
  }

  /** An agent's model, as OpenCode and the bridge have it now: nothing for an agent not the harness's. */
  private async modelCopyOf(agentId: string): Promise<AgentModelCopy | undefined> {
    const whose = await this.whoseIs(agentId);
    if (whose === undefined) return undefined;
    const [catalogue, fallback] = await Promise.all([this.options.opencode.models(), this.fallbackOf(whose.agent)]);
    return modelCopy({ catalogue, pick: this.options.state.models?.[whose.who], fallback });
  }

  /** An agent's model sent, where it changed since it last was (Chips takes the same copy once). */
  private async sendModel(agentId: string): Promise<void> {
    try {
      const copy = await this.modelCopyOf(agentId);
      if (copy !== undefined) await this.options.chips.settings.model(agentId, copy);
    } catch (error) {
      this.log(`the model of ${agentId} not sent: ${messageOf(error)}`);
    }
  }

  /**
   * A person's pick of an agent's model and level from its page (Chips ADR 0241): kept with the
   * bridge's state, and given to each of its sessions before its next message there. Only a model
   * OpenCode runs, at one of its levels; `null` is its default again. Answered with its copy.
   */
  async modelChanged(change: ModelChangeFrame): Promise<AgentModelCopy> {
    const whose = await this.whoseIs(change.agent_id);
    if (whose === undefined) throw new Refuse("This harness has no such agent.");
    const { opencode, state, saveState } = this.options;
    let pick: ModelPick | null;
    try {
      pick = pickOf(change, await opencode.models());
    } catch (error) {
      throw new Refuse(messageOf(error), await this.modelCopyOf(change.agent_id).catch(() => undefined));
    }
    const models = { ...state.models };
    if (pick === null) delete models[whose.who];
    else models[whose.who] = pick;
    state.models = models;
    saveState(state);
    const name = await this.nameOf(whose);
    this.log(`${name} runs on ${pick === null ? "its default" : `${pick.model}${pick.effort === undefined ? "" : ` at ${pick.effort}`}`}, from Chips`);
    const copy = await this.modelCopyOf(change.agent_id);
    if (copy === undefined) throw new Refuse("OpenCode names no model for it.");
    return copy;
  }

  /**
   * The session a message goes to, put on the model its agent runs on, where it isn't on it
   * already (Chips ADR 0241): its pick, else its model in the bridge's config. A session that was
   * put on another before, with neither now, goes back to its OpenCode agent's or the server's.
   */
  private async modelled(sessionId: string, { who, agent }: Pick<Room, "who" | "agent">): Promise<void> {
    const { opencode, state } = this.options;
    const pick = state.models?.[who];
    try {
      const has = (await opencode.session(sessionId))["model"] as ModelRef | undefined;
      const want = pick !== undefined ? refOf(pick) : (agent.model ?? (has === undefined ? undefined : (await this.fallbackOf(agent))?.model));
      if (want === undefined || sameModel(want, has)) return;
      await opencode.setModel(sessionId, want);
      this.log(`${sessionId} runs on ${writtenOf(want)}${want.variant === undefined ? "" : ` at ${want.variant}`} from now`);
    } catch (error) {
      // A session OpenCode no longer has is made again, on the right model, when the words find it gone.
      if (!(error instanceof OpenCodeError && error.tag === "SessionNotFoundError")) {
        this.log(`${sessionId} stays on its model: ${messageOf(error)}`);
      }
    }
  }

  /** The folder an agent's sessions work in, its own or the one project's; none where the bridge knows neither. */
  private async agentFolder(whose: Pick<Room, "who" | "agent">): Promise<string | undefined> {
    return (await this.folderFor(whose)) ?? this.options.directory;
  }

  /**
   * What OpenCode reads for a folder beside its `AGENTS.md` files: where its walk up stops, and
   * from 2.0.30 the files its config's `instructions` names. A folder whose project OpenCode can't
   * say is its own project.
   */
  private async readingOf(folder: string): Promise<Reading> {
    const { opencode } = this.options;
    const { home } = this.places;
    let root = this.roots.get(folder);
    if (root === undefined) {
      root = await opencode.projectRoot(folder).catch(() => folder);
      this.roots.set(folder, root);
    }
    this.readsNamed ??= opencode.version().then(
      (version) => !before(version, READS_NAMED),
      () => false,
    );
    const sources = (await this.readsNamed) ? await opencode.instructions(folder).catch(() => []) : [];
    return { stop: within(folder, home) ? home : root, named: namedFiles(sources, folder, root, home) };
  }

  /** Each agent of the harness's, with the folder its sessions work in and what OpenCode reads there. */
  private async agentReadings(): Promise<{ agentId: string; folder: string; reading: Reading }[]> {
    const read: { agentId: string; folder: string; reading: Reading }[] = [];
    for (const agent of await this.options.chips.agents.list().catch(() => [])) {
      if (agent.state === "archived") continue;
      const whose = await this.whoseIs(agent.agentId);
      const folder = whose === undefined ? undefined : await this.agentFolder(whose);
      if (folder !== undefined) read.push({ agentId: agent.agentId, folder, reading: await this.readingOf(folder) });
    }
    return read;
  }

  /** The harness's own set and each agent's files, as they are on disk now: each sent where it changed. */
  private async sendContexts(): Promise<void> {
    const files = this.files;
    if (files === undefined) return;
    try {
      const read = await this.agentReadings();
      const readings = new Map(read.map((each) => [each.folder, each.reading]));
      await this.options.chips.settings.harnessContext(files.harnessCopy(readings, read.map((each) => each.folder)));
      for (const { agentId, folder, reading } of read) {
        await this.options.chips.settings.context(agentId, files.agentCopy(folder, reading));
      }
    } catch (error) {
      this.log(`the agents' files not sent: ${messageOf(error)}`);
    }
  }

  /** One agent's files sent, where they changed. */
  private async sendContext(agentId: string): Promise<void> {
    const whose = await this.whoseIs(agentId);
    const folder = whose === undefined ? undefined : await this.agentFolder(whose);
    if (this.files === undefined || folder === undefined) return;
    try {
      await this.options.chips.settings.context(agentId, this.files.agentCopy(folder, await this.readingOf(folder)));
    } catch (error) {
      this.log(`the files of ${agentId} not sent: ${messageOf(error)}`);
    }
  }

  /**
   * A person's edit of a file from Chips (Chips ADR 0134): saved where OpenCode reads it, only if
   * it is still the version they changed, and answered with the copy as it is now. OpenCode reads
   * it again before the agent's next model call, and tells the agent what changed: every agent
   * working in that folder, or for the harness's own set every agent that reads the file.
   */
  async contextEdited(edit: ContextEditFrame): Promise<AgentContextCopy | HarnessContextCopy> {
    const files = this.files;
    if (files === undefined) throw new Refuse("This bridge doesn't know where its agents' files are.");
    if (edit.agent_id === undefined) {
      const read = await this.agentReadings();
      const readings = new Map(read.map((each) => [each.folder, each.reading]));
      const folders = read.map((each) => each.folder);
      await files.saveShared(readings, folders, edit);
      this.log(`OpenCode's ${edit.name} saved from Chips`);
      return files.harnessCopy(readings, folders);
    }
    const whose = await this.whoseIs(edit.agent_id);
    const folder = whose === undefined ? undefined : await this.agentFolder(whose);
    if (whose === undefined || folder === undefined) throw new Refuse("This harness has no such agent.");
    const reading = await this.readingOf(folder);
    await files.saveAgent(folder, reading, edit);
    this.log(`${await this.nameOf(whose)}'s ${edit.name} saved from Chips`);
    // A copy of the agent works in its folder too, and reads the same file.
    for (const other of await this.agentReadings()) {
      if (other.agentId !== edit.agent_id && other.folder === folder) void this.sendContext(other.agentId);
    }
    return files.agentCopy(folder, reading);
  }

  // ------------------------------------------------------------------ how full each agent is (Chips ADRs 0146, 0241)

  /** The Chips agent whose sessions are `who`'s: a configured agent's, or the agent itself. */
  private agentIdOf(who: string): string {
    return this.agents.find((agent) => agent.key === who)?.agentId ?? who;
  }

  /** Whose a session is, by the rooms the bridge keeps: nothing for one it didn't make. */
  private whoseSession(sessionId: string): string | undefined {
    const id = Object.entries(this.options.state.sessions).find(([, each]) => each === sessionId)?.[0];
    return id?.slice(0, id.lastIndexOf("|"));
  }

  /** An agent's window copy sent, and kept with the bridge's state: nothing until it has said how full it is. */
  private async sendWindow(who: string): Promise<void> {
    const kept = this.options.state.windows?.[who];
    if (kept === undefined) return;
    this.options.saveState(this.options.state);
    await this.options.chips.settings
      .contextWindow(this.agentIdOf(who), windowCopy(kept, this.compacting.get(who)?.state))
      .catch((error: unknown) => this.log(`the context window of ${who} not sent: ${messageOf(error)}`));
  }

  /**
   * Each agent's window as it last said, at start. One the bridge kept nothing of, from before it
   * kept them, is read from the newest model call of its sessions.
   */
  private async sendWindows(): Promise<void> {
    const { opencode, state } = this.options;
    const whose = new Set(Object.keys(state.sessions).map((id) => id.slice(0, id.lastIndexOf("|"))));
    for (const who of whose) {
      if (state.windows?.[who] === undefined) {
        let newest: { sessionId: string; call: NonNullable<Awaited<ReturnType<OpenCodeClient["lastCall"]>>> } | undefined;
        for (const [id, sessionId] of Object.entries(state.sessions)) {
          if (!id.startsWith(`${who}|`)) continue;
          const call = await opencode.lastCall(sessionId).catch(() => undefined);
          if (call !== undefined && (newest === undefined || call.at > newest.call.at)) newest = { sessionId, call };
        }
        const model = newest?.call.model === undefined ? undefined : writtenOf(newest.call.model);
        const window = model === undefined ? undefined : await this.windowOf(model);
        if (newest === undefined || model === undefined || window === undefined) continue;
        const asOf = new Date(newest.call.at > 0 ? newest.call.at : Date.now()).toISOString();
        state.windows = { ...state.windows, [who]: { used: usedOf(newest.call.tokens as unknown as Tokens), window, model, asOf, session: newest.sessionId } };
      }
      await this.sendWindow(who);
    }
  }

  /** A turn ended: how full it got, where that passed half the window, and the copy as it is now. */
  private async turnHeld(turn: Turn): Promise<void> {
    const kept = this.options.state.windows?.[turn.who];
    if (kept === undefined) return;
    if (turn.peak > kept.window / 2) {
      kept.longTurn = { at: new Date().toISOString(), peak: Math.round(turn.peak), folds: turn.folds };
    }
    await this.sendWindow(turn.who);
  }

  /**
   * What OpenCode says of a compaction of one of the agents' sessions: under way, done, with how
   * much it held before and after, or failed. A Compact now asked from Chips that failed is
   * refused after all, in OpenCode's words.
   */
  private compactionHeard(sessionId: string, event: OpenCodeEvent): void {
    // What it keeps of the room's rules is its summary's to say: they are said again (Chips ADR 0250).
    if (event.type === "session.compaction.started") this.rules.forget(sessionId);
    const who = this.whoseSession(sessionId);
    const kept = who === undefined ? undefined : this.options.state.windows?.[who];
    if (who === undefined || kept === undefined) return;
    const asked = this.compacting.get(who);
    if (event.type === "session.compaction.started") {
      if (asked === undefined) this.compacting.set(who, { state: "running" });
      else asked.state = "running";
      void this.sendWindow(who);
      return;
    }
    if (event.type === "session.compaction.ended") {
      this.compacting.delete(who);
      const to = compactedTo(event.data);
      const by = event.data["reason"] === "manual" ? "asked" : "itself";
      kept.last = { at: new Date().toISOString(), from: Math.round(kept.used), to, by };
      kept.used = to;
      kept.asOf = kept.last.at;
      kept.session = sessionId;
      const turn = this.turns.get(sessionId);
      if (turn !== undefined && by === "itself") turn.folds += 1;
      this.log(`${who} compacted (${by}), ${kept.last.from} to ${to} tokens`);
      void this.sendWindow(who);
      return;
    }
    if (event.type === "session.compaction.failed") {
      this.compacting.delete(who);
      const error = (event.data["error"] ?? {}) as Record<string, unknown>;
      const why = text(error["message"]) ?? "OpenCode didn't compact it.";
      this.log(`${who} not compacted: ${why}`);
      if (asked?.changeId === undefined) {
        void this.sendWindow(who);
        return;
      }
      void this.options.chips.settings
        .contextWindowFailed(this.agentIdOf(who), asked.changeId, why, windowCopy(kept))
        .catch((failed: unknown) => this.log(`the context window of ${who} not sent: ${messageOf(failed)}`));
    }
  }

  /**
   * A person's Compact now (Chips ADR 0146): asked of OpenCode for the session the agent said it
   * was in last, which takes it at once when idle and at its next step when working, and answered
   * with the copy saying so. How it goes comes in OpenCode's own events.
   */
  async windowCompact(ask: WindowCompactFrame): Promise<AgentContextWindowCopy> {
    const whose = await this.whoseIs(ask.agent_id);
    if (whose === undefined) throw new Refuse("This harness has no such agent.");
    const { who } = whose;
    const kept = this.options.state.windows?.[who];
    if (kept === undefined) throw new Refuse(`${await this.nameOf(whose)} hasn't said how full it is yet.`);
    if (this.compacting.has(who)) throw new Refuse("It is compacting already.", windowCopy(kept, this.compacting.get(who)?.state));
    const { opencode } = this.options;
    const busy = this.turns.has(kept.session) || (await opencode.active().catch(() => new Set<string>())).has(kept.session);
    this.compacting.set(who, { state: busy ? "queued" : "running", changeId: ask.change_id });
    try {
      await opencode.compact(kept.session);
    } catch (error) {
      this.compacting.delete(who);
      throw new Refuse(`OpenCode didn't take it: ${messageOf(error)}`, windowCopy(kept));
    }
    this.log(`${await this.nameOf(whose)} compacts ${busy ? "at its session's next step" : "now"}, from Chips`);
    // As it stands now: a compaction done meanwhile has said so already.
    return windowCopy(kept, this.compacting.get(who)?.state);
  }

  /** A person's limit: OpenCode keeps its own, set in its config, and the copy says so. */
  async windowChange(ask: WindowChangeFrame): Promise<AgentContextWindowCopy> {
    const whose = await this.whoseIs(ask.agent_id);
    const kept = whose === undefined ? undefined : this.options.state.windows?.[whose.who];
    if (whose === undefined) throw new Refuse("This harness has no such agent.");
    const copy = kept === undefined ? undefined : windowCopy(kept, this.compacting.get(whose.who)?.state);
    throw new Refuse(copy?.why_read_only ?? "OpenCode keeps its own limit.", copy);
  }

  // ------------------------------------------------------------------ what is said to it

  /** A message for some of its agents: each takes a turn in its room, one after another there. */
  private async hear(message: MessageNew, own: Pick<Asked, "goal" | "saysWho"> = {}): Promise<void> {
    const spaceId = message.space_id;
    if (spaceId === undefined) return;
    const harnessId = this.options.chips.harnessId;
    for (const taker of message.for ?? [harnessId]) {
      const agent = await this.runnerOf(taker);
      if (agent === undefined) continue;
      const room = this.roomOf(agent, taker, spaceId);
      room.queue.push({ message, speakerId: taker === harnessId ? undefined : taker, ...own });
      void this.pump(room);
    }
  }

  /**
   * A person's Not right? on one of its agents' messages (Chips ADR 0200): their note, or a 👎
   * from a device from before it, is a message for the agent who said it, found by the message in
   * the room's lines, and heard as any other, after what that agent's session there has to do
   * first. A message the room no longer has goes to whoever a message for nobody would. Any other
   * reaction, a 👍 among them, is nothing, and each feedback is answered once.
   */
  private async notRight(feedback: Feedback): Promise<void> {
    const { space_id: spaceId, message_id: messageId } = feedback;
    const note = feedback.kind === "correction" ? text(feedback.text?.trim()) : undefined;
    const asked = note !== undefined || (feedback.kind === "reaction" && feedback.reaction === "👎");
    if (!asked || spaceId === undefined || text(messageId) === undefined || this.looked.has(feedback.id)) return;
    this.looked.add(feedback.id);
    const oldest = this.looked.values().next().value;
    if (this.looked.size > LOOKS_KEPT && oldest !== undefined) this.looked.delete(oldest);
    const context = await this.options.chips.roomContext(spaceId, { limit: 200 }).catch(() => undefined);
    const said = context?.lines.find((line) => line.message_id === messageId);
    const look = secondLook(feedback.from.display_name, text(said?.text), note);
    // An id of its own, from the feedback's: never a real message's.
    const message = {
      type: "message.new",
      space_id: spaceId,
      message_id: `${feedback.id}:not-right`,
      text: look.text,
      from: feedback.from,
      ...(said === undefined ? {} : { for: [said.from.id] }),
    } as unknown as MessageNew;
    await this.hear(message, { goal: look.goal, saysWho: true });
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

  private async turn(room: Room, { message, speakerId, goal, saysWho }: Asked): Promise<void> {
    const { agent, spaceId } = room;
    const speaker = speakerId === undefined ? this.options.chips : this.options.chips.as(speakerId);
    const run = await speaker.runs.start({ spaceId, goal: goal ?? goalOf(message, agent.config.name) });
    const readied = await this.projectFor(room, speakerId ?? agent.agentId);
    const asked = {
      ...(speakerId === undefined ? {} : { taker: speakerId }),
      sayWho: saysWho !== true,
      sendsFiles: true,
      project: readied?.facts,
    };
    // A session told the room's rules isn't told them again until they change or it compacts.
    const rules = rulesFor(message, asked);
    const said = (session: string) =>
      promptFor(message, { ...asked, rulesHeld: this.rules.holds(session, rules) });
    let sessionId: string;
    let given: string;
    try {
      ({ sessionId, given } = await this.give(room, said, rules));
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
      who: room.who,
      agentId: speakerId ?? agent.agentId,
      peak: 0,
      folds: 0,
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
      project: readied === undefined ? undefined : { copy: readied.copy, name: readied.name },
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
    // What OpenCode offers may have changed meanwhile, a provider set up, and the agent may have
    // changed its own files.
    await this.sendModel(turn.agentId);
    await this.sendContext(turn.agentId);
    await this.turnHeld(turn);
  }

  /** The words into the room's session: the one it had, or a new one when OpenCode no longer has it. */
  private async give(
    { id, who, agent, spaceId }: Room,
    said: (sessionId: string) => string,
    rules: string,
  ): Promise<{ sessionId: string; given: string }> {
    const { opencode, state, saveState } = this.options;
    let kept = state.sessions[id];
    // A copy's session is saved once Chips has it: its first words wait, not to start a blank one.
    if (kept === undefined && this.copying.size > 0) {
      await Promise.allSettled(this.copying.values());
      kept = state.sessions[id];
    }
    if (kept !== undefined) {
      try {
        await this.modelled(kept, { who, agent });
        return { sessionId: kept, given: await this.prompted(kept, said(kept), rules) };
      } catch (error) {
        if (!(error instanceof OpenCodeError && error.tag === "SessionNotFoundError")) throw error;
        this.log(`${agent.config.name}'s session for ${spaceId} is gone from OpenCode: a new one`);
      }
    }
    const pick = state.models?.[who];
    const made = await opencode.newSession({
      title: `Chips space ${spaceId}`,
      agent: agent.config.agent,
      model: pick === undefined ? agent.model : refOf(pick),
      directory: await this.folderFor({ who, agent }),
      metadata: { chips_space: spaceId, chips_agent: who },
    });
    state.sessions[id] = made;
    saveState(state);
    return { sessionId: made, given: await this.prompted(made, said(made), rules) };
  }

  /**
   * The folder an agent's new sessions work in, its own: made the first time, named after it, and
   * kept by whose it is, so a rename doesn't move it. None without `folders`: the project's.
   */
  private async folderFor({ who, agent }: Pick<Room, "who" | "agent">): Promise<string | undefined> {
    const { folders: root, state, saveState } = this.options;
    if (root === undefined) return undefined;
    let folder = state.folders?.[who];
    if (folder === undefined) {
      const name = await this.nameOf({ who, agent });
      folder = freeFolder(root, name, Object.values(state.folders ?? {}));
      state.folders = { ...state.folders, [who]: folder };
      saveState(state);
    }
    mkdirSync(folder, { recursive: true });
    return folder;
  }

  /**
   * The room's project for a turn (Chips ADR 0221): the agent's copy in its own folder, brought up
   * to date, and what the turn is told of it. None without `folders`, nor where this machine has no
   * git for it.
   */
  private async projectFor(
    room: Room,
    agentId: string,
  ): Promise<{ copy: Project; name: string; facts: ProjectFacts } | undefined> {
    if (this.options.projects !== true) return undefined;
    const name = await this.nameOf(room);
    try {
      const folder = await this.folderFor(room);
      if (folder === undefined) return undefined;
      const project = this.options.chips.project({
        spaceId: room.spaceId,
        agentId,
        name,
        folder,
        log: (line) => this.log(line),
      });
      return { copy: project, name, facts: await project.pull() };
    } catch (error) {
      this.log(`${name}'s copy of the room's project couldn't be readied: ${messageOf(error)}`);
      return undefined;
    }
  }

  /**
   * What the turn changed in its copy, sent to the room's project before its words are posted: the
   * commit it left `main` at, for the reply to carry (Chips ADR 0222), when it sent one; else, when
   * the change didn't go, the line the reply says so in (Chips AP-6).
   */
  private async sendProject(turn: Turn, words: string): Promise<{ change?: string; note?: string }> {
    if (turn.project === undefined) return {};
    const { copy, name } = turn.project;
    try {
      const pushed = await copy.push({ words });
      this.log(`${name}'s project: ${pushedInWords(pushed)}`);
      if (pushed.state === "sent") return { change: pushed.commit };
      const note = heldNote(pushed, name);
      return note === undefined ? {} : { note };
    } catch (error) {
      this.log(`${name}'s project couldn't be sent: ${messageOf(error)}`);
      const note = heldNote({ state: "failed", why: messageOf(error) }, name);
      return note === undefined ? {} : { note };
    }
  }

  /** Whose session a room's is, by name: the configured agent's, or one Chips knows of. */
  private async nameOf({ who, agent }: Pick<Room, "who" | "agent">): Promise<string> {
    if (who === agent.key) return agent.config.name;
    const known = await this.options.chips.agents.list().catch(() => []);
    return known.find((each) => each.agentId === who)?.name ?? "agent";
  }

  /** A turn's first words into a session, what it says meanwhile held for the turn. */
  /**
   * A turn's words given to a session, which is told the room's rules they carry as they are
   * given, so a compaction heard during the turn forgets them (Chips ADR 0250).
   */
  private async prompted(sessionId: string, text: string, rules: string): Promise<string> {
    this.early.set(sessionId, []);
    this.rules.told(sessionId, rules);
    try {
      return await this.options.opencode.prompt(sessionId, text);
    } catch (error) {
      this.early.delete(sessionId);
      this.rules.forget(sessionId);
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
    // A copy names its original as `parentID` here, and is no sub-agent of it: nothing it does is the original's.
    if (event.type === "session.forked") return;
    // A compaction of an agent's session, asked from Chips or OpenCode's own: after what its turn
    // heard before it, where one is going.
    if (event.type.startsWith("session.compaction.")) {
      const going = this.turns.get(sessionId);
      if (going === undefined) this.compactionHeard(sessionId, event);
      else going.chain = going.chain.then(() => this.compactionHeard(sessionId, event));
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
        // Every token in, and how many of them the cache held (Chips ADR 0214).
        ...(prompt === undefined
          ? {}
          : { inputTokens: prompt, cacheReadTokens: tokens?.cache.read, cacheWriteTokens: tokens?.cache.write }),
        ...(written === undefined ? {} : { outputTokens: written }),
        ...(cost === undefined || cost <= 0 ? {} : { costUsd: cost }),
      })
      .catch(() => undefined);
    if (!own || event.type !== "session.step.ended" || prompt === undefined || written === undefined) return;
    const limit = await this.windowOf(model);
    if (limit === undefined) return;
    await turn.run.context({ usedTokens: prompt + written, limitTokens: limit, model }).catch(() => undefined);
    // How full the agent is, for its page (Chips ADR 0241): sent when the turn ends.
    const windows = (this.options.state.windows ??= {});
    windows[turn.who] = { ...windows[turn.who], used: prompt + written, window: limit, model, asOf: new Date().toISOString(), session: turn.sessionId };
    turn.peak = Math.max(turn.peak, prompt + written);
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
      .replyPermission(
        askingSession,
        requestId,
        decisionOf(decision, card.action.kind === "shell.exec"),
        decision.allowed ? undefined : decision.reason,
      )
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
    const { change, note } = await this.sendProject(turn, answer);
    // The files its `MEDIA:` lines name go with its words, from its session's folder (Chips TT-7).
    const folder = await this.folderOf(turn.sessionId);
    const { chips } = this.options;
    const words = [answer, note ?? ""].filter((part) => part !== "").join("\n\n");
    const post = await sendAnswer(words, {
      folders: folder === undefined ? [] : [folder],
      upload: (input) => chips.upload(input),
    });
    const reply = post.text;
    if (reply !== "" || post.uploadIds.length > 0) {
      await turn.speaker.post({ spaceId: run.spaceId, runId: run.id, text: reply, uploadIds: post.uploadIds, change });
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

/**
 * What a person changes of the harness's agents from their pages, made by the bridge once it is
 * running: each agent's model, files and context window (Chips ADR 0241).
 */
export function settingsFor(bridge: () => Bridge | undefined): SettingsHandlers {
  const active = (): Bridge => {
    const running = bridge();
    if (running === undefined) throw new Refuse("The harness is still starting.");
    return running;
  };
  return {
    models: (change) => active().modelChanged(change),
    context: (edit) => active().contextEdited(edit),
    contextWindows: {
      compact: (ask) => active().windowCompact(ask),
      change: (ask) => active().windowChange(ask),
    },
  };
}

// ------------------------------------------------------------------ small words

interface Field {
  readonly key: string;
  readonly type: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly options?: readonly { value: string; label: string; description?: string | undefined }[] | undefined;
  readonly custom?: boolean | undefined;
  readonly default?: unknown;
}

/**
 * OpenCode's decision for a person's answer: always where they said so, else once; a no is reject.
 * A command's Always is OpenCode's once (Chips ADR 0239): Chips remembers how each part of it
 * starts and answers the next ask itself, where OpenCode's own always would let through more.
 */
export function decisionOf(decision: Decision, command = false): PermissionDecision {
  if (!decision.allowed) return "reject";
  return decision.scope === "always" && !command ? "always" : "once";
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
      question: one === undefined ? "Change these files?" : `Change ${cut(baseName(one), QUESTION_MAX - 8)}?`,
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
    question: `${verb}${what === "" ? "" : ` ${cut(what, QUESTION_MAX - verb.length - 2)}`}?`,
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

/** A space's name from what it is for: its first line, cut at a word near 48 characters. */
export function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  if (line.length <= 48) return line;
  const cut = line.slice(0, 48);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 24))}…`;
}

/** A copy's name, as Jacobian names its forks: `Nova · fork`, which Chips numbers when it is taken. */
export function forkName(original: string): string {
  return `${original.trim().replace(/ · fork( \d+)?$/, "")} · fork`;
}

/** Whether a fork failed for want of anything to copy: an empty session, or one OpenCode no longer has. */
function nothingToCopy(error: unknown): boolean {
  return error instanceof OpenCodeError && (error.kind === "empty_session" || error.tag === "SessionNotFoundError");
}

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

/**
 * A second look's words and its run's goal (Chips ADR 0200): the reply quoted where the room
 * still has it, and what wasn't right, or, for a 👎 alone, that they didn't say. The goal is the
 * note's first line, which the thinking bubble shows.
 */
export function secondLook(who: string, reply: string | undefined, note: string | undefined): { text: string; goal: string } {
  const text = [
    `${who} says your reply in this space wasn't right.`,
    ...(reply === undefined ? [] : [`Your reply:\n«${cut(reply.trim(), REPLY_CHARS)}»`]),
    note === undefined ? "They didn't say what. Read your reply again and find what was wrong." : `What wasn't right: «${note}»`,
    "Look at it again and answer properly in its place. If it is not clear what was wrong, ask them in one short line. Say plainly what you changed.",
  ].join("\n\n");
  const first = note?.split("\n").find((line) => line.trim() !== "")?.trim();
  return { text, goal: first === undefined ? "Looking again at its reply" : cut(`Looking again: ${first}`, 120) };
}

/** At most `most` characters, the last of them an ellipsis where it was cut. */
/** The most an approval's question holds: the protocol's `maxLength`, past which Chips refuses the ask. */
const QUESTION_MAX = 200;

function cut(words: string, most: number): string {
  return words.length <= most ? words : `${words.slice(0, most - 1)}…`;
}

function lastLine(said: string): string {
  const lines = said.split(/(?<=[.!?])\s+|\n+/).map((line) => line.trim()).filter((line) => line !== "");
  return lines.at(-1) ?? "";
}
