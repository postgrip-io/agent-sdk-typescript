# Quick start

Two examples: enqueueing a task as a client, and running an agent that registers a workflow + activities.

## Enqueue a task

A program that just hands work to the runtime service needs only `Client` + `Connection`.

```ts
import { Client, Connection } from '@postgrip/agent';

const connection = await Connection.connect({
  // Agent token from Settings > Organization > Agent tokens.
  headers: { Authorization: `Bearer ${process.env.POSTGRIP_AGENT_TOKEN}` },
});

const client = new Client({ connection });

// shell.exec — runs whatever's on the agent's PATH.
const task = await client.task.shellExec({
  queue: 'default',
  command: 'echo',
  args: ['hello from agent'],
});
console.log('enqueued', task.id);

// container.exec — runs in a per-task container the agent launches via its
// docker CLI. Polyglot without bloating the agent image.
await client.task.containerExec({
  queue: 'default',
  image: 'node:22-alpine',
  command: 'node',
  args: ['-e', "console.log('hi from node')"],
  pullPolicy: 'missing',
  timeoutSeconds: 60,
});
```

!!! note
    `container.exec` requires the agent process to have `DOCKER_HOST` set so the container runs through the worker stack's docker socket proxy. Containers run with `--rm --network=none`, no host volume mounts, and the same env-key allowlist as `shell.exec`.

## Inspect or stream task events

`TaskClient` doesn't expose a single "wait for result" call for raw tasks — terminal results are workflow-shaped. To watch a `shell.exec` / `container.exec` task progress, stream its event log:

```ts
for await (const event of client.task.watchEvents(task.id)) {
  console.log(event.kind, event.message);
}
```

The async iterator closes when the task reaches a terminal state. For a one-shot snapshot of the events so far, use `client.task.events(task.id)` instead.

The "wait for terminal state and unwrap the value" pattern is the right fit for workflows — see [Start a workflow from elsewhere](#start-a-workflow-from-elsewhere) below, where `await handle.result()` resolves to the workflow's return value.

## Run an agent

Agents register workflow and activity functions, then poll the runtime service for tasks.

```ts
import {
  Agent,
  Client,
  Connection,
  proxyActivities,
} from '@postgrip/agent';

// Activities are plain async functions. Inside the body, activity helpers
// (heartbeat, activityMilestone, activityStdout, activityInfo) work via
// the per-task runtime the agent attaches.
const activities = {
  async greet(name: string): Promise<string> {
    return `Hello, ${name}`;
  },
};

// proxyActivities returns a typed proxy. Calling greet(...) inside a
// workflow schedules the activity via the runtime.
const { greet } = proxyActivities<typeof activities>({
  startToCloseTimeoutMs: 10_000,
  retry: { maximumAttempts: 3 },
});

// Workflows are regular async functions.
export async function greetingWorkflow(name: string): Promise<string> {
  return greet(name);
}

const connection = await Connection.connect({
  // Agent token from Settings > Organization > Agent tokens.
  headers: { Authorization: `Bearer ${process.env.POSTGRIP_AGENT_TOKEN}` },
});

const agent = await Agent.create({
  connection,
  namespace: 'default',
  taskQueue: 'default',
  workflows: { greetingWorkflow },
  activities,
  maxConcurrentTaskExecutions: 8,
});

const client = new Client({ connection });
const resultPromise = client.workflow.execute(greetingWorkflow, {
  namespace: 'default',
  taskQueue: 'default',
  workflowId: 'greeting-workflow-id',
  args: ['PostGrip'],
});

// runUntil starts the agent and resolves when the supplied promise does —
// convenient for one-shot scripts. For long-lived workers, use agent.run()
// and wire your own shutdown signaling.
await agent.runUntil(resultPromise);
console.log(await resultPromise);
```

The agent loops, leasing tasks from the configured queue, heartbeating each leased task, and dispatching to your registered functions. Concurrency is bounded by `maxConcurrentTaskExecutions` (default 4).

## Start a workflow from elsewhere

From the client side, start the workflow you registered above and read its result via a handle:

```ts
const handle = await client.workflow.start(greetingWorkflow, {
  workflowId: 'greeting-2',
  taskQueue: 'default',
  args: ['world'],
});

const result: string = await handle.result();
console.log(result); // Hello, world
```

`start` returns a `WorkflowHandle` — use it to wait, signal, query, update, cancel, terminate, or read history.

## Streaming events

Tasks emit ordered events (started / heartbeat / milestone / progress / stdout / stderr / completed / failed). To stream them as they land:

```ts
for await (const event of handle.watchEvents()) {
  console.log(event.kind, event.message);
}
```

The async iterator closes when the task reaches a terminal state.

## Where to next

- [Workflow runtime](workflow-runtime.md) — the durable replay model: how `sleep` / proxy-activity calls work under the hood, what determinism means, the sandbox, signals and queries, ContinueAsNew.
- [API](api.md) — the public surface re-exported from `@postgrip/agent`.
