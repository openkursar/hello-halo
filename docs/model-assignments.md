# Model assignments

Model assignments let you choose which configured account and model a new subagent uses, without changing the main Agent's model. You can name an assignment in a task, or explicitly enable task-based selection.

| What you do | What happens |
| --- | --- |
| Leave model assignments unconfigured | New subagents inherit their direct parent's model and effective reasoning settings. |
| Configure an assignment and keep **Inherit parent Agent** | Subagents still inherit unless you ask for a particular assignment, model, or allowed selection range. |
| Select **AI selects by task** | The AI can use your assignment purposes to choose a target, or keep the parent model. |
| Edit or remove an assignment | Future selections change; existing subagents keep their creation-time target. |

## Configure an assignment

1. Open **Settings → AI Models**. Add or sign in to the accounts you want to use first; you can also create a load-balancing group.
2. Open the chevron menu beside **Add AI Provider** (**More ways to add**).
3. Choose **Configure model assignments**. The **Model assignments** panel opens in place.
4. Choose **Configure** beside one of the three fixed tiers: **Small**, **Medium** or **Large**. The tier opens in place with its **Suitable tasks** and **Account and model**.
5. Adjust **Suitable tasks** if you want, select an account and model or a load-balancing group, then select **Save**.
6. To change a tier later, choose **Edit**. Its purpose and current target appear together; change either one and select **Save**.
7. Select **Done** to close the panel.

The tier names are organizational labels, not model ratings. You decide which targets fit them. All three tiers may remain **Not configured**; empty tiers are not used, and you do not need to fill every tier. Opening the panel or cancelling an editor does not bind a target.

The fixed tiers cannot be renamed or deleted. Use **Clear configuration** to remove a tier's target while retaining the tier and its purpose. Use **Add custom assignment** below the tiers for another named purpose, such as “Backend review.” Custom assignments can be renamed and deleted; their names must not duplicate a tier or another assignment.

Saving an assignment does not change the main model or turn on automatic selection. If saving fails, the assignment keeps its previous settings and the editor keeps your changes. If another client changed the same assignment, reopen it to edit the latest version.

## Choose how new subagents select a model

**Default selection** starts at **Inherit parent Agent**. Keep this setting if you want different models only when you request them.

To allow automatic choice, select **AI selects by task** yourself. At least one assignment must have a configured target before this option is available. Write purposes that describe the work you want each target to receive; the AI can still choose inheritance when none fits.

Examples you can give in chat:

- “Let Small extract the dates and totals, then check its results.”
- “Use Backend review to check the API changes.”
- “Use the configured GPT model for this subtask.”
- “For this task, choose only Small or Medium.”
- “For this task, have every subagent use the same model as you.”

An actual model name must identify a configured single-model assignment. If several assignments use that model through different accounts, specify the assignment or clarify which one you mean. A model listed inside a load-balancing group is not a promise to use that particular member. An empty tier does not borrow another tier's model.

Selection follows your instructions and the configured purposes; it is not a certified assessment of model ability. Naming an assignment does not add tools, permissions, skills, or a different execution engine.

## Reasoning and engine compatibility

A new subagent follows its **direct parent's** reasoning settings, including when that parent is another subagent. This also holds when it uses an assignment: Halo carries the parent's setting over to the selected target, using the closest level the target supports. Assignments and subtask requests do not set a separate reasoning effort.

The subagent keeps the parent's execution engine. Targets must be compatible with that engine:

| Engine | Target constraints |
| --- | --- |
| Halo SDK or Claude Code | Use accounts and groups supported by the selected engine and target's capabilities. CLI-delegated authentication requires Claude Code. |
| Codex | Requires a single OpenAI-compatible Chat Completions or Responses account; load-balancing groups and Anthropic accounts are not supported. |
| DeepSeek dsh | Requires its installed runtime and a compatible account or group. Available reasoning modes depend on the target and adapter. |

Unsupported targets are rejected rather than silently selecting a different engine. Provider availability and authentication still apply.

Assignments are local to the Halo installation. They are available to owner-authorized work, including the owner's remote web access, Digital Human conversations and automation. IM guests and external colleague requests do not gain access to the owner's assignment directory or model overrides; their otherwise permitted delegation continues to inherit.

## Changes, removal, and failures

- Editing a purpose, target, or name affects future selections, not existing subagents. Changing the parent's model or effort also does not retroactively change a child.
- Clearing a tier or deleting a custom assignment does not stop existing tasks. Removing the last configured target returns **Default selection** to **Inherit parent Agent**.
- Removing an account or group leaves its assignment unavailable so you can repair it. A subagent created with an assignment binding fails if that logical account or group can no longer be restored; Halo does not silently substitute the global account or a new account with the same name. This strict rule does not change older ordinary conversations' account-recovery behavior.
- A group remains a group: its existing routing and failover may select different members, and owner edits to its members can take effect. Existing bindings do not freeze its membership. Restored work must still satisfy current capabilities and permissions.
- Authentication, rate-limit, network, and provider failures use the existing task error path. Model assignments do not add automatic upgrades or retries through other assignments.
- Policy changes apply at safe session refresh boundaries rather than stopping running work. An older session may reject an override until its settings refresh; existing children are not retargeted.

## Data and cost

Subtask content is sent to the selected account's provider. With a load-balancing group, a request may go to another model or provider in that group. Choose targets whose data handling you accept.

A different model is not necessarily cheaper overall: reasoning, context, retries, and checking or redoing work all affect consumption. Higher inherited reasoning can also cost more than a model default. Usage and available estimates are not a provider invoice; missing pricing or usage does not establish zero cost, and group dollar figures may be unavailable. Model assignments do not promise improved quality or billed savings.
