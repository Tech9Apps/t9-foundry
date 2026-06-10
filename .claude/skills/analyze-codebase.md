# analyze-codebase

Produce a QA-focused analysis of the application codebase. Identifies entry points, routes, data models, authentication patterns, existing test coverage, and risk areas.

## When to invoke

Trigger phrases: "analyze the codebase", "understand the code for QA", "explore the codebase", "what does this feature do in code", "audit the application code", "analyze code for testing", "what should I be aware of when testing this"

## Arguments

Optional: `TICKET-ID` — scopes the analysis to the feature area mentioned in the ticket.

Example: `/analyze-codebase JIRA-42` focuses on the code paths relevant to that ticket.

## Steps

1. **Read qa-config.json**
   Get `codeRepository`, `environments.testEnvironmentBaseUrl`, and `testOutput.analysisDir`. If config is missing, stop and prompt to run `/connect-repo`.

2. **Determine code access method**
   - If `codeRepository.localPath` is set and exists: use Read and Bash tools directly on the filesystem. This is the primary path.
   - If GitHub: use `gh api repos/{owner}/{repo}/contents/{path}` for file access
   - If GitLab: use `curl -H "PRIVATE-TOKEN: $GITLAB_TOKEN"` to fetch repository tree and file contents
   - If Bitbucket: use REST API with `$BITBUCKET_TOKEN`

3. **If a TICKET-ID was provided**
   First fetch and read the ticket (using the configured ticket source) to understand the feature being analyzed. Use the ticket title, description, and acceptance criteria to scope which parts of the codebase to focus on.

4. **Launch 3 parallel analysis passes**

   **Pass A — API Routes and Entry Points**
   Identify: all HTTP routes/endpoints, controller/handler methods, middleware, authentication guards, input validation points. Look for: Express routes, FastAPI paths, Rails controllers, Spring controllers, Django views, Next.js API routes.

   **Pass B — Data Models and Database Interactions**
   Identify: database schema / ORM models, migration files, database queries (especially writes), external service calls, caching layers, data transformation points.

   **Pass C — Existing Test Coverage**
   Identify: existing unit tests, integration tests, e2e tests. Note: what is tested, what frameworks are used, what test data strategies exist, what is NOT covered, what test utilities / factories / fixtures already exist.

5. **Synthesize QA Analysis Report**

   Produce a structured markdown report with these sections:

   ```markdown
   # QA Codebase Analysis — [Project Name or Ticket ID]
   ## Tech Stack
   [Languages, frameworks, databases, external services]

   ## Feature Boundaries
   [What this feature does; key user flows]

   ## API / Route Map
   [Table of endpoints: method, path, auth required, description]

   ## Data Models Involved
   [Key models and their relationships relevant to testing]

   ## Risk Areas
   [Untested code paths, complex logic, external dependencies, error handling gaps]

   ## Existing Test Coverage
   [What's covered, what's missing, what frameworks/patterns are in use]

   ## Test Data Requirements
   [What entities need to be created, what states need to exist]

   ## External Dependencies
   [Third-party services, APIs, queues that affect testability]

   ## Recommended Test Approach
   [Which test types are highest value: unit, integration, e2e, API]

   ## Analysis Date
   [ISO date]
   ```

6. **Save the report**
   - If ticket-scoped: `{analysisDir}/{ticket-id}-analysis.md`
   - If general: `{analysisDir}/latest-analysis.md`
   - Create the directory if it doesn't exist

7. **Report completion**
   Show the report summary and path. Say: "Analysis complete. Run `/create-test-plan {ticket-id}` to generate a test plan, or `/write-e2e-tests {ticket-id}` to jump to test authoring."
