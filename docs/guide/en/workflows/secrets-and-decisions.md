---
title: Hand over credentials and decide on the phone
description: Let the AI use a credential it can never read, and turn a choice into a phone page that returns JSON
doc_type: how-to
module: Human in the loop
audience: Developers delegating work to an AI in a remote session
updated_at: 2026-09-20
source_evidence: [E002, E005, E006, E011]
prerequisites:
  - mp installed, mp doctor reports ok four times
  - Your phone can open trycloudflare.com links
related:
  - ../reference/commands.md
  - ../troubleshooting.md
source_anchors:
  - path: src/usage.js
    fingerprint: sha256:4a1b564592bd5b27
---

# Hand over credentials and decide on the phone

Both problems share a root: the AI needs input from you, and a chat box is the worst place to
put it. Passwords end up in the transcript, and a choice turns into a screen of prose.

## Prerequisites

- `mp` installed, `mp doctor` reports `ok` four times
- Your phone can open `trycloudflare.com` links

```mermaid
flowchart LR
  A[AI needs a credential] -->|mp secret ask| B[a form on the phone]
  B -->|you fill it in| C["values live in daemon memory only"]
  C -->|mp secret run| D["the command runs with them<br/>output comes back redacted"]
  C -.->|AI cannot read them| E["mp secret status<br/>names and fingerprints only"]
```

## Handing a credential to the AI

Start: a terminal in your project, with the AI having told you which command it wants to run.

1. Open a form:
   `mp secret ask --purpose "deploy needs cloud AccessKey" --field AK --field SK --use "npm run deploy"`.
2. Send the printed link to your phone and fill it in. Every command declared with `--use` is
   ticked off by you on the phone.
3. Run `mp secret wait` until the phone submits.
4. Run `mp secret run -- npm run deploy`. The values arrive as environment variables and the
   output comes back redacted.
5. Run `mp secret forget --all` when you are done.
   - Expected: it prints `forgot 1 secret slot(s)` and the values leave memory (evidence E011).

`mp secret status` only ever lists field names, approved uses and remaining time — **never
values**. Values stay in memory for 120 minutes by default, and the form link stays open for 30.

## Turning a choice into a page

Start: a decision that is yours to make, with more than two options or something to compare.

1. Write a self-contained HTML file: one file, no external resources, no `<form action>`.
2. Give each control a `name` and the submit button `data-mp-submit`. Add a second button
   carrying `data-mp-disposition="needs_clarification"` so you can answer that the question
   itself is wrong.
3. Run `mp interaction ask --purpose "which environment" --html ask-env.html`.
4. Send the link to your phone and submit your choice.
5. Run `mp interaction wait` to collect the answer, printed as JSON.
   - Expected: before the phone submits it prints
     `i-xxxxxx: still waiting — the link is open for 30 more min.` and exits 0; a timeout is
     not a failure (evidence E011).

The page is checked before any link is issued, and a page that fails is refused:

```text
$ mp interaction ask --purpose "which environment" --html ask-env.html
ask-env.html does not meet the interaction page contract:
  - nothing carries `data-mp-submit`, so the page has no way to submit
```

That refusal is real output (evidence E011). The full page contract is in
`docs/superpowers/specs/2026-09-16-interaction-page-contract.md`.

## When several are open at once

`secret` and `interaction` both take a slot keyed by a random id. With one slot left open,
`wait` / `forget` / `close` need no `--id`; past one they refuse to guess and print
`several interactions are open (i-2b944d, i-f1ed0b); pass --id.`

## Verify

`mp secret status` lists slots, field names and remaining time and contains no values.
`mp interaction status` lists open questions, their stage and how much is filled in. Both
lists are empty after `forget --all` and `close --all`.

## If it fails

When the link never comes out, the tunnel is the usual cause rather than the command; the fix
is the same as for previews, see [Troubleshooting](../troubleshooting.md).

When a page is refused, the command lists each failing rule. Fix them and run it again —
nothing goes live, so no half-built link escapes.
