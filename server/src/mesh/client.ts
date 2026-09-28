import mqtt, { type MqttClient } from 'mqtt';

/**
 * Client for a Meshtastic node bridged onto the local Mosquitto broker with
 * `mqtt.json_enabled` on. The node publishes decoded packets as JSON under
 * `<root>/2/json/<channelname>/<!gatewayid>` and a retained online/offline
 * status under `<root>/2/stat/<!gatewayid>` (LWT). Sending goes the other way:
 * a JSON envelope published to `<root>/2/json/mqtt/` that the gateway node
 * picks up and transmits over LoRa.
 */

export interface MeshClientConfig {
  mqttUrl: string;
  rootTopic: string;
  /** Channel NAME - it is a topic path segment on the uplink side. */
  channel: string;
  /** Channel INDEX - the downlink envelope selects the TX channel by number. */
  channelIndex: number | null;
  /** The gateway node's decimal node number; downlinks with any other `from` are dropped. */
  gatewayNode: number | null;
}

export interface MeshMessage {
  /** Packet id from the envelope; dashboard-sent messages get a synthetic negative id. */
  id: number;
  /** Sender's decimal node number; 0 for dashboard-sent messages. */
  from: number;
  /** 4294967295 (broadcast) unless it was a DM. */
  to: number;
  channel: number;
  text: string;
  /** Epoch seconds. Nodes without time sync send 0; we substitute receive time. */
  timestamp: number;
  /** True for messages sent from this dashboard - the gateway never uplinks its own TX. */
  viaDashboard: boolean;
}

export interface MeshNode {
  num: number;
  /** "!hex" id from nodeinfo. */
  id: string | null;
  longName: string | null;
  shortName: string | null;
  batteryLevel: number | null;
  voltage: number | null;
  snr: number | null;
  rssi: number | null;
  /** Epoch seconds of the newest packet seen from this node. */
  lastHeard: number;
}

export interface MeshStatus {
  /** Our connection to the broker. */
  connected: boolean;
  /** The gateway node's retained stat topic; null until the first frame arrives. */
  gatewayOnline: boolean | null;
  lastError: string | null;
}

export interface MeshSummary {
  status: MeshStatus;
  channel: string;
  canSend: boolean;
  /** Oldest first, capped at MESSAGE_CAP. */
  messages: MeshMessage[];
  /** Sorted by lastHeard, newest first. */
  nodes: MeshNode[];
}

const MESSAGE_CAP = 50;

/** The JSON envelope the firmware publishes; every field treated as optional. */
interface Envelope {
  id?: number;
  from?: number;
  to?: number;
  channel?: number;
  timestamp?: number;
  type?: string;
  snr?: number;
  rssi?: number;
  payload?: Record<string, unknown>;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function numberOr<T>(value: unknown, fallback: T): number | T {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export class MeshClient {
  #config: MeshClientConfig;
  #log: (message: string, extra?: unknown) => void;

  #client: MqttClient | null = null;
  #listeners = new Set<() => void>();
  #messages: MeshMessage[] = [];
  #nodes = new Map<number, MeshNode>();
  #status: MeshStatus = { connected: false, gatewayOnline: null, lastError: null };
  /** Dashboard-sent messages need ids too; the envelope ids are positive, so count down. */
  #syntheticId = -1;

  #jsonPrefix: string;
  #statPrefix: string;
  #downlinkTopic: string;

  constructor(config: MeshClientConfig, log: (message: string, extra?: unknown) => void) {
    this.#config = config;
    this.#log = log;
    const root = config.rootTopic.replace(/\/+$/, '');
    this.#jsonPrefix = `${root}/2/json/`;
    this.#statPrefix = `${root}/2/stat/`;
    this.#downlinkTopic = `${root}/2/json/mqtt/`;
  }

  get status(): MeshStatus {
    return { ...this.#status };
  }

  start(): void {
    // mqtt.js owns the reconnect loop (and MQTT keepalive is the heartbeat),
    // unlike the HA client where both are hand-rolled.
    const client = mqtt.connect(this.#config.mqttUrl, { reconnectPeriod: 5_000, keepalive: 60 });
    this.#client = client;

    client.on('connect', () => {
      this.#setStatus({ connected: true, lastError: null });
      this.#log(`Meshtastic broker connected (${this.#config.mqttUrl})`);
      client.subscribe([`${this.#jsonPrefix}+/+`, `${this.#statPrefix}+`], (error) => {
        if (error) this.#setStatus({ lastError: `subscribe failed: ${error.message}` });
      });
    });
    client.on('close', () => {
      if (this.#status.connected) this.#log('Meshtastic broker disconnected');
      this.#setStatus({ connected: false });
    });
    client.on('error', (error) => {
      this.#setStatus({ lastError: error.message });
    });
    client.on('message', (topic, payload) => this.#onMessage(topic, payload));
  }

  stop(): void {
    this.#client?.end(true);
    this.#client = null;
  }

  addListener(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get canSend(): boolean {
    return (
      this.#status.connected && this.#config.gatewayNode !== null && this.#config.channelIndex !== null
    );
  }

  summary(): MeshSummary {
    return {
      status: this.status,
      channel: this.#config.channel,
      canSend: this.canSend,
      messages: [...this.#messages],
      nodes: [...this.#nodes.values()].sort((a, b) => b.lastHeard - a.lastHeard),
    };
  }

  /**
   * Publish a text message for the gateway to transmit on the configured
   * channel. The firmware requires `from` to be the gateway's own node number
   * and silently drops anything else.
   */
  send(text: string): void {
    const { gatewayNode, channelIndex } = this.#config;
    const client = this.#client;
    if (!client || !this.canSend || gatewayNode === null || channelIndex === null) {
      throw new Error('mesh send is not available');
    }
    client.publish(
      this.#downlinkTopic,
      JSON.stringify({ from: gatewayNode, type: 'sendtext', payload: text, channel: channelIndex }),
    );
    // The gateway does not uplink its own transmission, so echo locally or the
    // sender would never see their message in the feed.
    this.#pushMessage({
      id: this.#syntheticId--,
      from: 0,
      to: 4_294_967_295,
      channel: channelIndex,
      text,
      timestamp: nowSeconds(),
      viaDashboard: true,
    });
  }

  #onMessage(topic: string, payload: Buffer): void {
    if (topic.startsWith(this.#statPrefix)) {
      const state = payload.toString().trim().toLowerCase();
      if (state === 'online' || state === 'offline') {
        this.#setStatus({ gatewayOnline: state === 'online' });
      }
      return;
    }
    if (!topic.startsWith(this.#jsonPrefix)) return;

    let envelope: Envelope;
    try {
      envelope = JSON.parse(payload.toString()) as Envelope;
    } catch {
      this.#log(`Ignoring unparseable mesh frame on ${topic}`);
      return;
    }
    if (typeof envelope.from !== 'number') return;

    // Topic shape: <root>/2/json/<channelname>/<!gatewayid>
    const channelName = topic.slice(this.#jsonPrefix.length).split('/')[0];
    const timestamp = numberOr(envelope.timestamp, 0) || nowSeconds();

    this.#upsertNode(envelope, timestamp);

    if (envelope.type === 'text' && channelName === this.#config.channel) {
      const text = stringOrNull(envelope.payload?.['text']);
      if (text === null) return;
      this.#pushMessage({
        id: numberOr(envelope.id, 0),
        from: envelope.from,
        to: numberOr(envelope.to, 4_294_967_295),
        channel: numberOr(envelope.channel, 0),
        text,
        timestamp,
        viaDashboard: false,
      });
      return;
    }
    this.#emit();
  }

  #upsertNode(envelope: Envelope, timestamp: number): void {
    const from = envelope.from as number;
    const node: MeshNode = this.#nodes.get(from) ?? {
      num: from,
      id: null,
      longName: null,
      shortName: null,
      batteryLevel: null,
      voltage: null,
      snr: null,
      rssi: null,
      lastHeard: 0,
    };

    node.lastHeard = Math.max(node.lastHeard, timestamp);
    node.snr = numberOr(envelope.snr, node.snr);
    node.rssi = numberOr(envelope.rssi, node.rssi);

    const payload = envelope.payload ?? {};
    if (envelope.type === 'nodeinfo') {
      node.id = stringOrNull(payload['id']) ?? node.id;
      node.longName = stringOrNull(payload['longname']) ?? node.longName;
      node.shortName = stringOrNull(payload['shortname']) ?? node.shortName;
    } else if (envelope.type === 'telemetry') {
      // Only device metrics carry these; environment telemetry leaves them alone.
      node.batteryLevel = numberOr(payload['battery_level'], node.batteryLevel);
      node.voltage = numberOr(payload['voltage'], node.voltage);
    }

    this.#nodes.set(from, node);
  }

  #pushMessage(message: MeshMessage): void {
    this.#messages.push(message);
    if (this.#messages.length > MESSAGE_CAP) this.#messages.splice(0, this.#messages.length - MESSAGE_CAP);
    this.#emit();
  }

  #setStatus(patch: Partial<MeshStatus>): void {
    this.#status = { ...this.#status, ...patch };
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (error) {
        this.#log('A mesh listener threw', error);
      }
    }
  }
}
