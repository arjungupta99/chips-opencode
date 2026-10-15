/**
 * `npm start [config]`: the bridge as a daemon. It joins Chips once — with a link a person made in
 * Chips (`CHIPS_JOIN_LINK`), or with a code a person allows — and keeps its key; then it connects,
 * registers its agents, and answers for them through OpenCode until it is stopped.
 *
 * The config is JSON, `~/.chips-opencode/config.json` unless a path is given, and may be left out:
 *
 *     { "url": "http://127.0.0.1:4096", "passwordEnv": "OPENCODE_PASSWORD",
 *       "directory": "~/Work/my-project",
 *       "agents": [{ "name": "OpenCode", "agent": "build" }, { "name": "Planner", "agent": "plan" }] }
 *
 * Without one it is OpenCode's `build` agent, named OpenCode, on `opencode serve`'s own address
 * and directory. The server's password is read from the environment variable `passwordEnv`
 * names, never written in the file. What it keeps is beside the config: the SDK's state (cursor,
 * unanswered events, runs not ended) and which session each room is.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { connect, fileStore, join as joinChips } from "@chips/harness";
import { type AgentConfig, Bridge, type BridgeState } from "./bridge.js";
import { OpenCodeClient } from "./opencode.js";

interface Config {
  readonly name: string;
  readonly url: string;
  readonly password: string;
  readonly directory: string | undefined;
  readonly agents: readonly AgentConfig[];
}

const home = (path: string) => (path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);

function readConfig(path: string): Config {
  const raw = (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}) as Record<string, unknown>;
  const passwordEnv = typeof raw["passwordEnv"] === "string" ? raw["passwordEnv"] : "OPENCODE_PASSWORD";
  const password = process.env[passwordEnv];
  if (password === undefined || password === "") {
    throw new Error(`OpenCode's server password is not in $${passwordEnv}: start \`opencode serve\` with one, and give it here too`);
  }
  const listed = Array.isArray(raw["agents"]) ? (raw["agents"] as Record<string, unknown>[]) : [{ name: "OpenCode", agent: "build" }];
  const agents = listed.map((agent) => {
    if (typeof agent["name"] !== "string" || typeof agent["agent"] !== "string") {
      throw new Error(`each agent in ${path} has a name and an OpenCode agent: { "name": "OpenCode", "agent": "build" }`);
    }
    return {
      name: agent["name"],
      agent: agent["agent"],
      ...(typeof agent["model"] === "string" ? { model: agent["model"] } : {}),
    };
  });
  if (agents.length === 0) throw new Error(`${path} names no agents`);
  return {
    name: typeof raw["name"] === "string" ? raw["name"] : "OpenCode",
    url: typeof raw["url"] === "string" ? raw["url"] : "http://127.0.0.1:4096",
    password,
    directory: typeof raw["directory"] === "string" ? resolve(home(raw["directory"])) : undefined,
    agents,
  };
}

const configPath = resolve(home(process.argv[2] ?? "~/.chips-opencode/config.json"));
const config = readConfig(configPath);
const folder = dirname(configPath);
mkdirSync(folder, { recursive: true, mode: 0o700 });
const statePath = join(folder, "sessions.json");
const log = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);

const opencode = new OpenCodeClient({ url: config.url, password: config.password, directory: config.directory });
const offered = await opencode.agents().catch((error: unknown) => {
  log(`OpenCode isn't answering at ${config.url} yet (${String(error)}): its agents are taken as configured`);
  return undefined;
});
for (const agent of config.agents) {
  if (offered !== undefined && !offered.some((each) => each.id === agent.agent)) {
    log(`OpenCode has no agent "${agent.agent}" for ${agent.name}: it has ${offered.map((each) => each.id).join(", ")}`);
  }
}

const joined = await joinChips({
  link: process.env["CHIPS_JOIN_LINK"],
  url: process.env["CHIPS_URL"],
  name: config.name,
  software: "chips-opencode 0.1.0",
  wants: ["agents"],
  onCode: (code) => log(`Allow this harness in Chips: ${code}`),
});

const state: BridgeState = existsSync(statePath)
  ? (JSON.parse(readFileSync(statePath, "utf8")) as BridgeState)
  : { sessions: {} };

const chips = await connect({
  url: joined.url,
  token: joined.token,
  client: { name: "chips-opencode", version: "0.1.0" },
  store: fileStore(join(folder, "chips-state.json")),
});

const bridge = new Bridge({
  chips,
  opencode,
  agents: config.agents,
  home: joined.spaceId,
  state,
  saveState: (next) => writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 }),
  log,
});
await bridge.start();
log(`answering for ${config.agents.map((agent) => agent.name).join(", ")} through OpenCode at ${config.url}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    bridge.stop();
    chips.close();
    process.exit(0);
  });
}
