/**
 * An agent's model and effort in Chips (Chips ADRs 0140, 0241): what each of the harness's agents
 * runs on in OpenCode, and at which of its model's levels, sent to Chips as a copy so a person sees
 * it on the agent's page; a person's pick there is kept by the bridge.
 *
 * OpenCode's server lists the models of the providers it is set up with (`GET /api/model`), each
 * with its variants: its reasoning levels, lowest first, which a session's model names beside it.
 * A disabled model isn't run. A session runs on the model it was made with or last switched to
 * (`POST /api/session/{id}/model`), else on its agent's from OpenCode's config, else on the
 * server's default (`GET /api/model/default`). A pick is written into nothing of OpenCode's: before
 * each message for the agent, the bridge switches the session the message goes to onto it, where
 * it isn't on it already.
 *
 * With no pick of its own an agent runs on the model the bridge's config gives it, else on
 * OpenCode's own for it: Same as … in Chips. Chips holds no model's name: every label here is
 * OpenCode's, or this module's for its levels.
 */

import type { AgentModelCopy } from "@chipschat/harness";
import { type ModelInfo, type ModelRef, modelRefOf } from "./opencode.js";

/** What Chips takes at most (`MODEL_CHOICES_MAX`, `EFFORT_LEVELS_MAX`). */
export const MODEL_CHOICES_MAX = 40;
export const EFFORT_LEVELS_MAX = 8;

/** A person's pick, as the bridge keeps it: `provider/model`, and one of its levels. */
export interface ModelPick {
  readonly model: string;
  readonly effort?: string | undefined;
}

/** What an agent runs on with no pick of its own, and what the Same as switch says of it. */
export interface Fallback {
  readonly model: ModelRef;
  readonly label: string;
}

/** OpenCode's levels, as a bar says them; another is said as OpenCode spells it, capitalised. */
const LEVEL_WORDS: Readonly<Record<string, string>> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  thinking: "Thinking",
};

type Choice = AgentModelCopy["choices"][number];

/** A model as Chips names it, and OpenCode's config does: `provider/model`. */
export function writtenOf(model: Pick<ModelRef, "providerID" | "id">): string {
  return `${model.providerID}/${model.id}`;
}

/** The model a pick is, as OpenCode takes it. */
export function refOf(pick: ModelPick): ModelRef {
  return { ...modelRefOf(pick.model), ...(pick.effort === undefined ? {} : { variant: pick.effort }) };
}

/** A model's level: none for OpenCode's `default`, which a session given no level is put on. */
export function levelOf(model: ModelRef | undefined): string | undefined {
  return model?.variant === undefined || model.variant === "default" ? undefined : model.variant;
}

/** Whether two models are the same, level and all. */
export function sameModel(a: ModelRef | undefined, b: ModelRef | undefined): boolean {
  return a?.providerID === b?.providerID && a?.id === b?.id && levelOf(a) === levelOf(b);
}

/** What a level's bar says. */
export function levelWords(id: string): string {
  return (LEVEL_WORDS[id] ?? `${id.charAt(0).toUpperCase()}${id.slice(1)}`).slice(0, 40);
}

/** The models OpenCode runs: enabled, and not retired. */
export function runnable(catalogue: readonly ModelInfo[]): ModelInfo[] {
  return catalogue.filter((model) => model.enabled !== false && model.status !== "deprecated");
}

/** A model's levels as Chips takes them: each once, lowest first, its highest eight. */
function levelsOf(model: ModelInfo | undefined): Choice["efforts"] {
  const seen = new Set<string>();
  const each = (model?.variants ?? []).filter((variant) => !seen.has(variant.id) && seen.add(variant.id));
  return each.slice(-EFFORT_LEVELS_MAX).map((variant) => ({ id: variant.id, label: levelWords(variant.id) }));
}

/** A level that is one of the choice's, or nothing. */
const fitting = (choice: Choice | undefined, effort: string | undefined): string | undefined =>
  choice?.efforts.some((level) => level.id === effort) === true ? effort : undefined;

/**
 * One agent's copy, whole, as Chips takes it (`PUT /v1/agents/:id/model`): the model and level it
 * runs on now, whether that is its own pick, what it runs on without one, and the models OpenCode
 * runs, each with its levels. A model it runs on that the catalogue doesn't have is among its
 * choices anyway, so the copy always names what is true. Nothing without a model to name.
 */
export function modelCopy(input: {
  readonly catalogue: readonly ModelInfo[];
  readonly pick: ModelPick | undefined;
  readonly fallback: Fallback | undefined;
}): AgentModelCopy | undefined {
  const { pick, fallback } = input;
  const runsOn = pick === undefined ? fallback?.model : refOf(pick);
  if (runsOn === undefined) return undefined;
  const offered = runnable(input.catalogue);
  // Two providers' models of the same name are told apart by their provider.
  const names = new Map<string, number>();
  for (const model of offered) names.set(model.name, (names.get(model.name) ?? 0) + 1);
  const choices: Choice[] = offered.map((model) => ({
    id: writtenOf(model),
    label: ((names.get(model.name) ?? 0) > 1 ? `${model.name} · ${model.providerID}` : model.name || model.id).slice(0, 80),
    efforts: levelsOf(model),
  }));
  const named = (ref: ModelRef): Choice => {
    const id = writtenOf(ref);
    const known = choices.find((choice) => choice.id === id);
    if (known !== undefined) return known;
    const level = levelOf(ref);
    const choice: Choice = { id, label: ref.id.slice(0, 80), efforts: level === undefined ? [] : [{ id: level, label: levelWords(level) }] };
    choices.push(choice);
    return choice;
  };
  const now = named(runsOn);
  const otherwise = fallback === undefined ? undefined : named(fallback.model);
  const effort = fitting(now, levelOf(runsOn));
  const fallbackEffort = fitting(otherwise, levelOf(fallback?.model));
  const keep = new Set([now.id, ...(otherwise === undefined ? [] : [otherwise.id])]);
  let others = MODEL_CHOICES_MAX - keep.size;
  return {
    model: now.id,
    ...(effort === undefined ? {} : { effort }),
    own: pick !== undefined,
    ...(fallback === undefined || otherwise === undefined
      ? {}
      : {
          default: {
            label: fallback.label.slice(0, 80),
            model: otherwise.id,
            ...(fallbackEffort === undefined ? {} : { effort: fallbackEffort }),
          },
        }),
    choices: choices.filter((choice) => keep.has(choice.id) || others-- > 0),
    editable: true,
  };
}

/**
 * A person's pick, as the bridge keeps it, once it is a model OpenCode runs and one of that
 * model's levels; `null` for no pick of its own. Throws, in a person's words, for any other.
 */
export function pickOf(
  change: { readonly model: string | null; readonly effort: string | null },
  catalogue: readonly ModelInfo[],
): ModelPick | null {
  if (change.model === null) return null;
  const model = runnable(catalogue).find((each) => writtenOf(each) === change.model);
  if (model === undefined) throw new Error(`OpenCode doesn't run ${change.model} here.`);
  if (change.effort === null) return { model: change.model };
  if (!(model.variants ?? []).some((variant) => variant.id === change.effort)) {
    throw new Error(`${model.name || model.id} has no ${levelWords(change.effort)} level.`);
  }
  return { model: change.model, effort: change.effort };
}
