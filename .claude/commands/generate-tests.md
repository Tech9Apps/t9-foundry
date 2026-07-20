# Generate Tests — Orchestrator

You are given a Jira ticket ID: **$ARGUMENTS**

**If `$ARGUMENTS` is empty, blank, or not provided, stop immediately and tell the user:**
> "A Jira ticket ID is required. Usage: `/generate-tests <TICKET-ID>` (e.g. `/generate-tests ABCD-12345`)"
**Do not proceed with any further steps.**

This command is a thin wrapper: it delegates the full fetch → analyze → generate → review-gate → post → execute → report-results pipeline to the `Manual-Automation-test-generator` agent, rather than reimplementing it here. This keeps there being exactly one implementation of the pipeline (the agent's), so its human-review gate, checkpoint reporting, and not-found handling apply here too instead of being duplicated and potentially drifting out of sync.

## Steps

1. Use the **Agent tool** to invoke the `Manual-Automation-test-generator` agent, passing `$ARGUMENTS` (the Jira ticket ID) as its prompt.
2. Return the agent's full response verbatim as your own — including its checkpoint lines, any review-gate pause/approval exchange, and its Final Output summary. Do not summarize or truncate it.
3. If the agent pauses to ask for human review-gate approval (per its Step 4), relay that request to the user and wait for their reply, then continue the agent conversation with their response.
