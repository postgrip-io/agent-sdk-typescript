// End-to-end runnable example for the PostGrip Agent TypeScript SDK.
//
// Registers one activity (`greet`) and one workflow function
// (`greetingWorkflow`), starts an in-process Agent that polls the runtime
// service, then enqueues a workflow execution and waits for the result.
//
// Run:
//
//   export POSTGRIP_AGENT_LIVE_SERVER_URL=https://postgrip.app
//   export POSTGRIP_AGENT_AUTH_TOKEN=...           # management-side bearer
//   export POSTGRIP_AGENT_ENROLLMENT_KEY=...       # agent-side enrollment key
//   bun run example/greeting.ts
//
// `POSTGRIP_AGENT_ENROLLMENT_KEY` is read transparently by the Agent — the
// worker exchanges it for a refreshable agent session before its first poll.

import {
  Agent,
  Client,
  Connection,
  proxyActivities,
  type ActivityRegistry,
  type WorkflowRegistry,
} from '@postgrip/agent';

const activities = {
  async greet(name: string): Promise<string> {
    return `Hello, ${name}`;
  },
};

// `proxyActivities<typeof activities>` with the narrow type fails strict-mode
// variance against `Record<string, ActivityFunction>`. Drop the generic and
// cast the result to keep the narrow types at workflow call sites.
const { greet } = proxyActivities({
  startToCloseTimeoutMs: 10_000,
  retry: { maximumAttempts: 3 },
}) as typeof activities;

export async function greetingWorkflow(name: string): Promise<string> {
  return greet(name);
}

// The activity / workflow types use `unknown[]` for args; narrow signatures
// like `(name: string)` are correct at the call site (proxyActivities preserves
// `typeof activities`) but need a widening cast at the registry boundary.
const workflows = { greetingWorkflow } as unknown as WorkflowRegistry;
const activityRegistry = activities as unknown as ActivityRegistry;

async function main(): Promise<void> {
  const baseUrl = process.env.POSTGRIP_AGENTORCHESTRATOR_URL ?? process.env.POSTGRIP_AGENT_LIVE_SERVER_URL ?? 'https://agentorchestrator.postgrip.app';
  const authToken = process.env.POSTGRIP_AGENT_AUTH_TOKEN ?? '';
  const taskQueue = process.env.POSTGRIP_AGENT_TASK_QUEUE ?? 'typescript-example';

  const connection = await Connection.connect({
    baseUrl,
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
  });

  const agent = await Agent.create({
    connection,
    taskQueue,
    workflows,
    activities: activityRegistry,
    maxConcurrentTaskExecutions: 4,
  });

  const client = new Client({ connection });
  const workflowId = `typescript-example-${crypto.randomUUID()}`;

  const result = await agent.runUntil(
    client.workflow.execute('greetingWorkflow', {
      workflowId,
      taskQueue,
      args: ['PostGrip'],
      timeoutMs: 60_000,
    }),
  );

  console.log(`workflow ${workflowId} -> ${JSON.stringify(result)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
