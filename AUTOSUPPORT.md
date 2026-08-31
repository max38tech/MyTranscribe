# AutoSupport

This repo was set up with [AutoSupport](https://github.com/) Level 1: an
installable, GitHub-native support pipeline. This file explains what
`autosupport init` put in place and what you still need to do by hand.

## What got installed

```
.autosupport/
  config.yml              pipeline configuration - read this first
  prompts/                system prompts the three workflows send to Claude
    triage.md
    fix.md
    respond.md
    chat.md                not run automatically yet - see "Converse", below
  knowledge/               empty for now - see "Learn", below
  scripts/
    triage.mjs
    fix.mjs
    respond.mjs
    lib/                   shared helpers (config, Claude client, gh/git
                            exec wrapper, envelope extraction, untrusted-
                            content prompt framing) - node:builtins only,
                            no npm install
.github/
  ISSUE_TEMPLATE/
    bug_report.yml
    feature_request.yml
    config.yml              disables blank issues, links to Discussions
  workflows/
    autosupport-triage.yml   runs on every new issue labeled "autosupport"
    autosupport-fix.yml      runs when triage adds "autosupport:auto-fix"
    autosupport-respond.yml  runs on issue close, or "autosupport:respond"
AUTOSUPPORT.md            this file
```

## Finish setup

1. **Add the `ANTHROPIC_API_KEY` repo secret.** Settings -> Secrets and
   variables -> Actions -> New repository secret. All three workflows need
   it; without it every run fails immediately (and cheaply - it fails before
   any other work happens).
2. **Create the labels** the workflows key off of, if they don't already
   exist: `autosupport`, `autosupport:auto-fix`, `autosupport:respond`,
   `bug`, `enhancement`, `support`, `duplicate`, plus `severity:critical`,
   `severity:high`, `severity:medium`, `severity:low`. Triage creates
   `severity:*` and `duplicate` labels on issues it edits, but GitHub only
   applies a label if it already exists in the repo - create them once up
   front (`gh label create ...` or the repo's Labels page).
3. **Allow Actions to write and to open pull requests.** Settings -> Actions
   -> General -> Workflow permissions: select **Read and write permissions**
   and tick **Allow GitHub Actions to create and approve pull requests**.
   The fix workflow pushes a branch and opens a PR with the built-in
   `GITHUB_TOKEN`; with the default read-only setting it runs, calls the
   model, produces a perfectly good patch, and then fails at the last step.
   Triage and respond only need `issues: write`, so they will appear to work
   while fix quietly does not - which makes this the most confusing thing to
   discover late.
4. **Review `.autosupport/config.yml`.** It was written from what you told
   `autosupport init` (app id, name, repo, platforms) plus every policy
   value written out explicitly. In particular check `policy.bug.auto_fix`
   and `policy.bug.require_approval` - together they decide whether a
   detected bug gets an automatic draft PR at all, and whether that PR is a
   draft awaiting your review (recommended) or opened ready-to-merge.
5. **Commit and push** `.autosupport/`, `.github/`, and this file if your
   copy of AutoSupport didn't do that for you. Workflows only fire on issue
   events once they exist **on the repository's default branch** - issue
   events are repo-scoped, not branch-scoped, so a workflow sitting on a
   feature branch will never run no matter how the issue is labelled.
6. **Enable Discussions** on the repo if you want the "Contact support" link
   in the issue picker to go anywhere (`.github/ISSUE_TEMPLATE/config.yml`
   points at it unconditionally).

## The six stages, and what Level 1 actually runs

| # | Stage    | Where it runs      | Level 1 status |
|---|----------|---------------------|----------------|
| 1 | Ingest   | your app -> GitHub  | built (in your app, via `@autosupport/core`) |
| 2 | Triage   | GitHub Actions       | built - `autosupport-triage.yml` |
| 3 | Resolve  | GitHub Actions       | built - `autosupport-fix.yml`, patch-based |
| 4 | Respond  | GitHub Actions       | built - `autosupport-respond.yml` |
| 5 | Converse | GitHub Discussions   | prompt only (`prompts/chat.md`) - no runner ships in Level 1 |
| 6 | Learn    | `.autosupport/knowledge/` | seam only - the directory exists, nothing populates or reads it yet |

## Seams worth knowing about

- **No email, push, or chat delivery.** `respond.mjs` posts exactly one
  GitHub issue comment. That comment *is* the reply - there is no other
  notification channel in Level 1. If a reporter doesn't watch the issue,
  they won't hear back any other way.
- **`fix.mjs` is patch-based, not a full coding agent.** It asks Claude for
  a single unified diff and applies it with `git apply`, which is reliable
  but limited to changes that fit in one diff against the files triage
  already pointed at. `.github/workflows/autosupport-fix.yml` has a
  commented-out example of swapping in a third-party coding-agent Action for
  more ambitious fixes - it is intentionally not live YAML, see the comment
  block for why.
- **`.autosupport/scripts/lib/config.mjs` is a YAML *subset* loader, not a
  YAML parser.** It handles exactly the flat style `config.yml` ships with:
  nested mappings, flow sequences (`[a, b]`), quoted or bare scalars,
  comments. It does not support block "`- item`" lists, flow mappings, or
  multi-line strings - a line it can't parse is skipped rather than crashing
  a workflow. If you hand-edit `config.yml` into something fancier, `gh`
  Actions will silently see fewer fields than you think. Keep edits flat.
- **"Converse" and "Learn" are not wired to anything yet.** `prompts/chat.md`
  and `.autosupport/knowledge/` exist so the shape is in place, but nothing
  in this template runs them. That's intentional for Level 1 - see
  `SPEC.md` section 3 in the AutoSupport source repo for the full roadmap.
