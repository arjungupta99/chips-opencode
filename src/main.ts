/**
 * `npm start [config]`: the bridge as a daemon. It joins Chips once — with a link a person made in
 * Chips (`CHIPS_JOIN_LINK`), or with a code a person allows — and keeps its key; then it connects,
 * registers its agents, and answers for them through OpenCode until it is stopped.
 *
 * The config is JSON, `~/.chips-opencode/config.json` unless a path is given, and may be left out:
 *
 *     { "url": "http://127.0.0.1:4096", "passwordEnv": "OPENCODE_PASSWORD",
 *       "folders": "~/chips-opencode/agents",
 *       "agents": [{ "name": "OpenCode", "agent": "build" }, { "name": "Planner", "agent": "plan" }] }
 *
 * Without one it is OpenCode's `build` agent, named OpenCode, on `opencode serve`'s own address.
 * Each agent's sessions work in a folder of its own under `folders`; a `directory` puts them all
 * in that one project instead. The server's password is read from the environment variable `passwordEnv`
 * names, never written in the file. What it keeps is beside the config: the SDK's state (cursor,
 * unanswered events, runs not ended) and which session each room is.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { connect, fileStore, helloOnce, join as joinChips } from "@chipschat/harness";
import { Bridge, type BridgeState } from "./bridge.js";
import { OpenCodeClient } from "./opencode.js";
import { type Config, checkOpenCode, readConfig, SetupError } from "./setup.js";

const home = (path: string) => (path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
const link = process.env["CHIPS_JOIN_LINK"] || undefined;

const configPath = resolve(home(process.argv[2] ?? "~/.chips-opencode/config.json"));
const log = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);
const stop = (error: unknown): never => {
  if (!(error instanceof SetupError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
};
let config: Config;
try {
  config = readConfig(configPath);
} catch (error) {
  config = stop(error);
}
const folder = dirname(configPath);
mkdirSync(folder, { recursive: true, mode: 0o700 });
const statePath = join(folder, "sessions.json");

const opencode = new OpenCodeClient({ url: config.url, password: config.password, directory: config.directory });
// With a link, which works once, OpenCode answers before it is taken up; after that, a bridge
// started before OpenCode takes its agents as configured and says so.
const offered = link !== undefined
  ? await checkOpenCode(config, opencode).catch(stop)
  : await opencode.agents().catch((error: unknown) => {
      log(`OpenCode isn't answering at ${config.url} yet (${String(error)}): its agents are taken as configured`);
      return undefined;
    });
for (const agent of config.agents) {
  // An empty list is OpenCode not having loaded the project yet, not a missing agent (setup audit S12).
  if (offered !== undefined && offered.length > 0 && !offered.some((each) => each.id === agent.agent)) {
    log(`OpenCode has no agent "${agent.agent}" for ${agent.name}: it has ${offered.map((each) => each.id).join(", ")}`);
  }
}

const joined = await joinChips({
  link,
  url: process.env["CHIPS_URL"],
  name: config.name,
  software: "chips-opencode 0.1.0",
  wants: ["agents", "new_agents"],
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
  ...(config.directory === undefined ? { folders: config.folders } : {}),
});
await bridge.start();
log(`answering for ${config.agents.map((agent) => agent.name).join(", ")} through OpenCode at ${config.url}`);

// Its first words in the room it joined, once: the card that followed its link waits for them.
const main = bridge.mainAgentId;
await helloOnce(joined, {
  name: config.name,
  say: (spaceId) =>
    (main === undefined ? chips : chips.as(main)).post({
      spaceId,
      text: `Hi, I'm ${config.agents[0]?.name ?? config.name}, here through OpenCode. Ask me anything.`,
    }),
}).catch((error: unknown) => log(`hello not said: ${String(error)}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    bridge.stop();
    chips.close();
    process.exit(0);
  });
}
