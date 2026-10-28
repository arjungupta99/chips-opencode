/**
 * `opencode serve --hostname 127.0.0.1 --port <port>` as the bridge runs it, played by the fake
 * OpenCode: on that port, to the password in `OPENCODE_PASSWORD`, saying its process in `/api/info`
 * as OpenCode does. Each start is counted in `$FAKE_SERVE_STARTS`, a file, when set;
 * `FAKE_SERVE_FAIL=1` says something and stops at once.
 */

import { appendFileSync } from "node:fs";
import { startFakeOpenCode } from "./fake-opencode.ts";

const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const starts = process.env["FAKE_SERVE_STARTS"];
if (starts !== undefined) appendFileSync(starts, `${process.pid}\n`);
if (process.env["FAKE_SERVE_FAIL"] === "1") {
  process.stderr.write("Error: no provider is configured\n");
  process.exit(1);
}
const fake = await startFakeOpenCode({ port, password: process.env["OPENCODE_PASSWORD"] ?? "", pid: process.pid });
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void fake.close().then(() => process.exit(0));
  });
}
