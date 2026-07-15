---
description: List unfixed production errors, annotate known ones, and start fixing known root causes
argument-hint: "[env or message filter, e.g. production]"
---

Triage the openDAW production error log.

## 1. Fetch the unfixed groups

Run (add `?env=production` or `?limit=N` if `$ARGUMENTS` narrows scope):

```
curl -s "https://logs.opendaw.studio/unfixed.php" | python3 -m json.tool
```

Each row is one deduplicated issue: `error_name`, `error_message`, `occurrences`, `first_seen`, `last_seen`,
`latest_id`, `build_envs`, `ids`, and the latest `error_stack` (trimmed). It's ordered by frequency.

If `$ARGUMENTS` looks like a message substring (not an env), filter the rows to matching messages instead of
passing `env`.

## 2. Match against the knowledge base

Read `docs/error-triage.md`. For every fetched group, find its signature row (match on the message substring).
Classify each group:

- **known-fixed** — a `fixed` row exists. It is still unfixed in the DB, so it should be marked fixed (list its
  `ids`). Note the commit that fixed it.
- **root-cause-known** — a `root-cause-known` row exists but no shipped fix. Candidate to start now.
- **new / unknown** — no row. Diagnose it (step 4).

## 3. Report

Print a prioritized table: message · occurrences · last_seen · status · action. Order: root-cause-known first
(actionable), then new/unknown (needs diagnosis), then known-fixed (just mark in DB). Keep it compact.

Whenever you reference an error id in a suggested/prefilled next-prompt, append a short description in brackets
so the bare number is meaningful, e.g. `work on 1054 (regions overlap: prev.complete > next.position)` — never
`work on 1054`.

## 4. Diagnose new groups

For each new/unknown group worth pursuing, fetch a full sample (stack + captured logs) from the raw list:

```
curl -s "https://logs.opendaw.studio/list.php?offset=0&limit=40" | python3 -c "import json,sys; [print(json.dumps(r,indent=1)) for r in json.load(sys.stdin) if r['id']==<latest_id>]"
```

Grep the codebase for the thrown message / the top non-minified stack frame to locate the source. Follow the
repo's rules: find the ROOT CAUSE from evidence before proposing anything (see the CLAUDE.md workflow and the
`feedback_*` memories — no band-aids, measure the reported symptom, repro/test first). Then add an
`investigating` or `root-cause-known` row to `docs/error-triage.md` with what the evidence shows.

## 5. Start fixing (root-cause-known only)

For each group whose root cause is known and not yet shipped: propose the concrete fix (files + approach) per
the CLAUDE.md workflow ("analyze and propose, wait for approval before editing"). On approval, implement + add a
regression test, then update the `docs/error-triage.md` row to `fixed` with the commit. Do NOT commit unless
explicitly asked (see `feedback_never_commit_unprompted`).

## 6. Marking fixed in the DB

`unfixed.php` filters on `errors.fixed = 0`, so a shipped fix stays in the list until its rows are flipped to
`fixed = 1`. There is no write endpoint yet — surface the `ids` to mark and ask whether to add a `fix.php` POST
endpoint rather than assuming one exists.
