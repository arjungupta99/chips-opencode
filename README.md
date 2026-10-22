# chips-opencode

[OpenCode](https://opencode.ai) as a [Chips](https://chipschat.ai) harness, on OpenCode's own V2
server (`opencode serve`, 2.0).
- Each OpenCode agent you name (`build`, `plan`, or one of your own) is a Chips agent. The first is
  the harness's Main agent.
- Each Chips room an agent is in is an OpenCode session of that agent, made the first time somebody
  there speaks to it. It shows in OpenCode's own apps too.
- A new agent a person asks for in a room (Add, then a new one) runs as the first OpenCode agent,
  in a session of its own.

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
| Files in the reply | each `MEDIA:<path>` line of its own in the answer, taken out of the words and sent from the session's folder (the agent's own), as OpenCode says it (each turn is told how); a file outside it is refused, and the reply says so |
| Cost and tokens | each model call's `session.step.ended`: OpenCode's own cost, as a step's share |
| The context gauge | the last call's tokens against the model's window from `GET /api/model` |
| An approval card | `permission.asked` → `POST …/permission/{id}/reply`: `always` when a person said always, else `once`; `reject` with their reason for a no. One answered in OpenCode's own apps is settled in Chips (ADR 0079) |
| A question | a `form.created` whose fields are choices or yes-or-no, at most four → `POST …/form/{id}/reply` |
| Stop | `POST …/interrupt`, and the words OpenCode hasn't taken yet taken back |
| A steer, a follow-up, an interrupt | a prompt with `delivery: "steer"`; with `"queue"`; interrupt, then a prompt |
| Not right? on an agent's reply (Chips ADR 0200), or a 👎 from an older device | a run of the agent who said it, in its session for the room, after its turns there: a prompt with its reply, what wasn't right, and to answer again in its place; the goal is *Looking again:* and the note's first line. A 👍, or any other reaction, is nothing |
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

1. Install OpenCode (opencode.ai), and `npm install` once in this repository.

2. Join Chips once, with a link from Chips's gallery (Add an agent → OpenCode), whose card gives
   this line with the link in it:

   ```
   cd ~/Work/Chips/chips-opencode && CHIPS_JOIN_LINK='<link>' npm run keep
   ```

   The bridge runs OpenCode's server itself (`opencode serve` on `127.0.0.1`, 4096 when it is
   free), with a password it makes and keeps in `~/.chips-opencode/server.json`, readable by you
   only: nobody starts a server or makes up a password. While the bridge runs, a server that stops
   is started again; when the bridge stops, so does its server.

   Before it takes the link up, which works once, it checks OpenCode is installed and its server
   answers; anything missing stops it with what to do, and the link is still good. Joined, it
   writes a launch agent (`~/Library/LaunchAgents/chat.chips.opencode.plist`; a systemd user unit
   on Linux) that runs the bridge from login and again whenever it stops, and ends; the kept copy
   says hello in its room once, which the card waits for. Its log is
   `~/Library/Logs/chips-opencode.log`. `npm run keep -- --stop` stops it and removes the file.
   `npm start` is the same without keeping it, in the terminal. Stop a copy started by hand first:
   two answer twice. The key Chips gives it is kept; a new link from Chips replaces it. Or join with
   `CHIPS_URL` and a code a person allows.

3. Optionally, name the agents in `~/.chips-opencode/config.json` (see `config.example.json`).
   Without a config it is OpenCode's `build` agent, named OpenCode.

   Each agent's sessions work in a folder of its own, `~/chips-opencode/agents/<its name>`, made
   the first time it is spoken to and kept after a rename; `folders` moves them. A `directory`
   puts every session in that one project instead, a repository the agents share.

   **A server of your own.** To use an `opencode serve` you run yourself, give its password in the
   environment variable `passwordEnv` names (`OPENCODE_PASSWORD` by default, never in the file),
   and its `url` in the config when it isn't `127.0.0.1:4096`. `npm run keep` takes the password
   with it, in a file only you can read; your server is kept running your own way.

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
Chips checkout (`CHIPS_REPO`, `~/Work/Chips/chips-main` unless set; skipped without one) and the same scripted OpenCode.
Each thing not set up stops it with the link still good; then it joins with what the card grants,
says hello once in its room, says nothing more started again, and takes up a new link in place of
the key it kept. The scratch Chips, the link and the run come from Chips's `tools/connect-kit`.
