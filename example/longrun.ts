// Long-running sequential example.
//
// Runs five workflows back-to-back. Each workflow chains five activity
// calls separated by 13-second durable timers, so a single workflow lasts
// ~65-75 seconds and a full run takes ~5-6 minutes. Exercises the TS SDK's
// replay, suspension, and durable-timer paths under realistic timing.
//
// Run:
//
//   export POSTGRIP_AGENTORCHESTRATOR_URL=https://agentorchestrator.postgrip.app
//   export POSTGRIP_AGENT_AUTH_TOKEN=...
//   export POSTGRIP_AGENT_ENROLLMENT_KEY=...
//   bun run example/longrun.ts

import {
  Agent,
  Client,
  Connection,
  proxyActivities,
  sleep,
  type ActivityRegistry,
  type WorkflowRegistry,
} from '@postgrip/agent';

const STEPS_PER_WORKFLOW = 5;
const WORKFLOW_RUNS = 5;
const STEP_SLEEP_MS = 13_000;

const activities = {
  async processStep(name: string, step: number): Promise<string> {
    return `processed step ${step} for ${name}`;
  },
};

const { processStep } = proxyActivities({
  startToCloseTimeoutMs: 30_000,
  retry: { maximumAttempts: 3 },
}) as typeof activities;

export async function LongRunningWorkflow(name: string, steps: number): Promise<string> {
  for (let i = 1; i <= steps; i++) {
    await processStep(name, i);
    await sleep(STEP_SLEEP_MS);
  }
  return `completed ${steps} steps for ${name}`;
}

const workflows = { LongRunningWorkflow } as unknown as WorkflowRegistry;
const activityRegistry = activities as unknown as ActivityRegistry;

async function main(): Promise<void> {
  const baseUrl = process.env.POSTGRIP_AGENTORCHESTRATOR_URL ?? process.env.POSTGRIP_AGENT_LIVE_SERVER_URL ?? 'https://agentorchestrator.postgrip.app';
  const authToken = process.env.POSTGRIP_AGENT_AUTH_TOKEN ?? '';
  const taskQueue = process.env.POSTGRIP_AGENT_TASK_QUEUE ?? 'typescript-longrun';

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

  await agent.runUntil((async () => {
    const overallStart = Date.now();
    for (let i = 1; i <= WORKFLOW_RUNS; i++) {
      const runStart = Date.now();
      const workflowId = `ts-longrun-${crypto.randomUUID()}-${i}`;
      console.log(`[${i}/${WORKFLOW_RUNS}] starting ${workflowId}`);
      const result = await client.workflow.execute('LongRunningWorkflow', {
        workflowId,
        taskQueue,
        args: [`PostGrip-${i}`, STEPS_PER_WORKFLOW],
        timeoutMs: 5 * 60_000,
      });
      console.log(`[${i}/${WORKFLOW_RUNS}] ${workflowId} -> ${JSON.stringify(result)} (${Math.round((Date.now() - runStart) / 1000)}s)`);
    }
    console.log(`done — ${WORKFLOW_RUNS} workflows in ${Math.round((Date.now() - overallStart) / 1000)}s`);
  })());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
