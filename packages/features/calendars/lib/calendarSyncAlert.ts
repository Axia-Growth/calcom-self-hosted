import process from "node:process";
import logger from "@calcom/lib/logger";
import { safeStringify } from "@calcom/lib/safeStringify";

const log = logger.getSubLogger({ prefix: ["CALENDAR_SYNC_FAILURE"] });

export type CalendarSyncAction =
  | "create"
  | "update"
  | "delete"
  // The calendar write threw, but we found the event on the calendar and kept it.
  | "create-recovered"
  // The event was written but setting the Meet link as location/description failed.
  | "meet-link-patch";

export type CalendarSyncFailure = {
  action: CalendarSyncAction;
  bookingUid?: string | null;
  credentialId?: number | null;
  credentialType?: string | null;
  startTime?: string | null;
  error?: unknown;
  detail?: string;
};

const ALERT_TIMEOUT_MS = 5000;

function describeError(error: unknown): string {
  if (!error) return "";
  if (typeof error === "string") return error;
  const e = error as { code?: unknown; status?: unknown; message?: unknown; calError?: unknown };
  const code = e.code ?? e.status;
  const message =
    typeof e.message === "string" ? e.message : typeof e.calError === "string" ? e.calError : "";
  const text = [code ? `code=${String(code)}` : "", message].filter(Boolean).join(" ");
  return (text || String(safeStringify(error))).slice(0, 500);
}

export function getCalendarSyncAlertWebhookUrl(): string | undefined {
  return (
    process.env.CALENDAR_SYNC_ALERT_SLACK_WEBHOOK_URL || process.env.SLACK_INFRA_WEBHOOK_URL || undefined
  );
}

export function formatCalendarSyncAlert(failure: CalendarSyncFailure): string {
  const parts = [
    `:rotating_light: Calendar sync ${failure.action} failed`,
    failure.bookingUid ? `booking=${failure.bookingUid}` : "",
    failure.startTime ? `start=${failure.startTime}` : "",
    failure.credentialType ? `calendar=${failure.credentialType}` : "",
    failure.credentialId ? `credentialId=${failure.credentialId}` : "",
  ].filter(Boolean);
  const error = describeError(failure.error);
  return [parts.join(" | "), failure.detail, error ? `error: ${error}` : ""].filter(Boolean).join("\n");
}

/**
 * Loud, never-throwing alert for calendar writes that did not land.
 *
 * Before this existed, CalendarManager swallowed calendar errors and only wrote a log line, so a
 * booking could be confirmed (and emailed) while the host's calendar was never created/updated/deleted.
 * Always logs at error level with a greppable tag; posts to Slack when a webhook is configured
 * (CALENDAR_SYNC_ALERT_SLACK_WEBHOOK_URL, falling back to the platform-wide SLACK_INFRA_WEBHOOK_URL).
 */
export async function alertCalendarSyncFailure(failure: CalendarSyncFailure): Promise<void> {
  const text = formatCalendarSyncAlert(failure);
  try {
    log.error(`[CALENDAR_SYNC_FAILURE] ${text}`);
  } catch {
    // logging must never break the booking flow
  }

  const url = getCalendarSyncAlertWebhookUrl();
  if (!url) {
    log.error("[CALENDAR_SYNC_FAILURE] No SLACK_INFRA_WEBHOOK_URL configured; Slack alert not delivered");
    return;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.error(`[CALENDAR_SYNC_FAILURE] Slack alert returned HTTP ${res.status}`);
    }
  } catch (error) {
    log.error("[CALENDAR_SYNC_FAILURE] Slack alert could not be delivered", describeError(error));
  }
}
