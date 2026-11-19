/**
 * What the bridge checks before it takes up a link, which works once (Chips ADR 0122): the server
 * password filled in rather than the `…` the gallery's command was copied with, OpenCode 2 rather
 * than OpenCode 1, and OpenCode answering to it. Anything missing stops it with what to do, and the
 * link is still good for the same command run again.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { filledIn, type StopWords } from "@chipschat/harness";
import type { AgentConfig } from "./bridge.js";
import { type AgentInfo, OpenCodeError } from "./opencode.js";
import { foldersPathOf, fromHome, placesOf } from "./places.js";
import { INSTALL_LINE } from "./server.js";

export interface Config {
  readonly name: string;
  readonly url: string;
  /** The password of a server a person runs; none when the bridge runs its own (`ownServer`). */
  readonly password: string | undefined;
  readonly passwordEnv: string;
  /**
   * The bridge runs OpenCode's server itself: no `url` in the config and no password in the
   * environment, so nobody starts `opencode serve` by hand (setup audit HS-5).
   */
  readonly ownServer: boolean;
  /** One project every session works in: a repository they share. Each agent has its own folder when absent. */
  readonly directory: string | undefined;
  /** Where each agent's own folder is made, without a `directory`. */
  readonly folders: string;
  readonly agents: readonly AgentConfig[];
}

/**
 * Something to put right before the bridge starts, said so a person can: the message in a terminal,
 * `words` on Chips for Mac's sheet (Chips ADR 0218, phase 5).
 */
export class SetupError extends Error {
  override readonly name = "SetupError";
  constructor(
    message: string,
    readonly words: StopWords = {},
  ) {
    super(message);
  }
}

/** Where a server is, as a person reads it: `127.0.0.1:4096`. */
export const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export const STILL_GOOD = "The link is still good: run the same command again once that's done.";


/** The config at `path`, or the defaults when there is none, with the password from the environment. */
export function readConfig(path: string, env: NodeJS.ProcessEnv = process.env): Config {
  const raw = (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}) as Record<string, unknown>;
  const passwordEnv = typeof raw["passwordEnv"] === "string" ? raw["passwordEnv"] : "OPENCODE_PASSWORD";
  const password = filledIn(env[passwordEnv]) ? env[passwordEnv] : undefined;
  const ownServer = password === undefined && typeof raw["url"] !== "string";
  if (password === undefined && !ownServer) {
    throw new SetupError(
      `OpenCode's server password isn't in $${passwordEnv}: give it the one \`opencode serve\` at ${String(raw["url"])} was started with, not the … from the command. ${STILL_GOOD}`,
    );
  }
  const listed = Array.isArray(raw["agents"]) ? (raw["agents"] as Record<string, unknown>[]) : [{ name: "OpenCode", agent: "build" }];
  const agents = listed.map((agent) => {
    if (typeof agent["name"] !== "string" || typeof agent["agent"] !== "string") {
      throw new SetupError(`Each agent in ${path} has a name and an OpenCode agent: { "name": "OpenCode", "agent": "build" }. ${STILL_GOOD}`);
    }
    return {
      name: agent["name"],
      agent: agent["agent"],
      ...(typeof agent["model"] === "string" ? { model: agent["model"] } : {}),
    };
  });
  if (agents.length === 0) throw new SetupError(`${path} names no agents. ${STILL_GOOD}`);
  return {
    name: typeof raw["name"] === "string" ? raw["name"] : "OpenCode",
    url: typeof raw["url"] === "string" ? raw["url"] : "http://127.0.0.1:4096",
    password,
    passwordEnv,
    ownServer,
    directory: typeof raw["directory"] === "string" ? resolve(fromHome(raw["directory"])) : undefined,
    folders: foldersPathOf(typeof raw["folders"] === "string" ? raw["folders"] : placesOf().agents),
    agents,
  };
}

/**
 * OpenCode 2 answering to the password, with the agents it offers, before the link is spent.
 * OpenCode 1 would answer this far and fail the first message, so it stops here, by name.
 */
export async function checkOpenCode(
  config: Config,
  client: { agents(): Promise<AgentInfo[]>; older?(): Promise<string | undefined> },
): Promise<AgentInfo[]> {
  const older = await client.older?.();
  if (older !== undefined) {
    throw new SetupError(
      config.ownServer
        ? `OpenCode ${older} is on this machine, and Chips needs OpenCode 2: install it with \`${INSTALL_LINE}\`, then open a new terminal. ${STILL_GOOD}`
        : `OpenCode ${older} answers at ${config.url}, and Chips needs OpenCode 2: install it there with \`${INSTALL_LINE}\`, then start its server again. ${STILL_GOOD}`,
      {
        detail: `OpenCode ${older} is on this Mac`,
        says: "Chips needs OpenCode 2.",
        doing: "Run this in Terminal, then try again.",
        copy: INSTALL_LINE,
      },
    );
  }
  try {
    return await client.agents();
  } catch (error) {
    if (error instanceof OpenCodeError && error.status === 401) {
      throw new SetupError(
        `OpenCode at ${config.url} refused the password in $${config.passwordEnv}: give it the one \`opencode serve\` was started with. ${STILL_GOOD}`,
        {
          detail: "Its server refused the password",
          says: "OpenCode refused the password.",
          doing: `Give $${config.passwordEnv} the password opencode serve was started with.`,
        },
      );
    }
    throw new SetupError(`OpenCode isn't answering at ${config.url}: start \`opencode serve\` with a password. ${STILL_GOOD}`, {
      detail: `Nothing answers at ${hostOf(config.url)}`,
      says: "OpenCode's server isn't answering.",
      doing: `Start it with a password in $${config.passwordEnv}, then try again.`,
      copy: "opencode serve",
    });
  }
}
