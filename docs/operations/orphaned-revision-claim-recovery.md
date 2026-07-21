# Orphaned Revision Claim Recovery

Runbook for diagnosing and recovering from orphaned deterministic revision claims.

## What is a revision claim

When DevFlow executes a deterministic revision for a task in `VERIFYING` state, it first acquires ownership via an atomic compare-and-set (CAS) on the `currentRevisionJson` column. The claim is a JSON string with this structure:

```json
{
  "kind": "DETERMINISTIC_REVISION_CLAIM",
  "claimId": "<uuid>",
  "taskId": "<task-id>",
  "claimedAt": "<iso-8601-timestamp>"
}
```

The claim is written before the builder runs and is used as the CAS token for finalization. Only one caller can hold the claim at a time.

## When a claim becomes orphaned

A claim becomes orphaned if the process that acquired it fails to finalize. Possible causes:

- The builder throws (e.g., Git error, path validation error, command execution error).
- `JSON.stringify(result)` throws (non-serializable result).
- `finalizeTaskDeterministicRevision` throws a SQLite error (e.g., `SQLITE_BUSY`).
- The process receives `SIGTERM` after claim acquisition but before finalization.
- The process receives `SIGKILL` after claim acquisition but before finalization.
- The machine restarts after claim acquisition but before finalization.
- An unhandled exception or assertion failure crashes the process.

In all these cases the task remains in `VERIFYING` state with `currentRevisionJson` containing the claim JSON.

## What protection the claim provides

- Prevents silent double execution: no other caller can acquire the same claim.
- Keeps the task in `VERIFYING` state until finalization or manual intervention.
- Blocks new builders from running on the same task.
- Does **not** indicate whether previous `requiredCommands` produced any effects on the filesystem.

## Limitations

- The claim does **not** contain a process ID (PID).
- The claim does **not** contain a hostname.
- The claim does **not** contain a lease or expiration time.
- The claim does **not** contain a heartbeat.
- `claimedAt` does **not** prove the process is dead — it only records when the claim was acquired.
- There is no automated way to determine whether the owning process is still alive.
- `requiredCommands` are **not** guaranteed to be idempotent. Re-executing them may produce different results or side effects.

## Prerequisites for recovery

Before performing any recovery operation:

1. Authorized access to the SQLite database.
2. A backup of the database file.
3. The task must be in `VERIFYING` state.
4. The `currentRevisionJson` must be parsed correctly and confirmed to contain `kind: "DETERMINISTIC_REVISION_CLAIM"`.
5. The `taskId` in the claim must match the task row.
6. The `claimId` and `claimedAt` must be noted.
7. Application and system logs must be reviewed for evidence of the owning process.
8. Explicit human approval must be obtained.
9. A documented decision must exist regarding possible re-execution of `requiredCommands`.

## Safe inspection

Query the task by ID:

```sql
SELECT
  id,
  state,
  currentRevisionJson,
  updatedAt
FROM tasks
WHERE id = ?;
```

The operator must:

1. Copy the exact `currentRevisionJson` value.
2. Parse it outside of SQLite (e.g., in a JSON parser or editor).
3. Confirm the `kind` field is exactly `DETERMINISTIC_REVISION_CLAIM`.
4. Confirm the `taskId` matches the row.
5. Preserve the exact string for the CAS cleanup operation.

Do **not** use `LIKE` as a validation mechanism.

## Decision options

After inspection, the operator may choose one of:

1. **Keep blocked** — leave the task as-is if recovery is not urgent or if the owning process may still be active.
2. **Cancel or resolve externally** — if an authorized policy exists to cancel the task or move it to another state through supported means.
3. **Release claim and retry** — clear the claim and allow a new execution, only under explicit human approval and after confirming no active process holds the claim.

There is no supported API for canceling a task. Any state change requires direct SQLite access.

## Safe cleanup via compare-and-set

Use a parameterized CAS update to clear the claim:

```sql
UPDATE tasks
SET currentRevisionJson = NULL,
    updatedAt = ?
WHERE id = ?
  AND state = 'VERIFYING'
  AND currentRevisionJson = ?;
```

Parameter order:

1. New `updatedAt` value (ISO-8601 timestamp).
2. `taskId`.
3. The exact `currentRevisionJson` string copied during inspection.

Requirements:

- Verify that exactly 1 row was affected (`changes === 1`).
- If `changes === 0`, **stop immediately**. Do not retry the UPDATE.
- Re-inspect the task to determine what changed (the claim may have been finalized by the original process, or the state may have changed).
- Do **not** use an UPDATE that matches only by `id` without the CAS conditions.
- Do **not** use `LIKE` to select or match claims.
- Do **not** clean up if the claim string has changed since inspection.
- Do **not** clean up if the state is no longer `VERIFYING`.

## Post-cleanup verification

After a successful cleanup, confirm:

1. `state` is still `VERIFYING`.
2. `currentRevisionJson` is `NULL`.
3. `updatedAt` has changed.
4. No other columns were modified.
5. No known active execution is targeting this task.

```sql
SELECT
  id,
  state,
  currentRevisionJson,
  updatedAt
FROM tasks
WHERE id = ?;
```

## Retry policy

Before retrying `executeRevisionForTask`:

1. Review the `requiredCommands` from the task's contract.
2. Identify possible side effects of re-executing those commands.
3. Manually restore any external state if necessary.
4. Obtain explicit human approval.
5. Document that the commands may execute again.

Do **not** assume that `requiredCommands` are idempotent. The system does not guarantee this.

## Prohibitions

- Do **not** clean up claims automatically based on age.
- Do **not** use TTL or time-based heuristics as proof of abandonment.
- Do **not** kill processes by generic name matching.
- Do **not** use `LIKE` to select or match claims in SQL.
- Do **not** clear `currentRevisionJson` without an exact CAS match.
- Do **not** change `state` and `currentRevisionJson` in separate operations without an authorized policy.
- Do **not** retry while there is a reasonable possibility that the owning process is still active.

## Manual audit record

For each recovery operation, record the minimum following data:

| Field | Description |
|-------|-------------|
| `taskId` | The task identifier. |
| `claimId` | The `claimId` from the claim JSON. |
| `claimedAt` | The `claimedAt` timestamp from the claim JSON. |
| `claimJson` | The exact claim string, or its hash. |
| `operator` | Name or identifier of the person performing recovery. |
| `date` | ISO-8601 timestamp of the recovery operation. |
| `evidenceReviewed` | Description of logs, process list, or other evidence examined. |
| `decision` | The decision made (keep blocked / cancel / release and retry). |
| `approval` | Identifier of the person who approved the action. |
| `updateResult` | Number of rows affected by the CAS UPDATE. |
| `followUp` | Any subsequent action taken (retry, cancel, etc.). |

Automated audit storage is not currently implemented.

## Limitations of `inspect` command

The `devflow inspect --task <id>` command shows whether `currentRevisionJson` is non-null, but does **not** distinguish between an active claim and a finalized result. It displays:

```
Revision actual: Sí
```

This is the same output for both a claim and a completed revision. To determine the actual content, query the database directly.

## Current state

- No automated recovery mechanism exists.
- No CLI command for claim cleanup is implemented.
- No heartbeat, lease, or PID tracking is available.
- Recovery requires manual SQLite access with the procedure described above.
