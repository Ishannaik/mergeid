# Glossary

Definitions are plain-English and Discord/GitHub specific where the project
uses them.

- **Audit log**: append-only record of who changed what, used for security
  review and debugging.
- **Bot token**: secret credential that identifies the bot to Discord; it must
  never be committed or shared.
- **DM**: direct message between the bot and one user, often used for ephemeral
  results.
- **Ephemeral message**: a Discord message only the invoking user can see; it
  disappears when they leave the interaction.
- **GitHub App**: GitHub integration with its own identity, permissions, and
  installable scope.
- **Guild**: Discord's term for a server; the container for channels, roles,
  and members.
- **Least privilege**: giving each credential or permission only what it needs.
- **OAuth scope**: a named permission an OAuth grant requests on behalf of a
  user or installation.
- **PAT**: Personal Access Token; a GitHub credential with a defined scope and
  expiry.
- **Rate limit**: server-enforced cap on how often a client may call an API.
- **Read-only**: permission to view data without mutating it.
- **Revocation**: invalidating a credential, session, or grant so it can no
  longer be used.
- **Role hierarchy**: Discord's ordering of roles; higher roles can generally
  manage lower ones.
- **Session**: a short-lived authenticated context established after login.
- **Slash command**: a Discord interaction invoked with `/`; the bot receives a
  structured payload instead of parsing free text.
- **Snowflake**: Discord's numeric ID for users, guilds, channels, and messages.
- **Webhook**: an HTTP callback that pushes an event to a URL instead of being
  polled.
