// Fake Claude desktop data for the demo and the README screenshots: made-up projects, threads and conversations.
// It writes the same files the board reads from the real Claude (thread files, process registry, transcripts) into a
// folder of your choice, so the board runs without Claude desktop and shows nothing of your own work.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { QuotaService } from '../lib/quotas.js';

const MIN = 60_000;
const ROOT = '/Users/demo/Repo';

/** Threads: status comes from `summary` (blocked / completed) or from `run` (a live process). Times are minutes ago. */
const THREADS = [
  {
    id: 'review', title: 'Review pull request #42', project: 'shop-api', ago: 190, last: 11, starred: false,
    summary: { status_category: 'blocked', status_detail: '', needs_action: 'The PR changes how tax is computed. Approve it, or ask for changes?' },
    turns: [
      ['Review PR #42 and tell me if it is safe to merge.', ['Read the diff of PR #42 and the tests around `calculateTax`.', 'The change is small, but it alters rounding for discounted orders.', 'Do you want me to approve it, or ask for changes?'], ['Bash', 'Read', 'Read', 'Grep']],
    ],
  },
  {
    id: 'security', title: 'Check the security of PR 42', project: 'shop-api', ago: 40, last: 1, parent: 'review', run: { status: 'busy' },
    summary: { status_category: 'completed', status_detail: 'Scanned the dependencies; no known issues.', needs_action: '' },
    turns: [
      ['Run a security pass on the files this PR touches.', ['Running the dependency audit and checking input validation on the new endpoint.'], ['Bash', 'Bash', 'Grep']],
    ],
  },
  {
    id: 'migrate', title: 'Migrate the database to the new schema', project: 'shop-api', ago: 240, last: 38, starred: false,
    summary: { status_category: 'blocked', status_detail: '', needs_action: 'Run the migration on staging first, or go straight to production?' },
    turns: [
      ['Migrate the orders table to the new schema and keep a rollback script.', ['Wrote the migration and a matching rollback script.', 'Run it on staging first, or go straight to production?'], ['Read', 'Write', 'Write', 'Bash']],
    ],
  },
  {
    id: 'tests', title: 'Write tests for the payment module', project: 'shop-api', ago: 130, last: 2, run: { status: 'busy' },
    summary: { status_category: 'completed', status_detail: 'Added 12 tests for refunds.', needs_action: '' },
    turns: [
      ['Add tests for the payment module, starting with refunds.', ['Added 12 tests for refunds.'], ['Read', 'Write', 'Bash']],
      ['Now cover partial refunds and failed captures.', ['Writing the cases for partial refunds first, then failed captures; the mock gateway needs a timeout option.'], ['Read', 'Edit', 'Edit', 'Bash', 'Bash']],
    ],
  },
  {
    id: 'upload', title: 'Refactor the image upload service', project: 'mobile-app', ago: 95, last: 4, run: { status: 'busy' },
    summary: null,
    turns: [
      ['Split the upload service into a queue and a worker, keep the public API.', ['Moved the retry logic into the worker; now updating the callers.'], ['Read', 'Edit', 'Edit', 'Edit', 'Bash']],
    ],
  },
  {
    id: 'deploy', title: 'Deploy a preview environment', project: 'docs-site', ago: 60, last: 6, run: { status: 'waiting', waitingFor: 'approve Bash: vercel deploy --prebuilt' },
    summary: null,
    turns: [
      ['Deploy a preview of the docs branch so I can check the new navigation.', ['Built the site; waiting for permission to deploy.'], ['Bash', 'Bash']],
    ],
  },
  {
    id: 'docs', title: 'Update the API docs to v3', project: 'docs-site', ago: 300, last: 70, starred: true,
    summary: { status_category: 'completed', status_detail: 'Updated 9 pages; every link works.', needs_action: '' },
    turns: [
      ['List the pages that still describe the v2 endpoints.', ['Found 9 pages that still describe the v2 endpoints.', 'Three of them also show the old authentication header.'], ['Grep', 'Grep', 'Read']],
      ['Update them to v3 and keep the examples runnable.', ['Updated the 9 pages and rewrote the examples for the v3 client.', 'Each example is now a file under `examples/` instead of an inline snippet.'], ['Read', 'Edit', 'Edit', 'Edit', 'Edit', 'Write', 'Bash']],
      ['Check that no link is broken.', ['Ran the link checker: every internal and external link works.', 'Two redirects were pointing at the old v2 URLs; I fixed them.'], ['Bash', 'Bash', 'Edit']],
      ['Add a short migration guide from v2 to v3.', ['Added `guides/migrate-to-v3.md` with a before/after table for each changed endpoint.', 'Linked it from the sidebar and the changelog.'], ['Write', 'Edit', 'Edit']],
      ['Open a pull request with a summary.', ['Opened a pull request with the changes grouped by section and a checklist for the reviewer.'], ['Bash', 'Bash']],
    ],
  },
  {
    id: 'ci', title: 'Fix the flaky CI job', project: 'shop-api', ago: 420, last: 95,
    summary: { status_category: 'completed', status_detail: 'CI is green again; the cause was a Node version mismatch.', needs_action: '' },
    turns: [
      ['The integration job fails about one run in five. Find out why.', ['The job runs on Node 20 in CI but 22 locally, and a timer test depends on the newer behavior.', 'Pinned the CI image to Node 22 and removed the retry that hid the failure.'], ['Bash', 'Read', 'Grep', 'Edit']],
    ],
  },
  {
    id: 'tokens', title: 'Audit the design tokens', project: 'design-system', ago: 360, last: 120,
    summary: { status_category: 'completed', status_detail: 'Found 14 unused tokens; removed 11 and listed 3 to review.', needs_action: '' },
    turns: [
      ['Find design tokens nobody uses.', ['Found 14 unused tokens; removed 11 and listed 3 to review.'], ['Grep', 'Grep', 'Edit', 'Write']],
    ],
  },
  {
    id: 'tokens-docs', title: 'Document the removed tokens', project: 'design-system', ago: 200, last: 130, parent: 'tokens',
    summary: { status_category: 'completed', status_detail: 'Added a changelog entry for the 11 removed tokens.', needs_action: '' },
    turns: [
      ['Write the changelog entry for the removed tokens.', ['Added a changelog entry for the 11 removed tokens.'], ['Read', 'Edit']],
    ],
  },
  {
    id: 'export', title: 'Add retries to the nightly export', project: 'data-pipeline', ago: 500, last: 160,
    summary: { status_category: 'completed', status_detail: 'Added retry with backoff to the export job; 6 tests added.', needs_action: '' },
    turns: [
      ['The nightly export sometimes dies on a network blip. Make it retry.', ['Added retry with exponential backoff to the export job; 6 tests added.'], ['Read', 'Edit', 'Write', 'Bash']],
    ],
  },
];

const clock = (now, minutesAgo) => new Date(now - minutesAgo * MIN).toISOString();

/**
 * Write the fake data under `dir` and return the options for SessionReader.
 * @param {string} dir an empty folder
 * @param {number} [now]
 * @param {number} [pid] a live process id, so the "running" threads look alive (default: this process)
 */
export function writeDemo(dir, now = Date.now(), pid = process.pid) {
  const desktopRoot = join(dir, 'claude-code-sessions');
  const desktopDir = join(desktopRoot, 'account', 'org');
  const registryDir = join(dir, 'claude', 'sessions');
  const projectsDir = join(dir, 'claude', 'projects');
  for (const d of [desktopDir, registryDir, projectsDir]) mkdirSync(d, { recursive: true });

  THREADS.forEach((t, n) => {
    const cwd = `${ROOT}/${t.project}`;
    const cliId = `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`;
    const hostId = `local_demo-${t.id}`;
    const thread = {
      sessionId: hostId, cliSessionId: cliId, title: t.title, cwd, originCwd: cwd,
      isStarred: t.starred === true, isArchived: false,
      createdAt: now - t.ago * MIN, lastActivityAt: now - t.last * MIN,
    };
    if (t.parent) thread.spawnedFrom = { sessionId: `local_demo-${t.parent}` };
    if (t.summary) thread.postTurnSummary = t.summary;
    writeFileSync(join(desktopDir, `${hostId}.json`), JSON.stringify(thread));

    if (t.run) {
      const entry = { pid, hostSessionId: hostId, sessionId: cliId, status: t.run.status, statusUpdatedAt: now - t.last * MIN };
      if (t.run.waitingFor) entry.waitingFor = t.run.waitingFor;
      writeFileSync(join(registryDir, `${pid}-${t.id}.json`), JSON.stringify(entry));
    }

    // the conversation: one entry per message, spread over the life of the thread
    const lines = [];
    const span = t.ago - t.last;
    t.turns.forEach(([prompt, reply, tools], i) => {
      const start = t.ago - (span * i) / t.turns.length;
      lines.push({ type: 'user', timestamp: clock(now, start), message: { content: prompt } });
      lines.push({ type: 'assistant', timestamp: clock(now, start - 0.4), message: { content: tools.map((name) => ({ type: 'tool_use', name })) } });
      lines.push({ type: 'assistant', timestamp: clock(now, start - 1.2), message: { content: [{ type: 'text', text: reply.join('\n\n') }] } });
    });
    const dirOfProject = join(projectsDir, t.project);
    mkdirSync(dirOfProject, { recursive: true });
    writeFileSync(join(dirOfProject, `${cliId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  });
  return { desktopDir: desktopRoot, registryDir, projectsDir };
}

/**
 * Made-up quotas for the demo and the screenshots: a fake key, a fake fetch and fixed token numbers.
 * The demo never reads your environment and never touches the network, whatever keys you have set.
 */
export function demoQuotas() {
  const body = { success: true, data: { remainingCredits: 130, planCredits: 1000, billingPeriodStart: '2026-11-01T00:00:00Z', billingPeriodEnd: '2026-12-01T00:00:00Z' } };
  return new QuotaService({
    env: { FIRECRAWL_API_KEY: 'demo-not-a-key' },
    fetch: /** @type {any} */ (async () => new Response(JSON.stringify(body), { status: 200 })),
    claude: { estimate: () => ({ fiveHour: 412_000, week: 6_850_000, warnings: [] }) },
  });
}
