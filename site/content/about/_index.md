---
title: "About"
description: "Why this project exists and who maintains it."
eyebrow: "About"
---

{{< product >}} gives you open-source desktop bots that keep their own conversation, memory,
routines and computer. Its promise is about who does the work and where — every bot is pinned to
a provider, model and effort level the owner chose, using the owner's own subscriptions and keys,
and that pin never silently changes. See [VISION.md]({{< repo-link "VISION.md" >}}) for the full
reasoning.

## Open by default

{{< product >}} is released under the Apache-2.0 license and maintained by the
[ArdurAI]({{ .Site.Params.repoURL }}) project on GitHub. It is an independently maintained fork;
see [NOTICE]({{< repo-link "NOTICE" >}}) for its upstream origin and Apache-2.0 attribution.
Issues and pull requests are public.

## Where the code comes from

Work lands on the `dev` branch; `main` only moves after a human has verified a build. CI (lint,
typecheck, build, unit tests) is advisory, not a merge gate. See
[CONTRIBUTING.md]({{< repo-link "CONTRIBUTING.md" >}}) for how changes flow.

- Source: [{{ .Site.Params.repoURL }}]({{ .Site.Params.repoURL }})
- Docs: [{{< product >}} docs]({{< ref "/docs/" >}})
- Security reports: {{ .Site.Params.securityEmail }}
