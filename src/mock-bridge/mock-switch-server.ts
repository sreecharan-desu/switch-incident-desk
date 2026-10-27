import type { SwitchAgentClient } from "../protocol/switch-client.js";
import type {
  DomainEventEnvelope,
  LinkedRoomSummary,
  MessagePayload,
  RoomContextResponse,
  RoomDocument,
  RoomHistoryMessage,
  RoomReference,
} from "../protocol/types.js";

interface RoomState {
  room_id: string;
  name: string;
  description: string;
  instructions: string;
  participants: Array<{ id: string; name: string; kind: "agent" | "user" }>;
  references: RoomReference[];
  roles: Array<{ name: string; holder_agent_id: string | null; exclusive: boolean }>;
  links: LinkedRoomSummary[];
  documents: Map<string, RoomDocument>;
  messages: RoomHistoryMessage[];
}

export class InMemorySwitchBridge {
  private rooms = new Map<string, RoomState>();
  private clients = new Map<string, SwitchAgentClient>();
  private connectionRooms = new Map<string, Set<string>>();
  private sequence = 0;

  createRoom(config: {
    room_id: string;
    name: string;
    description: string;
    instructions: string;
    participants?: Array<{ id: string; name: string; kind: "agent" | "user" }>;
    references?: RoomReference[];
    roles?: Array<{ name: string; exclusive: boolean }>;
  }): void {
    this.rooms.set(config.room_id, {
      room_id: config.room_id,
      name: config.name,
      description: config.description,
      instructions: config.instructions,
      participants: config.participants ?? [],
      references: config.references ?? [],
      roles: (config.roles ?? []).map((r) => ({
        name: r.name,
        holder_agent_id: null,
        exclusive: r.exclusive,
      })),
      links: [],
      documents: new Map(),
      messages: [],
    });
  }

  linkRooms(fromRoomId: string, toRoomId: string, label: string): void {
    const fromRoom = this.rooms.get(fromRoomId);
    const toRoom = this.rooms.get(toRoomId);
    if (!fromRoom || !toRoom) {
      throw new Error(`Cannot link unknown rooms: ${fromRoomId} -> ${toRoomId}`);
    }
    fromRoom.links.push({
      room_id: toRoom.room_id,
      name: toRoom.name,
      description: toRoom.description,
      label,
    });
  }

  seedDocument(roomId: string, doc: RoomDocument): void {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`Unknown room: ${roomId}`);
    room.documents.set(doc.name, doc);
  }

  seedMessage(roomId: string, sender: string, senderName: string, body: string, threadId: string | null = null): RoomHistoryMessage {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`Unknown room: ${roomId}`);
    const msg: RoomHistoryMessage = {
      message_id: `msg-${++this.sequence}`,
      sender,
      sender_name: senderName,
      body,
      timestamp: Date.now(),
      thread_id: threadId,
    };
    room.messages.push(msg);
    return msg;
  }

  attachAgentClient(client: SwitchAgentClient, initialRooms: string[]): void {
    this.clients.set(client.agentId, client);
    this.connectionRooms.set(client.connectionId, new Set(initialRooms));
  }

  async openAgentStream(agentId: string): Promise<void> {
    const client = this.clients.get(agentId);
    if (!client) throw new Error(`Unknown agent client: ${agentId}`);
    const rooms = Array.from(this.connectionRooms.get(client.connectionId) ?? []);
    await client.handleSseFrame(
      "connection_state",
      JSON.stringify({
        connection_id: client.connectionId,
        agent_id: client.agentId,
        scope: client.scope,
        filter: client.filter,
        spawn_capable: false,
        rooms,
        cursor: this.sequence,
        protocol: 1,
        heartbeat_interval_seconds: 2,
      })
    );
  }

  async postAndDeliverMessage(params: {
    roomId: string;
    sender: string;
    senderName: string;
    body: string;
    threadId?: string | null;
  }): Promise<RoomHistoryMessage> {
    const room = this.rooms.get(params.roomId);
    if (!room) throw new Error(`Unknown room: ${params.roomId}`);

    const seq = ++this.sequence;
    const msg: RoomHistoryMessage = {
      message_id: `msg-${seq}`,
      sender: params.sender,
      sender_name: params.senderName,
      body: params.body,
      timestamp: Date.now(),
      thread_id: params.threadId ?? null,
    };
    room.messages.push(msg);

    for (const [agentId, client] of this.clients.entries()) {
      // Do not echo an agent's own message back to itself as an addressed prompt
      if (params.sender === `@switch-agent-${agentId}:local`) {
        continue;
      }
      const covered = this.connectionRooms.get(client.connectionId);
      if (!covered || !covered.has(params.roomId)) {
        continue;
      }

      const roleHeldByAgent = room.roles
        .filter((r) => r.holder_agent_id === agentId)
        .map((r) => `@${r.name}`);

      const addressed =
        params.body.includes(`@${agentId}`) ||
        roleHeldByAgent.some((roleMention) => params.body.includes(roleMention));

      const envelope: DomainEventEnvelope<MessagePayload> = {
        type: "message",
        room_id: params.roomId,
        bridge_id: "slack-default",
        channel_type: "channel_private",
        sequence: seq,
        payload: {
          addressed,
          sender: params.sender,
          sender_name: params.senderName,
          message_id: msg.message_id,
          body: msg.body,
          timestamp: msg.timestamp,
          thread_id: msg.thread_id,
          attachments: [],
        },
      };

      await client.handleSseFrame("message", JSON.stringify(envelope), String(seq));
    }

    return msg;
  }

  createFetchAdapter(): typeof fetch {
    return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      const pathParts = url.pathname.split("/").filter(Boolean);

      if (pathParts[0] === "health") {
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }

      // POST /agents/{agent_id}/connection/beat
      if (
        pathParts[0] === "agents" &&
        pathParts[2] === "connection" &&
        pathParts[3] === "beat"
      ) {
        const body = JSON.parse((init?.body as string) ?? "{}") as {
          connection_id: string;
          cursor: number;
        };
        const rooms = this.connectionRooms.get(body.connection_id);
        if (!rooms) {
          return new Response(JSON.stringify({ error: "unknown connection" }), { status: 404 });
        }
        return new Response(
          JSON.stringify({
            ok: true,
            rooms: Array.from(rooms),
            cursor: Math.max(body.cursor, this.sequence),
          }),
          { status: 200 }
        );
      }

      // POST /agents/{agent_id}/ops/{operation}
      if (pathParts[0] === "agents" && pathParts[2] === "ops" && pathParts[3]) {
        const agentId = pathParts[1];
        const op = pathParts[3];
        const args = JSON.parse((init?.body as string) ?? "{}") as Record<string, unknown>;

        try {
          const result = await this.handleOperation(agentId, op, args);
          return new Response(JSON.stringify({ result }), { status: 200 });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const status = message.includes("Permission denied") ? 403 : 400;
          return new Response(JSON.stringify({ error: message }), { status });
        }
      }

      return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    };
  }

  private async handleOperation(
    agentId: string,
    op: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    if (op === "connect_to_room") {
      const roomId = String(args.room_id);
      const room = this.rooms.get(roomId);
      if (!room) throw new Error(`Unknown room: ${roomId}`);
      const ctx: RoomContextResponse = {
        room_id: room.room_id,
        name: room.name,
        instructions: room.instructions,
        participants: room.participants,
        references: room.references,
        roles: room.roles,
        linked_rooms: room.links,
      };
      return ctx;
    }

    if (op === "read_context") {
      const roomId = String(args.room_id);
      const limit = typeof args.limit === "number" ? args.limit : 25;
      const room = this.rooms.get(roomId);
      if (!room) throw new Error(`Unknown room: ${roomId}`);
      return room.messages.slice(-limit);
    }

    if (op === "post_message") {
      const roomId = String(args.room_id);
      const content = String(args.content);
      const threadId = typeof args.thread_id === "string" ? args.thread_id : null;
      const msg = await this.postAndDeliverMessage({
        roomId,
        sender: `@switch-agent-${agentId}:local`,
        senderName: agentId,
        body: content,
        threadId,
      });
      return { message_id: msg.message_id };
    }

    if (op === "list_linked_rooms") {
      const roomId = String(args.room_id);
      const room = this.rooms.get(roomId);
      if (!room) throw new Error(`Unknown room: ${roomId}`);
      return room.links;
    }

    if (op === "load_internal_documents") {
      const roomId = String(args.room_id);
      const room = this.rooms.get(roomId);
      if (!room) throw new Error(`Unknown room: ${roomId}`);
      return Array.from(room.documents.values());
    }

    if (op === "create_room_document") {
      const roomId = String(args.room_id);
      const name = String(args.name);
      const content = String(args.content);
      const instructions =
        typeof args.instructions === "string" ? args.instructions : undefined;
      const room = this.rooms.get(roomId);
      if (!room) throw new Error(`Unknown room: ${roomId}`);
      if (room.documents.has(name)) {
        throw new Error(`Document '${name}' already exists in room ${roomId}`);
      }
      const doc: RoomDocument = {
        id: `doc-${++this.sequence}`,
        name,
        content,
        instructions,
        created_by_agent_id: agentId,
        updated_at: new Date().toISOString(),
      };
      room.documents.set(name, doc);
      return doc;
    }

    if (op === "update_room_document") {
      const roomId = String(args.room_id);
      const name = String(args.name);
      const content = String(args.content);
      const room = this.rooms.get(roomId);
      if (!room) throw new Error(`Unknown room: ${roomId}`);
      const existing = room.documents.get(name);
      if (!existing) {
        throw new Error(`Document '${name}' not found in room ${roomId}`);
      }
      if (existing.created_by_agent_id && existing.created_by_agent_id !== agentId) {
        throw new Error(
          `Permission denied: agent ${agentId} cannot modify document authored by ${existing.created_by_agent_id}`
        );
      }
      const updated: RoomDocument = {
        ...existing,
        content,
        updated_at: new Date().toISOString(),
      };
      room.documents.set(name, updated);
      return updated;
    }

    if (op === "assume_role") {
      const roomId = String(args.room_id);
      const roleName = String(args.role_name);
      const room = this.rooms.get(roomId);
      if (!room) throw new Error(`Unknown room: ${roomId}`);
      const role = room.roles.find((r) => r.name === roleName);
      if (!role) throw new Error(`Role '${roleName}' not defined in room ${roomId}`);
      if (role.exclusive && role.holder_agent_id && role.holder_agent_id !== agentId) {
        throw new Error(`Exclusive role '${roleName}' is already held by ${role.holder_agent_id}`);
      }
      role.holder_agent_id = agentId;
      return { leased: true, role: roleName };
    }

    throw new Error(`Unsupported operation: ${op}`);
  }

  getRoomMessages(roomId: string): RoomHistoryMessage[] {
    return [...(this.rooms.get(roomId)?.messages ?? [])];
  }

  getRoomDocument(roomId: string, name: string): RoomDocument | undefined {
    return this.rooms.get(roomId)?.documents.get(name);
  }
}
