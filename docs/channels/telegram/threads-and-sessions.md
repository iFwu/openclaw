---
summary: "Forum topic session keys, topic config inheritance, per-topic agents, and ACP bindings"
read_when:
  - Routing a forum topic to its own agent
  - Working out a Telegram session key for a topic
  - Binding an ACP harness session to a topic
title: "Telegram threads and sessions"
sidebarTitle: "Threads and sessions"
---

How forum topics map to sessions, agents, and ACP bindings.

## Forum topics and sessions

<AccordionGroup>
  <Accordion title="Forum topics and thread behavior">
    Forum supergroups: topic session keys append `:topic:<threadId>`; replies and typing target the topic thread; topic config path is `channels.telegram.groups.<chatId>.topics.<threadId>`.

    General topic (`threadId=1`) is a special case: message sends omit `message_thread_id` (Telegram rejects `sendMessage(...thread_id=1)` with "thread not found"), but typing actions still include `message_thread_id` (empirically required for the typing indicator to appear).

    Topic entries inherit group settings unless overridden (`requireMention`, `requireMentionInBotThreads`, `allowFrom`, `skills`, `systemPrompt`, `enabled`, `groupPolicy`). `agentId` is topic-only and does not inherit from group defaults. `topics."*"` sets defaults for every topic in that group; exact topic IDs still win over `"*"`.

    **Per-topic agent routing**: each topic can route to a different agent via `agentId` in the topic config, giving it its own workspace, memory, and session:

    ```json5
    {
      channels: {
        telegram: {
          groups: {
            "-1001234567890": {
              topics: {
                "1": { agentId: "main" },      // General topic -> main agent
                "3": { agentId: "zu" },        // Dev topic -> zu agent
                "5": { agentId: "coder" }      // Code review -> coder agent
              }
            }
          }
        }
      }
    }
    ```

    Each topic then has its own session key, for example `agent:zu:telegram:group:-1001234567890:topic:3`.

    **Persistent ACP topic binding**: forum topics can pin ACP harness sessions through top-level typed bindings (`bindings[]` with `type: "acp"`, `match.channel: "telegram"`, `peer.kind: "group"`, and a topic-qualified id like `-1001234567890:topic:42`). Currently scoped to forum topics in groups/supergroups. See [ACP Agents](/tools/acp-agents).

    **Thread-bound ACP spawn from chat**: `/acp spawn <agent> --thread here|auto` binds the current topic to a new ACP session; follow-ups route there directly, and OpenClaw pins the spawn confirmation in-topic. Controlled by `session.threadBindings.spawnSessions` (default: `true`).

    Startup waits for stored thread bindings before accepting updates. Shutdown drains accepted binding changes before a replacement bot reloads them. Bundled Telegram handlers persist bindings through the shared SQLite worker so storage does not block message handling. Deprecated synchronous Plugin SDK touch and lifecycle setters keep their immediate behavior on the same binding owner until the next SDK major.

    Disabling `threadBindings.enabled` globally, for Telegram, or for one account leaves ordinary Telegram messages working.

    Template context exposes `MessageThreadId` and `IsForum`. DM chats with `message_thread_id` keep reply metadata but only use thread-aware session keys when Telegram `getMe` reports `has_topics_enabled: true`.
    The retired `dm.threadReplies` and `direct.*.threadReplies` overrides are gone; BotFather threaded mode is the single source of truth. Run `openclaw doctor --fix` to remove stale config keys.

    In threaded DM mode, task handoffs and continuations must retain the exact existing topic session. `sessions_send` supports these private-topic sessions without replacing them with a parent private-chat session. A topic's transcript, model selection, and task ownership remain separate from its parent. A notification sent without a topic does not establish a user-accessible task conversation or authorize waking that parent session.

  </Accordion>
</AccordionGroup>

## Bot-created forum topics

Set `requireMentionInBotThreads` on a group or topic to override mention gating only in forum topics created by the receiving bot. `false` allows unmentioned messages to start turns there; `true` requires a mention, including for replies to the bot. Omission preserves existing behavior. A topic setting wins over the selected group setting. The same paths are available under `channels.telegram.accounts.<accountId>.groups`.

OpenClaw records the creator from an observed `forum_topic_created` service message or from a successful topic creation by the bot. Ownership is specific to that bot: another bot's topic or a human-created topic keeps its ordinary mention policy. Replying in a topic does not make the bot its creator.

Topic ownership persists alongside topic names in the existing cache, which retains up to 2,048 recently used topics. Topics created before OpenClaw observed them and evicted entries keep the ordinary mention policy. Telegram does not provide a topic-owner lookup to recover those facts. This setting does not change DM topics, authorization, group silence policy, or visible-reply policy. See [Mention behavior](/channels/telegram/access-control#access-control-and-activation) for configuration and Telegram visibility requirements.

## Automatic task segmentation (Jev)

Set `autoNewSession: true` on an explicitly selected Telegram group to evaluate
whether an incoming user request is independent of the current task. A topic can
set its own boolean override; omission inherits the group setting. The same paths
are supported under `channels.telegram.accounts.<accountId>.groups`. Wildcard
chat entries cannot enable this feature. To enable an explicit private chat, set
`channels.telegram.direct.<userId>.autoNewSession`; a DM topic may override it via
`direct.<userId>.topics.<topicId>.autoNewSession`. Account-scoped `direct` entries
work the same way. Wildcard direct entries and their topics cannot enable this
feature. DM evaluation is not enabled by group settings.

```json5
{
  channels: {
    telegram: {
      groups: {
        "-1001234567890": {
          autoNewSession: true,
          topics: { "7": { autoNewSession: false } },
        },
      },
    },
  },
}
```

Jev evaluates the current message, quote/reply context, bounded room context,
and the six most recent user/assistant transcript messages before the main model
loads its conversation. Quoted notifications can define self-contained new tasks;
shared vocabulary or a long time gap alone does not imply a new task.

The evaluator uses `https://api.typesafe.ai/v1/systemone`, model `jev-1.13.0`,
and `TYPESAFE_API_KEY_FILE` (preferred) or `TYPESAFE_API_KEY`. Opt-in sends this
bounded conversation data to TypeSafe. A dependency probability at or below 0.2
starts a clear-context reset boundary; at or above 0.8 continues the task;
intermediate scores keep the existing context. HTTP failure, malformed responses,
missing credentials, and the four-second evaluator timeout keep the existing context.

Commands, internal turns, bot messages, locked/native model sessions, active work,
pending approvals/questions, and unsettled child work are protected. A decision
must still match the session identity, lifecycle revision, and reply owner before
committing through the native reset owner. Segmentation retains transcript history
and session identity, clears the active context, and does not impersonate `/new`
or change routing, mention requirements, or visible-reply policy.

A committed segmentation requests one persistent status notice before model output:
`↪ 已按新话题处理，未携带上一段对话`, followed by the resolved provider/model
and thinking level when a model will run. A later runtime fallback may select a
different backend. Diagnostics record IDs, safe reasons, timings, and delivery
outcomes, not conversation bodies or credentials.
