/**
 * The modes a person picks in Chips for OpenCode's sessions (Chips ADR 0300, addenda of 19 November
 * 2026): Chips's own, made of OpenCode's rules, set on each session Chips opens, and taken off again
 * without touching any rule of anybody else's.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { ownModes } from "@chipschat/protocol";
import { BASE, CHIPS_RULES, inMode, MODES, modeNote, modeRules, modesCopy, modeTarget } from "../src/modes.ts";

const EDIT_ASK = { action: "edit", resource: "*", effect: "ask" } as const;
const EDIT_DENY = { action: "edit", resource: "*", effect: "deny" } as const;
const SHELL_ASK = { action: "shell", resource: "*", effect: "ask" } as const;
/** What OpenCode's browser plugin adds to a session while a browser is attached. */
const BROWSER = { action: "browser", resource: "*", effect: "allow" } as const;

describe("OpenCode's modes", () => {
  it("are the three of Chips ADR 0300, with its lines word for word, Default first and where it starts", () => {
    assert.deepEqual(
      MODES.map((mode) => [mode.id, mode.name, mode.words]),
      [
        ["default", "Default", "Runs as your OpenCode settings say. Out of the box it asks almost nothing."],
        ["ask-changes", "Ask before changes", "Edits and commands wait for a yes. Reads run on their own."],
        ["read-only", "Read-only", "Reads on its own. Edits are refused, and commands ask first."],
      ],
    );
    assert.equal(BASE, "default");
    // None never asks: no mode is `everything`, and none allows anything.
    assert.ok(MODES.every((mode) => !("everything" in mode)));
    assert.ok(MODES.every((mode) => modeRules(mode.id).every((rule) => rule.effect !== "allow")));
  });

  it("are made of OpenCode's rules: an ask for edits and commands, or a refusal for edits and an ask for commands", () => {
    assert.deepEqual(modeRules("default"), []);
    assert.deepEqual(modeRules("ask-changes"), [EDIT_ASK, SHELL_ASK]);
    assert.deepEqual(modeRules("read-only"), [EDIT_DENY, SHELL_ASK]);
    assert.deepEqual(modeRules("bypassPermissions"), []);
  });

  it("goes into the pick while it holds, else Default, and says why for a pick that isn't one of its own", () => {
    assert.deepEqual(modeTarget(undefined), { mode: "default" });
    assert.deepEqual(modeTarget({ id: "default" }), { mode: "default" });
    assert.deepEqual(modeTarget({ id: "read-only", name: "Read-only" }), { mode: "read-only" });
    const other = modeTarget({ id: "bypassPermissions" });
    assert.equal(other.mode, "default");
    assert.match(other.why ?? "", /bypassPermissions, picked in Chips, isn't one of its modes/);
  });

  it("is said to Chips as own_rules.modes takes it", () => {
    const copy = modesCopy("read-only");
    assert.equal(ownModes.safeParse(copy).success, true);
    assert.deepEqual([copy.base, copy.running, copy.offers.map((mode) => mode.id)], ["default", "read-only", ["default", "ask-changes", "read-only"]]);
    assert.equal(modeNote("default"), undefined);
    assert.match(modeNote("ask-changes") ?? "", /edits and commands ask/);
    assert.match(modeNote("read-only") ?? "", /edits are refused and commands ask/);
  });
});

describe("a session put in a mode", () => {
  it("has the mode's rules after its own, and names them in its metadata, keeping the rest", () => {
    const moved = inMode({ metadata: { chips_space: "spc_1", chips_agent: "agt_1" } }, "ask-changes");
    assert.deepEqual(moved, {
      permissions: [EDIT_ASK, SHELL_ASK],
      metadata: { chips_space: "spc_1", chips_agent: "agt_1", [CHIPS_RULES]: [EDIT_ASK, SHELL_ASK] },
    });
    // In it already: nothing to change.
    assert.equal(inMode(moved ?? {}, "ask-changes"), undefined);
    assert.equal(inMode({}, "default"), undefined);
    assert.equal(inMode({ permissions: [BROWSER], metadata: { chips_space: "spc_1" } }, "default"), undefined);
  });

  it("swaps only the rules Chips added, and leaves anybody else's where they were", () => {
    // The browser plugin added its allow after Chips's rules went on.
    const session = { permissions: [EDIT_ASK, SHELL_ASK, BROWSER], metadata: { chips_space: "spc_1", [CHIPS_RULES]: [EDIT_ASK, SHELL_ASK] } };
    assert.deepEqual(inMode(session, "read-only"), {
      permissions: [BROWSER, EDIT_DENY, SHELL_ASK],
      metadata: { chips_space: "spc_1", [CHIPS_RULES]: [EDIT_DENY, SHELL_ASK] },
    });
    assert.deepEqual(inMode(session, "default"), { permissions: [BROWSER], metadata: { chips_space: "spc_1" } });
  });

  it("takes off one of each rule it added, the last first, so a person's own rule like it stays", () => {
    const session = { permissions: [SHELL_ASK, BROWSER, EDIT_DENY, SHELL_ASK], metadata: { [CHIPS_RULES]: [EDIT_DENY, SHELL_ASK] } };
    assert.deepEqual(inMode(session, "default"), { permissions: [SHELL_ASK, BROWSER], metadata: {} });
  });

  it("puts its rules back, and last, where something else took them off or wrote after them", () => {
    const wiped = { permissions: [], metadata: { [CHIPS_RULES]: [EDIT_DENY, SHELL_ASK] } };
    assert.deepEqual(inMode(wiped, "read-only")?.permissions, [EDIT_DENY, SHELL_ASK]);
    // A rule for edits written after Chips's would decide instead of them: Chips's go last again.
    const overruled = { permissions: [EDIT_DENY, SHELL_ASK, { action: "edit", resource: "*", effect: "allow" }], metadata: { [CHIPS_RULES]: [EDIT_DENY, SHELL_ASK] } };
    assert.deepEqual(inMode(overruled, "read-only")?.permissions, [{ action: "edit", resource: "*", effect: "allow" }, EDIT_DENY, SHELL_ASK]);
    // What Chips's metadata names, left with no rules of its, is cleared in Default.
    assert.deepEqual(inMode({ metadata: { [CHIPS_RULES]: [] } }, "default"), { permissions: [], metadata: {} });
  });
});
