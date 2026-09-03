# Interview Checklist — What to Ask, and What Not To

Run through this before calling `create_automation_app`. Don't guess user-specific values, and
don't ask questions the platform already answers automatically — both produce a bad experience,
in opposite directions.

## Ask these

1. **Trigger type.** Use the decision table in `create-digital-human/SKILL.md` §1. If the answer
   is WeCom or any IM channel, do **not** ask a frequency question — explain instead that
   creation needs no trigger config and that binding happens afterwards in Settings → Message
   Channels (`create-digital-human/im-triggers.md`). For `schedule`, get an explicit interval or
   cron; never assume one.
2. **External notification.** If the task needs to reliably notify someone (email/wecom/dingtalk/
   feishu/webhook, or an IM contact via `notify_bot`), **say so explicitly in `system_prompt`** —
   e.g. "when X happens, call `notify_channel` to email the result." There is no spec field that
   configures this: `output.notify` is schema-only and the runtime never reads it: delivery is
   entirely the agent's own runtime decision (`notify_channel`/`notify_bot` tool calls), not
   something `create_automation_app` sets up. Channel credentials are configured once, globally,
   in Settings — never per app. Don't ask "which channels should it push to" as if it were a spec
   field to fill in; the real answer belongs in the prompt.
3. **Desktop toast.** Don't ask about this at creation time — it isn't spec-configurable at all.
   It's a per-app **user override** (`app.userOverrides.notificationLevel`) the user sets
   afterward in that app's own Settings panel, defaulting to `'important'` (milestones/
   escalations/outputs, not every run). If they ask about it, point them there rather than
   inventing a spec field.
4. **Proactive IM push.** Does it need to message a person or group on its own initiative,
   rather than only replying? If yes → `permissions: ["im-push"]`, and tell the user it only
   works once the bot has a known contact.
5. **User-specific values** — URLs, keywords, thresholds, endpoints, target people, time
   windows. Model each as its own typed `config_schema` field instead of guessing a value or
   collapsing several preferences into one free-text field.
6. **Stakes and reversibility.** Does the task take actions that are hard to undo (approve or
   reject requests, book or cancel, send externally, delete data)? If so:
   - Keep `escalation.enabled: true` unless the user explicitly wants full autonomy.
   - Consider a report-only toggle in `config_schema` (see `auto_approve` in
     `create-digital-human/examples.md`) so autonomous action is opt-in.
   - Add an explicit "forbidden actions" section to `system_prompt` requiring confirmation for
     anything not pre-authorized by config. Don't leave it implicit.
   - Consider a per-run cap (e.g. `max_actions_per_run`) as a runaway guard.
7. **State across runs.** Must it avoid repeating work, keep history, or count failures? Ask
   *what* it should remember, then model that as `memory_schema`.
8. **Login-gated targets.** If it touches an internal system the user is normally logged into,
   add `browser_login` — never ask for a password or cookie.

## Never ask these

- **"Should it only respond when @-mentioned / to a certain prefix?"** for a WeCom group — the
  WeCom platform decides this, Halo cannot configure it. See `create-digital-human/im-triggers.md`.
- **"Which subscription type receives WeCom messages?"** — none; omit `subscriptions`.
- **Any credential, password, cookie, or session token as a config field** — use `browser_login`.
- **"Which chat or group IDs should trigger this?"** — implicit in the instance binding.
- **"Do you want web search / memory / OCR enabled?"** — always on, not permission-gated.

## Before `update_automation_app`

Always call `get_automation_status` first and read the current spec. Updates are JSON Merge
Patch: omitted fields are preserved, but wrong guesses overwrite real data. Use the `frequency`
shorthand for interval-only changes instead of rebuilding the `subscriptions` array by hand.

## Before you finish

Re-read the `system_prompt` you are about to submit and ask: if I were the runtime agent with
no other context, could I execute this end to end without improvising? The agent receives
nothing except this prompt, the user config, and its memory file. Anything you leave implicit
is a decision the agent will make differently every run.
