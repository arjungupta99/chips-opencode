# chips-opencode

[OpenCode](https://opencode.ai) as a [Chips](https://chipschat.ai) harness, on OpenCode's own V2
server (`opencode serve`, 2.0).
- Each OpenCode agent you name (`build`, `plan`, or one of your own) is a Chips agent. The first is
  the harness's Main agent.
- Each Chips room an agent is in is an OpenCode session of that agent, made the first time somebody
  there speaks to it. It shows in OpenCode's own apps too.
- A new agent a person asks for in a room (Add, then a new one) runs as the first OpenCode agent,
  in a session of its own.
- A space a person asks for from Chips's + is claimed under a new agent, which answers its first
  words the same way.
- A copy of an agent a person asks for in another room (Fork) is a copy of its session in its own
  room, in the same folder: it remembers what the agent did there, and from then on the two
  remember apart.
- Restart on the harness's page restarts the OpenCode server the bridge runs (see [Restart](#restart)).
- Each agent's page shows its model, which a person may change there (see [Models](#models)).

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
| An agent's model (Chips ADR 0241) | the models `GET /api/model` lists that OpenCode runs, each with its variants as levels; a person's pick put on the agent's session before its next message with `POST /api/session/{id}/model` (see [Models](#models)) |
| An approval card | `permission.asked` → `POST …/permission/{id}/reply`: `always` when a person said always, else `once`, and `once` for a command, which Chips remembers by how each part starts (Chips ADR 0239); `reject` with their reason for a no. One answered in OpenCode's own apps is settled in Chips (ADR 0079) |
| A question | a `form.created` whose fields are choices or yes-or-no, at most four → `POST …/form/{id}/reply` |
| Stop | `POST …/interrupt`, and the words OpenCode hasn't taken yet taken back |
| A steer, a follow-up, an interrupt | a prompt with `delivery: "steer"`; with `"queue"`; interrupt, then a prompt |
| A space from Chips's + (Chips ADR 0241) | claimed under a new agent, named from the first line of its first words; the agent answers them as the first OpenCode agent, in a session and a folder of its own |
| Fork (Chips ADR 0087): a copy of an agent in another room | `POST /api/session/{id}/fork` of the agent's session in its room, which copies what it remembers; then `PATCH /api/session/{id}` names the copy for its room and marks it as the copy's. The copy is registered after it (*Nova · fork* for Nova), `forkedFrom` the original, for the room asked, and works in the original's folder. An ask heard again registers the same copy; an agent that never spoke in its room is copied as a new one with nothing to remember |
| Not right? on an agent's reply (Chips ADR 0200), or a 👎 from an older device | a run of the agent who said it, in its session for the room, after its turns there: a prompt with its reply, what wasn't right, and to answer again in its place; the goal is *Looking again:* and the note's first line. A 👍, or any other reaction, is nothing |
| Trouble on the harness | `GET /api/info` every 30 s |
| Restart (Chips ADR 0094) | the bridge's own `opencode serve` stopped and started again on the same port and password; then `GET /api/info`: fine, or why it isn't back |

OpenCode asks before anything its config and the agent don't allow (its rules fall back to "ask"),
so its permission asks reach Chips as cards. An `always` there is saved by OpenCode as well; a
command never gets one, so the next command comes back to Chips, whose rule answers it.

When the event stream drops, OpenCode doesn't replay what was missed. When it's back, the bridge
reads each turn's session: which words were taken, whether it is still working, and how its last
answer ended.

Not yet:
- Free-text, number and link form fields, and forms of more than four. These are answered in
  OpenCode's own apps.
- A question answered in OpenCode's own apps stays open in Chips. The protocol has no way to take
  one back yet.
- OpenCode's commands, skills and context files in Chips.
- Fork for a bridge that joined from the gallery: its card grants `agents` and `new_agents`. A
  bridge that joins with a code asks for `new_spaces` and `forks` as well.
- More than one OpenCode server per bridge.

## Models

An agent's Model group in Chips (Chips ADR 0241) offers the models OpenCode's server runs: those
of the providers it is set up with (`GET /api/model`), less any disabled or retired, at most 40.
Each model's levels are its variants in OpenCode (`low`, `high`, `max` and so on), lowest first.

What an agent runs on, with no model of its own picked in Chips, is its `model` in the bridge's
config ("As in config.json"), else its OpenCode agent's model (`GET /api/agent`), else the server's
default (`GET /api/model/default`): "OpenCode's default". A person's pick, a model and a level, is
kept in `sessions.json`, not written into OpenCode's config. Before each message for the agent the
bridge puts the session it goes to on it (`POST /api/session/{id}/model`), where it isn't on it
already, and a new session is made on it. Picking the default again puts the agent's sessions back
on that before their next message. A copy made by Fork runs on what its original runs on. OpenCode
takes any model there, so the bridge refuses one its catalogue doesn't run, and a level its model
doesn't have, in so many words.

## Restart

Where the bridge runs OpenCode's server itself (no `url` in the config), a person can restart it
from the harness's page in Chips (Chips ADR 0094). The bridge stops the server and starts it again
on the same port and password, so its sessions, which OpenCode keeps on disk, go on where they
were. A server it took up from before, left running by a bridge that was stopped hard, is stopped
by the process it says it is. The bridge says nothing more until the server answers again, then
says it is fine. If the server doesn't come back, it says why, in OpenCode's own words where it has
them, ends the runs that were under way, and Chips offers Restart again. A restart stops whatever
OpenCode was doing, as Chips's sheet says.

A server you run yourself (`url` in the config) isn't the bridge's to restart. The bridge doesn't
ask for `restarts` when it joins, and doesn't hear the ask. A harness joined one way and later
configured the other keeps what it was granted when it joined:
- Joined running its own server, then given a `url`: Chips still draws Restart, and answers it
  with "Chips can't reach <its name> to restart it". Turn off *Be restarted from Chips* on the
  harness's page.
- Joined with a `url`, then running its own server: the bridge hears restarts, but Chips draws no
  Restart until you turn on *Be restarted from Chips* on the harness's page.

A link carries what the person chose on it, not what the bridge asks for. The gallery's card for
OpenCode doesn't grant `restarts` yet, so a bridge joined from it gets Restart once you turn it on
on its page.

## From Chips's gallery

The card's line is `chips connect opencode '<link>'` (Chips ADR 0218). It downloads this bridge as the npm package
`@chipschat/opencode`, the newest 1.x, checks it against the registry's checksum, and runs it on the Node
that Chips carries, so the machine needs no Node or npm of its own. The bridge checks OpenCode,
joins, and keeps itself running from login. `chips disconnect opencode` stops it. On another computer,
`curl -fsSL https://chipschat.ai/install | sh -s -- connect opencode '<link>'` installs Chips there
first. The steps below run the bridge from this checkout instead, to work on it.

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
the key it kept. The scratch Chips, the link and the run come from Chips's `tools/connect-kit`, which packs this checkout and serves it from a stand-in npm registry, so the card's `chips connect` downloads, checks and runs what would be published.

## Release

`npm run release` builds `dist/main.js`, one file with the SDK and everything else bundled in, and
`dist/THIRD-PARTY-NOTICES.md` beside it; runs the tests; and packs `chipschat-opencode-<version>.tgz`. `npm publish`
publishes it. A version's major is the Chips protocol it speaks, and Chips's card names that major
(Chips ADR 0218): a fix is a minor or a patch, and reaches every card of its major the day it is
published.
