/**
 * What OpenCode's own config lets through without asking (Chips ADR 0299), as a copy for the
 * harness's Permissions page in Chips. Read through OpenCode's server (`GET /api/config`), so the
 * person's `opencode.json` and a project's both count, in the order OpenCode reads them; never
 * written. Chips decides nothing from it, and only says it.
 *
 * OpenCode 1's `permission` is one answer for everything (`"allow"`), or one per tool: an answer, or
 * patterns each with one (`bash: { "*": "ask", "git *": "allow" }`). OpenCode 2 reads that as a list
 * of rules, `permissions`, which a config may write itself (`{ action, resource, effect }`, `bash`
 * named `shell`, `write` and `patch` named `edit`), and its server hands back each document's rules
 * as that list alone (2.0.25). Either way the last rule that matches decides.
 *
 * A check lays the agent's own rules, then the config's, then the session's, and asks where none
 * matches. But every agent's own rules start with an allow for everything (the build agent's ask
 * only before reading `.env` files, the plan agent's refuse edits), so whatever the config doesn't
 * make ask or refuse runs.
 */

import { homedir } from "node:os";
import { rulesOf } from "./opencode.js";

/** One thing the config lets through, asks about, or refuses, as Chips's `ownEntry` has it. */
export interface OwnEntry {
  readonly kind: "read" | "write" | "web" | "command" | "tool";
  readonly name: string;
  readonly words?: string[] | undefined;
  readonly raw?: string | undefined;
}

/** The copy, as Chips's `ownRules` has it (SDK 1.0.10's `OwnRules`). */
export interface OwnRules {
  readonly read_from: string[];
  readonly note?: string | undefined;
  readonly mode?: string | undefined;
  readonly everything?: boolean | undefined;
  readonly runs: OwnEntry[];
  readonly asks?: OwnEntry[] | undefined;
  readonly refuses?: OwnEntry[] | undefined;
}

/** One config document OpenCode read, and where. */
export interface ConfigDocument {
  readonly path: string;
  readonly info: Readonly<Record<string, unknown>>;
}

type Answer = "allow" | "ask" | "deny";
/** A tool's answer, or its patterns in the order written, each with one. */
type ToolRule = Answer | (readonly [string, Answer])[];

const MOST = 200;
const MOST_PLACES = 8;
const LONGEST_NAME = 120;
const LONGEST_RAW = 400;

const KINDS: Readonly<Record<string, OwnEntry["kind"]>> = {
  read: "read",
  glob: "read",
  grep: "read",
  list: "read",
  lsp: "read",
  edit: "write",
  write: "write",
  patch: "write",
  webfetch: "web",
  websearch: "web",
  codesearch: "web",
  bash: "command",
  shell: "command",
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isAnswer = (value: unknown): value is Answer => value === "allow" || value === "ask" || value === "deny";

const clip = (text: string, most: number) => (text.length > most ? text.slice(0, most) : text);

/** `~/.config/opencode/opencode.json` for a path under the home folder. */
export function tilde(path: string, home: string = homedir()): string {
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/**
 * The documents' `permission`, then their `permissions`, laid one over another as OpenCode lays
 * them: one answer for everything replaces what was before; a tool's answer replaces that tool's; a
 * tool's patterns are added to its patterns. In `permission` a pattern written again takes its new
 * answer in its old place; in `permissions`, where the last rule that matches decides, it goes last.
 */
export function joinedPermission(documents: readonly ConfigDocument[]): Answer | Map<string, ToolRule> | undefined {
  let joined: Answer | Map<string, ToolRule> | undefined;
  const toolsOf = () => (joined instanceof Map ? joined : new Map<string, ToolRule>());
  for (const { info } of documents) {
    const said = info["permission"];
    if (isAnswer(said)) joined = said;
    else if (isRecord(said)) {
      const tools = toolsOf();
      for (const [tool, rule] of Object.entries(said)) {
        if (isAnswer(rule)) tools.set(tool, rule);
        else if (isRecord(rule)) {
          const before = tools.get(tool);
          const patterns = new Map(Array.isArray(before) ? before : []);
          for (const [pattern, answer] of Object.entries(rule)) if (isAnswer(answer)) patterns.set(pattern, answer);
          tools.set(tool, [...patterns]);
        }
      }
      joined = tools;
    }
    for (const { action, resource, effect } of rulesOf(info["permissions"])) {
      const every = resource.trim() === "*" || resource.trim() === "";
      if (action === "*" && every) {
        joined = effect;
        continue;
      }
      const tools = toolsOf();
      if (every) tools.set(action, effect);
      else {
        const before = tools.get(action);
        const patterns = new Map(Array.isArray(before) ? before : typeof before === "string" ? [["*", before]] : []);
        patterns.delete(resource);
        patterns.set(resource, effect);
        tools.set(action, [...patterns]);
      }
      joined = tools;
    }
  }
  return joined;
}

/** The words a bash pattern's commands start with: `git` for `git *`; none for `*`, any command. */
export function patternWords(pattern: string): string[] | undefined {
  const start = pattern.trim().replace(/\s+\*$/, "");
  if (start === "" || start === "*") return undefined;
  return start
    .split(/\s+/)
    .slice(0, 8)
    .map((word) => clip(word, LONGEST_NAME));
}

function entryOf(tool: string, pattern: string | undefined): OwnEntry {
  const kind = KINDS[tool] ?? "tool";
  const name = clip(tool, LONGEST_NAME);
  const raw = clip(pattern === undefined ? tool : `${tool}: ${pattern}`, LONGEST_RAW);
  if (kind !== "command") return { kind, name, raw };
  const words = pattern === undefined ? undefined : patternWords(pattern);
  return { kind, name, ...(words === undefined ? {} : { words }), raw };
}

/** What the note says. */
export const NOTE =
  "OpenCode runs whatever its config and the agent's own rules don't make ask or refuse: out of the box its build agent asks only before reading .env files. An Always given in Chips is kept by Chips while its rules are on, and saved by OpenCode when they're off.";

/** OpenCode's copy, from the config documents its server read, oldest first. */
export function opencodeOwnRules(documents: readonly ConfigDocument[], home: string = homedir()): OwnRules {
  const read_from = documents.length === 0 ? ["~/.config/opencode/opencode.json"] : documents.map((each) => tilde(each.path, home)).slice(-MOST_PLACES);
  const note = NOTE;
  const joined = joinedPermission(documents);
  if (joined === "allow") return { read_from, note, everything: true, runs: [] };
  const lists: Record<Answer, OwnEntry[]> = { allow: [], ask: [], deny: [] };
  if (joined === "deny" || joined === "ask" || joined === undefined) {
    return { read_from, note, runs: [], ...(joined === "deny" ? { refuses: [entryOf("*", undefined)] } : {}) };
  }
  for (const [tool, rule] of joined) {
    if (typeof rule === "string") {
      lists[rule].push(entryOf(tool, undefined));
      continue;
    }
    rule.forEach(([pattern, answer], at) => {
      // A catch-all written before the patterns that follow it is the fallback, which asks anyway.
      const fallback = (pattern.trim() === "*" || pattern.trim() === "") && at < rule.length - 1 && answer !== "allow";
      if (!fallback) lists[answer].push(entryOf(tool, pattern));
    });
  }
  return {
    read_from,
    note,
    runs: lists.allow.slice(0, MOST),
    asks: lists.ask.slice(0, MOST),
    refuses: lists.deny.slice(0, MOST),
  };
}

/**
 * Send the copy where the connection takes it: SDK 1.0.10's `settings.ownRules`. An older SDK has
 * no such method and an older Chips refuses it; either way nothing else changes.
 */
export async function sendOwnRules(settings: unknown, copy: OwnRules): Promise<boolean> {
  const send = (settings as { ownRules?: (copy: unknown) => Promise<unknown> } | undefined)?.ownRules;
  if (typeof send !== "function") return false;
  try {
    await send.call(settings, copy);
    return true;
  } catch {
    return false;
  }
}
