# dsh-feishu-bridge

Two-way bridge between [DeepSeek Harness](https://github.com/deepseek-ai) (dsh) and a Feishu / Lark bot.

dsh pushes **stage conclusions** and **questions that need your input** to Feishu; you reply in the Feishu chat and it flows back into the dsh session. When the work is done, dsh sends a **work summary**.

**Table of Contents**

- [What it does](#what-it-does)
- [How it reports](#how-it-reports)
- [Install](#install)
- [Configure](#configure)
- [Feishu commands](#feishu-commands)
- [Chat mode](#chat-mode)
- [How the question bridge works](#how-the-question-bridge-works)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## What it does

| Direction | Behaviour |
|---|---|
| dsh 鈫?Feishu | Opening report, stage conclusions, work summary, and any `ask_user_question` prompt |
| Feishu 鈫?dsh | Plain text (including images) is delivered into the session as a user message |
| Feishu commands | `/help` `/stop` `/list` `/use` `/mute` `/chat` `/work` 鈥?see the table below |
| Feishu cards | Questions render as cards; option buttons send the answer back |

It is **not**:

- a public webhook service 鈥?it rides lark-cli's long connection, no inbound port needed
- a modification to dsh core 鈥?it is a regular plugin
- an outbound-only notifier 鈥?the Feishu chat is a real input channel into the session

## How it reports

Three layers with **different natures** 鈥?that distinction is the whole design:

| When | Nature | What it says |
|---|---|---|
| You send dsh a message | **Fixed action**, always sent | Opened work: how it plans to approach it |
| End of each turn | **Model judgement** (`turnPush: judge`) | Sent only if there is something worth reporting |
| Work finishes | Fixed action | Work summary: what was done + full change list |

**Stage conclusions are accumulated, not fired per sentence.** Thinking is gathered
since the last report; once there is enough for a real summary, the model is asked
one question 鈥?*"what was actually accomplished here?"* 鈥?and an answer of `NONE`
means it keeps accumulating. It only reports **work that is already done**
("I'm about to鈥? / "next I'll鈥? are explicitly not reported).

A `feishu_notify` policy is also injected into the system prompt, so the model knows
from the first message that it can push a conclusion on its own.

Three layers of quiet, when you want silence:

- `/mute` in Feishu 鈥?silences the current session (not persisted)
- `turnPush: off` / `thinkPush: false` 鈥?global switches in config
- `enabled: false` 鈥?turns the whole bridge off

## Install

The plugin needs **both halves** to load: a server half (`src/`) and a client half
(`lib/client.js`, which renders the settings page inside dsh). Because of that it
must be resolvable **by package name** 鈥?a `file:///` entry is not picked up by the
client module scan.

### Option 1: let an AI agent do it (recommended)

Paste this whole block to your dsh agent:

```text
Install the dsh-feishu-bridge plugin on this machine (a two-way bridge between dsh and a Feishu bot).

1. Clone the repo to ~/dsh-feishu-bridge; call it <PLUGIN_DIR> below.
2. Install it into the web profile by package name:
     dsh plugin --profile web add <PLUGIN_DIR>
   (use `link:<PLUGIN_DIR>` if you are installing from a local checkout 鈥?   both forms work; `add` registers the plugin's bundle layer automatically.)
3. Check the prerequisite: lark-cli is installed and
     lark-cli --profile dsh-bridge whoami
   returns an appId. If that profile does not exist yet, STOP and tell me 鈥?   creating a Feishu app requires me to click through the browser myself.
4. Restart dsh so the new plugin loads.
5. Report three things: whether the plugin loaded (check ~/.dsh/dsh-feishu-bridge/boot.log),
   whether a "椋炰功妗? section appears in dsh Settings, and what I need to do in Feishu next.
```

### Option 2: manual install

**1. Install lark-cli and create a Feishu bot**

```bash
npm i -g @larksuite/cli
lark-cli config init --new --name dsh-bridge
```

In the Feishu open platform, enable for this app:

- Permissions: `im:message`, `im:message:send_as_bot` (required); add `im:message:readonly` for card buttons
- Event subscriptions (**long connection mode**): `im.message.receive_v1` (required), `card.action.trigger` (optional, only for buttons)

**2. Install the plugin**

```bash
# from npm (once published)
dsh plugin --profile web add dsh-feishu-bridge

# or from a local checkout
dsh plugin --profile web add link:/path/to/dsh-feishu-bridge

# or straight from GitHub
dsh plugin --profile web add github:superSizzzz/dsh-feishu-bridge
```

`dsh plugin` forwards to pnpm and registers the plugin's `dsh.bundle` layer, so it is
**auto-mounted** 鈥?you do not edit any patch file. Restart dsh afterwards.

> Adding a plugin always needs a restart. `patchReload: live` only covers config
> changes to entries that are already loaded; a newly added bundle is not picked up
> by hot reload.

**3. Let it recognise you (no open_id needed)**

Find your bot in Feishu and **send it any message**. The plugin reads your `open_id`
from the event stream, remembers it, and replies to confirm.

> Feishu `open_id` is **scoped per app**, so it cannot be copied from anywhere else.
> Auto-claim is both the easiest and the least error-prone way.

**4. Done**

You can now message dsh directly, send `/help` for commands, or `/chat` for chat mode.

## Configure

Two entry points, same config, whichever you use.

### Entry 1: dsh Settings (recommended)

Open dsh **Settings** 鈥?there is a **"椋炰功妗?** section in the left nav. It lets you change:

| Field | Meaning |
|---|---|
| **Feishu bot** | Which Feishu app this bridge uses: a lark-cli profile name, or the bot's app id (`cli_xxx` 鈥?a profile name defaults to the app id). Changing it means changing bots; see below |
| **Bound user** | Your `open_id`. Empty = unbind; the next person to message the bot is auto-claimed |
| **Chat model** | provider / model for `/chat`; empty falls back to the dsh default |
| **Persona** | The speaking style used for every message pushed to you (opening report, stage summary, work summary, chat). Empty falls back to the config default |

Read-only: bot name, resolved app id, state file location. **Saving takes effect
immediately, no restart.**

**Changing the bot**: the inbound connection is rebuilt and the **bound user is cleared** 鈥?Feishu `open_id` is scoped per app, so the old id no longer points at the same person.
Send the new bot a message to re-claim.

### Entry 2: open it in a browser

```
http://127.0.0.1:3080/feishu-bridge/config
```

Same content as a standalone page. 3080 is dsh web's port 鈥?substitute yours if you
changed `--port`.

> **Security note**: dsh's HTTP server binds to `127.0.0.1` by default and requires a
> login token, so neither entry point adds its own auth 鈥?anyone who can open them can
> already use dsh on this machine. If you set the web server to `0.0.0.0`, both are
> exposed to the network; add a reverse proxy and auth in that case.

### Behaviour switches

`openPush` / `thinkPush` / `turnPush` / `thinkingJudge` / `summaryPush` stay in the
**config file**, not the settings page 鈥?they are set once when installing. Override
them by adding an entry with the same id to your own patch layer (upper layers win):

```yaml
# ~/.dsh/cordis.patch.yml
- insert:
    - id: feishu-bridge
      config:
        turnPush: always      # report every turn
        thinkingJudge: false  # disable per-stage judgement
```

## Feishu commands

| Command | What it does |
|---|---|
| `/help` | Command list |
| `/status` | Current bindings, target, mode |
| `/list` | Sessions seen so far (short code + title + workspace + status) |
| `/use <code>` | Switch the default delivery target |
| `/stop` | Interrupt the running agent |
| `/mute` `/unmute` | Silence / resume pushes for the current session |
| `/chat` `/work` | Toggle chat mode / work mode |
| `/polish <text>` | Rewrite a draft in the configured persona |
| `/mode` | Show the current mode |
| `/config` | View or change runtime config |
| `/forget` | Clear chat history |

## Chat mode

`/chat` switches the Feishu side into a **plain chat** 鈥?it talks to the model and
**never touches dsh**: no session, no tools, no workspace. `/work` goes back.

Chat uses the dsh API key by default. The model can be changed in the settings page or
via `/config chatModel <name>`.

History persists in `state.json`, but the mode itself deliberately does not 鈥?a restart
returns to work mode.

## How the question bridge works

When dsh needs to ask you something (`ask_user_question`), the plugin races two channels:

1. The question is pushed to Feishu as a card
2. Meanwhile the **web session stays open** and waits

Whichever you answer first wins; the other side is cancelled. If neither responds in
time (`questionTimeoutMs`, 5 minutes by default), it behaves as if you never answered.

The design goal: being on your phone is not a reason to lose a decision, and being at
the desk is not a reason to wait for a phone. Cards also carry numbered option buttons 鈥?tapping one sends that answer back (requires the `card.action.trigger` subscription).

## Troubleshooting

**Plugin does not load** 鈥?check `$DSH_HOME/dsh-feishu-bridge/boot.log`. It records
apply/config/whoami/inbox-lock/greeting/prompt-section lines. A bare
`1 entry did not activate` in dsh's own output means something threw during `apply()`.

**Not receiving messages** 鈥?run `lark-cli --profile <name> whoami`; if `available` is
false the bot identity is broken. Also check whether another dsh instance holds the
inbound lock (see below).

**Nothing gets pushed** 鈥?`/mute` may be on, or `enabled` / `turnPush` may be off.

**A plugin source edit has no effect** 鈥?plugin code is not hot-reloaded; restart dsh.

> **`dsh plugin` notes**: it forwards to pnpm, so `add` / `remove` / `why` all work;
> `remove` also unregisters the bundle layer. Git-hosted plugins (`github:user/repo`)
> build on install via their `prepare` script, which pnpm blocks until allowed 鈥?add
> the key pnpm prints under `allowBuilds` in the profile's `pnpm-workspace.yaml`
> and re-run.

## Development

```
src/
鈹溾攢鈹€ index.ts        plugin entry: config, wiring, command routing, lifecycle
鈹溾攢鈹€ config.ts       schemastery config schema
鈹溾攢鈹€ config-page.ts  config page (standalone local HTML form, no build step)
鈹溾攢鈹€ lark-cli.ts     lark-cli wrapper (send/patch/download/identity)
鈹溾攢鈹€ inbox.ts        generic NDJSON event consumer for a given EventKey
鈹溾攢鈹€ outbox.ts       throttling, idempotency, patch-in-place
鈹溾攢鈹€ render.ts       Feishu Card 2.0 builders
鈹溾攢鈹€ reporter.ts     session event listeners, accumulation, summary material
鈹溾攢鈹€ questions.ts    question bridge (dual-channel race)
鈹溾攢鈹€ writer.ts       turn material into copy via the model
鈹溾攢鈹€ chat.ts         chat mode engine
鈹斺攢鈹€ tools.ts        feishu_notify / feishu_summary / feishu_silence
lib/client.js       client half: the "椋炰功妗? section in dsh Settings (hand-written, no bundler)
tools/              standalone smoke-test scripts
```

### Pitfalls worth knowing

- **dsh loads TS in strip-only mode** 鈥?TypeScript parameter properties are unsupported;
  declare fields explicitly.
- **Prompt variable names must match `/^[a-z][a-z0-9_]*$/`** 鈥?one uppercase letter and
  registration throws, which propagates out of `apply()` and stops the whole plugin
  from activating.
- **An unregistered `{{variable}}` in a prompt section makes assembly throw** 鈥?that
  breaks the system prompt for *every* session, not just this plugin. Always guarantee
  the variable resolves, or substitute statically.
- **Getting a service is not synchronous** 鈥?`ctx.get('webServer')` in `apply()` often
  returns `undefined` because load order is not guaranteed. Use
  `ctx.inject(['webServer'], cb)`.
- **The client half must be resolvable by package name** 鈥?`dsh-client-modules` scans
  Loader entries and reads `dsh.client` + `exports["./client"]` from package.json.
- **Reasoning models need headroom** 鈥?`deepseek-flash` spends tokens on
  `reasoning-delta` before any `text-delta`. A low `maxTokens` yields an empty reply
  that looks like a model failure.
- **lark-cli `.ps1` wrappers corrupt stderr** on Windows, and PowerShell 5.1 strips
  JSON double quotes 鈥?call `node <cli>/scripts/run.js` with an argv array instead.

## License

MIT 鈥?see [LICENSE](LICENSE).
