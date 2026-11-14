/**
 * `opencode serve --hostname 127.0.0.1 --port <port>` as the bridge runs it, played by the fake
 * OpenCode: on that port, to the password in `OPENCODE_PASSWORD`, saying its process in `/api/info`
 * as OpenCode does. Each start is counted in `$FAKE_SERVE_STARTS`, a file, when set;
 * `FAKE_SERVE_FAIL=1` says something and stops at once; `FAKE_SERVE_SLOW_MS` is how long it takes
 * before it answers, stopping meanwhile when it is told to.
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
const slow = Number(process.env["FAKE_SERVE_SLOW_MS"] ?? 0);
if (slow > 0) {
  const stopped = () => process.exit(0);
  process.on("SIGINT", stopped);
  process.on("SIGTERM", stopped);
  await new Promise((done) => setTimeout(done, slow));
  process.off("SIGINT", stopped);
  process.off("SIGTERM", stopped);
}
const fake = await startFakeOpenCode({ port, password: process.env["OPENCODE_PASSWORD"] ?? "", pid: process.pid });
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void fake.close().then(() => process.exit(0));
  });
}
