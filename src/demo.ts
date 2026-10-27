import { IncidentTriagerAgent } from "./agents/incident-triager.js";
import { ReleaseAuditorAgent } from "./agents/release-auditor.js";
import { InMemorySwitchBridge } from "./mock-bridge/mock-switch-server.js";
import { SwitchAgentClient } from "./protocol/switch-client.js";
import {
  formatAlertForSwitchRoom,
  normalizeAlertmanagerPayload,
} from "./webhook/alert-normalizer.js";

async function runDemo(): Promise<void> {
  const bridge = new InMemorySwitchBridge();

  bridge.createRoom({
    room_id: "room-payments-releases",
    name: "payments-releases",
    description: "Day-to-day releases and release ledger for payments",
    instructions:
      "Track every production deployment in release-ledger.md. Only the exclusive release-manager role records releases or executes rollbacks.",
    roles: [{ name: "release-manager", exclusive: true }],
  });

  bridge.createRoom({
    room_id: "room-payments-incidents",
    name: "payments-incidents",
    description: "Production incident triage and rollback coordination",
    instructions:
      "Triage alerts against linked release rooms, maintain incident-<id>.md, and require human confirmation before any rollback.",
    roles: [
      { name: "incident-commander", exclusive: false },
      { name: "regression-checker", exclusive: false },
    ],
  });

  // Wire bidirectional Switch room links
  bridge.linkRooms("room-payments-releases", "room-payments-incidents", "incidents");
  bridge.linkRooms("room-payments-incidents", "room-payments-releases", "parent");

  // Seed release-ledger.md in payments-releases (authored by payments-release-auditor)
  bridge.seedDocument("room-payments-releases", {
    id: "doc-ledger-1",
    name: "release-ledger.md",
    created_by_agent_id: "payments-release-auditor",
    updated_at: "2026-10-27T14:10:00Z",
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
    agentId: "payments-incident-triager",
    apiKey: "sk-triager-demo",
    filter: "addressed",
    rooms: ["room-payments-incidents"],
    fetchImpl,
  });

  const auditorClient = new SwitchAgentClient({
    baseUrl: "http://switch.local",
    agentId: "payments-release-auditor",
    apiKey: "sk-auditor-demo",
    filter: "addressed",
    rooms: ["room-payments-releases", "room-payments-incidents"],
    fetchImpl,
  });

  bridge.attachAgentClient(triagerClient, ["room-payments-incidents"]);
  bridge.attachAgentClient(auditorClient, [
    "room-payments-releases",
    "room-payments-incidents",
  ]);

  await bridge.openAgentStream("payments-incident-triager");
  await bridge.openAgentStream("payments-release-auditor");

  const triager = new IncidentTriagerAgent(triagerClient, "room-payments-incidents");
  const auditor = new ReleaseAuditorAgent({
    client: auditorClient,
    releasesRoomId: "room-payments-releases",
    incidentsRoomId: "room-payments-incidents",
    allowedApprovers: ["sreecharan", "oncall-lead"],
  });

  await triager.initialize();
  await auditor.initialize();

  // 1. Simulate incoming Alertmanager webhook for 502 spike on /v1/checkout/authorize
  const alerts = normalizeAlertmanagerPayload({
    status: "firing",
    alerts: [
      {
        status: "firing",
        fingerprint: "inc402aa91",
        labels: {
          incident_id: "inc-402",
          service: "payments-api",
          severity: "critical",
          endpoint: "/v1/checkout/authorize",
        },
        annotations: {
          summary: "Checkout authorization 502 error rate > 14%",
          error_signature: "AcquirerSocketTimeoutError after 350ms",
        },
        startsAt: "2026-10-27T14:18:00Z",
      },
    ],
  });

  const alertMsg = await bridge.postAndDeliverMessage({
    roomId: "room-payments-incidents",
    sender: "@switch-user-alertmanager:local",
    senderName: "alertmanager-webhook",
    body: formatAlertForSwitchRoom(alerts[0]),
  });

  // 2. On-call engineer approves the rollback in the incident thread
  await bridge.postAndDeliverMessage({
    roomId: "room-payments-incidents",
    sender: "@switch-user-sreecharan:local",
    senderName: "sreecharan",
    body: "@release-manager confirm rollback a4f91c2",
    threadId: alertMsg.message_id,
  });

  console.log("=== Room: payments-incidents ===");
  for (const m of bridge.getRoomMessages("room-payments-incidents")) {
    console.log(`\n[${m.sender_name}] (thread: ${m.thread_id ?? "root"}):\n${m.body}`);
  }

  console.log("\n=== Room Document: incident-inc-402.md ===");
  console.log(bridge.getRoomDocument("room-payments-incidents", "incident-inc-402.md")?.content);

  console.log("\n=== Room Document: release-ledger.md (in payments-releases) ===");
  console.log(bridge.getRoomDocument("room-payments-releases", "release-ledger.md")?.content);
}

runDemo().catch((err) => {
  console.error(err);
  process.exit(1);
});
