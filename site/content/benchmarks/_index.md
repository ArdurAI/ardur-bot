---
title: "Benchmarks"
description: "How this project measures itself: the scoreboard method, what it covers today, and what it does not yet claim."
eyebrow: "Measurement, not marketing"
---

{{< product >}} measures itself with an internal scoreboard, not with public leaderboard scores. This
page explains the method and its current coverage. Every number here comes from the repository
linked beside it; nothing is a projection.

## The scoreboard method

The scoreboard is a paired-comparison harness: a baseline build and a candidate build run the same
declared scenarios, and a bootstrap statistical comparator judges whether a metric improved,
regressed, or stayed inconclusive. See
[Paired verdicts and policy calibration]({{< repo-link "docs/performance.md#paired-verdicts-and-policy-calibration" >}})
for the full method, including sample-size requirements (20 paired observations for a commit-tier
check, 200 for a release-tier check) and the Bonferroni-adjusted error budget across metric
families.

- **Timing and bundles.** Shell paint, submit-to-first-token, startup strata, and initial gzip
  JavaScript are compared against fixed budgets — see the
  [advisory budgets]({{< repo-link "docs/performance.md#advisory-budgets" >}}) and the
  [1,024-byte gzip budget]({{< repo-link "scripts/bundle-budget.mjs" >}}) this site's own build
  respects.
- **Effect safety and recovery.** A durable fault-injection matrix (`O1`–`O13`) kills processes at
  ten declared boundaries and checks that no effect ran twice, no approval was skipped, and no
  work was silently lost — see the
  [durable experiment matrix]({{< repo-link "packages/testkit/src/scoreboard/experiments/README.md" >}}).
- **Request usage.** A request-usage ledger records token counts by category (logical input,
  cache read/write, output, reasoning) as reported by the provider, never estimated — see the
  [request usage ledger]({{< repo-link "docs/request-usage.md" >}}).
- **Traces.** An opt-in, fixed-schema trace collector records only boundary names, opaque
  identities, and timings — never prompts, tool arguments, or provider content — see
  [production trace collection]({{< repo-link "docs/trace-spans.md" >}}).
- **Evidence chain.** Every scoreboard record is an append-only, content-addressed hash chain, so
  a passed or failed check cannot be quietly edited afterward — see the
  [evidence index]({{< repo-link "docs/performance.md#evidence-index" >}}).

## What is measured today

The install and performance baseline from 2026-09-24 is the most recent public measurement, taken
on one fixed Apple M5 Pro machine with 200 samples per offline scenario. It compares two specific
commits of this repository against each other; it is not a claim about any other product.
Full numbers, including what stayed "not measured locally" because the sandbox that produced them
had no display or Docker socket, are in
[the baseline table]({{< repo-link "docs/performance.md#install-and-performance-baseline--2026-09-24" >}}).

## Comparisons

**Not yet measured.** {{< product >}} has not run a graded, matched-task comparison against Hermes
Agent, Prime Agent, or any other agent product. Publishing a comparison without matched tasks,
matched hardware, and a fixed grading rubric would be a marketing claim dressed as evidence, which
is the opposite of what this scoreboard is for. When a comparison exists, it will be linked from
this page with its full method and raw data, the same way the baseline above is.

## What is not measured yet

- No native-platform acceptance run: Windows and Linux installers, tray behavior, and cold launch
  still need a real machine — [remaining real-machine check]({{< repo-link "docs/performance.md#remaining-real-machine-check" >}}).
- No physical energy or packaged idle-CPU measurement exists yet, so publication currently stops
  at the evidence gate — [evidence index]({{< repo-link "docs/performance.md#evidence-index" >}}).
- Live-provider quality and cache-hit measurements are explicit, budgeted, separate runs, not part
  of the offline scoreboard — [O3 in the experiment matrix]({{< repo-link "packages/testkit/src/scoreboard/experiments/README.md#scope-and-plans" >}}).
