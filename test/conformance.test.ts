/**
 * The golden scenario of Chips's conformance kit, played against the bridge and a scripted OpenCode
 * that asks before it acts: what `chips conformance custom --capabilities agents,new_spaces,new_agents,restarts`
 * checks of it live, running OpenCode's server itself, which a person's Restart restarts.
 */

import { strict as assert } from "node:assert";
import { it } from "node:test";
import { formatReport, runConformance } from "@chipschat/conformance";
import { type Chips, connect } from "@chipschat/harness";
import { Bridge } from "../src/bridge.ts";
import { OpenCodeClient } from "../src/opencode.ts";
import { startFakeOpenCode } from "./fake-opencode.ts";

it("passes the golden scenario", async () => {
  const opencode = await startFakeOpenCode({ askFirst: true });
  let client: Chips | undefined;
  let bridge: Bridge | undefined;
  try {
    const report = await runConformance({
      beatTimeoutMs: 3000,
      subject: {
        name: "chips-opencode",
        capabilities: ["agents", "new_spaces", "new_agents", "restarts"],
        start: async (address) => {
          client = await connect({ url: address.url, token: address.token, onRestart: () => bridge?.restart() });
          bridge = new Bridge({
            chips: client,
            opencode: new OpenCodeClient({ url: opencode.url, password: opencode.password }),
            agents: [{ name: "OpenCode", agent: "build" }],
            home: address.spaceId,
            state: { sessions: {} },
            saveState: () => undefined,
            restartServer: () => opencode.restart(200),
          });
          await bridge.start();
        },
        stop: async () => {
          bridge?.stop();
          client?.close();
        },
      },
    });
    assert.ok(report.passed, formatReport(report).join("\n"));
    assert.deepEqual(
      report.findings.filter((finding) => finding.severity !== "note"),
      [],
      formatReport(report).join("\n"),
    );
    assert.deepEqual(
      report.levels.map((level) => [level.label, level.has]),
      [
        ["Talks", 1],
        ["Supervised", 1],
        ["Lives in Chips", 4],
        ["Managed from Chips", 0],
      ],
    );
  } finally {
    await opencode.close();
  }
});
