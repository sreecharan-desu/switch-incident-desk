# switch-incident-desk

Linked-room production incident triage, release correlation, and human-gated rollback workflow built on [Agent Switch](https://github.com/sandbox-quantum/switch).

When a production alert fires, the conversation in `#payments-incidents` needs to know what shipped in `#payments-releases` ten minutes ago without someone digging through deploy logs or pasting context across channels. `switch-incident-desk` wires two Switch rooms together with directed room links, room-scoped documents, and role-addressed agents so people make the rollback decision and the agents handle the correlation and record-keeping around it.

## Architecture

```
+-------------------------------------------------------------------+
| Group: payments operations                                        |
|                                                                   |
|  +---------------------------+      incidents     +-------------+ |
|  | Room: payments-releases   | -----------------> |   Room:     | |
|  |                           | <----------------- |  payments-  | |
|  | - Doc: release-ledger.md  |       parent       |  incidents  | |
|  | - Role: release-manager   |                    |             | |
|  |   (exclusive)             |                    | - Doc:      | |
|  +---------------------------+                    |   incident- | |
|                ^                                  |   <id>.md   | |
|                |                                  +-------------+ |
+----------------|-----------------------------------------^--------+
                 |                                         |
        +--------+--------+                       +--------+--------+
        | release-auditor |                       | incident-triager|
        +-----------------+                       +-----------------+
```

### How a production alert flows through the rooms

1. **Alert ingestion (`src/webhook/alert-normalizer.ts`)**: An Alertmanager webhook payload is normalized and posted into `payments-incidents` addressed to `@incident-commander`.
2. **Cross-room release correlation (`src/agents/incident-triager.ts`)**:
   - `incident-triager` (holding the `incident-commander` role) receives the event over its Switch SSE stream (`GET /agents/{id}/events`).
   - It calls `list_linked_rooms` on `payments-incidents`, follows the `parent` link to `payments-releases`, and loads `release-ledger.md` via `load_internal_documents`.
   - It matches the failing endpoint (`/v1/checkout/authorize`) against recent deploys (`v2.42.0` / `a4f91c2`), writes a room-scoped timeline document (`incident-inc-402.md`) via `create_room_document`, and hands off diff verification in the same thread to `@regression-checker`.
3. **Diff check and rollback gate (`src/agents/release-auditor.ts`)**:
   - `release-auditor` (holding `@regression-checker` in `payments-incidents` and the exclusive `@release-manager` role in `payments-releases`) verifies the commit paths and posts the rollback command (`git revert --no-edit a4f91c2`).
   - It refuses to execute the rollback until an authorized operator in the room replies `@release-manager confirm rollback a4f91c2`.
4. **Resolution and postmortem record**:
   - Once an authorized operator confirms, `release-auditor` prepends the revert entry to `release-ledger.md` in `payments-releases` and notifies `@incident-commander` in the incident thread.
   - `incident-triager` updates `incident-inc-402.md` from `INVESTIGATING` to `RESOLVED`.

## Switch Agent Protocol Implementation

`src/protocol/switch-client.ts` implements the Switch wire contract directly:

- **Downstream SSE (`GET /agents/{agent_id}/events`)**:
  - Parses `connection_state`, `gap`, `subscription_changed`, `evicted`, and `room_released` control frames alongside `message` and `command` domain events.
  - Preserves sequence cursors from SSE `id:` lines and attaches any `gap` frame to the next surfaced event so the agent re-reads room context (`read_context`) before replying.
  - Enforces the `filter=addressed` rule where `command` frames are suppressed unless `filter=all` is configured.
- **Heartbeat (`POST /agents/{agent_id}/connection/beat`)**:
  - Sends `{connection_id, cursor}` every 2 seconds and flags `404` / `409` responses so the client reopens the stream rather than backing off on a dead connection.
- **Upstream Operations (`POST /agents/{agent_id}/ops/{operation}`)**:
  - Sends `X-Switch-Connection-Id` and unwrapped JSON arguments for `connect_to_room`, `read_context`, `post_message`, `list_linked_rooms`, `load_internal_documents`, `create_room_document`, `update_room_document`, and `assume_role`.

## Quick Start

Run the end-to-end two-room simulation and test suite locally:

```bash
npm install
npm test
npm run demo
```

## Switch Console Templates

Import either template in Switch Console (**Templates -> Create from YAML**):

- [`templates/incident-desk.template.yaml`](templates/incident-desk.template.yaml) — Version 1 group template provisioning `{team}-incident-triager`, `{team}-release-auditor`, `{team}-releases`, `{team}-incidents`, and bidirectional room links (`incidents` and `parent`).
- [`templates/incident-desk.v2.template.yaml`](templates/incident-desk.v2.template.yaml) — Version 2 resource template with conditional bridge user invitations and repository grounding.

## License

MIT
