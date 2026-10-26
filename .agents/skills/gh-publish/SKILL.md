---
name: gh-publish
description: Must be invoked before anything is written to GitHub or pushed to it — creating or editing an issue, comment, pull request, review, release, tag, label, milestone, discussion or gist; closing, reopening, labeling or deleting issues; dispatching a workflow; or running git push. The repository is public and watched by thousands; this skill keeps sensitive information out and keeps collaborators from being disrupted.
---

# Publishing to GitHub

## Why this exists

This repository is **public**. Everything posted to it is read by thousands of
people, mailed to every watcher the moment it is created, indexed by search
engines and mirrored. **Deleting or editing does not take it back**: the emails
are already sent, edit history stays visible, and pushed commits live on in
forks and clones.

If it should not be on a public billboard, it does not go to GitHub. When in
doubt, leave it out and ask the owner.

## Know where you are writing

Check whether the target repository is public or private before writing.

- **Public**: every rule below applies.
- **Private**: internal context is allowed, but secrets still never go there.

Internal material — handoff checklists, release status, who reported what, user
follow-ups, infrastructure notes — belongs in the maintainers' private tracker
or local notes. If you do not know where that is, ask the owner. Never name or
link the private location from public content.

## Never in public

1. **Secrets**: API keys, tokens, passwords, cookies, private keys, signing
   material, connection strings; also partial keys, key prefixes, and remarks
   such as "the key was pasted in chat", which tell an attacker where to look.
2. **Internal infrastructure**: private IP addresses, internal hostnames and
   domains, ports of internal services, Wi-Fi and VPN names, build-machine and
   runner names, internal update or release servers, and file paths that reveal
   a user name.
3. **People**: real names, nicknames, IM or internal account IDs, emails and
   phone numbers of users, colleagues or customers; quotes from private chats;
   screenshots showing any of these. Write "a user reported", "a colleague".
4. **Organizations**: employer, customer and partner names, internal product
   variants and deployments, business figures. Name a third-party product only
   when the problem is about integrating with it, the way the code already does.
5. **Private repositories**: their names, addresses, commit hashes, file
   contents, build details and state.
6. **Internal process**: release schedules and approvals, handoff and to-do
   lists, who is working on what, AI conversation IDs, memory or note paths,
   planning labels, internal review reports.
7. **Security vulnerabilities**: never in a public issue; follow `SECURITY.md`.
8. **Raw logs, dumps, configs**: they carry paths, IDs, tokens and addresses.
   Quote only the lines that matter, redacted.

Public content should contain the technical problem, how to reproduce it, the
root cause in code (`file:line`), and the direction of the fix — nothing that
only makes sense to someone inside the team.

## Do not disrupt collaborators

Every action on a public repository reaches other people.

- **Notifications.** Each new issue, comment, label change, close or reopen
  notifies watchers. Do not create issues in bulk, do not post scratch notes or
  progress logs as comments, do not open and then close or delete. One
  well-formed issue beats five small ones.
- **Other people's items.** Do not close, relabel, retitle, edit or comment on
  issues and pull requests in bulk without the owner's explicit go; show the
  owner the list first.
- **Mentions and assignments.** Do not @mention, assign or request reviews from
  anyone unless the owner asked for it.
- **Shared history.** Never force-push, rebase, delete or move a shared branch
  or a tag others may have fetched. If the remote moved, rebase your local
  commits onto it and push normally. A tag you created minutes ago that nobody
  uses may be moved once; say so in your report.
- **Releases and workflows.** Creating or editing a release notifies every
  watcher; do it only on the owner's instruction. Workflow logs of a public
  repository are public, so never pass internal data as a workflow input there.
- **Pushing.** Push only what the owner authorized, to the branch they named,
  and read the commit messages being pushed against the list above.

## Before you post

1. Write the whole text first, then read it once against the eight categories
   above: every name, address, number, path and link.
2. Confirm the target repository and that the action is what the owner asked
   for.
3. Only then post it.

## If something sensitive was published

Act at once, then tell the owner plainly.

1. **Secrets: rotate first.** A leaked key is compromised the moment it is
   posted, whatever happens to the post.
2. Remove the content: delete the comment or issue. Editing is not enough,
   because the edit history stays visible.
3. Pushed commits: do not rewrite shared history yourself. Rotate any secret,
   then report to the owner; rewriting affects every collaborator.
4. Report what was exposed, where, and for how long. Notification emails cannot
   be recalled, so say so.
