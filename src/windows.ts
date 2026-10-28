/**
 * An agent's context window in Chips (Chips ADRs 0146, 0241): how full one of this harness's agents
 * is, and a person's Compact now. What the bridge works out; the bridge itself hears the readings
 * and asks for the compactions.
 *
 * Each of OpenCode's model calls says its tokens (`session.step.ended`, and a session's newest
 * assistant message after it): all it read, the cache's among them, and all it wrote, which is how
 * full the session is now, of its model's context limit from the catalogue (`GET /api/model`). An
 * agent has a session in each space it is in, and Chips one window for it: the copy is of the
 * session that said last, and Compact now compacts that one (`POST /api/session/{id}/compact`),
 * at once, or at its next step when it is working. OpenCode says when a compaction starts and ends
 * (`session.compaction.started`, `.ended`, `.failed`), its own when the window is nearly full
 * among them, and with what it kept: the summary it wrote and the recent words it keeps as they
 * were.
 *
 * OpenCode keeps its own limit, set in its config (`compaction`), and takes no other from a
 * session: the copy offers none, and says so.
 */

import type { AgentContextWindowCopy } from "@chipschat/harness";
import { type LastCompaction, LONG_TURN_FOLDS_MAX, type LongTurn } from "@chipschat/protocol";

/** What the bridge keeps of an agent's window, by whose sessions they are. */
export interface KeptWindow {
  used: number;
  window: number;
  model?: string | undefined;
  asOf: string;
  /** The session that said last: the one Compact now compacts. */
  session: string;
  last?: LastCompaction | undefined;
  longTurn?: LongTurn | undefined;
}

/** Why a person can't pick the limit: OpenCode keeps its own. */
export const OWN_LIMIT = "OpenCode compacts it itself when it is nearly full, as its config says.";

/** A model call's tokens, as OpenCode counts them. */
export interface Tokens {
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cache: { readonly read: number; readonly write: number };
}

/** How full a session is after a model call: every token it read, and every one it wrote. */
export function usedOf(tokens: Tokens): number {
  return tokens.input + tokens.cache.read + tokens.cache.write + tokens.output + tokens.reasoning;
}

/**
 * What a session holds after a compaction, as OpenCode's `session.compaction.ended` says it: the
 * summary it wrote, by its tokens, and the recent words it kept, at about four characters a token.
 */
export function compactedTo(data: Readonly<Record<string, unknown>>): number {
  const tokens = data["tokens"] as Partial<Tokens> | undefined;
  const summary = typeof tokens?.output === "number" ? tokens.output : 0;
  const recent = typeof data["recent"] === "string" ? data["recent"] : "";
  return Math.round(summary + recent.length / 4);
}

/** An agent's copy, as Chips takes it (`PUT /v1/agents/:id/context-window`). */
export function windowCopy(kept: KeptWindow, compacting?: "queued" | "running" | undefined): AgentContextWindowCopy {
  return {
    used: Math.max(0, Math.round(kept.used)),
    window: Math.max(1, Math.round(kept.window)),
    ...(kept.model === undefined ? {} : { model: kept.model.slice(0, 120) }),
    as_of: kept.asOf,
    ...(compacting === undefined ? {} : { compacting }),
    ...(kept.last === undefined ? {} : { last: kept.last }),
    ...(kept.longTurn === undefined
      ? {}
      : { long_turn: { ...kept.longTurn, folds: Math.min(kept.longTurn.folds, LONG_TURN_FOLDS_MAX) } }),
    compacts: true,
    editable: false,
    why_read_only: OWN_LIMIT,
  };
}
