/**
 * A scripted OpenCode V2 server for the tests, on OpenCode's own routes and event shapes: a
 * session plays by the words it was given.
 * - `ask` asks permission before running a command, and says the decision it was given; `fetch`,
 *   the same to open a page whose address is longer than an approval's question may be.
 * - `elsewhere` asks, and is answered in OpenCode's own apps.
 * - `question` asks a question by its form, and says the answer.
 * - `delegate` hands work to a sub-agent in a child session that says what it cost.
 * - `fail` fails.
 * - `slow` writes for a while, unless interrupted.
 * - `drop` loses the event stream midway, and ends while nobody listens.
 * - A second look after a person's Not right? (Chips ADR 0200) answers again.
 * - `recall` says the first words its session remembers, a copy's from its original's.
 * - `full` reads a great deal, compacts itself, and answers.
 * - Anything else reads a file, says so, and answers.
 *
 * A session is copied as OpenCode 2.0.25 copies one (`POST …/fork`): what it remembers, its
 * folder, agent, title and metadata go to a new session, announced by `session.forked`, which
 * names the original as `parentID`. A session with nothing in it is refused.
 *
 * Words given while a session works wait in its inbox: `steer` ones are taken at its next step,
 * the rest when it is done. An interrupt parks what waited; words given after it start afresh.
 *
 * With `askFirst`, the first session it made asks before it answers, as the golden scenario needs;
 * a space the scenario asks for from the + answers at once.
 *
 * Its catalogue is two models of `nous` it runs, one with levels, and one of `lathe` that is
 * disabled; Heron 2 is its default, and its `plan` agent runs on Heron Mini. A session runs on the
 * model it was made with or last switched to, which OpenCode takes whatever it is.
 *
 * Asked to compact a session (`POST …/compact`), it does at once when the session is idle, and
 * after the step it is on when it is working; with `compactFails`, it fails saying so.
 *
 * Restarted, its event streams are cut and nothing answers for a while; its sessions are kept, as
 * OpenCode keeps them on disk.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

interface Item {
  readonly id: string;
  readonly text: string;
  readonly delivery: string | undefined;
  parked: boolean;
}

interface FakeSession {
  readonly id: string;
  readonly agent: string;
  readonly parentID?: string;
  readonly inbox: Item[];
  /** The folder it was made to work in, when it was given one. */
  readonly directory?: string;
  /** The model it was made with or last switched to. */
  model?: unknown;
  /** Its newest model call's tokens and model, and when. */
  lastCall?: { tokens: unknown; model: unknown; at: number };
  /** A compaction asked while it worked, for its next step's end. */
  compactAsked?: boolean;
  title?: unknown;
  metadata?: unknown;
  /** What it remembers: each person's words it took, and each answer, in order. */
  readonly history: string[];
  busy: boolean;
  interrupted: boolean;
  outcome?: string;
  last: string;
  /** Its stream was lost: what it does until it ends nobody hears. */
  dropped?: boolean;
}

export interface Prompted {
  readonly sessionId: string;
  readonly text: string;
  readonly delivery: string | undefined;
}

export interface Created {
  readonly id: string;
  readonly agent: unknown;
  readonly model: unknown;
  readonly location: unknown;
  readonly metadata: unknown;
}

/** What the thinking model answers, once its thinking is over. */
export const THOUGHTFUL = "Here it is:\n\n| Model | Score |\n|---|---|\n| A | 1 |";

/** What a second look answers. */
export const AGAIN = "You're right: Sunday it is. I read the dates again.";

/** A page's address longer than the protocol lets an approval's question be. */
export const LONG_URL = `https://example.com/search?q=${"chips+".repeat(40)}end`;

/** A session's copy: the session copied, and the copy. */
export interface Forked {
  readonly from: string;
  readonly to: string;
}

/** The models it offers, as `GET /api/model` lists them. */
export const CATALOGUE = [
  {
    id: "heron-2",
    modelID: "heron-2",
    providerID: "nous",
    name: "Heron 2",
    enabled: true,
    status: "active",
    variants: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }],
    limit: { context: 200_000, output: 8000 },
  },
  { id: "heron-mini", modelID: "heron-mini", providerID: "nous", name: "Heron Mini", enabled: true, status: "active", variants: [], limit: { context: 100_000, output: 4000 } },
  { id: "quill-1", modelID: "quill-1", providerID: "lathe", name: "Quill 1", enabled: false, status: "active", variants: [], limit: { context: 50_000, output: 4000 } },
];

export interface FakeOpenCode {
  readonly url: string;
  readonly password: string;
  readonly created: Created[];
  /** Each session switched onto a model (`POST /api/session/{id}/model`). */
  readonly switched: { sessionId: string; model: unknown }[];
  readonly forks: Forked[];
  /** Each change a session's title or metadata was given. */
  readonly updates: { sessionId: string; title: unknown; metadata: unknown }[];
  readonly prompts: Prompted[];
  readonly permissionReplies: { requestId: string; decision: unknown; message: unknown }[];
  readonly formReplies: { formId: string; answer: unknown }[];
  readonly interrupts: string[];
  readonly withdrawn: string[];
  up: boolean;
  /** How many times `GET /api/info` was asked: the bridge's health checks among them. */
  infoAsked: number;
  /** While set, `GET /api/info` waits for it, then answers as the server was when asked. */
  held: Promise<void> | undefined;
  /** A session OpenCode no longer has. */
  forget(sessionId: string): void;
  /** What a session remembers. */
  historyOf(sessionId: string): readonly string[];
  /** Stopped and started again: its streams cut, nothing answering for `downMs`, its sessions kept. */
  restart(downMs: number): Promise<void>;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startFakeOpenCode(
  options: {
    askFirst?: boolean;
    directory?: string;
    cold?: boolean;
    port?: number;
    password?: string;
    pid?: number;
    /** What `GET /api/info` says it is: 2.0.29 unless set. */
    version?: string;
    /** What its config's `instructions` names, for every folder. */
    instructions?: string[];
    /** Why each compaction fails, when they do. */
    compactFails?: string;
  } = {},
): Promise<FakeOpenCode> {
  /** With `cold`, its first catalogue answers are empty, as OpenCode 2.0's are for a project it hasn't loaded. */
  let cold = options.cold === true ? 2 : 0;
  /** The project its sessions work in, as OpenCode says it. */
  const directory = options.directory ?? "/work";
  const password = options.password ?? "opencode-test-password";
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  const sessions = new Map<string, FakeSession>();
  const streams = new Set<ServerResponse>();
  const answers = new Map<string, (value: unknown) => void>();
  let count = 0;
  let deaf = false;
  /** The first session it made, which asks first with `askFirst`. */
  let first: string | undefined;
  const next = (prefix: string) => `${prefix}_${(count += 1)}`;
  const fake: Omit<FakeOpenCode, "url" | "close" | "forget" | "historyOf" | "restart"> = {
    password,
    created: [],
    switched: [],
    forks: [],
    updates: [],
    prompts: [],
    permissionReplies: [],
    formReplies: [],
    interrupts: [],
    withdrawn: [],
    up: true,
    infoAsked: 0,
    held: undefined,
  };

  const emit = (type: string, data: Record<string, unknown>) => {
    if (deaf) return;
    const frame = `data: ${JSON.stringify({ id: next("evt"), type, created: Date.now(), data })}\n\n`;
    for (const stream of streams) stream.write(frame);
  };
  const tokens = { input: 1000, output: 40, reasoning: 10, cache: { read: 200, write: 0 } };
  const model = { providerID: "nous", id: "heron-2" };

  /** One model call, on the session's model: its message's start, what it says and does, and its cost. */
  const step = async (session: FakeSession, does: (message: string) => Promise<void>, of?: unknown, read = tokens) => {
    const message = next("msg");
    const on = of ?? session.model ?? model;
    emit("session.step.started", { sessionID: session.id, assistantMessageID: message, agent: session.agent, model: on, started: Date.now() });
    await does(message);
    emit("session.step.ended", { sessionID: session.id, assistantMessageID: message, finish: "stop", cost: 0.0042, tokens: read });
    session.lastCall = { tokens: read, model: on, at: Date.now() };
    if (session.compactAsked === true) {
      session.compactAsked = false;
      compaction(session, "manual");
    }
  };
  /** A compaction of the session: what it held summed up, and the newest words kept as they were. */
  const compaction = (session: FakeSession, reason: "auto" | "manual") => {
    emit("session.compaction.started", { sessionID: session.id, reason, recent: "" });
    if (options.compactFails !== undefined) {
      emit("session.compaction.failed", { sessionID: session.id, reason, error: { type: "ProviderError", message: options.compactFails } });
      return;
    }
    const used = { input: 600, output: 900, reasoning: 0, cache: { read: 5000, write: 0 } };
    emit("session.compaction.ended", { sessionID: session.id, reason, model, text: "## Objective\n…", recent: "r".repeat(400), tokens: used, cost: 0 });
  };
  const say = (session: FakeSession, message: string, text: string) => {
    session.last = text;
    session.history.push(text);
    emit("session.text.started", { sessionID: session.id, assistantMessageID: message, ordinal: 0 });
    emit("session.text.ended", { sessionID: session.id, assistantMessageID: message, ordinal: 0, text });
  };
  const tool = (session: FakeSession, message: string, id: string, name: string, input: Record<string, unknown>) => {
    emit("session.tool.input.started", { sessionID: session.id, assistantMessageID: message, id, name });
    emit("session.tool.called", { sessionID: session.id, assistantMessageID: message, id, input, executed: false });
  };
  const toolDone = (session: FakeSession, message: string, id: string, text: string) =>
    emit("session.tool.success", { sessionID: session.id, assistantMessageID: message, id, content: [{ type: "text", text }], executed: false });
  const waitFor = (id: string) => new Promise<unknown>((resolve) => answers.set(id, resolve));
  /** A session's model as OpenCode keeps it: given no level, its level is `default`. */
  const leveled = (given: unknown) => ({ variant: "default", ...(given as Record<string, unknown>) });

  /** Steering words waiting in the inbox, taken at a step's end. */
  const steerIn = (session: FakeSession) => {
    for (const item of session.inbox.filter((each) => each.delivery === "steer" && !each.parked)) {
      session.inbox.splice(session.inbox.indexOf(item), 1);
      emit("session.inbox.delivered", { sessionID: session.id, inboxID: item.id });
    }
  };

  const ask = async (session: FakeSession, message: string, requestId: string, command: string) => {
    tool(session, message, "call_1", "shell", { command });
    emit("permission.asked", {
      id: requestId,
      sessionID: session.id,
      action: "shell",
      resources: [command],
      save: [command],
      source: { type: "tool", messageID: message, id: "call_1" },
    });
    const decision = await waitFor(requestId);
    if (decision === "reject") {
      emit("session.tool.failed", { sessionID: session.id, assistantMessageID: message, id: "call_1", error: { type: "Permission", message: "denied" }, executed: false });
    } else toolDone(session, message, "call_1", "12 passed");
    return decision;
  };

  const play = async (session: FakeSession, words: string) => {
    // Its last line says "ask them", which is not asking first.
    if (words.startsWith("Look at it again")) return step(session, async (message) => say(session, message, AGAIN));
    if (/\brecall\b/.test(words)) {
      return step(session, async (message) => say(session, message, `First said here: ${session.history[0] ?? "nothing"}`));
    }
    if ((options.askFirst === true && session.id === first) || /\bask\b/.test(words)) {
      let decision: unknown;
      await step(session, async (message) => {
        decision = await ask(session, message, "per_1", "npm test");
      });
      return step(session, async (message) => say(session, message, `Given: ${String(decision)}`));
    }
    if (/\bfetch\b/.test(words)) {
      let decision: unknown;
      await step(session, async (message) => {
        tool(session, message, "call_3", "webfetch", { url: LONG_URL });
        emit("permission.asked", { id: "per_3", sessionID: session.id, action: "webfetch", resources: [LONG_URL], source: { type: "tool", messageID: message, id: "call_3" } });
        decision = await waitFor("per_3");
        toolDone(session, message, "call_3", "");
      });
      return step(session, async (message) => say(session, message, `Given: ${String(decision)}`));
    }
    if (/\belsewhere\b/.test(words)) {
      await step(session, async (message) => {
        tool(session, message, "call_2", "shell", { command: "rm -rf build" });
        emit("permission.asked", { id: "per_2", sessionID: session.id, action: "shell", resources: ["rm -rf build"], source: { type: "tool", messageID: message, id: "call_2" } });
        await sleep(80);
        emit("permission.replied", { sessionID: session.id, requestID: "per_2", reply: "once" });
        toolDone(session, message, "call_2", "");
      });
      return step(session, async (message) => say(session, message, "Cleaned."));
    }
    if (/\bquestion\b/.test(words)) {
      emit("form.created", {
        form: {
          id: "frm_1",
          sessionID: session.id,
          title: "Questions",
          metadata: { kind: "question" },
          fields: [
            {
              key: "q0",
              title: "Colour",
              description: "Which colour?",
              type: "string",
              options: [
                { value: "Red", label: "Red" },
                { value: "Blue", label: "Blue" },
              ],
              custom: true,
            },
          ],
        },
      });
      const answer = (await waitFor("frm_1")) as Record<string, unknown>;
      emit("form.replied", { id: "frm_1", sessionID: session.id, answer });
      return step(session, async (message) => say(session, message, `Chose: ${String(answer["q0"])}`));
    }
    if (/\bthink\b/.test(words)) {
      // A model that writes its thinking into its answer, as big-pickle does.
      return step(session, async (message) =>
        say(session, message, `Let me build a table.\n\n| Model | Score |\n| A | 1 |</think>${THOUGHTFUL}`),
      );
    }
    if (/\bfail\b/.test(words)) throw new Error("The model refused.");
    if (/\bfull\b/.test(words)) {
      // A great deal read, nearly all of the window; then OpenCode compacts it itself.
      await step(session, async (message) => say(session, message, "Read it all."), undefined, { ...tokens, input: 150_000 });
      compaction(session, "auto");
      return step(session, async (message) => say(session, message, "Compacted and done."));
    }
    if (/\bsend\b/.test(words)) {
      // Files named as the Chips SDK tells an agent: one from its folder, one from outside it.
      return step(session, async (message) => say(session, message, "The page is ready.\n\nMEDIA:page.html\nMEDIA:../secret.txt"));
    }
    if (/\bslow\b/.test(words)) {
      for (let i = 0; i < 30 && !session.interrupted; i += 1) {
        emit("session.text.delta", { sessionID: session.id, assistantMessageID: "msg_slow", ordinal: 0, delta: "." });
        steerIn(session);
        await sleep(20);
      }
      if (session.interrupted) return;
      return step(session, async (message) => say(session, message, "Slowly done."));
    }
    if (/\bdelegate\b/.test(words)) {
      await step(session, async (message) => {
        tool(session, message, "call_9", "subagent", { agent: "general", description: "Find three quotes", prompt: "Find three quotes." });
        const child: FakeSession = { id: next("ses"), agent: "general", parentID: session.id, inbox: [], history: [], busy: true, interrupted: false, last: "" };
        sessions.set(child.id, child);
        emit("session.created", { sessionID: child.id, parentID: session.id, projectID: "prj_1", slug: "child", version: "2.0.29" });
        await step(child, async (inner) => say(child, inner, "Three quotes."), { providerID: "nous", id: "heron-mini" });
        toolDone(session, message, "call_9", "Three quotes found.");
      });
      return step(session, async (message) => say(session, message, "Quotes are in."));
    }
    await step(session, async (message) => {
      emit("session.reasoning.ended", { sessionID: session.id, assistantMessageID: message, ordinal: 0, text: "Let me look at the notes." });
      say(session, message, "I'll read the notes first.");
      tool(session, message, "call_1", "read", { path: "notes.md" });
      toolDone(session, message, "call_1", "3 lines");
    });
    if (/\bdrop\b/.test(words)) {
      // The stream is lost, and the rest happens while nobody listens.
      for (const stream of streams) stream.destroy();
      deaf = true;
      session.dropped = true;
      await sleep(20);
      session.last = "Here is the answer.";
      return;
    }
    await step(session, async (message) => say(session, message, "Here is the answer."));
  };

  /** The session works through its inbox, then ends: succeeded, failed, or interrupted. */
  const execute = async (session: FakeSession) => {
    session.busy = true;
    session.interrupted = false;
    emit("session.execution.started", { sessionID: session.id });
    let failed: string | undefined;
    for (let item = session.inbox.find((each) => !each.parked); item !== undefined; item = session.inbox.find((each) => !each.parked)) {
      session.inbox.splice(session.inbox.indexOf(item), 1);
      emit("session.inbox.delivered", { sessionID: session.id, inboxID: item.id });
      // The person's words, the text's last line: not the room note before them, which may say "ask".
      const words = item.text.split("\n").at(-1) ?? "";
      session.history.push(words);
      try {
        await play(session, words);
      } catch (error) {
        failed = String((error as Error).message);
        break;
      }
      if (session.interrupted) break;
    }
    session.busy = false;
    if (session.interrupted) {
      session.outcome = "interrupted";
      emit("session.execution.interrupted", { sessionID: session.id, reason: "user" });
    } else if (failed !== undefined) {
      session.outcome = "failed";
      emit("session.execution.failed", { sessionID: session.id, error: { type: "ProviderError", message: failed } });
    } else {
      session.outcome = "succeeded";
      emit("session.execution.succeeded", { sessionID: session.id });
    }
    if (session.dropped === true) {
      session.dropped = false;
      deaf = false;
    }
    // Words given after an interrupt ring again: a fresh run for them.
    if (session.inbox.some((each) => !each.parked)) void execute(session);
  };

  const json = (response: ServerResponse, status: number, body?: unknown) => {
    if (body === undefined) {
      response.writeHead(status);
      response.end();
      return;
    }
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const bodyOf = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
    let text = "";
    for await (const chunk of request) text += String(chunk);
    return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
  };
  const missing = (response: ServerResponse, sessionId: string) =>
    json(response, 404, { _tag: "SessionNotFoundError", sessionID: sessionId, message: `Session not found: ${sessionId}` });

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://fake");
      const method = request.method ?? "GET";
      const path = url.pathname;
      const up = fake.up;
      if (method === "GET" && path === "/api/info") {
        fake.infoAsked += 1;
        await fake.held;
      }
      if (!up) return json(response, 503, { _tag: "Unavailable", message: "down" });
      if (request.headers.authorization !== auth) return json(response, 401, { _tag: "UnauthorizedError", message: "Authentication required" });
      if (method === "GET" && path === "/api/info") {
        return json(response, 200, { version: options.version ?? "2.0.29", pid: options.pid ?? 1, urls: [], paths: { tmp: "/tmp" } });
      }
      // A folder is a project of its own, outside any repository.
      const asked = url.searchParams.get("location[directory]") ?? directory;
      if (method === "GET" && path === "/api/location") return json(response, 200, { directory: asked, project: { id: "prj_1", directory: asked } });
      if (method === "GET" && path === "/api/config") {
        return json(response, 200, [
          ...(options.instructions === undefined ? [] : [{ type: "document", path: "/config/opencode.json", info: { instructions: options.instructions } }]),
          { type: "directory", path: "/config" },
        ]);
      }
      if (method === "GET" && path === "/api/agent") {
        if (cold > 0) {
          cold -= 1;
          return json(response, 200, { location: { directory: "/work" }, data: [] });
        }
        return json(response, 200, {
          location: { directory: "/work" },
          data: [
            { id: "build", name: "Build", mode: "primary", hidden: false },
            { id: "plan", name: "Plan", mode: "primary", hidden: false, model: { providerID: "nous", id: "heron-mini" } },
          ],
        });
      }
      if (method === "GET" && path === "/api/model") return json(response, 200, { location: { directory: "/work" }, data: CATALOGUE });
      if (method === "GET" && path === "/api/model/default") return json(response, 200, { location: { directory: "/work" }, data: CATALOGUE[0] });
      if (method === "GET" && path === "/api/event") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ id: next("evt"), type: "server.connected", data: {} })}\n\n`);
        streams.add(response);
        response.on("close", () => streams.delete(response));
        return;
      }
      if (method === "GET" && path === "/api/session/active") {
        return json(response, 200, { data: Object.fromEntries([...sessions.values()].filter((each) => each.busy).map((each) => [each.id, {}])) });
      }
      if (method === "POST" && path === "/api/session") {
        const body = await bodyOf(request);
        const id = next("ses");
        first ??= id;
        const own = (body["location"] as { directory?: unknown } | undefined)?.directory;
        sessions.set(id, {
          id,
          agent: String(body["agent"] ?? "build"),
          inbox: [],
          ...(typeof own === "string" ? { directory: own } : {}),
          ...(body["model"] === undefined ? {} : { model: leveled(body["model"]) }),
          title: body["title"],
          metadata: body["metadata"],
          history: [],
          busy: false,
          interrupted: false,
          last: "",
        });
        fake.created.push({ id, agent: body["agent"], model: body["model"], location: body["location"], metadata: body["metadata"] });
        emit("session.created", { sessionID: id, projectID: "prj_1", slug: "room", version: "2.0.29" });
        return json(response, 200, { data: { id, projectID: "prj_1", cost: 0, tokens, time: { created: 0, updated: 0 }, location: { directory: "/work" } } });
      }
      const route = /^\/api\/session\/([^/]+)(?:\/(.+))?$/.exec(path);
      const session = route === null ? undefined : sessions.get(route[1] ?? "");
      if (route === null) return json(response, 404, { _tag: "NotFound", message: "no such route" });
      if (session === undefined) return missing(response, route[1] ?? "");
      const rest = route[2];
      if (method === "GET" && rest === undefined) {
        return json(response, 200, {
          data: {
            id: session.id,
            outcome: session.outcome,
            title: session.title,
            metadata: session.metadata,
            ...(session.model === undefined ? {} : { model: session.model }),
            location: { directory: session.directory ?? directory },
          },
        });
      }
      if (method === "GET" && rest === "inbox") return json(response, 200, { data: session.inbox.map((item) => ({ id: item.id })) });
      if (method === "GET" && rest === "message") {
        const call = session.lastCall;
        return json(response, 200, {
          data: [
            {
              type: "assistant",
              content: [{ type: "text", text: session.last }],
              ...(call === undefined ? {} : { tokens: call.tokens, model: call.model, time: { created: call.at } }),
            },
          ],
          cursor: {},
        });
      }
      const body = method === "DELETE" ? {} : await bodyOf(request);
      if (method === "PATCH" && rest === undefined) {
        fake.updates.push({ sessionId: session.id, title: body["title"], metadata: body["metadata"] });
        if ("title" in body) session.title = body["title"];
        if ("metadata" in body) session.metadata = body["metadata"];
        return json(response, 204);
      }
      if (method === "POST" && rest === "fork") {
        if (session.history.length === 0) {
          return json(response, 400, { _tag: "InvalidRequestError", message: `Cannot fork empty session: ${session.id}`, kind: "empty_session" });
        }
        const id = next("ses");
        const title = typeof session.title === "string" ? `${session.title} (fork #1)` : undefined;
        sessions.set(id, {
          id,
          agent: session.agent,
          inbox: [],
          ...(session.directory === undefined ? {} : { directory: session.directory }),
          ...(session.model === undefined ? {} : { model: session.model }),
          title,
          metadata: session.metadata,
          history: [...session.history],
          busy: false,
          interrupted: false,
          last: "",
        });
        fake.forks.push({ from: session.id, to: id });
        const boundary = { type: "through", messageID: next("msg") };
        emit("session.forked", { sessionID: id, parentID: session.id, boundary });
        return json(response, 200, {
          data: {
            id,
            fork: { sessionID: session.id, boundary },
            projectID: "prj_1",
            agent: session.agent,
            cost: 0,
            tokens,
            time: { created: 0, updated: 0 },
            title,
            metadata: session.metadata,
            location: { directory: session.directory ?? directory },
          },
        });
      }
      if (method === "POST" && rest === "compact") {
        const id = next("msg");
        json(response, 200, { data: { id, sessionID: session.id, type: "compaction", payload: {}, delivery: "steer", time: { created: 0 } } });
        if (session.busy) session.compactAsked = true;
        else {
          emit("session.execution.started", { sessionID: session.id });
          emit("session.inbox.delivered", { sessionID: session.id, inboxID: id });
          compaction(session, "manual");
          emit("session.execution.succeeded", { sessionID: session.id });
        }
        return;
      }
      if (method === "POST" && rest === "model") {
        fake.switched.push({ sessionId: session.id, model: body["model"] });
        session.model = leveled(body["model"]);
        return json(response, 204);
      }
      if (method === "POST" && rest === "prompt") {
        const item: Item = { id: next("msg"), text: String(body["text"]), delivery: typeof body["delivery"] === "string" ? body["delivery"] : undefined, parked: false };
        fake.prompts.push({ sessionId: session.id, text: item.text, delivery: item.delivery });
        session.inbox.push(item);
        json(response, 200, { data: { id: item.id, sessionID: session.id, type: "user", delivery: item.delivery ?? "queue", time: { created: 0 }, payload: {} } });
        if (!session.busy) void execute(session);
        return;
      }
      if (method === "DELETE" && rest?.startsWith("inbox/")) {
        const id = rest.slice("inbox/".length);
        fake.withdrawn.push(id);
        const at = session.inbox.findIndex((item) => item.id === id);
        if (at >= 0) session.inbox.splice(at, 1);
        return json(response, 204);
      }
      if (method === "POST" && rest === "interrupt") {
        fake.interrupts.push(session.id);
        const was = session.busy;
        if (was) {
          session.interrupted = true;
          for (const item of session.inbox) item.parked = true;
          for (const [id, answer] of answers) {
            answers.delete(id);
            answer("reject");
          }
        }
        return json(response, 200, { interrupted: was });
      }
      const permission = /^permission\/([^/]+)\/reply$/.exec(rest ?? "");
      if (method === "POST" && permission !== null) {
        const requestId = permission[1] ?? "";
        fake.permissionReplies.push({ requestId, decision: body["decision"], message: body["message"] });
        const answer = answers.get(requestId);
        if (answer === undefined) return json(response, 404, { _tag: "PermissionNotFoundError", message: "not pending" });
        answers.delete(requestId);
        emit("permission.replied", { sessionID: session.id, requestID: requestId, reply: body["decision"] });
        answer(body["decision"]);
        return json(response, 204);
      }
      const form = /^form\/([^/]+)\/reply$/.exec(rest ?? "");
      if (method === "POST" && form !== null) {
        const formId = form[1] ?? "";
        fake.formReplies.push({ formId, answer: body["answer"] });
        const answer = answers.get(formId);
        if (answer === undefined) return json(response, 409, { _tag: "ConflictError", message: "already answered" });
        answers.delete(formId);
        answer(body["answer"]);
        return json(response, 204);
      }
      return json(response, 404, { _tag: "NotFound", message: "no such route" });
    })().catch((error: unknown) => {
      if (!response.headersSent) json(response, 500, { _tag: "Defect", message: String(error) });
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(fake, {
    url: `http://127.0.0.1:${port}`,
    forget: (sessionId: string) => void sessions.delete(sessionId),
    historyOf: (sessionId: string) => [...(sessions.get(sessionId)?.history ?? [])],
    restart: async (downMs: number) => {
      fake.up = false;
      for (const stream of streams) stream.destroy();
      await sleep(downMs);
      fake.up = true;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  }) as FakeOpenCode;
}
