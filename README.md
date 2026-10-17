# chips-opencode

[OpenCode](https://opencode.ai) as a [Chips](https://chipschat.ai) harness, on OpenCode's own V2
server (`opencode serve`, 2.0).
- Each OpenCode agent you name (`build`, `plan`, or one of your own) is a Chips agent. The first is
  the harness's Main agent.
- Each Chips room an agent is in is an OpenCode session of that agent, made the first time somebody
  there speaks to it. It shows in OpenCode's own apps too.

Apache-2.0. Not published: a local repository until Chips's SDK is.

## What Chips shows

| In Chips | From OpenCode (`/api`) |
| --- | --- |
| A message to the agent | `POST /api/session/{id}/prompt`: the room note, what was said, the words |
| The run | the session's work from `session.inbox.delivered` of those words to `session.execution.succeeded`, `failed` or `interrupted` |
| The thinking bubble's words | `session.reasoning.ended`, `session.text.ended` on the way, a retry's `session.status` |
| Steps, drawn by kind | `session.tool.called` / `success` / `failed`, by OpenCode's call id |
| A sub-agent | the `subagent` call as a handoff step; its child session's cost and asks are the run's |
| The reply | the words of the session's last answer |
| Cost and tokens | each model call's `session.step.ended`: OpenCode's own cost, as a step's share |
| The context gauge | the last call's tokens against the model's window from `GET /api/model` |
| An approval card | `permission.asked` → `POST …/permission/{id}/reply`: `always` when a person said always, else `once`; `reject` with their reason for a no. One answered in OpenCode's own apps is settled in Chips (ADR 0079) |
| A question | a `form.created` whose fields are choices or yes-or-no, at most four → `POST …/form/{id}/reply` |
| Stop | `POST …/interrupt`, and the words OpenCode hasn't taken yet taken back |
| A steer, a follow-up, an interrupt | a prompt with `delivery: "steer"`; with `"queue"`; interrupt, then a prompt |
| Trouble on the harness | `GET /api/info` every 30 s |

OpenCode asks before anything its config and the agent don't allow (its rules fall back to "ask"),
so its permission asks reach Chips as cards. An `always` there is saved by OpenCode as well.

When the event stream drops, OpenCode doesn't replay what was missed. When it's back, the bridge
reads each turn's session: which words were taken, whether it is still working, and how its last
answer ended.

Not yet:
- Free-text, number and link form fields, and forms of more than four. These are answered in
  OpenCode's own apps.
- A question answered in OpenCode's own apps stays open in Chips. The protocol has no way to take
  one back yet.
- OpenCode's models as the agent's Model group in Chips. Its commands, skills and context files.
- More than one OpenCode server per bridge.

## Run it

1. Start OpenCode's server in the project it should work in, with a password:

   ```
   OPENCODE_PASSWORD=<a long random password> opencode serve
   ```

   It listens on `127.0.0.1:4096`.

2. Optionally, name the agents in `~/.chips-opencode/config.json` (see `config.example.json`).
   Without a config it is OpenCode's `build` agent, named OpenCode, on `127.0.0.1:4096` in the
   server's own directory. The password is read from the environment variable `passwordEnv` names
   (`OPENCODE_PASSWORD` by default), never from the file.

3. Join Chips once, with a link from Chips's gallery (Add an agent → OpenCode), whose card gives
   this line with the link in it:

   ```
   cd ~/Work/chips-opencode && CHIPS_JOIN_LINK='<link>' OPENCODE_PASSWORD=<the server's password> npm start
   ```

   Or with `CHIPS_URL` and a code a person allows. Before it takes the link up, which works once,
   it checks the password is filled in (not the card's `…`) and OpenCode answers to it; anything
   missing stops it with what to do, and the link is still good. Joined, its Main agent says hello
   in its room once, which the card waits for. The key Chips gives it is kept, so later starts need
   only the password; a new link from Chips replaces it.

## Tests

```
npm test
```

They run the bridge against Chips's conformance fake and a scripted OpenCode server
(`test/fake-opencode.ts`), on OpenCode's own routes and event shapes. That includes Chips's golden
scenario. The SDK and the kit are in `vendor/`, packed from a Chips checkout with
`pnpm release:sdk <this repo>/vendor`.

```
npm run e2e
```

The gallery's card for this connector, run as a person runs it, against a scratch Chips from a
Chips checkout (`CHIPS_REPO`, `~/Work/Chips` unless set; skipped without one) and the same scripted OpenCode.
Each thing not set up stops it with the link still good; then it joins with what the card grants,
says hello once in its room, says nothing more started again, and takes up a new link in place of
the key it kept. The scratch Chips, the link and the run come from Chips's `tools/connect-kit`.
