/**
 * The mode a person picks in Chips for OpenCode's sessions (Chips ADR 0300, addenda of 19 November
 * 2026). OpenCode has rules, not modes, so these modes are Chips's, made of OpenCode's own rules
 * and set only on the sessions Chips opens: Ask before changes adds an ask rule for edits and for
 * commands, Read-only a deny rule for edits and an ask rule for commands. None of them never asks:
 * OpenCode already asks almost nothing, and an allow-everything rule would beat a person's own
 * deny rules.
 *
 * A session's own rules are read after its agent's, so they win, and OpenCode reads them again at
 * every check (2.0.25): a change applies from the session's next tool call. A session's rules are
 * one list, replaced whole, and others write to it too (OpenCode's browser plugin adds and takes off
 * an allow for `browser`). So the rules Chips added are named in the session's own metadata
 * (`chips_rules`), as OpenCode's own ACP names the folders it allows, and only those come off.
 *
 * `edit` is every tool that writes a file (edit, write and patch all ask as `edit`), and `shell`
 * every command. Nothing else is touched: a sub-agent's session is made with its parent's rules,
 * and reading outside the folder, the web and other tools stay as the person's settings say.
 */

import type { PolicyMode } from "@chipschat/protocol";
import { type Rule, rulesOf } from "./opencode.js";

/** A mode a person may pick, as Chips's `own_rules.modes` offers it. */
export interface Mode {
  readonly id: string;
  readonly name: string;
  readonly words: string;
}

/** The mode its sessions start in, and go back to: no rules of Chips's. */
export const BASE = "default";

/** OpenCode's modes and their lines on the page, in their order (Chips ADR 0300, decision 1 of the second addendum). */
export const MODES: readonly Mode[] = [
  { id: BASE, name: "Default", words: "Runs as your OpenCode settings say. Out of the box it asks almost nothing." },
  { id: "ask-changes", name: "Ask before changes", words: "Edits and commands wait for a yes. Reads run on their own." },
  { id: "read-only", name: "Read-only", words: "Reads on its own. Edits are refused, and commands ask first." },
];

/** The rules each mode adds to a session, after its own. */
const RULES: Readonly<Record<string, readonly Rule[]>> = {
  [BASE]: [],
  "ask-changes": [
    { action: "edit", resource: "*", effect: "ask" },
    { action: "shell", resource: "*", effect: "ask" },
  ],
  "read-only": [
    { action: "edit", resource: "*", effect: "deny" },
    { action: "shell", resource: "*", effect: "ask" },
  ],
};

/** Where a session's metadata names the rules Chips added to it. */
export const CHIPS_RULES = "chips_rules";

/** A mode's name, or its id for one this bridge doesn't know. */
export const nameOf = (id: string) => MODES.find((mode) => mode.id === id)?.name ?? id;

/** The rules a mode adds; none for the one it starts in. */
export const modeRules = (mode: string): readonly Rule[] => RULES[mode] ?? [];

/**
 * The mode its sessions go into: the pick while it holds, where it is one of OpenCode's, else the
 * one they start in, and why, for the log.
 */
export function modeTarget(picked: PolicyMode | undefined): { readonly mode: string; readonly why?: string } {
  if (picked === undefined || picked.id === BASE) return { mode: BASE };
  if (RULES[picked.id] === undefined) return { mode: BASE, why: `${picked.id}, picked in Chips, isn't one of its modes` };
  return { mode: picked.id };
}

const same = (one: Rule, other: Rule) =>
  one.action === other.action && one.resource === other.resource && one.effect === other.effect;

const sameList = (one: readonly Rule[], other: readonly Rule[]) =>
  one.length === other.length && one.every((rule, at) => same(rule, other[at] as Rule));

/**
 * A session's rules and metadata once it is in a mode: the rules its metadata says Chips added taken
 * off, one each, the last first, and the mode's put after what is left, so they decide; the metadata
 * then names them, and keeps the rest. Nothing where it is in that mode already.
 */
export function inMode(
  session: { readonly permissions?: unknown; readonly metadata?: unknown },
  mode: string,
): { readonly permissions: Rule[]; readonly metadata: Record<string, unknown> } | undefined {
  const has = rulesOf(session.permissions);
  const metadata = typeof session.metadata === "object" && session.metadata !== null ? (session.metadata as Record<string, unknown>) : {};
  const added = rulesOf(metadata[CHIPS_RULES]);
  const kept = [...has];
  for (const rule of added) {
    const at = kept.findLastIndex((each) => same(each, rule));
    if (at !== -1) kept.splice(at, 1);
  }
  const wanted = modeRules(mode);
  const permissions = [...kept, ...wanted];
  if (sameList(permissions, has) && sameList(added, wanted) && (wanted.length > 0 || !(CHIPS_RULES in metadata))) return undefined;
  const { [CHIPS_RULES]: _before, ...rest } = metadata;
  return { permissions, metadata: wanted.length === 0 ? rest : { ...rest, [CHIPS_RULES]: [...wanted] } };
}

/** The `modes` of what it runs on its own, as Chips's `own_rules.modes` has them. */
export interface OwnModes {
  readonly base: string;
  readonly running: string;
  readonly offers: readonly Mode[];
}

/** The modes a person may pick, and the one its sessions run in. */
export const modesCopy = (running: string): OwnModes => ({ base: BASE, running, offers: MODES });

/**
 * What the note on its Permissions page adds while a mode other than the one it starts in holds:
 * the config's list, which the page shows, is overruled for edits and commands.
 */
export function modeNote(running: string): string | undefined {
  if (running === "ask-changes") {
    return "In Ask before changes, its sessions also have rules from Chips, read after these: edits and commands ask.";
  }
  if (running === "read-only") {
    return "In Read-only, its sessions also have rules from Chips, read after these: edits are refused and commands ask.";
  }
  return undefined;
}
