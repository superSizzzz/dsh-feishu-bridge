# dsh-feishu-bridge

English | [中文](README.md)

Working with dsh usually means sitting in front of the machine. Step away and you lose
the thread — you can't see how far it got, you can't answer the question it's stuck on,
and by the time you're back it may have been waiting on you for twenty minutes.

This plugin runs a line between dsh and a Feishu (Lark) bot. dsh reports to you in
Feishu, you reply there, and your messages land in the session so it keeps going.

## Contents

- [Install](#install)
- [When it talks](#when-it-talks)
- [What it looks like](#what-it-looks-like)
- [Configure](#configure)
- [Feishu commands](#feishu-commands)
- [Chat mode](#chat-mode)
- [The question bridge](#the-question-bridge)
- [Permissions](#permissions)
- [Uninstall](#uninstall)
- [FAQ](#faq)
- [Hacking on it](#hacking-on-it)
- [License](#license)

## Install

```powershell
dsh plugin --profile web add github:superSizzzz/dsh-feishu-bridge
```

One command. dsh reads the package's `dsh.bundle.patch` and folds it into the current
profile, so there's no config file to write by hand.

Then one more step: **send the bot a message in Feishu.**

That's how it learns who you are. It reads your open_id off that message and only ever
serves you. Feishu scopes open_id per app, so there is nowhere to copy it from — letting
the plugin claim it is both easier and less likely to be wrong.

| | Requirement |
|---|---|
| dsh | >= 0.1.7-rc.2 |
| Node | >= 22 |
| lark-cli | installed globally, see below |
| Feishu app | your own, with `im:message` + `im:message:send_as_bot` |

If you don't have a Feishu app yet:

```bash
npm i -g @larksuite/cli
lark-cli config init --new --name dsh-bridge
```

The browser walks you through creating one. Then in the open platform give it two
permissions (`im:message`, `im:message:send_as_bot`) and subscribe (under
**event subscriptions**) to `im.message.receive_v1` in **long-connection mode** — that
mode needs no public URL and opens no port.

For card buttons, add `im:message:readonly` and `card.action.trigger`. Without them
everything still works, the buttons just don't respond.

Install it once per profile; swap the name after `--profile`.

### Or have an agent do it

Paste this to your dsh agent:

```text
Install the dsh-feishu-bridge plugin on this machine (a two-way bridge between dsh and a Feishu bot).

Repo: https://github.com/superSizzzz/dsh-feishu-bridge

1. Install it into the web profile with this one command:
     dsh plugin --profile web add github:superSizzzz/dsh-feishu-bridge
   It forwards to pnpm and registers the plugin's bundle layer in the profile
   automatically — no need to clone the repo, no need to edit any config file.
2. Check the prerequisite: lark-cli is installed and
     lark-cli --profile dsh-bridge whoami
   returns an appId. If that profile does not exist yet, stop and tell me —
   creating a Feishu app is something I have to click through myself.
3. Restart dsh so the plugin loads.
4. Report three things: whether the plugin loaded (check ~/.dsh/dsh-feishu-bridge/boot.log),
   whether a "飞书桥" section shows up in dsh Settings, and what I need to do in Feishu next.
```

## When it talks

By default it speaks at three moments. Everything in between is quiet.

**The moment you give it work, it says what it's about to do.** No judgement involved —
this one is fixed, every time.

**When a stage produces a result, it reports.** This one accumulates: thinking is
buffered, and only once there is something worth saying does it ask the model one
question — *what did this stage actually get done?* An answer of `NONE` means keep
buffering.

The reason for the indirection: reporting sentence by sentence turns into noise. A
stream of "looking at this file" / "now editing that function" is just the terminal log
relocated into Feishu. So the bar is fixed and narrow — **it only reports finished
work**. "I'm about to…" and "next I'll…" don't count. If nothing got done, it stays
quiet and saves it for later.

**When the work is over, it sends a summary.** What it did, which files it touched, how
many lines went in and came out.

Want it chattier? Set `turnPush` to `always` and it reports every turn.

Want it quiet for a while? Send `/mute` in Feishu. Want it properly off? Set `enabled`
to `false`.

## What it looks like

Feishu gets cards. Below is the structure from a real run (the body is model-written, so
wording varies; paths and content are generalised):

```text
┌────────────────────────────────────────────┐
│ What this stage got done · turn 12          │
│ (bot name)                                  │
├────────────────────────────────────────────┤
│ workspace  ~/projects/my-app                │
│ session    #A3F2  fix image upload · turn 12│
├────────────────────────────────────────────┤
│ All three bugs in the image path are        │
│ located: the data is under data.messages,   │
│ not items; the resource key is embedded in  │
│ text as [Image: img_v3_...]; and --type is  │
│ a required flag that --help never lists.    │
│ The download step is verified working.      │
└────────────────────────────────────────────┘
```

The wrap-up adds a change list:

```text
┌────────────────────────────────────────────┐
│ Work summary                                │
│ (bot name)                                  │
├────────────────────────────────────────────┤
│ workspace  ~/projects/my-app                │
│ session    #A3F2  fix image upload          │
│ elapsed    17:35 → 17:50 · 6 turns · 216 calls│
├────────────────────────────────────────────┤
│ The image upload path now works end to end. │
│ Three separate problems — a wrong field, a  │
│ key hidden in text, and an undocumented     │
│ required flag — are all fixed, with the     │
│ download step verified.                     │
│                                             │
│ Files touched (2 files  +111 −0)            │
│   src/upload.ts           +58 −0            │
│   src/types.ts            +53 −0            │
└────────────────────────────────────────────┘
```

The short code on the session line (`#A3F2`) is the routing identity — `/use` switches
targets by it. The title after it is for humans. The title comes from dsh's title
service when available, otherwise from the first few words you sent.

## Configure

Two entry points, same config underneath, use whichever.

**dsh Settings** (recommended): open Settings and there's a **飞书桥** section in the
left nav. Four things to change — which bot, who's bound, which model chat mode uses,
and the persona.

**Or open it in a browser:**

```
http://127.0.0.1:3080/feishu-bridge/config
```

That's dsh web's port; substitute yours if you changed it.

Saving takes effect immediately, no restart. Behaviour switches (`turnPush`,
`thinkingJudge`, and friends) stay out of the UI — they're install-time decisions. To
change one, add an entry to your own patch:

```yaml
- id: feishu-bridge
  config:
    turnPush: always
    thinkingJudge: false
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `profile` | `dsh-bridge` | which lark-cli profile; an app id works too |
| `userId` | `''` | delivery target. **Leave it empty** — the first message claims it |
| `promptSection` | `true` | write a "you can use feishu_notify" section into the system prompt |
| `openPush` | `true` | say what it's about to do; fixed action |
| `turnPush` | `judge` | per-turn policy: `judge` / `always` / `changes` / `off` |
| `thinkingJudge` | `true` | judge each stage for a result worth reporting |
| `pendingMinChars` | `400` | how much text to accumulate before asking the model |
| `summaryPush` | `true` | the wrap-up summary |
| `writerEnabled` | `true` | copy is model-written, not templated |
| `persona` | 女高中生 | the voice it speaks in |

## Feishu commands

Send these in Feishu and they're treated as commands.

| Command | Does |
|---|---|
| `/help` | command list |
| `/status` | current binding, target, mode |
| `/list` | sessions seen so far, with short codes and titles |
| `/use <code>` | switch which session gets delivery |
| `/stop` | interrupt the running agent |
| `/mute` `/unmute` | quiet for now / resume |
| `/chat` `/work` | chat mode / back to work |
| `/polish <text>` | rewrite a passage in the configured persona |
| `/config` | view or change runtime config |
| `/forget` | clear chat history |

Anything that isn't a command goes straight into the session, the same as typing at the
machine.

Images work too — it downloads them and hands them to the attachment service, so the
model can see them.

## Chat mode

After `/chat`, Feishu becomes an ordinary chat window: it talks to the model and
**never touches dsh** — no session, no tools, no workspace. `/work` goes back.

It uses your dsh key. The model is changeable in the settings page.

History persists locally, but the **mode doesn't** — restarting dsh returns you to work
mode. That's deliberate: you shouldn't end up chatting with a bot that isn't doing
anything and not know it.

## The question bridge

When dsh needs to ask you something (`ask_user_question`), the plugin does two things at
once: it pushes the question to Feishu as a card, and **the web side keeps waiting**.

Whichever you answer first wins. Answer in Feishu and the web prompt gets dismissed;
answer on the web and the Feishu card is edited to say it was answered there.

The point is not losing either end: answering at the desk is fastest, answering from a
phone is sometimes the only option. If neither side answers (5 minutes by default), it
behaves as if you never replied and moves on — it won't leave the agent hung.

Card options are tappable buttons; one tap sends the answer back.

## Permissions

| | |
|---|---|
| Feishu scopes | only `im:message` and `im:message:send_as_bot` |
| Feishu events | only `im.message.receive_v1` (plus optional `card.action.trigger`) |
| Network listening | **no new port**. The config page reuses dsh's own HTTP server |
| Outbound | Feishu, and the model provider you configured |
| Disk | only `$DSH_HOME/dsh-feishu-bridge/` (state file and log) |
| Telemetry | none. There is no analytics code in this repo |

One thing worth stating plainly: every message pushed to you (opening report, stage
summary, wrap-up, chat) **is written by the model**, so session content goes to your
model provider with those requests. Know that before installing.

On the Feishu side it touches no contacts, no docs, no calendar. open_id is scoped per
app, so the plugin can only ever see people who have messaged this bot.

## Uninstall

```powershell
dsh plugin --profile web remove dsh-feishu-bridge
```

State lives in `$DSH_HOME/dsh-feishu-bridge/`; delete that directory to clean up
entirely. The Feishu app and its permissions are yours to deal with in the open
platform — the plugin has no say there.

## FAQ

**Installed, but nothing happens?** Send the bot a message first. Until it's claimed you
it doesn't know where to deliver, so it stays quiet.

**Messages get no response?** Check `$DSH_HOME/dsh-feishu-bridge/boot.log` — startup
self-checks land there. Also note that when two dsh instances run on one machine, only
one of them receives Feishu messages (chosen by a pid lock); the other only reports
local sessions.

**Console windows popping up on the desktop build?** Older versions did; it's fixed.
The cause wasn't dsh — lark-cli's `scripts/run.js` is just a forwarder, and when it
calls the native binary internally it doesn't pass `windowsHide`. You never notice in a
terminal; on desktop there's no console, so that child process has to create one. It now
calls the native binary directly. Upgrade and it's gone.

**Edited the source and nothing changed?** Plugin code isn't hot-reloaded. Restart dsh.

**Want to rename the bot?** Do it in the open platform. The plugin asks for the current
name at startup and puts it into the prompt.

## Hacking on it

```
src/
├── index.ts        plugin entry: config, wiring, command routing, lifecycle
├── config.ts       schemastery config schema
├── config-page.ts  config page (standalone local HTML form, no build step)
├── lark-cli.ts     lark-cli wrapper (send, download, identity)
├── inbox.ts        generic NDJSON event consumer for any EventKey
├── outbox.ts       throttling, idempotency, patch-in-place
├── render.ts       Feishu Card 2.0 builders
├── reporter.ts     session event listeners, accumulation, summary material
├── questions.ts    question bridge (dual-channel race)
├── writer.ts       turn material into copy via the model
├── chat.ts         chat mode engine
└── tools.ts        feishu_notify / feishu_summary / feishu_silence
lib/client.js       the client half: the "飞书桥" section in dsh Settings. Hand-written, no bundler
tools/              standalone smoke-test scripts
```

Things we stepped on, so you don't have to.

**dsh loads TS in strip-only mode** — TypeScript parameter properties
(`constructor(private readonly x: T)`) aren't supported. Declare fields explicitly, or
the plugin silently fails to load.

**Prompt variable names must match `/^[a-z][a-z0-9_]*$/`.** I wrote `feishuBotName`,
uppercase letters and all, and registration threw on the spot. That error propagates out
of `apply()`, so **the whole plugin fails to activate** — not just the prompt section.

**An unregistered `{{variable}}` in a prompt section makes assembly throw.** That
breaks the system prompt for *every* session, not just this plugin. Either guarantee the
variable resolves, or substitute it statically at registration time.

**Getting a service is not synchronous.** `ctx.get('webServer')` in `apply()` often
returns `undefined` because load order isn't guaranteed. Use
`ctx.inject(['webServer'], cb)` and wait for it.

**The client half must be resolvable by package name.** `dsh-client-modules` scans
Loader entries by package name and reads `dsh.client` plus `exports["./client"]` from
package.json. A `file:///` entry isn't picked up.

**Leave headroom for reasoning models.** `deepseek-flash` spends tokens on reasoning
before writing anything, so a small `maxTokens` gives you an empty reply that looks like
a broken model. Start at 3000.

**Don't batch-edit UTF-8 files with PowerShell's `Get-Content`/`Set-Content`.** PS 5.1
reads as ANSI by default, so Chinese text is already mojibake on the way in, and
`-Encoding UTF8` only covers the write side. I destroyed a README this way. Use an
editor or a file API.

## License

MIT, see [LICENSE](./LICENSE).
