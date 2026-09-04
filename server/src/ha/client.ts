import WebSocket from 'ws';

export interface HassState {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
  last_changed: string;
  last_updated: string;
}

export interface HaStatus {
  connected: boolean;
  version: string | null;
  lastError: string | null;
  /** Set when HA rejected the token. Retrying will not help until the token is replaced. */
  authFailed: boolean;
}

type StateListener = (entityId: string, state: HassState | null) => void;
type StatusListener = (status: HaStatus) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

const COMMAND_TIMEOUT_MS = 15_000;
const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

/**
 * Minimal client for the Home Assistant WebSocket API.
 *
 * Protocol: connect to /api/websocket, HA sends `auth_required`, we reply with
 * `auth`, HA replies `auth_ok`. After that every command carries an incrementing
 * `id` and gets a matching `result` message back. Ids restart at 1 on each new
 * connection, so the pending map is cleared on close.
 */
export class HaClient {
  readonly states = new Map<string, HassState>();

  #wsUrl: string;
  #token: string;
  #log: (message: string, extra?: unknown) => void;

  #ws: WebSocket | null = null;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #stateListeners = new Set<StateListener>();
  #statusListeners = new Set<StatusListener>();

  #status: HaStatus = { connected: false, version: null, lastError: null, authFailed: false };
  #backoffMs = BACKOFF_MIN_MS;
  #pingTimer: NodeJS.Timeout | null = null;
  #pongTimer: NodeJS.Timeout | null = null;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #stopped = false;

  /** Events that arrive while the initial get_states is still in flight. */
  #eventBuffer: { entityId: string; state: HassState | null }[] | null = null;

  constructor(baseUrl: string, token: string, log: (message: string, extra?: unknown) => void) {
    this.#wsUrl = `${baseUrl.replace(/^http/, 'ws')}/api/websocket`;
    this.#token = token;
    this.#log = log;
  }

  get status(): HaStatus {
    return { ...this.#status };
  }

  start(): void {
    this.#stopped = false;
    this.#open();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#ws?.close();
    this.#ws = null;
    this.#clearHeartbeat();
  }

  addStateListener(listener: StateListener): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  addStatusListener(listener: StatusListener): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  async callService(
    domain: string,
    service: string,
    entityId: string,
    serviceData: Record<string, unknown> = {},
  ): Promise<void> {
    await this.#send({
      type: 'call_service',
      domain,
      service,
      target: { entity_id: entityId },
      service_data: serviceData,
    });
  }

  // --- connection lifecycle ---

  #open(): void {
    const ws = new WebSocket(this.#wsUrl);
    this.#ws = ws;

    ws.on('message', (raw) => this.#onMessage(raw));
    ws.on('close', (code) => this.#onClose(code));
    ws.on('error', (error: Error) => {
      // An error event is always followed by close, which schedules the reconnect.
      this.#setStatus({ lastError: error.message });
    });
  }

  #onClose(code: number): void {
    const wasConnected = this.#status.connected;
    this.#clearHeartbeat();
    this.#ws = null;
    this.#eventBuffer = null;

    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Home Assistant connection closed'));
    }
    this.#pending.clear();
    this.#nextId = 1;

    this.#setStatus({ connected: false });
    if (wasConnected) this.#log(`Home Assistant disconnected (code ${code})`);

    if (this.#stopped) return;

    // A bad token is not a transient fault, so do not hammer HA over it.
    const delay = this.#status.authFailed ? BACKOFF_MAX_MS : this.#backoffMs;
    this.#backoffMs = Math.min(this.#backoffMs * 2, BACKOFF_MAX_MS);
    this.#reconnectTimer = setTimeout(() => this.#open(), delay + Math.floor(Math.random() * 500));
  }

  #onMessage(raw: WebSocket.RawData): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      this.#log('Ignoring unparseable message from Home Assistant');
      return;
    }

    switch (message['type']) {
      case 'auth_required':
        this.#ws?.send(JSON.stringify({ type: 'auth', access_token: this.#token }));
        return;

      case 'auth_ok':
        this.#backoffMs = BACKOFF_MIN_MS;
        this.#setStatus({
          connected: true,
          version: typeof message['ha_version'] === 'string' ? message['ha_version'] : null,
          lastError: null,
          authFailed: false,
        });
        this.#log(`Home Assistant connected (${this.#status.version ?? 'unknown version'})`);
        this.#startHeartbeat();
        void this.#bootstrap();
        return;

      case 'auth_invalid':
        this.#setStatus({
          authFailed: true,
          lastError: typeof message['message'] === 'string' ? message['message'] : 'auth_invalid',
        });
        this.#log('Home Assistant rejected the access token - replace HA_TOKEN');
        this.#ws?.close();
        return;

      case 'pong':
        if (this.#pongTimer) clearTimeout(this.#pongTimer);
        this.#pongTimer = null;
        return;

      case 'event':
        this.#onEvent(message['event']);
        return;

      case 'result': {
        const id = message['id'];
        if (typeof id !== 'number') return;
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        if (message['success'] === true) {
          pending.resolve(message['result']);
        } else {
          const error = message['error'] as { message?: string } | undefined;
          pending.reject(new Error(error?.message ?? 'Home Assistant returned an error'));
        }
        return;
      }

      default:
        return;
    }
  }

  /**
   * Subscribe before snapshotting, buffering anything that arrives in between -
   * the other order silently drops changes that land mid-fetch.
   */
  async #bootstrap(): Promise<void> {
    this.#eventBuffer = [];
    try {
      await this.#send({ type: 'subscribe_events', event_type: 'state_changed' });
      const snapshot = (await this.#send({ type: 'get_states' })) as HassState[];

      this.states.clear();
      for (const state of snapshot) this.states.set(state.entity_id, state);

      const buffered = this.#eventBuffer ?? [];
      this.#eventBuffer = null;
      for (const { entityId, state } of buffered) this.#applyState(entityId, state);

      for (const state of this.states.values()) this.#emitState(state.entity_id, state);
    } catch (error) {
      this.#eventBuffer = null;
      this.#setStatus({ lastError: error instanceof Error ? error.message : String(error) });
      this.#log('Home Assistant bootstrap failed, dropping the connection', error);
      this.#ws?.close();
    }
  }

  #onEvent(event: unknown): void {
    const payload = event as {
      event_type?: string;
      data?: { entity_id?: string; new_state?: HassState | null };
    };
    if (payload?.event_type !== 'state_changed') return;
    const entityId = payload.data?.entity_id;
    if (!entityId) return;
    const newState = payload.data?.new_state ?? null;

    if (this.#eventBuffer) {
      this.#eventBuffer.push({ entityId, state: newState });
      return;
    }
    this.#applyState(entityId, newState);
    this.#emitState(entityId, newState);
  }

  #applyState(entityId: string, state: HassState | null): void {
    if (state) {
      this.states.set(entityId, state);
    } else {
      this.states.delete(entityId);
    }
  }

  #emitState(entityId: string, state: HassState | null): void {
    for (const listener of this.#stateListeners) {
      try {
        listener(entityId, state);
      } catch (error) {
        this.#log('A state listener threw', error);
      }
    }
  }

  #setStatus(patch: Partial<HaStatus>): void {
    this.#status = { ...this.#status, ...patch };
    const snapshot = this.status;
    for (const listener of this.#statusListeners) {
      try {
        listener(snapshot);
      } catch (error) {
        this.#log('A status listener threw', error);
      }
    }
  }

  #send(message: Record<string, unknown>): Promise<unknown> {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Home Assistant is not connected'));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Home Assistant did not answer command ${id} in time`));
      }, COMMAND_TIMEOUT_MS);
      this.#pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ ...message, id }));
    });
  }

  // --- heartbeat ---
  // A half-open TCP connection looks identical to an idle one, so ping and
  // require a pong; a missed pong is what actually triggers the reconnect.

  #startHeartbeat(): void {
    this.#clearHeartbeat();
    this.#pingTimer = setInterval(() => {
      if (this.#pongTimer) return;
      this.#pongTimer = setTimeout(() => {
        this.#log('Home Assistant missed a pong, terminating the socket');
        this.#ws?.terminate();
      }, PONG_TIMEOUT_MS);
      this.#send({ type: 'ping' }).catch(() => {
        /* the close handler deals with it */
      });
    }, PING_INTERVAL_MS);
  }

  #clearHeartbeat(): void {
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    if (this.#pongTimer) clearTimeout(this.#pongTimer);
    this.#pingTimer = null;
    this.#pongTimer = null;
  }
}
