---
name: grok-run-output
description: Internal guidance for presenting Grok Build bridge output back to the user
user-invocable: false
---

# Grok Build Run Output

When the helper returns Grok output:
- Preserve the helper's verdict, summary, findings, and next steps structure.
- For review or critique output, present findings first and keep them ordered by severity.
- Use the file paths and line numbers exactly as the helper reports them.
- Preserve evidence boundaries. If Grok marked something as an inference, uncertainty, or follow-up question, keep that distinction.
- Preserve output sections when the prompt asked for them, such as observed facts, inferences, open questions, touched files, or next steps.
- If there are no findings, say that explicitly and keep the residual-risk note brief.
- If Grok made edits, say so explicitly and list the touched files when the helper provides them.
- For `grok-build:grok-delegate`, do not turn a failed or incomplete Grok run into a Claude-side implementation attempt. Report the failure and stop.
- For `grok-build:grok-delegate`, if Grok was never successfully invoked, do not generate a substitute answer at all.
- CRITICAL: After presenting review or critique findings, STOP. Do not make any code changes. Do not fix any issues. You MUST explicitly ask the user which issues, if any, they want fixed before touching a single file. Auto-applying fixes from a review is strictly forbidden, even if the fix is obvious.
- For `grok-build:grok-delegate`, the helper's result is already the run's final report when Grok emitted one: `## Result`, `## Files changed`, `## Artifacts`, `## Verification`, `## Follow-ups`. Preserve those sections and their content. Do not re-summarize them into a paragraph, and do not drop `## Artifacts` — for a Godot or Blender run the artifact paths are the deliverable.
- Treat the report's `## Verification` section as the agent's own claim, not as the bridge's verdict. The bridge's `Verified:` line is the measured one; if they disagree, say so and trust the bridge's.
- If the helper's result is plainly narration rather than a report (`Let me check ...`), the model did not comply with the output contract. Present what there is and say the run returned no structured report; do not invent one.
- If the helper reports malformed output or a failed Grok run, include the most actionable stderr lines and stop there instead of guessing.
- If the helper reports that setup or authentication is required, direct the user to `/grok-build:check` and do not improvise alternate auth flows.
