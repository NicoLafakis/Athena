# Read completion preceded descriptor closure on Windows

Main commit `8221133` had a Windows 20 CI failure in `tests/tools/read.test.ts`
fixture removal: `ENOTEMPTY` while deleting an `athena-read-*` temporary directory.
The passing Copilot reviewer workflow was not a passing CI matrix.

The Read tool finished its readline iteration before the underlying stream's `close`
event. Its optional `fileSha256` guard likewise resolved on `end`, which confirms byte
delivery but does not confirm descriptor closure. Immediate Windows cleanup could
therefore race a live file handle. This was reproduced with a deterministic regression:
after awaiting Read, the observed stream still had `closed === false`.

Read now closes the reader/destroys the stream in `finally` and awaits the stream's
close event on success, truncation, cancellation and failure. Input-stream errors
close the reader and are returned as read errors. File hashing resolves or rejects
only after descriptor closure and refuses an unexpected incomplete stream.

Regression coverage observes real streams and checks closure before tool completion,
with and without the hash guard, plus cancellation and directory-read failure. This
fix addresses the concrete CI race rather than hiding it with fixture deletion retries.
No unrelated cleanup or system file changes are included.
