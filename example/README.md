# example/

Runnable examples that exercise the PostGrip Agent TypeScript SDK end-to-end
against a live runtime service.

## greeting

A single-process demo: it starts an Agent that registers one activity and one
workflow function, then enqueues a workflow execution from the same process
and waits for the result.

```sh
export POSTGRIP_AGENT_LIVE_SERVER_URL=https://postgrip.app
export POSTGRIP_AGENT_AUTH_TOKEN=...           # management-side bearer token
export POSTGRIP_AGENT_ENROLLMENT_KEY=...       # local standalone only
bun run example/greeting.ts
```

Optional overrides:

| Variable                       | Default                |
|:-------------------------------|:-----------------------|
| `POSTGRIP_AGENT_TASK_QUEUE`    | `typescript-example`   |

When a PostGrip host agent launches the example as a `workflow.runtime` task,
it injects delegated session credentials. `POSTGRIP_AGENT_ENROLLMENT_KEY` is
only for local standalone runs where no host agent is supervising the runtime.

## In-repo development

The example imports from the published package name `@postgrip/agent`. To run
it directly out of this repo without installing from npm, run `bun link` from
the repo root once and `bun link @postgrip/agent` from your example workspace,
or replace the import path with `../src/index.ts`.
