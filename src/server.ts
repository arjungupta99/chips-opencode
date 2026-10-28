/**
 * OpenCode's server, run by the bridge when a person runs none of their own (Chips's setup audit
 * HS-5): nobody starts `opencode serve` by hand or makes up a password for it, and the gallery's
 * line carries none. Its port and password are kept in `server.json` beside the bridge's state,
 * readable by its user only, so the next start finds the same server: one still answering there
 * to that password (a bridge stopped hard leaves its server running) is taken up, and anything
 * else is started afresh. While the bridge runs, a server that stops is started again; when the
 * bridge stops, so does the server it started. A person's Restart in Chips (ADR 0094) stops it,
 * the one taken up from before included, and starts it again on the same port and password.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";

/** The server the bridge runs, once it answers. */
export interface OwnServer {
  readonly url: string;
  readonly password: string;
  /** Stop it, when the bridge started it; one it took up from before stays. */
  readonly stop: () => void;
  /**
   * Stop it, the one taken up from before included, and start it again on the same port and
   * password, so whatever speaks to it goes on as it was: a person's Restart. Resolves once it
   * answers again; throws a `ServerError` saying why when it doesn't. Asked again meanwhile, it is
   * the same restart.
   */
  readonly restart: () => Promise<void>;
}

export interface ServerOptions {
  /** Where `server.json` is kept: the bridge's own folder. */
  readonly folder: string;
  /** Where the server runs from: its default project, before each agent's own folder. */
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  /** OpenCode's command: `opencode` on the PATH. */
  readonly command?: string;
  readonly log?: (line: string) => void;
  /** How long it may take to answer once started (30 s). */
  readonly waitMs?: number;
  /** How long it is given to stop, for a restart, before it is killed (10 s). */
  readonly stopMs?: number;
}

/** Why the bridge's own server isn't there, said so a person can act on it. */
export class ServerError extends Error {
  override readonly name = "ServerError";
  constructor(
    message: string,
    /** OpenCode isn't installed here, rather than failing to start. */
    readonly missing = false,
  ) {
    super(message);
  }
}

interface Kept {
  readonly port: number;
  readonly password: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const onPath = (command: string, env: NodeJS.ProcessEnv) =>
  command.includes("/")
    ? existsSync(command)
    : (env["PATH"] ?? "").split(delimiter).some((folder) => {
        if (folder === "") return false;
        try {
          accessSync(join(folder, command), constants.X_OK);
          return true;
        } catch {
          return false;
        }
      });

/** A port nothing listens on now: 4096, OpenCode's own, when it is free. */
async function freePort(): Promise<number> {
  const tryPort = (port: number) =>
    new Promise<number | undefined>((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(undefined));
      probe.listen(port, "127.0.0.1", () => {
        const { port: got } = probe.address() as { port: number };
        probe.close(() => resolve(got));
      });
    });
  return (await tryPort(4096)) ?? (await tryPort(0)) ?? 4096;
}

/** What the server at `url` says of itself (`GET /api/info`) to `password`: `refused` (somebody else's), or `none`. */
async function infoOf(url: string, password: string): Promise<Record<string, unknown> | "refused" | "none"> {
  try {
    const answer = await fetch(`${url}/api/info`, {
      headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
      signal: AbortSignal.timeout(2000),
    });
    if (answer.ok) return ((await answer.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    return answer.status === 401 ? "refused" : "none";
  } catch {
    return "none";
  }
}

/** Whether a server answers at `url` to `password`: `ok`, `refused` (somebody else's), or `none`. */
async function answers(url: string, password: string): Promise<"ok" | "refused" | "none"> {
  const info = await infoOf(url, password);
  return typeof info === "string" ? info : "ok";
}

function keptIn(path: string): Kept | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const kept = JSON.parse(readFileSync(path, "utf8")) as Partial<Kept>;
    return typeof kept.port === "number" && typeof kept.password === "string" ? (kept as Kept) : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a process is still there. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A process asked to stop, and killed when it hasn't within `ms`: once it is gone. */
async function ended(pid: number, ms: number): Promise<void> {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(pid, signal);
    } catch {
      return;
    }
    for (const by = Date.now() + (signal === "SIGTERM" ? ms : 2000); alive(pid) && Date.now() < by; ) await sleep(50);
    if (!alive(pid)) return;
  }
}

/**
 * The bridge's own OpenCode server, answering: the one it started before, else a new one. Throws a
 * `ServerError` saying what to do when OpenCode isn't installed or its server won't start.
 */
export async function ownServer(options: ServerOptions): Promise<OwnServer> {
  const env = options.env ?? process.env;
  const command = options.command ?? "opencode";
  const log = options.log ?? (() => undefined);
  const path = join(options.folder, "server.json");
  let kept = keptIn(path);
  /** A server from before, still answering, taken up rather than started: no process of the bridge's. */
  let before = false;
  if (kept !== undefined) {
    const now = await answers(`http://127.0.0.1:${kept.port}`, kept.password);
    before = now === "ok";
    // Something else took the port: another one, the same password.
    if (now === "refused") kept = { port: await freePort(), password: kept.password };
  }
  if (!before && !onPath(command, env)) {
    throw new ServerError("OpenCode isn't installed on this machine: install it (opencode.ai), then run this again.", true);
  }
  kept ??= { port: await freePort(), password: randomBytes(24).toString("base64url") };
  const { port, password } = kept;
  const url = `http://127.0.0.1:${port}`;

  let child: ChildProcess | undefined;
  let stopping = false;
  /** It has answered once: from then on, a server that stops is started again. */
  let answered = false;
  let failed: string | undefined;
  let wait = 2000;
  let again: NodeJS.Timeout | undefined;
  const said: string[] = [];
  const start = () => {
    writeFileSync(path, `${JSON.stringify({ port, password }, null, 2)}\n`, { mode: 0o600 });
    const started = spawn(command, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: options.cwd,
      env: { ...env, OPENCODE_PASSWORD: password },
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [started.stdout, started.stderr]) {
      if (stream === null) continue;
      createInterface({ input: stream }).on("line", (line) => {
        said.push(line);
        if (said.length > 20) said.shift();
      });
    }
    started.on("exit", (code, signal) => {
      if (child !== started) return;
      child = undefined;
      if (stopping) return;
      if (!answered) {
        failed = signal ?? `exit ${code}`;
        return;
      }
      log(`OpenCode's server stopped (${signal ?? `exit ${code}`}): starting it again in ${wait / 1000} s`);
      again = setTimeout(() => {
        if (!stopping && child === undefined) start();
      }, wait);
      again.unref();
      wait = Math.min(wait * 2, 60_000);
    });
    started.on("error", (error) => {
      if (!answered) failed = error.message;
      log(`OpenCode's server didn't start: ${error.message}`);
    });
    child = started;
  };

  /** Started, and answering in its time; else stopped, and why in words. */
  const up = async (anew: boolean) => {
    stopping = false;
    answered = false;
    failed = undefined;
    said.length = 0;
    start();
    const by = Date.now() + (options.waitMs ?? 30_000);
    while ((await answers(url, password)) !== "ok") {
      if (failed !== undefined || Date.now() > by) {
        stopping = true;
        child?.kill("SIGTERM");
        const last = said.slice(-3).join(" ").trim();
        throw new ServerError(`OpenCode's server didn't start${anew ? " again" : ""} at ${url}${last === "" ? "" : `: ${last}`}`);
      }
      await sleep(250);
    }
    answered = true;
    wait = 2000;
  };

  /**
   * What answers now, stopped and gone: the server started here, or the one taken up from before,
   * by the process it says it is. One that doesn't say can't be stopped from here.
   */
  const down = async () => {
    stopping = true;
    clearTimeout(again);
    const stopMs = options.stopMs ?? 10_000;
    const pid = child?.pid;
    if (pid !== undefined) return ended(pid, stopMs);
    const info = await infoOf(url, password);
    if (typeof info === "string") return;
    // Never this process: a server that says so isn't one to stop.
    if (typeof info["pid"] !== "number" || info["pid"] <= 0 || info["pid"] === process.pid) {
      throw new ServerError(
        `OpenCode's server at ${url} was running before this bridge and doesn't say which process it is: stop it on this machine, then restart again.`,
      );
    }
    await ended(info["pid"], stopMs);
  };

  if (before) log(`OpenCode's server from before is still answering at ${url}`);
  else {
    await up(false);
    log(`OpenCode's own server answering at ${url}`);
  }

  let restarting: Promise<void> | undefined;
  const restart = async () => {
    // Nothing stopped that can't be started again.
    if (!onPath(command, env)) {
      throw new ServerError("OpenCode isn't installed on this machine any more: install it (opencode.ai), then restart again.", true);
    }
    log(`restarting OpenCode's server at ${url}`);
    await down();
    await up(true);
    log(`OpenCode's server is answering again at ${url}`);
  };
  return {
    url,
    password,
    stop: () => {
      stopping = true;
      clearTimeout(again);
      child?.kill("SIGTERM");
    },
    restart: () => {
      restarting ??= restart().finally(() => {
        restarting = undefined;
      });
      return restarting;
    },
  };
}
