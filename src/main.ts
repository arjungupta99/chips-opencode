/**
 * `npm start [config]`: the bridge as a daemon. It joins Chips once — with a link a person made in
 * Chips (`CHIPS_JOIN_LINK`), or with a code a person allows — and keeps its key; then it connects,
 * registers its agents, and answers for them through OpenCode until it is stopped.
 *
 * The config is JSON, `~/Chips/.bridges/opencode/config.json` unless a path is given, and may be left out:
 *
 *     { "url": "http://127.0.0.1:4096", "passwordEnv": "OPENCODE_PASSWORD",
 *       "folders": "~/Chips/Agents/opencode",
 *       "agents": [{ "name": "OpenCode", "agent": "build" }, { "name": "Planner", "agent": "plan" }] }
 *
 * Without one it is OpenCode's `build` agent, named OpenCode, on `opencode serve`'s own address.
 * Each agent's sessions work in a folder of its own under `folders`; a `directory` puts them all
 * in that one project instead. The server's password is read from the environment variable `passwordEnv`
 * names, never written in the file. What it keeps is beside the config: the SDK's state (cursor,
 * unanswered events, runs not ended) and which session each room is. An install from before 1.0.15,
 * in `~/.chips-opencode` and `~/chips-opencode/agents`, is moved to `~/Chips` first, and its
 * sessions with it once OpenCode answers (`move.ts`, Chips ADR 0283).
 *
 * `npm run keep` is the same, then keeps the bridge running from login (`keep.ts`).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { checkGit, connect, fileStore, helloOnce, JoinError, join as joinChips, reportStep, runsKept } from "@chipschat/harness";
import { Bridge, type BridgeState, settingsFor, wantsFor } from "./bridge.js";
import { handsOver, keepIfAsked, stopIfAsked, words } from "./keep.js";
import { moveOld, moveSessions } from "./move.js";
import { OpenCodeClient } from "./opencode.js";
import { configPathOf, configTargetOf } from "./places.js";
import { INSTALL_LINE, type OwnServer, ownServer, ServerError } from "./server.js";
import { type Config, checkOpenCode, hostOf, readConfig, SetupError, STILL_GOOD } from "./setup.js";
import { VERSION } from "./version.js";

const link = process.env["CHIPS_JOIN_LINK"] || undefined;

const LABEL = "chat.chips.opencode";
stopIfAsked(LABEL);
// A stop is heard from here on, the start included, which can be hours of waiting for Chips: what
// the start has opened so far is closed, the newest first. Heard only once the start was done, a
// stop before then left the server it started running and nothing saved.
const closing: (() => void)[] = [];
// Once the start is done, a stop is a clean end. Before that it ends as the signal, as it always
// has, so that whoever started it (`chips connect`, which reads an exit of 0 as connected) never
// takes a start that was stopped for one that worked.
let started = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    for (const close of closing.reverse()) close();
    if (started) process.exit(0);
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  });
}
const log = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);
// What it kept before 1.0.15, brought across to ~/Chips first, so everything after reads it
// there; by the kept copy, where this run hands over to one (`handsOver`).
if (!handsOver) moveOld(configTargetOf(words[0]), log);
const configPath = configPathOf(words[0]);
const stop = (error: unknown): never => {
  if (!(error instanceof SetupError)) throw error;
  // Where it stopped, in a few words for Chips for Mac's sheet; the whole sentence for a terminal.
  reportStep("failed", error.words);
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

// Nobody's own server named: the bridge runs one, and stops it when it stops.
let server: OwnServer | undefined;
if (link !== undefined) reportStep("checking", { detail: "Looking for OpenCode" });
if (config.ownServer) {
  // Its own folder, `~/Chips/Agents/opencode`, not the one every harness's agents share above it.
  const cwd = config.directory ?? config.folders;
  mkdirSync(cwd, { recursive: true });
  try {
    // The server it starts is the stop's to end from the moment it is started, answering or not.
    server = await ownServer({ folder, cwd, log, stopWith: (stop) => closing.push(stop) });
  } catch (error) {
    if (!(error instanceof ServerError)) throw error;
    stop(
      new SetupError(link === undefined ? error.message : `${error.message} ${STILL_GOOD}`, {
        detail: error.missing ? "OpenCode isn't on this Mac" : "Its server didn't start",
        says: error.missing ? "OpenCode isn't installed on this Mac." : "OpenCode's server didn't start.",
        doing: error.missing ? "Run this in Terminal, then try again." : error.message,
        ...(error.missing ? { copy: INSTALL_LINE } : {}),
      }),
    );
  }
}
// However this process ends, a failed join included, the server it started ends with it.
process.on("exit", () => server?.stop());
const address = server ?? { url: config.url, password: config.password ?? "" };
const opencode = new OpenCodeClient({ url: address.url, password: address.password, directory: config.directory });
// With a link, which works once, OpenCode answers before it is taken up; after that, a bridge
// started before OpenCode takes its agents as configured and says so.
const offered = link !== undefined
  ? await checkOpenCode(config, opencode).then((agents) => {
      reportStep("checked", { detail: `Its server answers at ${hostOf(address.url)}` });
      return agents;
    }, stop)
  : await opencode.agents().catch((error: unknown) => {
      log(`OpenCode isn't answering at ${address.url} yet (${String(error)}): its agents are taken as configured`);
      return undefined;
    });
for (const agent of config.agents) {
  // An empty list is OpenCode not having loaded the project yet, not a missing agent (setup audit S12).
  if (offered !== undefined && offered.length > 0 && !offered.some((each) => each.id === agent.agent)) {
    log(`OpenCode has no agent "${agent.agent}" for ${agent.name}: it has ${offered.map((each) => each.id).join(", ")}`);
  }
}

/** A link Chips refuses (spent, expired, not a link), said plainly: its words, no stack. */
const refused = (error: unknown): never => {
  if (!(error instanceof JoinError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
};
const joined = await joinChips({
  link,
  url: process.env["CHIPS_URL"],
  name: config.name,
  software: `chips-opencode ${VERSION}`,
  wants: wantsFor(server !== undefined),
  onCode: (code) => log(`Allow this harness in Chips: ${code}`),
}).catch(refused);
// Joined, `npm run keep` hands over to a copy kept running, which says the hello. It takes the
// server's password with it, in a file only its user can read; or, running its own server, stops
// it first, for the kept copy to run and watch its own.
keepIfAsked(LABEL, joined.url, [config.passwordEnv], log, () => server?.stop());

const state: BridgeState = existsSync(statePath)
  ? (JSON.parse(readFileSync(statePath, "utf8")) as BridgeState)
  : { sessions: {} };
const saveState = (next: BridgeState) => writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
// The sessions of folders that moved to ~/Chips, moved by OpenCode before any is used.
if (offered !== undefined) await moveSessions(state, opencode, saveState, log);

// Each try that fails is told here, every few seconds: said once, and again when the reason
// changes, so a server down for a night is a line in the log and not thousands.
let waitingFor: string | undefined;
const waitingSaid = (why: string) => {
  if (why !== waitingFor) log(`waiting for Chips: ${why}`);
  waitingFor = why;
};
let bridge: Bridge | undefined;
const chips = await connect({
  url: joined.url,
  token: joined.token,
  client: { name: "chips-opencode", version: VERSION },
  store: fileStore(join(folder, "chips-state.json")),
  // The copy this machine keeps running starts at login, perhaps before its server is up: it waits
  // and tries again, where a run by hand hears at once that Chips can't be reached.
  waitForServer: runsKept(LABEL),
  onWaiting: waitingSaid,
  // A person's Restart (Chips ADR 0094), heard only where the bridge runs OpenCode's server: one a
  // person runs themselves isn't the bridge's to restart, so this connection doesn't say it hears them.
  ...(server === undefined ? {} : { onRestart: () => bridge?.restart() }),
  // What a person changes of an agent from its page (Chips ADR 0241): its model and its files.
  settings: settingsFor(() => bridge),
});
closing.push(() => chips.close());

// Each agent works on its room's project in a copy of its own (Chips ADR 0221), where git will.
const git = await checkGit();
if (!git.ok) log(`rooms' projects are off: ${git.why}`);

bridge = new Bridge({
  chips,
  opencode,
  projects: git.ok,
  agents: config.agents,
  home: joined.spaceId,
  state,
  saveState,
  log,
  restartServer: server?.restart,
  ...(config.directory === undefined ? { folders: config.folders } : { directory: config.directory }),
});
closing.push(() => bridge?.stop());
await bridge.start();
started = true;
log(`answering for ${config.agents.map((agent) => agent.name).join(", ")} through OpenCode at ${address.url}`);

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
