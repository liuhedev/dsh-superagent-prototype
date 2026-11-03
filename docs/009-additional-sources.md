# 009 Additional Sources

The optional DingTalk plugin reuse the existing Source registry, admission policy, evaluator, Tickets and Outbox. It does not introduce a separate agent loop. See [006 Deployment](006-deployment.md) for worker isolation and [002 Authorization](002-authorization.md) for admission rules.

## Enable explicitly

The standard bundle and its default Sources remain unchanged. Add only the plugins you need to the profile's `cordis.patch.yml`, alongside its existing configuration:

```yaml
- insert:
    - id: dsh-superagent-dingtalk
      name: dsh-superagent/dingtalk-watch
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
