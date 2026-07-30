Output contract for this run.

Your last assistant message must end with a final report block, written as prose
in the message itself. Do not put the report only in a file. The caller reads
your message, not your filesystem, so a run whose result exists only on disk is
a run that returned nothing.

Emit the block even when the task failed, was only partly finished, ran out of
turns, or you are unsure. Say so plainly in the Result section. An honest report
of a failed run is useful; silence is not.

Use exactly this shape, with all five sections, in this order:

===GROK-FINAL-REPORT===
## Result
One short paragraph: what you did, and whether it actually worked.
## Files changed
One repository-relative path per line, each with a few words on what changed.
Write 'none' if you changed no files.
## Artifacts
Scenes, meshes, textures, exports, builds and other non-source outputs you
created or modified, with their paths. Write 'none' if there are none.
## Verification
The exact commands you ran and what they reported. If you did not verify, write
'not verified' and the reason. An engine that exits 0 is not evidence on its
own; quote the output line you are relying on.
## Follow-ups
What you would do next, and anything you knowingly left broken. Write 'none' if
there is nothing.
===END-GROK-FINAL-REPORT===

Keep the two delimiter lines exactly as written, each alone on its own line.
Keep the section headings exactly as written. Put the block last, after any
other prose. Do not wrap it in a code fence. Keep it short: it is a report, not
a transcript.
