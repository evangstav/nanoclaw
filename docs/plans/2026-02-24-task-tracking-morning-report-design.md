# Project Task Tracking + Morning Report — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** High-level milestone tracking per project via TASKS.md files, with a daily agent that updates statuses from repo signals and sends a consolidated morning briefing to Telegram.

**Architecture:** TASKS.md files at each project root track milestones (above beads-level). A `task-report` NanoClaw group runs at 3:30 AM, reads each TASKS.md, checks git log / open PRs / beads status for signals, updates the files, commits, and sends a report.

**Tech Stack:** Markdown (TASKS.md), git CLI, beads CLI (`bd`), Azure DevOps REST API, GitLab API, NanoClaw task scheduler

---

## Reference

**Workspace:** `/home/estavrop/workspace/` (mounted at `/workspace/extra/workspace/` inside containers)

**Projects and their VCS:**

| Project | Workspace Path | Sub-repos (git) | VCS | Push? |
|---------|---------------|-----------------|-----|-------|
| Star Bulk | `starbulk-project/` | `sblk-backend/`, `sblk-frontend/`, `sblk-regulation-sync/` | Azure DevOps | Yes |
| Health & Safety | `health-and-safety/` | (single repo) | GitLab | Yes |
| ADMIE/IPTO | `admie-project/` | `ADMIEAI/` | Netcompany internal | No (analysis only) |
| Cosmos | `cosmos-ai-assistant/` | (single repo) | Local only | No remote |

**Key detail:** `starbulk-project/` is NOT a git repo — it's a local folder containing separate git repos (`sblk-backend/`, `sblk-frontend/`, etc.). TASKS.md goes at the `starbulk-project/` level (not version-controlled itself, just a local file). Same for `admie-project/`.

**Credentials:**
- Azure DevOps PAT: `/workspace/extra/workspace/starbulk-project/.azure-pat`
- GitLab PAT: `/workspace/extra/workspace/health-and-safety/.gitlab-pat`

**Beads CLI:** `bd` is installed at `/home/estavrop/.local/bin/bd`. Run from within a project directory. Key commands: `bd ready`, `bd list --status=open`, `bd blocked`.

**Telegram JID:** `tg:-5271778316`
**Timezone:** `Europe/Athens`

---

### Task 1: Create initial TASKS.md files for each project

The agent will maintain these going forward, but we need to seed them with current milestones based on PROJECTS.md and project context.

**Files:**
- Create: `/home/estavrop/workspace/starbulk-project/TASKS.md`
- Create: `/home/estavrop/workspace/health-and-safety/TASKS.md`
- Create: `/home/estavrop/workspace/admie-project/TASKS.md`
- Create: `/home/estavrop/workspace/cosmos-ai-assistant/TASKS.md`

**Step 1: Create Star Bulk TASKS.md**

Create `/home/estavrop/workspace/starbulk-project/TASKS.md`:

```markdown
# Star Bulk MSQ AI — Milestones

| # | Milestone | Status | Target | Notes |
|---|-----------|--------|--------|-------|
| 1 | Azure infrastructure provisioning | in_progress | - | AI Foundry, Blob Storage, AI Search, Container Apps still needed |
| 2 | Backend deployment to Azure | blocked | - | Blocked by infrastructure |
| 3 | Frontend CI/CD pipeline | todo | - | Pipeline not created yet |
| 4 | Data ingestion (production) | blocked | - | Blocked by Blob Storage + Container Apps |
| 5 | E2E testing on Azure | blocked | - | Blocked by deployment |
| 6 | MVP demo delivery | blocked | - | Blocked by E2E testing |
```

**Step 2: Create Health & Safety TASKS.md**

Create `/home/estavrop/workspace/health-and-safety/TASKS.md`:

```markdown
# Health & Safety — Milestones

| # | Milestone | Status | Target | Notes |
|---|-----------|--------|--------|-------|
| 1 | Fix critical bugs (ingest, thread-safety) | in_progress | - | 9 ready beads issues |
| 2 | Internal networking resolution | in_progress | - | IBM investigation ongoing |
| 3 | Vision agent image passing | todo | - | Depends on networking |
| 4 | Production deployment | blocked | - | Blocked by networking |
```

**Step 3: Create ADMIE/IPTO TASKS.md**

Create `/home/estavrop/workspace/admie-project/TASKS.md`:

```markdown
# ADMIE/IPTO — Milestones

| # | Milestone | Status | Target | Notes |
|---|-----------|--------|--------|-------|
| 1 | Complete manual indexing | in_progress | - | 55/194 manuals indexed |
| 2 | Azure access resolution | blocked | - | Kousiadis ticket pending |
| 3 | Demo deployment | blocked | - | Blocked by Azure access |
```

**Step 4: Create Cosmos TASKS.md**

Create `/home/estavrop/workspace/cosmos-ai-assistant/TASKS.md`:

```markdown
# Cosmos AI Assistant — Milestones

| # | Milestone | Status | Target | Notes |
|---|-----------|--------|--------|-------|
| 1 | IBM Knowledge Catalog MCP server | in_progress | - | API exploration ongoing |
```

**Step 5: Commit Health & Safety TASKS.md (the only one in a git repo that we'll commit)**

Health & Safety is a git repo with push access:

```bash
cd /home/estavrop/workspace/health-and-safety
git add TASKS.md
git commit -m "docs: add high-level milestone tracking"
```

The other TASKS.md files live in non-git directories (`starbulk-project/`, `admie-project/`) or local-only repos (`cosmos-ai-assistant/`), so no git commit needed.

---

### Task 2: Create the task-report NanoClaw group

**Files:**
- Create: `groups/task-report/CLAUDE.md`
- Create: `groups/task-report/logs/` (directory)
- Modify: `.gitignore` (add exception for `groups/task-report/`)

**Step 1: Create directory**

```bash
mkdir -p /home/estavrop/NanoClaw/groups/task-report/logs
```

**Step 2: Write CLAUDE.md**

Create `groups/task-report/CLAUDE.md` with this content:

```markdown
# Task Report Agent

You are a project milestone tracker. Your job is to review all project TASKS.md files, update their statuses based on repository activity, and send a consolidated morning briefing.

## Workspace

- `/workspace/extra/workspace/` — all projects

## Projects

| Project | TASKS.md Path | Sub-repos | VCS | Push |
|---------|--------------|-----------|-----|------|
| Star Bulk | `starbulk-project/TASKS.md` | `sblk-backend/`, `sblk-frontend/`, `sblk-regulation-sync/` | Azure DevOps | Yes |
| Health & Safety | `health-and-safety/TASKS.md` | (single repo) | GitLab | Yes |
| ADMIE/IPTO | `admie-project/TASKS.md` | `ADMIEAI/` | Netcompany | No |
| Cosmos | `cosmos-ai-assistant/TASKS.md` | (single repo) | Local | No |

## Credentials

- Azure DevOps PAT: `/workspace/extra/workspace/starbulk-project/.azure-pat`
- GitLab PAT: `/workspace/extra/workspace/health-and-safety/.gitlab-pat`

## TASKS.md Format

Each TASKS.md has this structure:

| # | Milestone | Status | Target | Notes |
|---|-----------|--------|--------|-------|

Status values: `todo`, `in_progress`, `done`, `blocked`

## Your Process

### 1. Pull latest code

For repos with push access, pull latest before checking signals:

```bash
# Star Bulk sub-repos
AZURE_PAT=$(cat /workspace/extra/workspace/starbulk-project/.azure-pat)
for repo in sblk-backend sblk-frontend sblk-regulation-sync; do
  cd /workspace/extra/workspace/starbulk-project/$repo
  git fetch origin 2>/dev/null
  echo "=== $repo: fetched ==="
done

# Health & Safety
GITLAB_PAT=$(cat /workspace/extra/workspace/health-and-safety/.gitlab-pat)
cd /workspace/extra/workspace/health-and-safety
git fetch "https://oauth2:$GITLAB_PAT@gitlab.swpd/genai-data-intelligence/hedno/health-and-safety.git" dev 2>/dev/null && echo "=== health-and-safety: fetched ===" || echo "=== health-and-safety: fetch failed ==="

# ADMIE
cd /workspace/extra/workspace/admie-project/ADMIEAI
git fetch origin 2>/dev/null && echo "=== ADMIEAI: fetched ===" || echo "=== ADMIEAI: fetch failed ==="
```

### 2. Check signals for each project

For each project, gather:

**Recent commits (last 24 hours):**
```bash
cd /workspace/extra/workspace/<project-path>
git log --since="24 hours ago" --oneline --all 2>/dev/null | head -20
```

For Star Bulk, run this in each sub-repo (`sblk-backend/`, `sblk-frontend/`, `sblk-regulation-sync/`).

**Open PRs (Star Bulk only, via Azure DevOps API):**
```bash
AZURE_PAT=$(cat /workspace/extra/workspace/starbulk-project/.azure-pat)
for azure_repo in msqai-be-core msqai-fe-ui msqai-be-sync; do
  echo "=== $azure_repo ==="
  curl -s -u ":$AZURE_PAT" \
    "https://dev.azure.com/Starbulk/StarBulkAI/_apis/git/repositories/$azure_repo/pullrequests?searchCriteria.status=active&api-version=7.1" \
    | jq '.value[] | {id: .pullRequestId, title: .title, author: .createdBy.displayName, created: .creationDate}'
done
```

**Beads status:**
```bash
cd /workspace/extra/workspace/<project-path>
bd ready 2>/dev/null || echo "no beads"
bd blocked 2>/dev/null || echo "no blocked beads"
```

For Star Bulk, run beads in `sblk-backend/` and `sblk-frontend/`.

### 3. Update TASKS.md files

Read each TASKS.md, compare milestones against signals:

- **Move to `done`** if: PR merged for that milestone, or branch deleted, or code changes confirm completion
- **Move to `in_progress`** if: recent commits related to the milestone
- **Move to `blocked`** if: no progress and related beads are blocked, or dependency milestones aren't done
- **Update Notes** with: commit count, PR status, beads summary
- **Do NOT add new milestones** — only update existing ones. The user adds milestones manually.

Write updated TASKS.md files back.

### 4. Commit changes (where applicable)

For Health & Safety (git repo with push):
```bash
cd /workspace/extra/workspace/health-and-safety
git add TASKS.md
git diff --cached --quiet || git commit -m "chore: update milestone status (automated)"
```

For Star Bulk and ADMIE — TASKS.md lives in the non-git parent directory, so no commit needed.

### 5. Send report

Use `mcp__nanoclaw__send_message` to send ONE consolidated message:

```
📋 Morning Briefing — {date}

🔵 Star Bulk
  ✅ {done milestone} — done
  🔄 {in_progress milestone} — in_progress, {X commits yesterday in sblk-backend}
  ⏳ {blocked milestone} — blocked, {reason}

🟡 Health & Safety
  🔄 {milestone} — in_progress, {Y beads issues ready}

🟢 ADMIE/IPTO
  ⏳ {milestone} — blocked, {reason}

💡 Cosmos
  🔄 {milestone} — in_progress

📊 Summary: {total} milestones across 4 projects. {done} done, {in_progress} active, {blocked} blocked.
```

Project status icons:
- 🔵 Has active work (commits or PRs in last 24h)
- 🟡 Has ready work but no recent activity
- 🟢 All milestones on track
- 🔴 Has blocked milestones needing attention

Milestone icons:
- ✅ done
- 🔄 in_progress
- ⏳ blocked
- 📝 todo

If a project has no TASKS.md, skip it and note in the report.

## Communication

Use `mcp__nanoclaw__send_message` to send the report. Send ONE message with the full report.
```

**Step 3: Update .gitignore**

Add exceptions for the task-report group in `.gitignore`, following the existing pattern for pr-review.

**Step 4: Commit**

```bash
cd /home/estavrop/NanoClaw
git add groups/task-report/CLAUDE.md .gitignore
git commit -m "feat: add task-report group for daily milestone tracking"
```

---

### Task 3: Register the task-report group and create scheduled task

**Step 1: Register the group in the database**

```bash
node -e "
const { initDatabase, setRegisteredGroup } = require('./dist/db.js');
initDatabase();
setRegisteredGroup('internal:task-report', {
  name: 'task-report',
  folder: 'task-report',
  trigger: '@TaskReport',
  added_at: new Date().toISOString(),
  containerConfig: {
    additionalMounts: [
      { hostPath: '/home/estavrop/workspace', containerPath: 'workspace', readonly: false }
    ],
    timeout: 900000
  },
  requiresTrigger: false
});
console.log('task-report group registered');
"
```

**Step 2: Verify registration**

```bash
node -e "
const { initDatabase, getAllRegisteredGroups } = require('./dist/db.js');
initDatabase();
const groups = getAllRegisteredGroups();
const g = groups['internal:task-report'];
console.log(g ? 'OK: ' + JSON.stringify(g, null, 2) : 'FAIL: group not found');
"
```

**Step 3: Create the scheduled task**

```bash
node -e "
const { initDatabase, createTask } = require('./dist/db.js');
const { CronExpressionParser } = require('cron-parser');
initDatabase();

const scheduleValue = '30 3 * * *';
const tz = 'Europe/Athens';
const interval = CronExpressionParser.parse(scheduleValue, { tz });
const nextRun = interval.next().toISOString();

createTask({
  id: 'task-report-daily',
  group_folder: 'task-report',
  chat_jid: 'tg:-5271778316',
  prompt: 'Check all project milestones and send the morning briefing. Follow the instructions in your CLAUDE.md exactly. Send the report using mcp__nanoclaw__send_message.',
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

**Step 4: Verify task**

```bash
node -e "
const { initDatabase, getTaskById } = require('./dist/db.js');
initDatabase();
const task = getTaskById('task-report-daily');
console.log(task ? 'OK: ' + JSON.stringify(task, null, 2) : 'FAIL');
"
```

Expected: Task with `schedule_value: "30 3 * * *"`, `group_folder: "task-report"`, next_run at ~01:30 UTC.

---

### Task 4: Restart NanoClaw and test

**Step 1: Restart NanoClaw to load the new group**

```bash
systemctl --user restart nanoclaw
sleep 3
systemctl --user status nanoclaw --no-pager
```

**Step 2: Verify group loaded**

```bash
grep "groupCount" /home/estavrop/NanoClaw/logs/nanoclaw.log | tail -1
```

Expected: `groupCount: 4` (main, doc-sync, pr-review, task-report)

**Step 3: Create one-time test task**

```bash
node -e "
const { initDatabase, createTask } = require('./dist/db.js');
initDatabase();

const nextRun = new Date(Date.now() + 10000).toISOString();
createTask({
  id: 'task-report-test-once',
  group_folder: 'task-report',
  chat_jid: 'tg:-5271778316',
  prompt: 'Check all project milestones and send the morning briefing. Follow the instructions in your CLAUDE.md exactly. Send the report using mcp__nanoclaw__send_message.',
  schedule_type: 'once',
  schedule_value: nextRun.replace('Z', '').split('.')[0],
  context_mode: 'isolated',
  next_run: nextRun,
  status: 'active',
  created_at: new Date().toISOString()
});
console.log('Test task created. Will fire at:', nextRun);
"
```

**Step 4: Wait and verify**

```bash
sleep 90
tail -20 /home/estavrop/NanoClaw/logs/nanoclaw.log
```

Expected: Container spawns for task-report, completes, sends Telegram message.

**Step 5: Check Telegram for the morning briefing report**

Verify the report arrived with correct format — project sections, milestone statuses, summary line.
