# Antigravity runtime

Antigravity is an Experimental native runtime for text-only turns on a connected host computer. It uses the owner's installed `agy` CLI. Install it and sign in manually on that computer before selecting Antigravity in a bot's **Runs on** setting. Ardur checks the installed version (1.2.12 or later) and the CLI model list; a successful text turn is the first sign-in evidence. A model shown from the dated fallback list can be saved while offline, but a run requires a live model list.

Each turn starts one `agy` process in the bot's native working directory. Ardur passes the exact pinned model and its required suffix effort. `claude-sonnet-4-6` and `claude-opus-4-6-thinking` have no effort setting. Ardur checks the model reported by the CLI before releasing text. Stop terminates the process. A native tool attempt, denied action, malformed stream, missing result, nonzero exit, or model mismatch fails the turn visibly. Ardur does not retry with another runtime or model.

Images, Ardur tools, structured output, controlled comparisons, native conversation resume, read-only peer work, and locality-restricted runs are unavailable in this first slice. The CLI may have owner-configured tools; Ardur stops a turn when it observes an attempted native tool. Do not grant native tools for this runtime. Its printed usage supplies token counts, but no monetary price. Cost remains unavailable.

The first slice is covered by offline fake-process tests. A live owner demo and platform-specific acceptance remain separate from this implementation.
