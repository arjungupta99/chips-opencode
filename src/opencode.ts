/**
 * OpenCode's V2 server, as the bridge speaks it: `opencode serve`, or the background service
 * `opencode service start` runs. Read from its source (anomalyco/opencode, `packages/protocol` and
 * `packages/schema`, 2.0.29, 14 October 2026).
 * - Every call is under `/api` and carries Basic auth: `opencode` and the server's password.
 * - A prompt is admitted to a session's inbox and answered with the inbox item, not the answer.
 * - What happens comes on one event stream for the whole server, `GET /api/event`: `data:` lines
 *   of `{ id, type, created, data }`, a `: heartbeat` every 15 s. It is volatile: events missed
 *   while it is down are gone, so the bridge reads a session's state after it comes back.
 */

/** Where the server answers, and how. */
export interface ServerAddress {
  /** `http://127.0.0.1:4096`, where `opencode serve` listens by default. */
  readonly url: string;
  /** The server's password: what `opencode serve` was started with in `OPENCODE_PASSWORD`. */
  readonly password: string;
  /** The project the sessions work in. The server's own directory when absent. */
  readonly directory?: string | undefined;
}

/** One event on the stream. `data.sessionID` says whose it is, for a session's events. */
export interface OpenCodeEvent {
  readonly id: string;
  readonly type: string;
  readonly created?: number | undefined;
  readonly data: Readonly<Record<string, unknown>>;
}

/** A model as OpenCode names one: its provider and its id there. */
export interface ModelRef {
  readonly providerID: string;
  readonly id: string;
  readonly variant?: string | undefined;
}

export interface AgentInfo {
  readonly id: string;
  readonly name: string;
  readonly mode: "primary" | "subagent" | "all";
  readonly hidden: boolean;
  readonly description?: string | undefined;
}

export interface ModelInfo {
  readonly id: string;
  readonly providerID: string;
  readonly name: string;
  readonly limit: { readonly context: number };
}

export type PermissionDecision = "once" | "always" | "reject";
export type Delivery = "steer" | "queue";
export type FormAnswer = Readonly<Record<string, string | number | boolean | readonly string[]>>;

export class OpenCodeError extends Error {
  override readonly name = "OpenCodeError";
  constructor(
    message: string,
    readonly status: number,
    readonly tag?: string | undefined,
  ) {
    super(message);
  }
}

/** The fetch the client uses: the platform's, unless a test hands in its own. */
export type Fetch = typeof fetch;

/** `provider/model`, as a person writes one, as OpenCode names it. */
export function modelRefOf(written: string): ModelRef {
  const slash = written.indexOf("/");
  if (slash <= 0 || slash === written.length - 1) throw new Error(`a model is provider/model, not "${written}"`);
  return { providerID: written.slice(0, slash), id: written.slice(slash + 1) };
}

export class OpenCodeClient {
  private readonly root: string;
  private readonly auth: string;

  constructor(
    private readonly address: ServerAddress,
    private readonly fetcher: Fetch = fetch,
  ) {
    this.root = address.url.replace(/\/+$/, "");
    this.auth = `Basic ${Buffer.from(`opencode:${address.password}`).toString("base64")}`;
  }

  /** Whether the server answers, and to this password: `GET /api/info`. */
  async healthy(): Promise<boolean> {
    try {
      await this.call("GET", "/api/info");
      return true;
    } catch {
      return false;
    }
  }

  async agents(): Promise<AgentInfo[]> {
    return (await this.catalogue("agent")) as AgentInfo[];
  }

  async models(): Promise<ModelInfo[]> {
    return (await this.catalogue("model")) as ModelInfo[];
  }

  /**
   * A project's catalogue. OpenCode 2.0 answers the first ask for a project it hasn't loaded with
   * an empty list, and the next with the whole one: a server always has its `build` agent, so an
   * empty list is asked again, a few times, before it is believed.
   */
  private async catalogue(of: "agent" | "model"): Promise<unknown[]> {
    for (let tries = 1; ; tries += 1) {
      const listed = await this.call("GET", `/api/${of}${this.where()}`);
      const data = Array.isArray(listed["data"]) ? listed["data"] : [];
      if (data.length > 0 || tries === 4) return data;
      await new Promise((resolve) => setTimeout(resolve, 100 * tries));
    }
  }

  /** A session for a room, of one agent, in `directory`, else the project. */
  async newSession(input: {
    readonly title: string;
    readonly agent: string;
    readonly model?: ModelRef | undefined;
    readonly directory?: string | undefined;
    readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  }): Promise<string> {
    const directory = input.directory ?? this.address.directory;
    const made = await this.call("POST", "/api/session", {
      title: input.title,
      agent: input.agent,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(directory === undefined ? {} : { location: { directory } }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    });
    const id = (made["data"] as Record<string, unknown> | undefined)?.["id"];
    if (typeof id !== "string") throw new OpenCodeError("OpenCode made a session and named none", 502);
    return id;
  }

  /**
   * Words for a session. Idle, it starts on them. Busy, `queue` waits for what it is doing to end
   * and `steer` is read at its next step. The inbox item's id, which `session.inbox.delivered`
   * names when the session takes it.
   */
  async prompt(sessionId: string, text: string, delivery?: Delivery): Promise<string> {
    const admitted = await this.call("POST", `/api/session/${encodeURIComponent(sessionId)}/prompt`, {
      text,
      ...(delivery === undefined ? {} : { delivery }),
    });
    const id = (admitted["data"] as Record<string, unknown> | undefined)?.["id"];
    if (typeof id !== "string") throw new OpenCodeError("OpenCode took the words and named no inbox item", 502);
    return id;
  }

  /** Words the session hasn't taken yet, taken back. */
  async withdraw(sessionId: string, item: string): Promise<void> {
    await this.call("DELETE", `/api/session/${encodeURIComponent(sessionId)}/inbox/${encodeURIComponent(item)}`);
  }

  /** Stop what the session is doing. */
  async interrupt(sessionId: string): Promise<void> {
    await this.call("POST", `/api/session/${encodeURIComponent(sessionId)}/interrupt`, {});
  }

  /** A person's answer to a permission it asked: `reject` with a message tells the model why. */
  async replyPermission(sessionId: string, requestId: string, decision: PermissionDecision, message?: string): Promise<void> {
    await this.call(
      "POST",
      `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
      { decision, ...(message === undefined || message === "" ? {} : { message }) },
    );
  }

  async replyForm(sessionId: string, formId: string, answer: FormAnswer): Promise<void> {
    await this.call(
      "POST",
      `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}/reply`,
      { answer },
    );
  }

  /** The session as it stands: `outcome` says how its last run ended. */
  async session(sessionId: string): Promise<Record<string, unknown>> {
    const read = await this.call("GET", `/api/session/${encodeURIComponent(sessionId)}`);
    return (read["data"] as Record<string, unknown> | undefined) ?? {};
  }

  /** The ids of the words waiting in a session's inbox, not yet taken. */
  async waiting(sessionId: string): Promise<string[]> {
    const read = await this.call("GET", `/api/session/${encodeURIComponent(sessionId)}/inbox`);
    const items = Array.isArray(read["data"]) ? (read["data"] as Record<string, unknown>[]) : [];
    return items.map((item) => String(item["id"]));
  }

  /** The sessions working now. One absent is idle. */
  async active(): Promise<Set<string>> {
    const read = await this.call("GET", "/api/session/active");
    return new Set(Object.keys((read["data"] as Record<string, unknown> | undefined) ?? {}));
  }

  /** The words of the session's newest answer: for the end of a run whose events were missed. */
  async lastWords(sessionId: string): Promise<string> {
    const read = await this.call(
      "GET",
      `/api/session/${encodeURIComponent(sessionId)}/message?type=assistant&order=desc&limit=1`,
    );
    const newest = (Array.isArray(read["data"]) ? (read["data"] as Record<string, unknown>[]) : [])[0];
    const content = Array.isArray(newest?.["content"]) ? (newest["content"] as Record<string, unknown>[]) : [];
    return content
      .filter((part) => part["type"] === "text" && typeof part["text"] === "string")
      .map((part) => String(part["text"]))
      .join("\n\n");
  }

  /** Every event the server sends, each handed to `hear` as it comes, until the stream ends. */
  async events(hear: (event: OpenCodeEvent) => void, signal?: AbortSignal): Promise<void> {
    const answer = await this.fetcher(`${this.root}/api/event`, {
      headers: { authorization: this.auth, accept: "text/event-stream" },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!answer.ok || answer.body === null) throw await failureOf(answer);
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of answer.body as unknown as AsyncIterable<Uint8Array>) {
      buffered += decoder.decode(chunk, { stream: true });
      let end = buffered.indexOf("\n\n");
      while (end >= 0) {
        const event = eventOf(buffered.slice(0, end));
        buffered = buffered.slice(end + 2);
        if (event !== undefined) hear(event);
        end = buffered.indexOf("\n\n");
      }
    }
  }

  /** `?location[directory]=…` for the catalogues, which are per project. */
  private where(): string {
    const directory = this.address.directory;
    return directory === undefined ? "" : `?location%5Bdirectory%5D=${encodeURIComponent(directory)}`;
  }

  private async call(method: string, path: string, body?: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const answer = await this.fetcher(`${this.root}${path}`, {
      method,
      headers: {
        authorization: this.auth,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!answer.ok) throw await failureOf(answer);
    const text = await answer.text();
    return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
  }
}

/** One server-sent event's `data`, read as OpenCode's JSON, or nothing for a heartbeat. */
function eventOf(block: string): OpenCodeEvent | undefined {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  if (data === "") return undefined;
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    if (typeof parsed["type"] !== "string") return undefined;
    const fields = parsed["data"];
    return {
      id: String(parsed["id"] ?? ""),
      type: parsed["type"],
      created: typeof parsed["created"] === "number" ? parsed["created"] : undefined,
      data: typeof fields === "object" && fields !== null ? (fields as Record<string, unknown>) : {},
    };
  } catch {
    return undefined;
  }
}

/** OpenCode's errors are `{ _tag, message }`. */
async function failureOf(answer: Response): Promise<OpenCodeError> {
  let message = `OpenCode answered ${answer.status}`;
  let tag: string | undefined;
  try {
    const body = (await answer.json()) as { _tag?: string; message?: string };
    if (typeof body.message === "string" && body.message !== "") message = body.message;
    tag = body._tag;
  } catch {
    // Not JSON: the status says enough.
  }
  return new OpenCodeError(message, answer.status, tag);
}
