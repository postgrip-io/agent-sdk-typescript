import type {
  BackfillScheduleRequest,
  BackfillScheduleResponse,
  CompactResponse,
  CreateScheduleRequest,
  Namespace,
  EnqueueTaskRequest,
  PauseScheduleRequest,
  PollTaskResponse,
  Schedule,
  ScheduleState,
  TriggerScheduleRequest,
  TriggerScheduleResponse,
  UnpauseScheduleRequest,
  UpdateScheduleRequest,
  CancelWorkflowRequest,
  TerminateWorkflowRequest,
  Task,
  TaskEvent,
  TaskEventInput,
  TaskResult,
  TaskState,
  WorkflowExecution,
  WorkflowCountResponse,
  WorkflowHistoryEvent,
  SignalWorkflowRequest,
  SignalWithStartWorkflowRequest,
  SignalWithStartWorkflowResponse,
} from './types.js';
import {
  HEADER_AGENT_SIGNATURE,
  HEADER_AGENT_SIGNATURE_KEY_ID,
  HEADER_AGENT_SIGNATURE_TIMESTAMP,
  generateSigningKey,
  importSigningKeyFromBase64,
  signRequest,
  type AgentSigningKey,
} from './_signing.js';

export interface ConnectionOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  headers?: HeadersInit;
  agentAuth?: AgentAuthOptions;
}

export interface AgentAuthOptions {
  enrollmentKey?: string;
  agentId?: string;
  workerId?: string;
  name?: string;
  host?: string;
  namespace?: string;
  queue?: string;
  accessToken?: string;
  refreshToken?: string;
  accessExpiresAt?: string;
  signingPrivateKey?: string;
}

interface PollTaskOptions {
  namespace?: string;
  queue: string;
  agentId?: string;
  workerId?: string;
  waitSeconds?: number;
  taskTypes?: string[];
  signal?: AbortSignal;
}

interface AgentSessionResponse {
  agentId?: string;
  tenantId: string;
  tokenFamilyId: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
  status: string;
  trustState: string;
}

export class Connection {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: HeadersInit | undefined;
  private agentAuth: AgentAuthOptions = {};
  private agentSessionRefresh: Promise<void> | undefined;
  // Ed25519 keypair the agent uses to sign requests to agent-authed
  // endpoints. Generated lazily on first enroll and reused for the lifetime
  // of the Connection.
  private agentSigningKey: AgentSigningKey | undefined;

  private constructor(options: Required<Pick<ConnectionOptions, 'baseUrl'>> & Omit<ConnectionOptions, 'baseUrl'>) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? fetch;
    this.headers = options.headers;
    this.configureAgentAuth(options.agentAuth ?? {});
  }

  static async connect(options: ConnectionOptions = {}): Promise<Connection> {
    const connection = new Connection({
      ...options,
      baseUrl: options.baseUrl ?? process.env.POSTGRIP_AGENTORCHESTRATOR_URL ?? 'http://127.0.0.1:4100',
    });
    await connection.health();
    return connection;
  }

  async health(): Promise<{ status: string }> {
    return this.request('GET', '/healthz');
  }

  configureAgentAuth(options: AgentAuthOptions): void {
    const normalized = normalizeAgentAuthOptions(options);
    this.agentAuth = {
      ...this.agentAuth,
      ...Object.fromEntries(Object.entries(normalized).filter(([, value]) => value != null && value !== '')),
    };
    if (normalized.signingPrivateKey) {
      this.agentSigningKey = importSigningKeyFromBase64(normalized.signingPrivateKey);
    }
  }

  async ensureAgentSession(options: AgentAuthOptions = {}): Promise<boolean> {
    this.configureAgentAuth(options);
    if (this.agentAuth.accessToken && accessTokenIsFresh(this.agentAuth.accessExpiresAt)) {
      return true;
    }
    if (!this.agentAuth.refreshToken && !this.agentAuth.enrollmentKey) {
      return false;
    }
    if (!this.agentSessionRefresh) {
      this.agentSessionRefresh = this.refreshOrEnrollAgentSession().finally(() => {
        this.agentSessionRefresh = undefined;
      });
    }
    await this.agentSessionRefresh;
    return Boolean(this.agentAuth.accessToken);
  }

  async ready(): Promise<{ status: string; stats: Record<string, number> }> {
    return this.request('GET', '/readyz');
  }

  async listNamespaces(): Promise<Namespace[]> {
    return this.request('GET', '/api/v1/namespaces');
  }

  async createNamespace(name: string): Promise<Namespace> {
    return this.request('POST', '/api/v1/namespaces', { name });
  }

  async compact(options: { retentionSeconds?: number } = {}): Promise<CompactResponse> {
    return this.request('POST', '/api/v1/admin/compact', { retention_seconds: options.retentionSeconds ?? 0 });
  }

  async enqueueTask<P = unknown, R = unknown>(request: EnqueueTaskRequest<P>): Promise<Task<P, R>> {
    return this.request('POST', '/api/v1/tasks', request);
  }

  async listTasks<P = unknown, R = unknown>(options: {
    namespace?: string;
    queue?: string;
    type?: string;
    state?: TaskState;
    limit?: number;
    offset?: number;
  } = {}): Promise<Task<P, R>[]> {
    const query = new URLSearchParams();
    if (options.namespace) query.set('namespace', options.namespace);
    if (options.queue) query.set('queue', options.queue);
    if (options.type) query.set('type', options.type);
    if (options.state) query.set('state', options.state);
    if (options.limit != null) query.set('limit', String(options.limit));
    if (options.offset != null) query.set('offset', String(options.offset));
    return this.request('GET', `/api/v1/tasks${query.size ? `?${query.toString()}` : ''}`);
  }

  async getTask<P = unknown, R = unknown>(taskId: string): Promise<Task<P, R>> {
    return this.request('GET', `/api/v1/tasks/${encodeURIComponent(taskId)}`);
  }

  async getTaskEvents(taskId: string): Promise<TaskEvent[]> {
    return this.request('GET', `/api/v1/tasks/${encodeURIComponent(taskId)}/events`);
  }

  async createSchedule<Args extends unknown[] = unknown[]>(request: CreateScheduleRequest<Args>): Promise<Schedule<Args>> {
    return this.request('POST', '/api/v1/schedules', request);
  }

  async listSchedules<Args extends unknown[] = unknown[]>(options: {
    namespace?: string;
    state?: ScheduleState;
    limit?: number;
    offset?: number;
  } = {}): Promise<Array<Schedule<Args>>> {
    const query = new URLSearchParams();
    if (options.namespace) query.set('namespace', options.namespace);
    if (options.state) query.set('state', options.state);
    if (options.limit != null) query.set('limit', String(options.limit));
    if (options.offset != null) query.set('offset', String(options.offset));
    return this.request('GET', `/api/v1/schedules${query.size ? `?${query.toString()}` : ''}`);
  }

  async getSchedule<Args extends unknown[] = unknown[]>(scheduleId: string): Promise<Schedule<Args>> {
    return this.request('GET', `/api/v1/schedules/${encodeURIComponent(scheduleId)}`);
  }

  async updateSchedule<Args extends unknown[] = unknown[]>(scheduleId: string, request: UpdateScheduleRequest<Args>): Promise<Schedule<Args>> {
    return this.request('PATCH', `/api/v1/schedules/${encodeURIComponent(scheduleId)}`, request);
  }

  async deleteSchedule<Args extends unknown[] = unknown[]>(scheduleId: string): Promise<Schedule<Args>> {
    return this.request('DELETE', `/api/v1/schedules/${encodeURIComponent(scheduleId)}`);
  }

  async pauseSchedule<Args extends unknown[] = unknown[]>(scheduleId: string, request: PauseScheduleRequest = {}): Promise<Schedule<Args>> {
    return this.request('POST', `/api/v1/schedules/${encodeURIComponent(scheduleId)}/pause`, request);
  }

  async unpauseSchedule<Args extends unknown[] = unknown[]>(scheduleId: string, request: UnpauseScheduleRequest = {}): Promise<Schedule<Args>> {
    return this.request('POST', `/api/v1/schedules/${encodeURIComponent(scheduleId)}/unpause`, request);
  }

  async triggerSchedule<Args extends unknown[] = unknown[], R = unknown>(
    scheduleId: string,
    request: TriggerScheduleRequest = {},
  ): Promise<TriggerScheduleResponse<Args, R>> {
    return this.request('POST', `/api/v1/schedules/${encodeURIComponent(scheduleId)}/trigger`, request);
  }

  async backfillSchedule<Args extends unknown[] = unknown[], R = unknown>(
    scheduleId: string,
    request: BackfillScheduleRequest,
  ): Promise<BackfillScheduleResponse<Args, R>> {
    return this.request('POST', `/api/v1/schedules/${encodeURIComponent(scheduleId)}/backfill`, request);
  }

  async listWorkflows<R = unknown>(options: {
    namespace?: string;
    id?: string;
    runId?: string;
    type?: string;
    queue?: string;
    state?: WorkflowExecution['state'];
    query?: string;
    orderBy?: string;
    pageToken?: string;
    searchAttributes?: Record<string, string | number | boolean>;
    limit?: number;
    offset?: number;
  } = {}): Promise<WorkflowExecution<R>[]> {
    const query = new URLSearchParams();
    if (options.namespace) query.set('namespace', options.namespace);
    if (options.id) query.set('id', options.id);
    if (options.runId) query.set('run_id', options.runId);
    if (options.type) query.set('type', options.type);
    if (options.queue) query.set('queue', options.queue);
    if (options.state) query.set('state', options.state);
    if (options.query) query.set('query', options.query);
    if (options.orderBy) query.set('order_by', options.orderBy);
    if (options.pageToken) query.set('page_token', options.pageToken);
    if (options.limit != null) query.set('limit', String(options.limit));
    if (options.offset != null) query.set('offset', String(options.offset));
    for (const [key, value] of Object.entries(options.searchAttributes ?? {})) {
      query.set(`search.${key}`, String(value));
    }
    return this.request('GET', `/api/v1/workflows${query.size ? `?${query.toString()}` : ''}`);
  }

  async countWorkflows(options: {
    namespace?: string;
    id?: string;
    runId?: string;
    type?: string;
    queue?: string;
    state?: WorkflowExecution['state'];
    query?: string;
    searchAttributes?: Record<string, string | number | boolean>;
  } = {}): Promise<WorkflowCountResponse> {
    const query = new URLSearchParams();
    if (options.namespace) query.set('namespace', options.namespace);
    if (options.id) query.set('id', options.id);
    if (options.runId) query.set('run_id', options.runId);
    if (options.type) query.set('type', options.type);
    if (options.queue) query.set('queue', options.queue);
    if (options.state) query.set('state', options.state);
    if (options.query) query.set('query', options.query);
    for (const [key, value] of Object.entries(options.searchAttributes ?? {})) {
      query.set(`search.${key}`, String(value));
    }
    return this.request('GET', `/api/v1/workflows/count${query.size ? `?${query.toString()}` : ''}`);
  }

  async getWorkflow<R = unknown>(workflowId: string): Promise<WorkflowExecution<R>> {
    return this.request('GET', `/api/v1/workflows/${encodeURIComponent(workflowId)}`);
  }

  async getWorkflowHistory(workflowId: string): Promise<WorkflowHistoryEvent[]> {
    return this.request('GET', `/api/v1/workflows/${encodeURIComponent(workflowId)}/history`);
  }

  async signalWorkflow<Args extends unknown[] = unknown[]>(workflowId: string, request: SignalWorkflowRequest<Args>): Promise<WorkflowHistoryEvent> {
    return this.request('POST', `/api/v1/workflows/${encodeURIComponent(workflowId)}/signal`, request);
  }

  async signalWithStartWorkflow<WorkflowArgs extends unknown[] = unknown[], SignalArgs extends unknown[] = unknown[], R = unknown>(
    workflowId: string,
    request: SignalWithStartWorkflowRequest<WorkflowArgs, SignalArgs>,
  ): Promise<SignalWithStartWorkflowResponse<WorkflowArgs, R>> {
    return this.request('POST', `/api/v1/workflows/${encodeURIComponent(workflowId)}/signal-with-start`, request);
  }

  async cancelWorkflow(workflowId: string, request: CancelWorkflowRequest = {}): Promise<WorkflowHistoryEvent> {
    return this.request('POST', `/api/v1/workflows/${encodeURIComponent(workflowId)}/cancel`, request);
  }

  async terminateWorkflow(workflowId: string, request: TerminateWorkflowRequest = {}): Promise<WorkflowHistoryEvent> {
    return this.request('POST', `/api/v1/workflows/${encodeURIComponent(workflowId)}/terminate`, request);
  }

  async pollTask<P = unknown, R = unknown>(options: PollTaskOptions): Promise<Task<P, R> | undefined> {
    const agentId = options.agentId ?? options.workerId;
    if (!agentId) {
      throw new Error('agentId is required');
    }
    const query = new URLSearchParams({
      namespace: options.namespace ?? 'default',
      queue: options.queue,
      agent_id: agentId,
      wait_seconds: String(options.waitSeconds ?? 20),
    });
    if (options.taskTypes?.length) {
      query.set('task_types', options.taskTypes.join(','));
    }
    await this.ensureAgentSession({ namespace: options.namespace ?? 'default', queue: options.queue, agentId });
    const response = await this.request<PollTaskResponse<P, R>>('GET', `/api/v1/agent/poll?${query.toString()}`, undefined, options.signal, { agentAuth: true });
    return response.task;
  }

  async heartbeatTask(taskId: string, agentId: string, event?: TaskEventInput): Promise<Task> {
    await this.ensureAgentSession({ agentId });
    return this.request('POST', this.agentTaskPath(taskId, 'heartbeat', agentId), { event }, undefined, { agentAuth: true });
  }

  async appendTaskEvent(taskId: string, agentId: string, event: TaskEventInput): Promise<TaskEvent> {
    await this.ensureAgentSession({ agentId });
    return this.request('POST', this.agentTaskPath(taskId, 'events', agentId), { event }, undefined, { agentAuth: true });
  }

  async completeTask<R = unknown>(taskId: string, agentId: string, result: TaskResult<R>): Promise<Task> {
    await this.ensureAgentSession({ agentId });
    return this.request('POST', this.agentTaskPath(taskId, 'complete', agentId), { result }, undefined, { agentAuth: true });
  }

  async blockTask(taskId: string, agentId: string, reason?: string): Promise<Task> {
    await this.ensureAgentSession({ agentId });
    return this.request('POST', this.agentTaskPath(taskId, 'block', agentId), { reason }, undefined, { agentAuth: true });
  }

  async failTask<R = unknown>(taskId: string, agentId: string, error: string, result?: TaskResult<R>): Promise<Task> {
    await this.ensureAgentSession({ agentId });
    return this.request('POST', this.agentTaskPath(taskId, 'fail', agentId), { error, result }, undefined, { agentAuth: true });
  }

  private agentTaskPath(taskId: string, action: string, agentId: string): string {
    return `/api/v1/agent/tasks/${encodeURIComponent(taskId)}/${action}?agent_id=${encodeURIComponent(agentId)}`;
  }

  private async refreshOrEnrollAgentSession(): Promise<void> {
    if (this.agentAuth.refreshToken) {
      try {
        const session = await this.request<AgentSessionResponse>('POST', '/api/v1/agent/session/refresh', {
          refreshToken: this.agentAuth.refreshToken,
        });
        this.applyAgentSession(session);
        return;
      } catch (err) {
        if (!this.agentAuth.enrollmentKey) {
          throw err;
        }
      }
    }
    if (!this.agentAuth.enrollmentKey) {
      return;
    }
    if (!this.agentSigningKey) {
      this.agentSigningKey = generateSigningKey();
    }
    const session = await this.request<AgentSessionResponse>('POST', '/api/v1/agent/enroll', {
      enrollmentKey: this.agentAuth.enrollmentKey,
      agentId: this.agentAuth.agentId,
      name: this.agentAuth.name ?? this.agentAuth.agentId,
      host: this.agentAuth.host,
      namespaces: [this.agentAuth.namespace ?? 'default'],
      queues: [this.agentAuth.queue ?? 'default'],
      signaturePublicKey: this.agentSigningKey.publicKeyBase64,
    });
    this.applyAgentSession(session);
  }

  private applyAgentSession(session: AgentSessionResponse): void {
    this.configureAgentAuth({
      agentId: session.agentId,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      accessExpiresAt: session.accessExpiresAt,
    });
  }

  private async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal, options: { agentAuth?: boolean } = {}): Promise<T> {
    const useAgentAuth = options.agentAuth === true || this.shouldUseAgentRuntimeAuth(path);
    if (useAgentAuth) {
      await this.ensureAgentSession();
    }
    const headers = new Headers(this.headers);
    if (useAgentAuth && this.agentAuth.accessToken) {
      headers.set('Authorization', `Bearer ${this.agentAuth.accessToken}`);
    }
    if (body != null) {
      headers.set('Content-Type', 'application/json');
    }
    const bodyString = body == null ? '' : JSON.stringify(body);
    if (useAgentAuth && this.agentSigningKey) {
      const queryStart = path.indexOf('?');
      const reqPath = queryStart === -1 ? path : path.slice(0, queryStart);
      const reqQuery = queryStart === -1 ? '' : path.slice(queryStart + 1);
      const ts = Math.floor(Date.now() / 1000);
      headers.set(HEADER_AGENT_SIGNATURE_TIMESTAMP, String(ts));
      headers.set(HEADER_AGENT_SIGNATURE_KEY_ID, this.agentSigningKey.keyId);
      headers.set(HEADER_AGENT_SIGNATURE, signRequest(
        this.agentSigningKey.privateKey, method, reqPath, reqQuery, ts, Buffer.from(bodyString),
      ));
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      signal,
      headers,
      body: body == null ? undefined : bodyString,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(typeof payload.error === 'string' ? payload.error : response.statusText);
    }
    const text = await response.text();
    if (text === '') {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new Error(`postgrip-agent: ${method} ${path} -> ${response.status} (parse failed): ${text.slice(0, 200)}`);
    }
  }

  private shouldUseAgentRuntimeAuth(path: string): boolean {
    if (!this.agentAuth.accessToken && !this.agentAuth.refreshToken) {
      return false;
    }
    const queryStart = path.indexOf('?');
    const reqPath = queryStart === -1 ? path : path.slice(0, queryStart);
    return reqPath === '/api/v1/tasks'
      || reqPath.startsWith('/api/v1/tasks/')
      || reqPath === '/api/v1/workflows'
      || reqPath.startsWith('/api/v1/workflows/')
      || reqPath === '/api/v1/namespaces';
  }
}

function accessTokenIsFresh(expiresAt: string | undefined): boolean {
  if (!expiresAt) return false;
  const expiresAtMs = Date.parse(expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs > Date.now() + 30_000;
}

function normalizeAgentAuthOptions(options: AgentAuthOptions): AgentAuthOptions {
  const { workerId, ...canonical } = options;
  return {
    ...canonical,
    agentId: options.agentId ?? workerId,
  };
}
