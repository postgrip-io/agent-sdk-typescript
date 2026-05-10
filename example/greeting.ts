// End-to-end runnable example for the PostGrip Agent TypeScript SDK.
//
// Running it locally submits a workflow.runtime task to an existing agent
// pool. When the host agent launches the runtime, it registers one activity
// (`greet`) and one workflow function (`greetingWorkflow`) with delegated
// agent credentials.
//
// Run:
//
//   export POSTGRIP_AGENT_LIVE_SERVER_URL=https://postgrip.app
//   export POSTGRIP_AGENT_AUTH_TOKEN=...           # management-side bearer
//   export SDK_EXAMPLE_RUNTIME_ARGS_JSON='["-lc","bun run example/greeting.ts"]'
//   bun run example/greeting.ts
//
// The SDK does not enroll standalone agents; host agents inject delegated
// managed-runtime credentials.

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
  if (process.env.POSTGRIP_AGENT_MANAGED_RUNTIME !== 'true') {
    await submitManagedRuntime();
    return;
  }

  const baseUrl = process.env.POSTGRIP_AGENTORCHESTRATOR_URL ?? process.env.POSTGRIP_AGENT_LIVE_SERVER_URL ?? 'https://agentorchestrator.postgrip.app';
  const authToken = process.env.POSTGRIP_AGENT_AUTH_TOKEN ?? '';
  const tenantId = process.env.POSTGRIP_AGENT_TENANT_ID ?? '';
  const taskQueue = process.env.POSTGRIP_AGENT_TASK_QUEUE ?? 'typescript-example';
  const agentId = process.env.POSTGRIP_AGENT_ID ?? 'typescript-example-agent';
  const headers: Record<string, string> = {};
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  if (tenantId) headers['x-postgrip-agent-tenant-id'] = tenantId;

  const connection = await Connection.connect({
    baseUrl,
    headers,
  });

  const agent = await Agent.create({
    connection,
    identity: agentId,
    name: agentId,
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
      args: [process.env.SDK_EXAMPLE_GREETING_NAME ?? 'PostGrip'],
      ui: {
        displayName: 'TypeScript greeting example',
        description: 'Started from the TypeScript SDK greeting example.',
        details: { sdk: 'typescript' },
        tags: ['sdk-ui-demo', 'typescript'],
      },
      timeoutMs: 60_000,
    }),
  );

  console.log(`workflow ${workflowId} -> ${JSON.stringify(result)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

async function submitManagedRuntime(): Promise<void> {
  const baseUrl = process.env.POSTGRIP_AGENTORCHESTRATOR_URL ?? process.env.POSTGRIP_AGENT_LIVE_SERVER_URL ?? 'https://agentorchestrator.postgrip.app';
  const authToken = process.env.POSTGRIP_AGENT_AUTH_TOKEN ?? '';
  const tenantId = process.env.POSTGRIP_AGENT_TENANT_ID ?? '';
  const headers: Record<string, string> = {};
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  if (tenantId) headers['x-postgrip-agent-tenant-id'] = tenantId;
  const connection = await Connection.connect({ baseUrl, headers });
  const client = new Client({ connection });
  const args = JSON.parse(process.env.SDK_EXAMPLE_RUNTIME_ARGS_JSON ?? process.env.POSTGRIP_EXAMPLE_RUNTIME_ARGS_JSON ?? 'null') as unknown;
  if (!Array.isArray(args) || args.some((item) => typeof item !== 'string')) {
    throw new Error('SDK_EXAMPLE_RUNTIME_ARGS_JSON is required and must be a JSON array of strings');
  }
  const queue = process.env.SDK_EXAMPLE_RUNTIME_QUEUE ?? process.env.POSTGRIP_EXAMPLE_RUNTIME_QUEUE ?? 'default';
  const runtimeQueue = process.env.SDK_EXAMPLE_RUNTIME_CHILD_QUEUE ?? process.env.POSTGRIP_EXAMPLE_RUNTIME_CHILD_QUEUE ?? `postgrip-greeting-${crypto.randomUUID().slice(0, 8)}`;
  const pullPolicy = (process.env.SDK_EXAMPLE_RUNTIME_PULL_POLICY ?? process.env.POSTGRIP_EXAMPLE_RUNTIME_PULL_POLICY) as 'always' | 'missing' | 'never' | undefined;
  const task = await client.task.workflowRuntime({
    queue,
    runtimeQueue,
    image: process.env.SDK_EXAMPLE_RUNTIME_IMAGE ?? process.env.POSTGRIP_EXAMPLE_RUNTIME_IMAGE,
    command: process.env.SDK_EXAMPLE_RUNTIME_COMMAND ?? process.env.POSTGRIP_EXAMPLE_RUNTIME_COMMAND ?? 'sh',
    args,
    working_dir: process.env.SDK_EXAMPLE_RUNTIME_WORKING_DIR ?? process.env.POSTGRIP_EXAMPLE_RUNTIME_WORKING_DIR,
    pull_policy: pullPolicy,
    timeout_seconds: 300,
    leaseTimeoutSeconds: 30,
    env: {
      SDK_EXAMPLE_GREETING_NAME: process.env.SDK_EXAMPLE_GREETING_NAME ?? 'PostGrip',
    },
  });
  console.log(`submitted managed workflow runtime task=${task.id} queue=${queue} runtimeQueue=${runtimeQueue}`);
}
