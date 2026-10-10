---
summary: "How active-run steering queues messages at runtime boundaries"
read_when:
  - Explaining how steer behaves while an agent is using tools
  - Explaining why steering does not cancel an already-running tool
  - Changing active-run queue behavior or runtime steering integration
  - Comparing steering with followup, collect, and interrupt queue modes
title: "Steering queue"
---

When a normal prompt arrives while a session run is active and the queue mode is `steer` (the default, no config needed), OpenClaw tries to send that prompt into the active runtime, including during tool execution. OpenClaw and the native Codex app-server harness implement the delivery details differently.

This page covers queue-mode steering for normal inbound messages in `steer` mode. In `followup` or `collect` mode, normal messages skip this path and wait until the active run finishes. For the explicit `/steer <message>` command, see [Steer](/tools/steer).

An older followup does not disable steering for later input. OpenClaw tries each new steer against the active run after earlier steering attempts settle. Messages that the runtime declines remain queued in their original order; accepted steering goes to the active turn.

## Runtime boundary

Ordinary steering does not cancel or skip tools. The OpenClaw runtime consumes
queued messages at the next model boundary:

1. The assistant asks for tool calls.
2. Those calls run under the existing sequential or parallel policy. Tool validation,
   approvals, execution authority, and explicit cancellation still apply.
3. Tool results are appended in assistant source order.
4. OpenClaw drains queued steering messages and appends them before the next LLM call.
5. Pending steering takes precedence over normal finalization, so a supplemental
   message does not need a separate followup run.

The model sees completed tool results followed by the user's new input. A correction
sent as ordinary steering may arrive too late to change this response's tool calls.
Use `/stop` or interrupt mode when existing work must stop rather than finish first.

Internal updates, including subagent completion reports, also reach the next model
boundary without canceling current tool calls. These updates can be hidden from
the chat transcript and do not appear in the user message queue.

The native Codex app-server harness exposes `turn/steer` instead of OpenClaw runtime's internal steering queue. OpenClaw batches queued prompts for the configured quiet window, then sends a single `turn/steer` request with all collected user input in arrival order. Codex's upstream turn scheduler owns its tool scheduling and drains pending input at model boundaries; OpenClaw does not add per-tool preemption to that runtime. A transcript commit confirms persistence, not that a later model request has read the input.

Codex review and manual compaction turns reject same-turn steering. When a runtime cannot accept steering in `steer` mode, OpenClaw waits for the active run to finish before starting the prompt.

Once an OpenClaw turn has finished or handed off, new prompts wait for the next turn even while cleanup is still running. Retries and compaction within the current turn can still receive steering.

## Tool launch boundaries

Tool launch still enforces approvals, argument validation, and current execution
permission. A queued steer is not a launch rejection. Neither sequential tails nor
prepared parallel calls receive synthetic errors merely because new input arrived.
Explicit Stop, cancellation, and admission failures retain their existing behavior.

The transcript remains append-only and structurally paired: assistant tool calls,
actual results (or genuine rejection/cancellation results), then the steering user
message. Executed work is not replayed just to deliver a steer.

## Modes

| Mode        | Active-run behavior                                    | Later behavior                                                                      |
| ----------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `steer`     | Steers the prompt into the active runtime when it can. | Waits for the active run to finish if steering is unavailable.                      |
| `followup`  | Does not steer.                                        | Runs queued messages later after the active run ends.                               |
| `collect`   | Does not steer.                                        | Coalesces compatible queued messages into one later turn after the debounce window. |
| `interrupt` | Aborts the active run instead of steering it.          | Starts the newest message after aborting.                                           |

## Burst example

If four users send messages while the agent is executing a tool call:

- OpenClaw preserves the runtime's configured steering drain mode and FIFO order. One-at-a-time consumers keep later messages for later boundaries; `all` consumers inject the queued FIFO batch together. Codex receives messages collected during its quiet window as one batched `turn/steer`.
- With `/queue collect`, OpenClaw does not steer. It waits until the active run ends, then creates a followup turn with compatible queued messages after the debounce window.
- With `/queue interrupt`, OpenClaw aborts the active run and starts the newest message instead of steering.

## Scope

Steering always targets the current active session run. It does not create a new session, change the active run's tool policy, or split messages by sender. In multi-user channels, inbound prompts already include sender and route context, so the next model call can see who sent each message.

Visible user turns started through the `agent` RPC can also receive compatible
steering. Channel input, including Telegram, resolves the same admitted direct-run
owner as Control UI input. The captured owner supplies its original source identity;
unrelated terminal receipts do not make a current turn unsteerable.

A direct peer continuation started by `sessions_send` can yield to authenticated
human input that cannot share its permissions or reply contract. This is an ordered
handoff, not a permission upgrade or interrupt: already-started tools finish, their
results commit, and the peer turn stops before its next model request. Its resources
settle before the queued human turn runs with its own authority and reply destination.
The incoming message stays in FIFO followup custody and completed tools are not
replayed. Once that logical run has already accepted human input, it retains the
required-answer responsibility through retries and finishes normally rather than
yielding it away. Read-only or unverified input cannot request this handoff; subagent
sessions, hidden coordination, and other background sources do not acquire this capability.

Other direct background turns with optional replies leave new human messages queued
for a followup turn that can provide the required answer.

Different signed-in people with the same permissions can steer each other's
active turn, including from different browsers or after reconnecting. The turn
keeps its original owner's authority, tool bindings, and approval destination.
Personal tools (`screen` and `theme`) act for one named person. When several
people have steered the turn, the agent must pass that person's verified
`requester_profile.id` as `user` to choose whose view or appearance to change,
and ask if it is unclear. Each authenticated Control UI message includes its
requester's verified profile id in the agent's user-role conversation context.
Personal instructions and other personal settings without a `user` selector
cannot be read or changed from a turn several people have steered. The person
should ask in their own turn with a new Control UI message. For Crabbox open-and-show requests in a
mixed-person turn, create the environment without `presentation`, then use
`screen` with `desktop_show` or `portal_show`, its `environmentId`, and the
requester's `requester_profile.id` as `user`.
Different permissions (role scopes, session access cap, sandbox requirement,
allowed agents, model access, access grant, or tool policy) queue the message as
a followup; changes to execution policy, workspace, or bound tools can also
require a followup.

Automatic credential rotation and model fallback also retain the active turn.
New input can steer that turn while the selected model remains unchanged, fallback
is still allowed, and the current permissions match. Selecting or locking a model,
pinning a different account, or changing tool permissions can require a followup
turn. Answers to a pending question still go to the question's original owner.

[Personal `USER.md` context](/concepts/user-model#personal-user-files-on-a-shared-gateway)
follows the session's assigned human owner, otherwise its authenticated human
creator. Another participant with the same permissions can steer without switching
that personal context, and collected messages keep the same session selection. Reassignment
takes effect on the next new turn; it does not replace the running turn's personal
instructions. Personal context selection does not grant tool permissions or
change the approval destination.

A visible message or send acknowledgment does not mean the active runtime has
consumed it. The Control UI shows specific notices when an accepted message is
waiting for worker setup or workspace sync.
Messages waiting for a followup turn appear in the queue above the composer,
including when the Gateway queues a message that could not be steered. They stay
there across reconnects until consumed or canceled, without being sent again.

Use `followup` or `collect` when you want messages to queue by default instead of steering the active run. Use `interrupt` when the newest prompt should replace the active run.

## Canceling a pending steer

An authorized Gateway client can withdraw a message still waiting in the OpenClaw
runtime's steering queue, before delivery starts, with `chat.abort({ sessionKey,
runId })`. Use the `runId` returned by that message's `chat.send`. This withdraws
that message without stopping the active run or retrying it as a followup.

Once delivery starts, cancellation cannot guarantee withdrawal or undo completed
work. If delivery cannot be confirmed, the existing steering safeguards can stop
the active run to avoid replaying input whose consumption is uncertain.

## Debounce

The built-in queue debounce applies to queued `followup` and `collect` delivery. In `steer` mode with the native Codex harness, it also sets the quiet window before sending batched `turn/steer`. OpenClaw active steering does not use the debounce timer; at model boundaries it drains FIFO according to the runtime's configured steering drain mode.

## Related

- [Command queue](/concepts/queue)
- [Steer](/tools/steer)
- [Messages](/concepts/messages)
- [Agent loop](/concepts/agent-loop)
- [Codex harness runtime](/plugins/codex-harness-runtime) - `turn/steer` behavior on the native Codex harness
