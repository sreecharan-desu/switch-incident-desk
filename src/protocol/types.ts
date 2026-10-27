export type ConnectionScope = "single" | "all";
export type DeliveryFilter = "all" | "addressed";

export interface ConnectionStateFrame {
  connection_id: string;
  agent_id: string;
  scope: ConnectionScope;
  filter: DeliveryFilter;
  spawn_capable: boolean;
  rooms: string[];
  cursor: number;
  protocol: number;
  heartbeat_interval_seconds: number;
}

export interface GapFrame {
  from_sequence: number;
  resumed_at: number;
  reason: string;
}

export interface EvictedFrame {
  reason: string;
}

export interface SubscriptionChangedFrame {
  rooms: string[];
  reason: string;
}

export interface MessagePayload {
  addressed: boolean;
  sender: string;
  sender_name: string;
  sender_kind?: "platform";
  on_behalf_of?: string;
  message_id: string;
  body: string;
  timestamp: number;
  thread_id: string | null;
  attachments: Array<{
    filename: string;
    mimetype: string;
    size: number;
    mxc: string;
    msgtype: string;
  }>;
}

export interface CommandPayload {
  command: string;
  args: string;
  user_id: string;
  user_name: string;
  thread_id: string | null;
}

export interface DomainEventEnvelope<T = unknown> {
  type:
    | "message"
    | "command"
    | "room_join"
    | "task_delegate"
    | "task_accept"
    | "task_update"
    | "task_finalise"
    | "task_cancel";
  room_id: string;
  bridge_id: string | null;
  channel_type: string | null;
  payload: T;
  sequence: number;
}

export interface LinkedRoomSummary {
  room_id: string;
  name: string;
  description: string;
  label: string;
}

export interface RoomDocument {
  id: string;
  name: string;
  content: string;
  instructions?: string;
  created_by_agent_id?: string;
  updated_at: string;
}

export interface RoomReference {
  id: string;
  type: "github" | "confluence" | "jira" | "gdrive";
  address: string;
  instructions: string;
}

export interface RoomContextResponse {
  room_id: string;
  name: string;
  instructions: string;
  participants: Array<{ id: string; name: string; kind: "agent" | "user" }>;
  references: RoomReference[];
  roles: Array<{ name: string; holder_agent_id: string | null; exclusive: boolean }>;
  linked_rooms: LinkedRoomSummary[];
  warning?: string;
}

export interface RoomHistoryMessage {
  message_id: string;
  sender: string;
  sender_name: string;
  body: string;
  timestamp: number;
  thread_id: string | null;
}
