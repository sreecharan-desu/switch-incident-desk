import { describe, expect, it } from "vitest";
import { IncidentTriagerAgent, parseReleaseLedger } from "../src/agents/incident-triager.js";
import { ReleaseAuditorAgent } from "../src/agents/release-auditor.js";
import { InMemorySwitchBridge } from "../src/mock-bridge/mock-switch-server.js";
import { SwitchAgentClient } from "../src/protocol/switch-client.js";
import {
  formatAlertForSwitchRoom,
  normalizeAlertmanagerPayload,
} from "../src/webhook/alert-normalizer.js";

describe("Switch Incident Desk workflow", () => {
  function setupEnvironment() {
    const bridge = new InMemorySwitchBridge();

    bridge.createRoom({
      room_id: "room-releases",
      name: "payments-releases",
      description: "Day-to-day releases",
      instructions: "Maintain release-ledger.md",
      roles: [{ name: "release-manager", exclusive: true }],
    });

    bridge.createRoom({
      room_id: "room-incidents",
      name: "payments-incidents",
      description: "Production incidents",
      instructions: "Correlate alerts with linked releases room",
      roles: [
        { name: "incident-commander", exclusive: false },
        { name: "regression-checker", exclusive: false },
      ],
    });

    bridge.linkRooms("room-releases", "room-incidents", "incidents");
    bridge.linkRooms("room-incidents", "room-releases", "parent");

    bridge.seedDocument("room-releases", {
      id: "doc-1",
      name: "release-ledger.md",
      created_by_agent_id: "release-auditor",
      updated_at: "2026-10-27T14:05:00Z",
      content: [
        "## v2.42.0 (a4f91c2)",
        "- Author: sreecharan",
        "- Deployed: 2026-10-27T14:05:00Z",
        "- Paths: src/checkout/authorize.ts, src/checkout/retry-policy.ts",
        "- Summary: Tighten acquirer socket timeout from 2500ms to 350ms",
        "",
        "## v2.41.3 (88c10e4)",
        "- Author: priya",
        "- Deployed: 2026-10-26T18:20:00Z",
        "- Paths: src/webhooks/stripe.ts",
        "- Summary: Idempotency key deduplication on webhook retries",
      ].join("\n"),
    });

    const fetchImpl = bridge.createFetchAdapter();

    const triagerClient = new SwitchAgentClient({
      baseUrl: "http://switch.local",
      agentId: "incident-triager",
      apiKey: "key-triager",
      filter: "addressed",
      rooms: ["room-incidents"],
      fetchImpl,
    });

    const auditorClient = new SwitchAgentClient({
      baseUrl: "http://switch.local",
      agentId: "release-auditor",
      apiKey: "key-auditor",
      filter: "addressed",
      rooms: ["room-releases", "room-incidents"],
      fetchImpl,
    });

    bridge.attachAgentClient(triagerClient, ["room-incidents"]);
    bridge.attachAgentClient(auditorClient, ["room-releases", "room-incidents"]);

    return { bridge, triagerClient, auditorClient };
  }

  it("parses release-ledger.md entries accurately", () => {
    const entries = parseReleaseLedger(
      [
        "## v2.42.0 (a4f91c2)",
        "- Author: sreecharan",
        "- Deployed: 2026-10-27T14:05:00Z",
        "- Paths: src/checkout/authorize.ts, src/checkout/retry-policy.ts",
        "- Summary: Tighten acquirer socket timeout",
      ].join("\n")
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      version: "v2.42.0",
      sha: "a4f91c2",
      author: "sreecharan",
      deployedAt: "2026-10-27T14:05:00Z",
      touchedPaths: ["src/checkout/authorize.ts", "src/checkout/retry-policy.ts"],
      summary: "Tighten acquirer socket timeout",
    });
  });

  it("correlates an alert across linked rooms, prepares a rollback plan, enforces human approval, and updates both room documents", async () => {
    const { bridge, triagerClient, auditorClient } = setupEnvironment();
    await bridge.openAgentStream("incident-triager");
    await bridge.openAgentStream("release-auditor");

    const triager = new IncidentTriagerAgent(triagerClient, "room-incidents");
    const auditor = new ReleaseAuditorAgent({
      client: auditorClient,
      releasesRoomId: "room-releases",
      incidentsRoomId: "room-incidents",
      allowedApprovers: ["sreecharan"],
    });

    await triager.initialize();
    await auditor.initialize();

    const normalized = normalizeAlertmanagerPayload({
      status: "firing",
      alerts: [
        {
          status: "firing",
          labels: {
            incident_id: "inc-402",
            service: "payments-api",
            severity: "critical",
            endpoint: "/v1/checkout/authorize",
          },
          annotations: {
            summary: "Checkout 502 spike",
            error_signature: "AcquirerSocketTimeoutError",
          },
          startsAt: "2026-10-27T14:18:00Z",
        },
      ],
    });

    const alertPost = await bridge.postAndDeliverMessage({
      roomId: "room-incidents",
      sender: "@switch-user-webhook:local",
      senderName: "alertmanager",
      body: formatAlertForSwitchRoom(normalized[0]),
    });

    // Verify incident-triager created incident-inc-402.md and handed off to @regression-checker,
    // and release-auditor posted the rollback verification waiting on human confirmation.
    const incDocInitial = bridge.getRoomDocument("room-incidents", "incident-inc-402.md");
    expect(incDocInitial).toBeDefined();
    expect(incDocInitial?.content).toContain("Status: INVESTIGATING");
    expect(incDocInitial?.content).toContain("v2.42.0 (`a4f91c2`)");

    const incidentMessages = bridge.getRoomMessages("room-incidents");
    expect(incidentMessages).toHaveLength(3);
    expect(incidentMessages[1].body).toContain("@regression-checker verify commit `a4f91c2`");
    expect(incidentMessages[2].body).toContain("Human gate required: an on-call operator must reply `@release-manager confirm rollback a4f91c2`");

    // Unauthorized user tries to approve rollback -> refused
    await bridge.postAndDeliverMessage({
      roomId: "room-incidents",
      sender: "@switch-user-guest:local",
      senderName: "guest-observer",
      body: "@release-manager confirm rollback a4f91c2",
      threadId: alertPost.message_id,
    });

    const afterGuestMessages = bridge.getRoomMessages("room-incidents");
    expect(afterGuestMessages[afterGuestMessages.length - 1].body).toContain(
      "Refused rollback for `a4f91c2`: sender `guest-observer` is not in the authorized release approvers list."
    );

    // Authorized operator approves rollback -> executed, release-ledger.md updated, incident-inc-402.md marked RESOLVED
    await bridge.postAndDeliverMessage({
      roomId: "room-incidents",
      sender: "@switch-user-sreecharan:local",
      senderName: "sreecharan",
      body: "@release-manager confirm rollback a4f91c2",
      threadId: alertPost.message_id,
    });

    const finalIncDoc = bridge.getRoomDocument("room-incidents", "incident-inc-402.md");
    expect(finalIncDoc?.content).toContain("Status: RESOLVED");
    expect(finalIncDoc?.content).toContain("Rolled back commit `a4f91c2` after human operator approval");

    const updatedLedger = bridge.getRoomDocument("room-releases", "release-ledger.md");
    expect(updatedLedger?.content).toContain("## v2.42.0-revert (revert-a4f91c2)");
    expect(updatedLedger?.content).toContain("Emergency rollback for incident [inc-402]");
  });

  it("enforces room-scoped document authorship and exclusive role leases", async () => {
    const { bridge, triagerClient, auditorClient } = setupEnvironment();
    await bridge.openAgentStream("incident-triager");
    await bridge.openAgentStream("release-auditor");

    await auditorClient.assumeRole("room-releases", "release-manager");

    // Second agent attempting to assume exclusive release-manager role fails
    await expect(
      triagerClient.assumeRole("room-releases", "release-manager")
    ).rejects.toThrow(/already held by release-auditor/);

    // incident-triager attempting to overwrite release-ledger.md authored by release-auditor fails with 403
    await expect(
      triagerClient.updateRoomDocument("room-releases", "release-ledger.md", "tampered")
    ).rejects.toThrow(/403.*Permission denied/);
  });

  it("handles SSE gap frames by attaching gap metadata to the next surfaced event and suppresses command frames on filter=addressed", async () => {
    const { bridge, triagerClient } = setupEnvironment();
    await bridge.openAgentStream("incident-triager");

    let observedGapReason: string | null = null;
    let commandsReceived = 0;

    triagerClient.onMessage((_event, gap) => {
      if (gap) {
        observedGapReason = gap.reason;
      }
    });
    triagerClient.onCommand(() => {
      commandsReceived += 1;
    });

    await triagerClient.handleSseFrame(
      "gap",
      JSON.stringify({
        from_sequence: 4,
        resumed_at: 12,
        reason: "cursor_expired",
      })
    );
    expect(triagerClient.currentCursor).toBe(12);

    // Command frame should be ignored when filter === "addressed"
    await triagerClient.handleSseFrame(
      "command",
      JSON.stringify({
        type: "command",
        room_id: "room-incidents",
        bridge_id: null,
        channel_type: null,
        sequence: 13,
        payload: {
          command: "reset",
          args: "",
          user_id: "@switch-user-1:local",
          user_name: "sreecharan",
          thread_id: null,
        },
      }),
      "13"
    );
    expect(commandsReceived).toBe(0);

    // Next addressed message receives the held gap frame
    await triagerClient.handleSseFrame(
      "message",
      JSON.stringify({
        type: "message",
        room_id: "room-incidents",
        bridge_id: null,
        channel_type: null,
        sequence: 14,
        payload: {
          addressed: true,
          sender: "@switch-user-1:local",
          sender_name: "sreecharan",
          message_id: "msg-14",
          body: "@incident-triager status",
          timestamp: Date.now(),
          thread_id: null,
          attachments: [],
        },
      }),
      "14"
    );
    expect(observedGapReason).toBe("cursor_expired");
    expect(triagerClient.currentCursor).toBe(14);
  });
});
