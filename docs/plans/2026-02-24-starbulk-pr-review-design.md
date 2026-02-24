# Starbulk PR Review Scheduled Job — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Daily 3 AM cron job that reviews all open PRs across Starbulk Azure DevOps repos, provides AI-assisted risk assessment, and sends a structured report to Telegram.

**Architecture:** New `pr-review` group with its own CLAUDE.md, registered in the database with the same workspace mount as doc-sync. A cron scheduled task runs daily at 3:00 AM Europe/Athens, spawns an isolated container that uses the Azure DevOps REST API to fetch PRs and diffs, then sends the report to Telegram via `send_message`.

**Tech Stack:** Azure DevOps REST API (via curl + PAT), NanoClaw task scheduler (cron), Telegram delivery via IPC

---

## Reference: Existing Patterns

These are the existing values you'll need:

- **Telegram main JID:** `tg:-5271778316`
- **Timezone:** `Europe/Athens` (3:00 AM local = cron `0 3 * * *`)
- **doc-sync containerConfig pattern:**
  ```json
  {
    "additionalMounts": [
      { "hostPath": "/home/estavrop/workspace", "containerPath": "workspace", "readonly": false }
    ],
    "timeout": 900000
  }
  ```
- **Azure DevOps PAT path:** `/workspace/extra/workspace/starbulk-project/.azure-pat`
- **Starbulk repos:**
  | Local Dir | Azure Repo | Branch |
  |-----------|-----------|--------|
  | starbulk-project/sblk-backend | msqai-be-core | develop |
  | starbulk-project/sblk-frontend | msqai-fe-ui | develop |
  | starbulk-project/sblk-regulation-sync | msqai-be-sync | develop |

---

### Task 1: Create the pr-review group directory and CLAUDE.md

**Files:**
- Create: `groups/pr-review/CLAUDE.md`
- Create: `groups/pr-review/logs/` (empty directory)

**Step 1: Create directory structure**

```bash
mkdir -p groups/pr-review/logs
```

**Step 2: Write CLAUDE.md**

Create `groups/pr-review/CLAUDE.md` with this content:

```markdown
# PR Review Agent

You are a pull request review agent for the Star Bulk project. Your job is to review all open PRs across Starbulk Azure DevOps repositories, provide AI-assisted risk assessment, and send a structured morning report.

## Workspace

- `/workspace/extra/workspace/starbulk-project/` — Starbulk project root

## Repositories

| Local Dir | Azure Repo | Default Branch |
|-----------|-----------|----------------|
| sblk-backend | msqai-be-core | develop |
| sblk-frontend | msqai-fe-ui | develop |
| sblk-regulation-sync | msqai-be-sync | develop |

## Credentials

- Azure DevOps PAT: `/workspace/extra/workspace/starbulk-project/.azure-pat`

## Azure DevOps API

Organization: `Starbulk`, Project: `StarBulkAI`

Base URL: `https://dev.azure.com/Starbulk/StarBulkAI/_apis`

### List open PRs for a repo

```bash
AZURE_PAT=$(cat /workspace/extra/workspace/starbulk-project/.azure-pat)
curl -s -u ":$AZURE_PAT" \
  "https://dev.azure.com/Starbulk/StarBulkAI/_apis/git/repositories/<azure-repo>/pullrequests?searchCriteria.status=active&api-version=7.1"
```

### Get PR details (reviewers, votes, threads)

```bash
curl -s -u ":$AZURE_PAT" \
  "https://dev.azure.com/Starbulk/StarBulkAI/_apis/git/repositories/<azure-repo>/pullrequests/<pr-id>?api-version=7.1"
```

### Get PR threads (comments, status)

```bash
curl -s -u ":$AZURE_PAT" \
  "https://dev.azure.com/Starbulk/StarBulkAI/_apis/git/repositories/<azure-repo>/pullrequests/<pr-id>/threads?api-version=7.1"
```

### Get PR diff (iterations/changes)

```bash
# First get iterations
curl -s -u ":$AZURE_PAT" \
  "https://dev.azure.com/Starbulk/StarBulkAI/_apis/git/repositories/<azure-repo>/pullrequests/<pr-id>/iterations?api-version=7.1"

# Then get changes for the latest iteration
curl -s -u ":$AZURE_PAT" \
  "https://dev.azure.com/Starbulk/StarBulkAI/_apis/git/repositories/<azure-repo>/pullrequests/<pr-id>/iterations/<iteration-id>/changes?api-version=7.1"
```

### Read file content from a PR branch

For AI-assisted review, read the actual diff by checking out the source branch locally:

```bash
cd /workspace/extra/workspace/starbulk-project/<local-dir>
git fetch origin
git diff origin/develop...origin/<source-branch> -- .
```

## Review Process

For each repository:

1. **List open PRs** using the API
2. **For each PR:**
   a. Get reviewer votes (approved=10, approved with suggestions=5, waiting=0, rejected=-10)
   b. Get comment threads (count active/resolved)
   c. Check merge status and conflicts
   d. Fetch the diff (via git diff on source branch)
   e. **Read the diff and assess:**
      - Scope: how many files/lines changed
      - Risk level: Low (docs, tests, config), Medium (business logic, non-critical), High (auth, billing, data model, migrations)
      - Code quality observations (brief, 1-2 sentences)
      - Whether it looks ready to merge

3. **Format the report** (see template below)

## Report Format

```
📋 Starbulk PR Report — {date}

{repo_section_for_each_repo_with_open_prs}

🔵/🟡/🔴 PR #{id}: {title}
   Author: {author} · {age} days old · Target: {target}
   Reviewers: {approved}/{total} approved, {active_comments} active comments
   Risk: {Low|Medium|High} — {1-2 sentence assessment}

📊 Summary: {total} open PRs across {repo_count} repos. {actionable} need attention.
```

Status icons:
- 🔵 On track (approved or nearly approved, no blockers)
- 🟡 Needs attention (stale, unresolved comments, missing reviews)
- 🔴 Blocked (conflicts, rejected, or CI failing)

If no open PRs exist in any repo, send: "✅ No open PRs across Starbulk repos."

## Communication

Use `mcp__nanoclaw__send_message` to send the report. Send ONE message with the full report (don't split into multiple messages).
```

**Step 3: Commit**

```bash
git add groups/pr-review/CLAUDE.md
git commit -m "feat: add pr-review group with CLAUDE.md for Starbulk PR reviews"
```

---

### Task 2: Register the pr-review group in the database

**Files:**
- Modify: `src/index.ts` (no code changes — we'll use the database directly)

**Step 1: Register the group via a Node.js script**

Run this to register the group in the database with the same mount config as doc-sync:

```bash
node -e "
const { initDatabase, setRegisteredGroup } = require('./dist/db.js');
initDatabase();
setRegisteredGroup('internal:pr-review', {
  name: 'pr-review',
  folder: 'pr-review',
  trigger: '@PRReview',
  added_at: new Date().toISOString(),
  containerConfig: {
    additionalMounts: [
      { hostPath: '/home/estavrop/workspace', containerPath: 'workspace', readonly: false }
    ],
    timeout: 900000
  },
  requiresTrigger: false
});
console.log('pr-review group registered');
"
```

**Step 2: Verify registration**

```bash
node -e "
const { initDatabase, getAllRegisteredGroups } = require('./dist/db.js');
initDatabase();
const groups = getAllRegisteredGroups();
const pr = groups['internal:pr-review'];
console.log(pr ? 'OK: ' + JSON.stringify(pr, null, 2) : 'FAIL: group not found');
"
```

Expected: Shows the pr-review group with correct folder, trigger, and containerConfig.

---

### Task 3: Create the scheduled task (cron, 3 AM daily)

**Step 1: Build the task prompt**

The task prompt should be self-contained (isolated context mode = no conversation history). It tells the agent exactly what to do:

```
Review all open PRs across Starbulk Azure DevOps repositories and send a morning report. Follow the instructions in your CLAUDE.md exactly. Send the report using mcp__nanoclaw__send_message.
```

**Step 2: Create the task in the database**

```bash
node -e "
const { initDatabase, createTask } = require('./dist/db.js');
const { CronExpressionParser } = require('cron-parser');
initDatabase();

const scheduleValue = '0 3 * * *';
const tz = 'Europe/Athens';
const interval = CronExpressionParser.parse(scheduleValue, { tz });
const nextRun = interval.next().toISOString();

createTask({
  id: 'pr-review-daily',
  group_folder: 'pr-review',
  chat_jid: 'tg:-5271778316',
  prompt: 'Review all open PRs across Starbulk Azure DevOps repositories and send a morning report. Follow the instructions in your CLAUDE.md exactly. Send the report using mcp__nanoclaw__send_message.',
  schedule_type: 'cron',
  schedule_value: scheduleValue,
  context_mode: 'isolated',
  next_run: nextRun,
  status: 'active',
  created_at: new Date().toISOString()
});
console.log('Task created. Next run:', nextRun);
"
```

**Step 3: Verify the task**

```bash
node -e "
const { initDatabase } = require('./dist/db.js');
const db = require('better-sqlite3')('store/nanoclaw.db');
const task = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get('pr-review-daily');
console.log(task ? 'OK: ' + JSON.stringify(task, null, 2) : 'FAIL: task not found');
"
```

Expected: Task with `schedule_value: "0 3 * * *"`, `group_folder: "pr-review"`, `status: "active"`, and `next_run` set to tomorrow at 01:00 UTC (3:00 AM Europe/Athens).

---

### Task 4: Test with a one-time manual run

**Step 1: Create a one-time test task that runs immediately**

```bash
node -e "
const { initDatabase, createTask } = require('./dist/db.js');
initDatabase();

createTask({
  id: 'pr-review-test-once',
  group_folder: 'pr-review',
  chat_jid: 'tg:-5271778316',
  prompt: 'Review all open PRs across Starbulk Azure DevOps repositories and send a morning report. Follow the instructions in your CLAUDE.md exactly. Send the report using mcp__nanoclaw__send_message.',
  schedule_type: 'once',
  schedule_value: new Date(Date.now() + 5000).toISOString().replace('Z', '').split('.')[0],
  context_mode: 'isolated',
  next_run: new Date(Date.now() + 5000).toISOString(),
  status: 'active',
  created_at: new Date().toISOString()
});
console.log('Test task created — will fire in ~5 seconds if scheduler is running');
"
```

**Step 2: Watch the logs**

```bash
# If NanoClaw is running, watch for the container spawn:
tail -f groups/pr-review/logs/container-*.log
```

**Step 3: Verify report was sent**

Check Telegram for the PR review report message. If it arrived with the expected format, the integration is working.

**Step 4: Clean up test task (it auto-completes, but verify)**

```bash
node -e "
const db = require('better-sqlite3')('store/nanoclaw.db');
const task = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get('pr-review-test-once');
console.log('Status:', task?.status, '| Last result:', task?.last_result?.substring(0, 100));
"
```

Expected: `status: "completed"`, `last_result` contains the report summary.

**Step 5: Commit everything**

```bash
git add groups/pr-review/
git commit -m "feat: add Starbulk PR review daily scheduled task

Runs at 3:00 AM Europe/Athens, reviews open PRs across all Starbulk
Azure DevOps repos with AI-assisted risk assessment, sends report
to Telegram."
```
