export interface NormalizedIncidentAlert {
  incidentId: string;
  service: string;
  severity: "critical" | "warning";
  summary: string;
  endpoint: string;
  errorSignature: string;
  startedAt: string;
}

export interface AlertmanagerWebhookPayload {
  status: "firing" | "resolved";
  alerts: Array<{
    status: "firing" | "resolved";
    labels: Record<string, string>;
    annotations: Record<string, string>;
    startsAt: string;
    fingerprint?: string;
  }>;
}

export function normalizeAlertmanagerPayload(
  payload: AlertmanagerWebhookPayload
): NormalizedIncidentAlert[] {
  return payload.alerts
    .filter((a) => a.status === "firing")
    .map((alert, idx) => {
      const incidentId =
        alert.labels.incident_id ??
        alert.fingerprint?.slice(0, 8) ??
        `inc-${idx + 1}`;
      return {
        incidentId,
        service: alert.labels.service ?? "payments-api",
        severity:
          alert.labels.severity === "critical" ? "critical" : "warning",
        summary:
          alert.annotations.summary ??
          alert.labels.alertname ??
          "Unhandled service alert",
        endpoint: alert.labels.endpoint ?? "/v1/checkout/authorize",
        errorSignature:
          alert.annotations.error_signature ??
          alert.annotations.description ??
          "HTTP 502 upstream timeout",
        startedAt: alert.startsAt,
      };
    });
}

export function formatAlertForSwitchRoom(alert: NormalizedIncidentAlert): string {
  return [
    `@incident-commander [${alert.incidentId}] ${alert.severity.toUpperCase()} on ${alert.service}`,
    `Endpoint: ${alert.endpoint}`,
    `Symptom: ${alert.summary} (${alert.errorSignature})`,
    `Triggered: ${alert.startedAt}`,
  ].join("\n");
}
