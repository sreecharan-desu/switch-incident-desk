import type { SwitchAgentClient } from "../protocol/switch-client.js";
import type {
  DomainEventEnvelope,
  GapFrame,
  MessagePayload,
} from "../protocol/types.js";

export interface ReleaseEntry {
  version: string;
  sha: string;
  author: string;
  deployedAt: string;
  touchedPaths: string[];
  summary: string;
}

export function parseReleaseLedger(markdown: string): ReleaseEntry[] {
  const entries: ReleaseEntry[] = [];
  const blocks = markdown.split(/^##\s+/m).slice(1);
  for (const block of blocks) {
    const lines = block.trim().split("\n");
    const header = lines[0]?.trim() ?? "";
    const [versionPart, shaPart] = header.split(/\s+\(([a-f0-9]{7,40})\)/i);
    const version = versionPart?.trim() ?? "unknown";
    const sha = shaPart?.trim() ?? "unknown";

    let author = "unknown";
    let deployedAt = "unknown";
    let touchedPaths: string[] = [];
    let summary = "";

    for (const line of lines.slice(1)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("- Author:")) {
        author = trimmed.replace("- Author:", "").trim();
      } else if (trimmed.startsWith("- Deployed:")) {
        deployedAt = trimmed.replace("- Deployed:", "").trim();
      } else if (trimmed.startsWith("- Paths:")) {
        touchedPaths = trimmed
          .replace("- Paths:", "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      } else if (trimmed.startsWith("- Summary:")) {
        summary = trimmed.replace("- Summary:", "").trim();
      }
    }

    entries.push({ version, sha, author, deployedAt, touchedPaths, summary });
  }
  return entries;
}

export class IncidentTriagerAgent {
  private readonly client: SwitchAgentClient;
  private readonly incidentsRoomId: string;

  constructor(client: SwitchAgentClient, incidentsRoomId: string) {
    this.client = client;
    this.incidentsRoomId = incidentsRoomId;
  }

  async initialize(): Promise<void> {
    await this.client.connectToRoom(this.incidentsRoomId);
    await this.client.assumeRole(this.incidentsRoomId, "incident-commander");

    this.client.onMessage(async (event, gap) => {
      await this.handleMessage(event, gap);
    });
  }

  private async handleMessage(
    event: DomainEventEnvelope<MessagePayload>,
    gap: GapFrame | null
  ): Promise<void> {
    if (event.room_id !== this.incidentsRoomId) return;
    if (!event.payload.addressed) return;

    // If the stream reported a sequence gap, re-read room history before acting
    if (gap) {
      await this.client.readContext(this.incidentsRoomId, 20);
    }

    const body = event.payload.body;
    const threadId = event.payload.thread_id ?? event.payload.message_id;

    // Case 1: Rollback completion notification from release-auditor
    const rollbackDoneMatch = body.match(/Rollback complete for ([a-f0-9]{7,40}) on \[([a-z0-9-]+)\]/i);
    if (rollbackDoneMatch) {
      const [, rolledBackSha, incId] = rollbackDoneMatch;
      const docName = `incident-${incId}.md`;
      const existingDocs = await this.client.loadInternalDocuments(this.incidentsRoomId);
      const doc = existingDocs.find((d) => d.name === docName);
      if (doc) {
        const updatedContent = [
          doc.content.replace(/Status:\s*INVESTIGATING/i, "Status: RESOLVED"),
          "",
          "## Resolution",
          `- Rolled back commit \`${rolledBackSha}\` after human operator approval.`,
          `- Postmortem record locked in room document \`${docName}\`.`,
        ].join("\n");
        await this.client.updateRoomDocument(this.incidentsRoomId, docName, updatedContent);
      }

      await this.client.postMessage(
        this.incidentsRoomId,
        `Incident [${incId}] marked RESOLVED in \`${docName}\` after revert of \`${rolledBackSha}\`.`,
        threadId
      );
      return;
    }

    // Case 2: New incident alert addressed to @incident-commander
    const incMatch = body.match(/\[([a-z0-9-]+)\]\s+(CRITICAL|WARNING)\s+on\s+([a-z0-9-_]+)/i);
    if (!incMatch) return;

    const [, incidentId, severity, service] = incMatch;
    const endpointMatch = body.match(/Endpoint:\s*([^\n]+)/i);
    const symptomMatch = body.match(/Symptom:\s*([^\n]+)/i);
    const endpoint = endpointMatch ? endpointMatch[1].trim() : "/v1/checkout";
    const symptom = symptomMatch ? symptomMatch[1].trim() : "Elevated 5xx rate";

    // Follow room link from incidents room -> releases room
    const linkedRooms = await this.client.listLinkedRooms(this.incidentsRoomId);
    const releasesLink = linkedRooms.find(
      (l) => l.label === "parent" || l.label === "releases"
    );

    let suspectRelease: ReleaseEntry | undefined;
    if (releasesLink) {
      const releaseDocs = await this.client.loadInternalDocuments(releasesLink.room_id);
      const ledgerDoc = releaseDocs.find((d) => d.name === "release-ledger.md");
      if (ledgerDoc) {
        const releases = parseReleaseLedger(ledgerDoc.content);
        const endpointSegment = endpoint.split("/").filter(Boolean).pop() ?? "checkout";
        suspectRelease =
          releases.find((r) =>
            r.touchedPaths.some((p) => p.toLowerCase().includes(endpointSegment.toLowerCase()))
          ) ?? releases[0];
      }
    }

    const docName = `incident-${incidentId}.md`;
    const docBody = [
      `# Incident ${incidentId}: ${service}`,
      `- Status: INVESTIGATING`,
      `- Severity: ${severity.toUpperCase()}`,
      `- Endpoint: ${endpoint}`,
      `- Symptom: ${symptom}`,
      suspectRelease
        ? `- Correlated Release: ${suspectRelease.version} (\`${suspectRelease.sha}\`) by ${suspectRelease.author} at ${suspectRelease.deployedAt}`
        : `- Correlated Release: none found in linked release ledger`,
    ].join("\n");

    await this.client.createRoomDocument(
      this.incidentsRoomId,
      docName,
      docBody,
      "Room-scoped incident timeline and root-cause record maintained by incident-triager."
    );

    if (suspectRelease) {
      await this.client.postMessage(
        this.incidentsRoomId,
        [
          `Triaged [${incidentId}] (${severity.toUpperCase()} on \`${endpoint}\`). Recorded timeline in \`${docName}\`.`,
          `Followed link to \`${releasesLink?.name}\`: latest deploy touching \`${endpoint}\` is **${suspectRelease.version}** (\`${suspectRelease.sha}\`, "${suspectRelease.summary}").`,
          `@regression-checker verify commit \`${suspectRelease.sha}\` for [${incidentId}] and prepare rollback plan.`,
        ].join("\n"),
        threadId
      );
    } else {
      await this.client.postMessage(
        this.incidentsRoomId,
        `Triaged [${incidentId}] on \`${endpoint}\`. Created \`${docName}\`, but no matching release was found in linked rooms.`,
        threadId
      );
    }
  }
}
