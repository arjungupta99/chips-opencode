/**
 * An agent's context in Chips (Chips ADRs 0134, 0238, 0241): the files OpenCode builds each of this
 * harness's agents from, sent to Chips as a copy so a person sees them on the agent's page, and a
 * person's edit there saved where OpenCode reads it. Chips adds no context of its own.
 *
 * OpenCode 2.0 reads, for a session, `AGENTS.md` only (no `CLAUDE.md` in its place): its own,
 * `~/.config/opencode/AGENTS.md` (`OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`), then
 * the `AGENTS.md` of the session's folder and of each folder above it, nearest first, up to the
 * home folder, or for a folder outside it up to its project's root. From 2.0.30 it reads after them
 * the files its config's `instructions` names: a relative path or glob in each folder from the
 * session's up to its project's root, `~/` from the home folder, an absolute one as written. It
 * reads them all before each model call, and tells the agent what changed since the last, so an
 * edit applies from the agent's next message: Chips's own words for when files are read hold, and
 * the copy says nothing of its own. A URL in `instructions` isn't shown, nor is the `AGENTS.md` of
 * a folder inside the session's, which OpenCode reads only when the agent reads a file there.
 *
 * An agent's own files are those in its folder: its `AGENTS.md`, and any the config's
 * `instructions` finds there. The harness's own set is what its agents read beside them: the
 * `AGENTS.md` of the folder the agents' folders are made in, which a person may change for every
 * agent at once; any above it; and the person's own, which their own OpenCode reads too, so they
 * are shown and not changed here.
 *
 * Chips takes an agent's file named as a shared one as given in its place. The agent reads both, so
 * a file of the harness's set is named by where it is (`~ › .config › opencode › AGENTS.md`) and an
 * agent's by where it is in its folder (`AGENTS.md`), and no name is in both.
 */

import { createHash } from "node:crypto";
import { globSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { type AgentContextCopy, type HarnessContextCopy, Refuse } from "@chipschat/harness";
import { CONTEXT_FILE_BYTES, CONTEXT_FILES_SHOWN, contextBytes } from "@chipschat/protocol";

/** The file OpenCode looks for in each folder. */
const AGENTS_MD = "AGENTS.md";

/** Where this machine keeps what OpenCode reads beside the agents' folders. */
export interface Places {
  /** The person's home: `~` in a file's name, and where OpenCode's walk up stops. */
  readonly home: string;
  /** OpenCode's own folder, whose `AGENTS.md` every session reads. */
  readonly config: string;
}

export function placesOf(env: NodeJS.ProcessEnv, home: string): Places {
  const config = env["OPENCODE_CONFIG_DIR"] || join(env["XDG_CONFIG_HOME"] || join(home, ".config"), "opencode");
  return { home, config };
}

/** What OpenCode reads for a folder beside its `AGENTS.md` files, as the bridge has worked it out. */
export interface Reading {
  /** Where its walk up for `AGENTS.md` stops: the home folder, or the project's root outside it. */
  readonly stop: string;
  /** The files its config's `instructions` names, found, in the order OpenCode reads them. */
  readonly named: readonly string[];
}

/** One file the agents read: where it is, and how its row says it. */
interface Spot {
  readonly path: string;
  readonly name: string;
  readonly title: string;
  readonly about?: string | undefined;
  /** Whether a person may change it here. One not there yet is shown empty, and saving makes it. */
  readonly editable: boolean;
  readonly whyReadOnly?: string | undefined;
  /** For a file of the harness's set: its id, and the folders whose agents read it (all, where none). */
  readonly id?: string | undefined;
  readonly over?: ((folder: string) => boolean) | undefined;
}

/** What an edit from Chips asks: a file, its new words, and the version they were made from. */
export interface Edit {
  readonly name: string;
  readonly text: string;
  readonly base_hash: string | null;
}

/** The harness's own hash of a file's words, which an edit names as what it was made from. */
export function hashOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function textOf(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export const within = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}${sep}`);

/** A folder and each folder above it up to `stop`, nearest first; the folder alone where `stop` isn't above it. */
export function upTo(dir: string, stop: string): string[] {
  const dirs = [dir];
  for (let at = dir; within(at, stop) && at !== stop && dirname(at) !== at; ) {
    at = dirname(at);
    dirs.push(at);
  }
  return dirs;
}

/**
 * The files a config's `instructions` names, for a session in `folder` of a project rooted at
 * `root`, as OpenCode 2.0.30 finds them: each entry's matches in turn, sorted, each file once; a
 * URL is left out.
 */
export function namedFiles(sources: readonly string[], folder: string, root: string, home: string): string[] {
  const found: string[] = [];
  const glob = (pattern: string, cwd: string) => {
    try {
      return globSync(pattern, { cwd }).map((match) => join(cwd, match));
    } catch {
      return [];
    }
  };
  for (const source of sources) {
    if (/^https?:\/\//i.test(source)) continue;
    const expanded = source.startsWith("~/") ? join(home, source.slice(2)) : source;
    const matches = isAbsolute(expanded)
      ? glob(expanded.slice(dirname(expanded).length + 1), dirname(expanded))
      : upTo(folder, within(folder, root) ? root : folder).flatMap((dir) => glob(expanded, dir));
    for (const path of matches.sort()) if (isFile(path) && !found.includes(path)) found.push(path);
  }
  return found;
}

/** The words a version is older than: `2.0.25` is before `2.0.30`. */
export function before(version: string, than: string): boolean {
  const parts = (each: string) => each.split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parts(version), parts(than)];
  for (let at = 0; at < 3; at += 1) if ((a[at] ?? 0) !== (b[at] ?? 0)) return (a[at] ?? 0) < (b[at] ?? 0);
  return false;
}

/** The first version of OpenCode 2 that reads the files its config's `instructions` names. */
export const READS_NAMED = "2.0.30";

/**
 * Each agent's files and the harness's own set, read from disk each time they are asked for:
 * nothing about them is kept here.
 */
export class ContextFiles {
  constructor(
    private readonly places: Places,
    /** Where each agent's own folder is made, when each has one; else every agent works in one project. */
    private readonly folders: string | undefined,
  ) {}

  /** `~/Chips/Agents/opencode/AGENTS.md`, or the whole path where it isn't in the home. */
  private tilde(path: string): string {
    const { home } = this.places;
    return within(path, home) ? `~${path.slice(home.length)}` : path;
  }

  /** A shared file's name: where it is, a step at a time (`~ › .config › opencode › AGENTS.md`), with no slash. */
  private crumbs(path: string): string {
    const { home } = this.places;
    const steps = within(path, home) ? ["~", ...relative(home, path).split(sep)] : ["/", ...path.split(sep)];
    return steps.filter((step) => step !== "").join(" › ").slice(0, 255);
  }

  /**
   * The harness's own set, for agents whose folders read as `readings` says: every agent's
   * `AGENTS.md`, those above it, the person's own, and the named files not in an agent's folder.
   */
  private sharedSpots(readings: ReadonlyMap<string, Reading>): Spot[] {
    const { places, folders } = this;
    const spots: Spot[] = [];
    const add = (spot: Spot) => {
      if (!spots.some((each) => each.path === spot.path)) spots.push(spot);
    };
    // Whether OpenCode's walk up from an agent's folder reaches a folder.
    const reaches = (dir: string) => (folder: string) => within(folder, dir) && within(dir, readings.get(folder)?.stop ?? folder);
    // The folder the agents' folders are made in, which each one's walk passes in the home folder.
    if (folders !== undefined && within(folders, places.home)) {
      const path = join(folders, AGENTS_MD);
      add({
        path,
        name: this.crumbs(path),
        title: "For every OpenCode agent",
        about: this.tilde(path),
        editable: true,
        id: "every-agent",
        over: reaches(folders),
      });
    }
    const yours = join(places.config, AGENTS_MD);
    for (const [folder, reading] of readings) {
      for (const dir of upTo(folder, reading.stop).slice(1)) {
        const path = join(dir, AGENTS_MD);
        if (path === yours || !isFile(path)) continue;
        add({
          path,
          name: this.crumbs(path),
          title: `From ${this.tilde(dir)}`.slice(0, 80),
          about: this.tilde(path),
          editable: false,
          whyReadOnly: "It sits above the agents' folders.",
          id: `above-${hashOf(path).slice(0, 12)}`,
          over: reaches(dir),
        });
      }
    }
    if (isFile(yours)) {
      add({
        path: yours,
        name: this.crumbs(yours),
        title: "For all your OpenCode",
        about: this.tilde(yours),
        editable: false,
        whyReadOnly: "Your own OpenCode reads it too.",
        id: "yours",
      });
    }
    for (const [folder, reading] of readings) {
      for (const path of reading.named) {
        if (within(path, folder)) continue;
        add({
          path,
          name: this.crumbs(path),
          title: "Named in OpenCode's config",
          about: this.tilde(path),
          editable: false,
          whyReadOnly: "OpenCode's config names it for every session.",
          id: `named-${hashOf(path).slice(0, 12)}`,
          over: (other) => readings.get(other)?.named.includes(path) === true,
        });
      }
    }
    return spots;
  }

  /** An agent's own files: its folder's `AGENTS.md`, and the named files in its folder. */
  private ownSpots(folder: string, reading: Reading): Spot[] {
    const named = reading.named.filter((path) => within(path, folder) && path !== join(folder, AGENTS_MD));
    return [
      { path: join(folder, AGENTS_MD), name: AGENTS_MD, title: "How it works", editable: true },
      ...named.map((path) => ({
        path,
        name: relative(folder, path).split(sep).join(" › ").slice(0, 255),
        title: "Named in OpenCode's config",
        editable: true,
      })),
    ];
  }

  /** The shared files an agent in `folder` reads. */
  private readBy(folder: string, reading: Reading): Spot[] {
    return this.sharedSpots(new Map([[folder, reading]])).filter((spot) => spot.over === undefined || spot.over(folder));
  }

  /** An agent's copy: its own files and the shared ones it reads, eight at most. */
  agentCopy(folder: string, reading: Reading): AgentContextCopy {
    const rows: Record<string, unknown>[] = [];
    const notShown: Record<string, unknown>[] = [];
    const add = (row: Record<string, unknown>, text?: string) => {
      const named = { name: row["name"], title: row["title"] };
      if (text !== undefined && contextBytes(text) > CONTEXT_FILE_BYTES) notShown.push({ ...named, reason: "too_large" });
      else if (rows.length >= CONTEXT_FILES_SHOWN) notShown.push({ ...named, reason: "count" });
      else rows.push(row);
    };
    for (const spot of this.ownSpots(folder, reading)) {
      const text = textOf(spot.path) ?? "";
      add({ name: spot.name, title: spot.title, role: "instructions", text, hash: hashOf(text), editable: true }, text);
    }
    for (const spot of this.readBy(folder, reading)) {
      add({
        name: spot.name,
        title: spot.title,
        role: "instructions",
        ...(spot.about === undefined ? {} : { about: spot.about }),
        shared: spot.id,
        replaceable: false,
        editable: false,
      });
    }
    return { files: rows, ...(notShown.length === 0 ? {} : { not_shown: notShown }) } as unknown as AgentContextCopy;
  }

  /** The harness's own set, each file with how many of its agents (by their folders' readings) read it. */
  harnessCopy(readings: ReadonlyMap<string, Reading>, agentFolders: readonly string[]): HarnessContextCopy {
    const shared: Record<string, unknown>[] = [];
    const notShown: Record<string, unknown>[] = [];
    for (const spot of this.sharedSpots(readings)) {
      const text = textOf(spot.path) ?? "";
      const named = { name: spot.name, title: spot.title };
      if (contextBytes(text) > CONTEXT_FILE_BYTES) {
        notShown.push({ ...named, reason: "too_large" });
        continue;
      }
      if (shared.length >= CONTEXT_FILES_SHOWN) {
        notShown.push({ ...named, reason: "count" });
        continue;
      }
      const over = spot.over;
      shared.push({
        id: spot.id,
        name: spot.name,
        title: spot.title,
        role: "instructions",
        ...(spot.about === undefined ? {} : { about: spot.about }),
        text,
        hash: hashOf(text),
        editable: spot.editable,
        ...(spot.whyReadOnly === undefined ? {} : { why_read_only: spot.whyReadOnly }),
        used_by: over === undefined ? agentFolders.length : agentFolders.filter(over).length,
      });
    }
    return { shared, ...(notShown.length === 0 ? {} : { not_shown: notShown }) } as unknown as HarnessContextCopy;
  }

  /**
   * A person's edit of one of an agent's files, saved where OpenCode reads it, only if it is still
   * the version they changed. Refused, with the copy as it is, for a file that isn't the agent's own
   * to change, and as `changed` for one changed since.
   */
  async saveAgent(folder: string, reading: Reading, edit: Edit): Promise<void> {
    const now = () => this.agentCopy(folder, reading);
    const spot = this.ownSpots(folder, reading).find((each) => each.name === edit.name);
    if (spot === undefined) {
      const shared = this.readBy(folder, reading).some((each) => each.name === edit.name);
      throw new Refuse(
        shared ? "Every agent reads this one. Change it on OpenCode's page." : `There is no file called ${edit.name} here.`,
        now(),
        "failed",
      );
    }
    if (edit.base_hash === null) throw new Refuse("This file is the agent's own already.", now(), "failed");
    await this.write(spot, edit, now);
  }

  /** A person's edit of one of the harness's own files, read by its agents beside their own. */
  async saveShared(readings: ReadonlyMap<string, Reading>, agentFolders: readonly string[], edit: Edit): Promise<void> {
    const now = () => this.harnessCopy(readings, agentFolders);
    const spot = this.sharedSpots(readings).find((each) => each.name === edit.name);
    if (spot === undefined) throw new Refuse(`There is no file called ${edit.name} here.`, now(), "failed");
    if (!spot.editable) throw new Refuse(spot.whyReadOnly ?? "It can't be changed from Chips.", now(), "failed");
    if (edit.base_hash === null) {
      throw new Refuse("Every agent reads this file beside its own, so none can have its own in its place.", now(), "failed");
    }
    await this.write(spot, edit, now);
  }

  private async write(spot: Spot, edit: Edit, now: () => unknown): Promise<void> {
    if (hashOf(textOf(spot.path) ?? "") !== edit.base_hash) throw new Refuse("", now(), "changed");
    try {
      await mkdir(dirname(spot.path), { recursive: true });
      await writeFile(spot.path, edit.text, "utf8");
    } catch (error) {
      throw new Refuse(`It couldn't be saved: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300), now(), "failed");
    }
  }
}
