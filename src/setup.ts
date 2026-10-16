/**
 * What the bridge checks before it takes up a link, which works once (Chips ADR 0122): the server
 * password filled in rather than the `…` the gallery's command was copied with, and OpenCode
 * answering to it. Anything missing stops it with what to do, and the link is still good for the
 * same command run again.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { filledIn } from "@chipschat/harness";
import type { AgentConfig } from "./bridge.js";
import { type AgentInfo, OpenCodeError } from "./opencode.js";

export interface Config {
  readonly name: string;
  readonly url: string;
  readonly password: string;
  readonly passwordEnv: string;
  readonly directory: string | undefined;
  readonly agents: readonly AgentConfig[];
}

/** Something to put right before the bridge starts, said so a person can. */
export class SetupError extends Error {
  override readonly name = "SetupError";
}

export const STILL_GOOD = "The link is still good: run the same command again once that's done.";

const home = (path: string) => (path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);

/** The config at `path`, or the defaults when there is none, with the password from the environment. */
export function readConfig(path: string, env: NodeJS.ProcessEnv = process.env): Config {
  const raw = (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}) as Record<string, unknown>;
  const passwordEnv = typeof raw["passwordEnv"] === "string" ? raw["passwordEnv"] : "OPENCODE_PASSWORD";
  const password = env[passwordEnv];
  if (!filledIn(password)) {
    throw new SetupError(
      `OpenCode's server password isn't in $${passwordEnv}: start \`opencode serve\` with one, and give it here too, not the … from the command. ${STILL_GOOD}`,
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
    directory: typeof raw["directory"] === "string" ? resolve(home(raw["directory"])) : undefined,
    agents,
  };
}

/** OpenCode answering to the password, with the agents it offers, before the link is spent. */
export async function checkOpenCode(
  config: Config,
  client: { agents(): Promise<AgentInfo[]> },
): Promise<AgentInfo[]> {
  try {
    return await client.agents();
  } catch (error) {
    if (error instanceof OpenCodeError && error.status === 401) {
      throw new SetupError(
        `OpenCode at ${config.url} refused the password in $${config.passwordEnv}: give it the one \`opencode serve\` was started with. ${STILL_GOOD}`,
      );
    }
    throw new SetupError(`OpenCode isn't answering at ${config.url}: start \`opencode serve\` with a password. ${STILL_GOOD}`);
  }
}
