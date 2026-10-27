import { randomUUID } from "node:crypto";
import type {
  CommandPayload,
  ConnectionScope,
  ConnectionStateFrame,
  DeliveryFilter,
  DomainEventEnvelope,
  GapFrame,
  LinkedRoomSummary,
  MessagePayload,
  RoomContextResponse,
  RoomDocument,
  RoomHistoryMessage,
} from "./types.js";

export interface SwitchClientOptions {
  baseUrl: string;
  agentId: string;
  apiKey: string;
  connectionId?: string;
  scope?: ConnectionScope;
  filter?: DeliveryFilter;
  rooms?: string[];
  fetchImpl?: typeof fetch;
}

export class SwitchAgentClient {
  readonly baseUrl: string;
  readonly agentId: string;
  readonly apiKey: string;
  readonly connectionId: string;
  readonly scope: ConnectionScope;
  readonly filter: DeliveryFilter;
  private coveredRooms: string[];
  private cursor = 0;
  private heartbeatIntervalMs = 2000;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pendingGap: GapFrame | null = null;
  private readonly fetchImpl: typeof fetch;
  private messageHandlers: Array<
    (event: DomainEventEnvelope<MessagePayload>, gap: GapFrame | null) => Promise<void> | void
  > = [];
  private commandHandlers: Array<
    (event: DomainEventEnvelope<CommandPayload>) => Promise<void> | void
  > = [];

  constructor(options: SwitchClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.agentId = options.agentId;
    this.apiKey = options.apiKey;
    this.connectionId = options.connectionId ?? randomUUID();
    this.scope = options.scope ?? "all";
    this.filter = options.filter ?? "all";
    this.coveredRooms = options.rooms ? [...options.rooms] : [];
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get currentCursor(): number {
    return this.cursor;
  }

  get activeRooms(): string[] {
    return [...this.coveredRooms];
  }

  onMessage(
    handler: (
      event: DomainEventEnvelope<MessagePayload>,
      gap: GapFrame | null
    ) => Promise<void> | void
  ): void {
    this.messageHandlers.push(handler);
  }

  onCommand(
    handler: (event: DomainEventEnvelope<CommandPayload>) => Promise<void> | void
  ): void {
    this.commandHandlers.push(handler);
  }

  /**
   * Process a parsed SSE frame from GET /agents/{agent_id}/events.
   * Separated so both live HTTP streams and deterministic test harnesses drive the exact same state machine.
   */
  async handleSseFrame(eventType: string, dataJson: string, sseId?: string): Promise<void> {
    const parsed = JSON.parse(dataJson);

    if (eventType === "connection_state") {
      const state = parsed as ConnectionStateFrame;
      this.coveredRooms = [...state.rooms];
      this.cursor = Math.max(this.cursor, state.cursor);
      this.heartbeatIntervalMs = Math.max(500, state.heartbeat_interval_seconds * 1000);
      return;
    }

    if (eventType === "gap") {
      this.pendingGap = parsed as GapFrame;
      this.cursor = Math.max(this.cursor, this.pendingGap.resumed_at);
      return;
    }

    if (eventType === "subscription_changed") {
      this.coveredRooms = [...(parsed.rooms as string[])];
      return;
    }

    if (eventType === "evicted" || eventType === "room_released") {
      return;
    }

    const seqFromId = sseId ? Number.parseInt(sseId, 10) : NaN;
    const envelope = parsed as DomainEventEnvelope;
    const seq = Number.isFinite(seqFromId) ? seqFromId : envelope.sequence;
    if (Number.isFinite(seq) && seq > this.cursor) {
      this.cursor = seq;
    }

    if (envelope.type === "message") {
      const msgEvent = envelope as DomainEventEnvelope<MessagePayload>;
      if (this.filter === "addressed" && !msgEvent.payload.addressed) {
        return;
      }
      const gap = this.pendingGap;
      this.pendingGap = null;
      for (const handler of this.messageHandlers) {
        await handler(msgEvent, gap);
      }
      return;
    }

    if (envelope.type === "command") {
      if (this.filter === "addressed") {
        // Per Switch protocol spec: connections with filter=addressed never surface command events
        return;
      }
      const cmdEvent = envelope as DomainEventEnvelope<CommandPayload>;
      for (const handler of this.commandHandlers) {
        await handler(cmdEvent);
      }
    }
  }

  async sendHeartbeat(): Promise<{ ok: boolean; status: number; rooms: string[]; cursor: number }> {
    const res = await this.fetchImpl(`${this.baseUrl}/agents/${this.agentId}/connection/beat`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        connection_id: this.connectionId,
        cursor: this.cursor,
      }),
    });

    if (res.status === 404 || res.status === 409) {
      return { ok: false, status: res.status, rooms: this.coveredRooms, cursor: this.cursor };
    }

    const body = (await res.json()) as { ok: boolean; rooms: string[]; cursor: number };
    this.coveredRooms = [...body.rooms];
    if (body.cursor > this.cursor) {
      this.cursor = body.cursor;
    }
    return { ok: true, status: res.status, rooms: this.coveredRooms, cursor: this.cursor };
  }

  startHeartbeatLoop(onReconnectNeeded?: (status: number) => void): void {
    this.stopHeartbeatLoop();
    this.heartbeatTimer = setInterval(async () => {
      try {
        const beat = await this.sendHeartbeat();
        if (!beat.ok && onReconnectNeeded) {
          onReconnectNeeded(beat.status);
        }
      } catch {
        // Network error during beat; next beat or stream error will trigger reconnect
      }
    }, this.heartbeatIntervalMs);
  }

  stopHeartbeatLoop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async callOperation<TResult = unknown>(
    operation: string,
    args: Record<string, unknown> = {}
  ): Promise<TResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/agents/${this.agentId}/ops/${operation}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "X-Switch-Connection-Id": this.connectionId,
      },
      body: JSON.stringify(args),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Switch operation ${operation} failed (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as { result: TResult };
    return data.result;
  }

  async connectToRoom(roomId: string): Promise<RoomContextResponse> {
    return this.callOperation<RoomContextResponse>("connect_to_room", { room_id: roomId });
  }

  async readContext(roomId: string, limit = 25): Promise<RoomHistoryMessage[]> {
    return this.callOperation<RoomHistoryMessage[]>("read_context", {
      room_id: roomId,
      limit,
    });
  }

  async postMessage(roomId: string, content: string, threadId?: string | null): Promise<{ message_id: string }> {
    const payload: Record<string, unknown> = { room_id: roomId, content };
    if (threadId) {
      payload.thread_id = threadId;
    }
    return this.callOperation<{ message_id: string }>("post_message", payload);
  }

  async listLinkedRooms(roomId: string): Promise<LinkedRoomSummary[]> {
    return this.callOperation<LinkedRoomSummary[]>("list_linked_rooms", { room_id: roomId });
  }

  async loadInternalDocuments(roomId: string): Promise<RoomDocument[]> {
    return this.callOperation<RoomDocument[]>("load_internal_documents", { room_id: roomId });
  }

  async createRoomDocument(
    roomId: string,
    name: string,
    content: string,
    instructions?: string
  ): Promise<RoomDocument> {
    const payload: Record<string, unknown> = { room_id: roomId, name, content };
    if (instructions) {
      payload.instructions = instructions;
    }
    return this.callOperation<RoomDocument>("create_room_document", payload);
  }

  async updateRoomDocument(
    roomId: string,
    name: string,
    content: string
  ): Promise<RoomDocument> {
    return this.callOperation<RoomDocument>("update_room_document", {
      room_id: roomId,
      name,
      content,
    });
  }

  async assumeRole(roomId: string, roleName: string): Promise<{ leased: boolean; role: string }> {
    return this.callOperation<{ leased: boolean; role: string }>("assume_role", {
      room_id: roomId,
      role_name: roleName,
    });
  }
}
