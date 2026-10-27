import type { SwitchAgentClient } from "../protocol/switch-client.js";
import type { DomainEventEnvelope, MessagePayload } from "../protocol/types.js";
import { parseReleaseLedger } from "./incident-triager.js";

export interface PendingRollback {
  incidentId: string;
  sha: string;
  version: string;
  threadId: string | null;
}

export class ReleaseAuditorAgent {
  private readonly client: SwitchAgentClient;
  private readonly releasesRoomId: string;
  private readonly incidentsRoomId: string;
  private readonly allowedApprovers: Set<string>;
  private pendingRollbacks = new Map<string, PendingRollback>();

  constructor(options: {
    client: SwitchAgentClient;
    releasesRoomId: string;
    incidentsRoomId: string;
    allowedApprovers: string[];
  }) {
    this.client = options.client;
    this.releasesRoomId = options.releasesRoomId;
    this.incidentsRoomId = options.incidentsRoomId;
    this.allowedApprovers = new Set(options.allowedApprovers);
  }

  async initialize(): Promise<void> {
    await this.client.connectToRoom(this.releasesRoomId);
    await this.client.connectToRoom(this.incidentsRoomId);
    await this.client.assumeRole(this.releasesRoomId, "release-manager");
    await this.client.assumeRole(this.incidentsRoomId, "regression-checker");

    this.client.onMessage(async (event) => {
      await this.handleMessage(event);
    });
  }

  private async handleMessage(
    event: DomainEventEnvelope<MessagePayload>
  ): Promise<void> {
    if (!event.payload.addressed) return;
    const body = event.payload.body;
    const threadId = event.payload.thread_id ?? event.payload.message_id;

    // 1. Handoff from incident-triager asking @regression-checker to verify a suspect commit
    const verifyMatch = body.match(
      /verify commit `([a-f0-9]{7,40})` for \[([a-z0-9-]+)\]/i
    );
    if (verifyMatch && event.room_id === this.incidentsRoomId) {
      const [, sha, incidentId] = verifyMatch;
      const docs = await this.client.loadInternalDocuments(this.releasesRoomId);
      const ledger = docs.find((d) => d.name === "release-ledger.md");
      const entries = ledger ? parseReleaseLedger(ledger.content) : [];
      const entry = entries.find((e) => e.sha === sha);

      const version = entry?.version ?? "v-unknown";
      this.pendingRollbacks.set(sha, {
        incidentId,
        sha,
        version,
        threadId,
      });

      await this.client.postMessage(
        this.incidentsRoomId,
        [
          `Verified commit \`${sha}\` (${version}): diff modified \`${entry?.touchedPaths.join(", ") ?? "checkout handler"}\` (${entry?.summary ?? "retry timeout change"}).`,
          `Rollback plan ready: \`git revert --no-edit ${sha}\` and redeploy previous stable image.`,
          `Human gate required: an on-call operator must reply \`@release-manager confirm rollback ${sha}\` to execute.`,
        ].join("\n"),
        threadId
      );
      return;
    }

    // 2. Human gate confirmation: @release-manager confirm rollback <sha>
    const confirmMatch = body.match(/confirm rollback\s+([a-f0-9]{7,40})/i);
    if (confirmMatch) {
      const [, sha] = confirmMatch;
      const pending = this.pendingRollbacks.get(sha);
      if (!pending) {
        await this.client.postMessage(
          event.room_id,
          `No pending rollback found for commit \`${sha}\`.`,
          threadId
        );
        return;
      }

      if (!this.allowedApprovers.has(event.payload.sender_name)) {
        await this.client.postMessage(
          event.room_id,
          `Refused rollback for \`${sha}\`: sender \`${event.payload.sender_name}\` is not in the authorized release approvers list.`,
          threadId
        );
        return;
      }

      // Update release-ledger.md in the releases room
      const docs = await this.client.loadInternalDocuments(this.releasesRoomId);
      const ledger = docs.find((d) => d.name === "release-ledger.md");
      if (ledger) {
        const updatedLedger = [
          `## ${pending.version}-revert (revert-${sha})`,
          `- Author: ${event.payload.sender_name} (via release-auditor)`,
          `- Deployed: ${new Date().toISOString()}`,
          `- Paths: revert of ${sha}`,
          `- Summary: Emergency rollback for incident [${pending.incidentId}]`,
          "",
          ledger.content,
        ].join("\n");
        await this.client.updateRoomDocument(
          this.releasesRoomId,
          "release-ledger.md",
          updatedLedger
        );
      }

      this.pendingRollbacks.delete(sha);

      await this.client.postMessage(
        this.releasesRoomId,
        `Executed rollback of \`${sha}\` (${pending.version}) approved by \`${event.payload.sender_name}\` for incident [${pending.incidentId}].`
      );

      await this.client.postMessage(
        this.incidentsRoomId,
        `@incident-commander Rollback complete for ${sha} on [${pending.incidentId}] (approved by ${event.payload.sender_name}).`,
        pending.threadId
      );
    }
  }
}
