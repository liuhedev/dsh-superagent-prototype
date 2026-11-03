# 009 Additional Sources

Optional DingTalk and GitLab plugins reuse the existing Source registry, admission policy, evaluator, Tickets and Outbox. They do not introduce a separate agent loop. See [006 Deployment](006-deployment.md) for worker isolation and [002 Authorization](002-authorization.md) for admission rules.

## Enable explicitly

The standard bundle and its default Sources remain unchanged. Add only the plugins you need to the profile's `cordis.patch.yml`, alongside its existing configuration:

```yaml
- insert:
    - id: dsh-superagent-dingtalk
      name: dsh-superagent/dingtalk-watch
      disabled: true
    - id: dsh-superagent-gitlab
      name: dsh-superagent/gitlab-watch
      disabled: true
```

Set a row's `disabled` to `false`, restart the profile, then configure and enable that Source in **Sources**. Each loop waits for its receiving scope and credentials. GitHub can be turned off for installations that do not use it. Start with Eval's observe mode: receiving messages does not itself authorize work. Configure the prepare command separately if workers will be used.

## DingTalk through DWS

Install and authenticate the `dws` CLI. Set `cli` and, for a non-default organization, `profile`. The same profile is used for receiving and bot commands.

- `chats`: exact `openConversationId` values to receive all group messages.
- `directMessages`: receive all private messages of the authenticated personal account.
- `mentions`: receive platform events mentioning that personal account across groups. These are analysis signals, not explicit work requests.
- `prefix`: an explicit work request must start with this prefix and its platform sender must also be in Policy's allowed-sender list. Merely typing a person's name is not a platform mention.
- `botAppId` and `robotCode`: optionally connect an enterprise robot's private-message Stream using the official `dingtalk-stream` SDK. The DWS account must have permission to read that application's credentials. Credentials are held in memory and are not included in panel settings or triggers.
- `botReplies`: allow concise answers to authenticated robot private messages. Recipient IDs come only from the callback, and chat access does not grant work execution. The evaluator must issue a reply through the existing reply tool; enabling transport does not install a chat policy.
- `replies`: optionally allow robot group replies in the configured groups. Personal-account private messages are receive-only; the adapter never replies as the personal user.

DWS personal events are live streams, with reconnect attempts and stable message IDs. There is no historical backfill, reaction/edit synchronization or gap-recovery guarantee. Robot private context contains at most 30 locally received messages / 24,000 characters. An uncertain bot send is retained and blocks another send until reconciled; API acceptance is not a delivery receipt. SDK callbacks are acknowledged only after durable ingestion. Robot group callbacks are ignored; group receiving uses DWS.

## GitLab through glab

Install `glab` and authenticate a dedicated agent account for the configured `hostname`. Set `login` to its verified username. The adapter checks the account on every polling pass.

Choose one project (`namespace/project`) or `allProjects`. Polling receives changed Issues, MRs and comments and refreshes subscribed Ticket threads. A new scope starts from a current-time baseline instead of importing historical work. In single-project mode, allowed users mentioning the configured account can request work. Account-wide mentions remain observation signals.

Account-wide mode rotates through accessible projects for pipelines, scanning at most `pipelineBatch` projects per pass with four concurrent project readers. Pipeline status changes have independent fingerprints and checkpoints; one failed project keeps its checkpoint and is retried when rotation reaches it again. This is periodic polling, not a webhook or real-time guarantee. Both modes scan project pipelines; MR head pipeline snapshots are also tracked. Pagination is bounded; errors retain uncompleted checkpoints.

Replies are off by default. When enabled, comments use a stable Outbox marker and an exact originating project; markers suppress self-generated events. A reported MR must be the originating MR or belong to the configured agent and Ticket branch in the same project. The adapter never merges MRs. Use `gitlab_project` and `gitlab_mr_iid` in the existing executor report tool, without `pr_number`.

For GitLab worker preparation, use an absolute path to the packaged `scripts/prepare-gitlab.mjs` as Execution's prepare command. It reads the declared GitLab and Ticket environment variables, verifies the account/project, and clones only that Ticket's concrete project. It sets a repository-local commit identity without changing the operator's global Git/glab configuration. The clone uses a command-scoped credential helper; no credential keys are stored in the repository, so the existing directory credential check remains effective. For authenticated pushes, use `git -c credential.helper= -c 'credential.https://<hostname>.helper=!<configured-cli> auth git-credential' push ...` with the verified configured host and CLI, rather than setting repository-local credential keys. An empty project in account-wide mode is not a write target. GitHub and GitLab Tickets retain their respective delivery workflows when both Sources are enabled.
