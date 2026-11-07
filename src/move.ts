/**
 * An install from before 1.0.15 brought across to `~/Chips` (Chips ADR 0283), once, when the bridge
 * starts: its config, sessions, server password and state from `~/.chips-opencode`, its agents'
 * folders from `~/chips-opencode/agents`, and the folder paths it saved. OpenCode pins a session to
 * its folder and won't use one whose folder is gone, so each session of a folder that moved is noted
 * in the state (`moving`), and moved too, with everything said in it, once OpenCode answers
 * (`moveSessions`).
 *
 * Nothing is copied and deleted: a folder is renamed, or, where something is at the new place already,
 * what isn't there yet is moved in and a clash is left where it was, said in the log. A rename that
 * fails leaves the old place in use (`places.ts` reads a path where it is). Each step looks at what is
 * on disk, so a start that stops halfway finishes on the next, and a start with nothing to move does
 * nothing.
 */

import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { BridgeState } from "./bridge.js";
import { type OpenCodeClient, OpenCodeError } from "./opencode.js";
import { fromHome, inside, nowAt, type Places, placesOf } from "./places.js";

type Log = (line: string) => void;

const there = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

const isFolder = (path: string) => lstatSync(path).isDirectory();

/** `~` for the home in a path, as a person reads it. */
const shown = (path: string, home: string) => (path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

/**
 * `from` moved to `to`: renamed where nothing is at `to`; else, both folders, each entry `to` hasn't
 * got moved in, and `from` removed once it is empty. Anything else is left where it is and said.
 */
export function merge(from: string, to: string, log: Log, home: string = homedir(), quiet = false): void {
  if (!there(from)) return;
  try {
    if (!there(to)) {
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
      if (!quiet) log(`moved ${shown(from, home)} to ${shown(to, home)}`);
      return;
    }
    if (!isFolder(from) || !isFolder(to)) {
      log(`${shown(from, home)} was left where it is: ${shown(to, home)} is there already`);
      return;
    }
    for (const entry of readdirSync(from)) merge(join(from, entry), join(to, entry), log, home, true);
    if (readdirSync(from).length === 0) rmdirSync(from);
    if (!quiet) log(`moved what was in ${shown(from, home)} into ${shown(to, home)}`);
  } catch (error) {
    log(`${shown(from, home)} couldn't be moved to ${shown(to, home)}, so it is used where it is: ${(error as Error).message}`);
  }
}

/** A folder removed when nothing is left in it. */
function removeIfEmpty(path: string): void {
  try {
    if (readdirSync(path).length === 0) rmdirSync(path);
  } catch {
    // Not there, or something of the person's still is.
  }
}

/** The folder a path names before the move and after it, where it is one of the agents' places. */
function pairOf(path: string, places: Places): { readonly old: string; readonly now: string } | undefined {
  const old = inside(places.oldAgents, path);
  if (old !== undefined) return { old: path, now: join(places.agents, old) };
  const now = inside(places.agents, path);
  return now === undefined ? undefined : { old: join(places.oldAgents, now), now: path };
}

/** A JSON file written whole, readable by the person alone, so a stop halfway leaves the old one. */
function writeJson(path: string, value: unknown): void {
  const next = `${path}.next`;
  writeFileSync(next, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(next, path);
}

const readJson = (path: string): Record<string, unknown> | undefined => {
  try {
    const read = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return typeof read === "object" && read !== null ? (read as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

/** The bridge whose config goes at `configPath` (`configTargetOf`) brought across from before 1.0.15. */
export function moveOld(configPath: string, log: Log, home: string = homedir()): void {
  const places = placesOf(home);
  const settings = dirname(configPath);

  // The config, the sessions, the server's password and the SDK's state, where the config is in the
  // settings folder.
  const under = inside(places.settings, settings);
  if (under !== undefined) {
    mkdirSync(dirname(dirname(places.settings)), { recursive: true });
    mkdirSync(dirname(places.settings), { recursive: true, mode: 0o700 });
    merge(join(places.oldSettings, under), settings, log, home);
  }

  // The agents' folders: the config's, else the default.
  const config = readJson(configPath);
  const said = config?.["folders"];
  const root = typeof said === "string" && said !== "" ? resolve(fromHome(said, home)) : places.agents;
  const pair = pairOf(root, places);
  if (pair !== undefined) merge(pair.old, pair.now, log, home);

  // The config's own words, where it named the old place.
  if (config !== undefined && typeof said === "string") {
    const moved = nowAt(root, places.oldAgents, places.agents);
    if (moved !== root) writeJson(configPath, { ...config, folders: `~/${moved.slice(home.length + 1)}` });
  }

  // The folder each agent's sessions work in, as the state saved it, and the sessions to move with it.
  const statePath = join(settings, "sessions.json");
  const state = readJson(statePath) as Partial<BridgeState> | undefined;
  if (state === undefined) return;
  const moving: Record<string, string> = { ...state.moving };
  let changed = false;
  const folders: Record<string, string> = { ...state.folders };
  for (const [who, folder] of Object.entries(folders)) {
    const moved = nowAt(folder, places.oldAgents, places.agents);
    if (moved === folder) continue;
    folders[who] = moved;
    for (const [room, session] of Object.entries(state.sessions ?? {})) {
      if (room.slice(0, room.lastIndexOf("|")) === who) moving[session] = moved;
    }
    changed = true;
  }
  const forks: NonNullable<BridgeState["forks"]> = { ...state.forks };
  for (const [ask, fork] of Object.entries(forks)) {
    if (fork.folder === undefined) continue;
    const moved = nowAt(fork.folder, places.oldAgents, places.agents);
    if (moved === fork.folder) continue;
    forks[ask] = { ...fork, folder: moved };
    if (fork.session !== undefined) moving[fork.session] = moved;
    changed = true;
  }
  if (changed) {
    writeJson(statePath, {
      ...state,
      folders,
      ...(state.forks === undefined ? {} : { forks }),
      ...(Object.keys(moving).length === 0 ? {} : { moving }),
    });
  }

  removeIfEmpty(places.oldSettings);
  removeIfEmpty(places.oldAgents);
  removeIfEmpty(dirname(places.oldAgents));
}

/**
 * Each session noted in `moving` moved by OpenCode to its agent's folder now, with everything said in
 * it, and taken off the list. One OpenCode refuses (a session deleted since) is said and taken off
 * too; one it doesn't answer for stays, for the next start.
 */
export async function moveSessions(
  state: BridgeState,
  opencode: Pick<OpenCodeClient, "moveSession">,
  save: (state: BridgeState) => void,
  log: Log,
  home: string = homedir(),
): Promise<void> {
  const moving = state.moving;
  if (moving === undefined) return;
  for (const [session, folder] of Object.entries(moving)) {
    try {
      await opencode.moveSession(session, folder);
      log(`moved OpenCode's session ${session} to ${shown(folder, home)}`);
      delete moving[session];
    } catch (error) {
      if (!(error instanceof OpenCodeError)) {
        log(`OpenCode's session ${session} wasn't moved to ${shown(folder, home)}, for now: ${String(error)}`);
        continue;
      }
      log(`OpenCode wouldn't move its session ${session} to ${shown(folder, home)}: ${error.message}`);
      delete moving[session];
    }
  }
  if (Object.keys(moving).length === 0) delete state.moving;
  save(state);
}
