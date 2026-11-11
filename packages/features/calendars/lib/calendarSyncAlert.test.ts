import process from "node:process";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { alertCalendarSyncFailure, formatCalendarSyncAlert } from "./calendarSyncAlert";

describe("calendarSyncAlert", () => {
  const originalEnv = { ...process.env };
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    delete process.env.CALENDAR_SYNC_ALERT_SLACK_WEBHOOK_URL;
    delete process.env.SLACK_INFRA_WEBHOOK_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
  });

  test("formats action, booking, calendar and error", () => {
    const text = formatCalendarSyncAlert({
      action: "update",
      bookingUid: "abc",
      credentialId: 27,
      credentialType: "google_calendar",
      startTime: "2026-11-12T18:30:00Z",
      error: Object.assign(new Error("Not Found"), { code: 404 }),
      detail: "Reschedule did NOT reach the host calendar",
    });
    expect(text).toContain("Calendar sync update failed");
    expect(text).toContain("booking=abc");
    expect(text).toContain("credentialId=27");
    expect(text).toContain("code=404 Not Found");
  });

  test("posts to SLACK_INFRA_WEBHOOK_URL when set", async () => {
    process.env.SLACK_INFRA_WEBHOOK_URL = "https://hooks.slack.test/infra";
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    await alertCalendarSyncFailure({ action: "create", bookingUid: "abc", error: "boom" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://hooks.slack.test/infra");
    expect(JSON.parse(init.body).text).toContain("Calendar sync create failed");
  });

  test("prefers the dedicated CALENDAR_SYNC_ALERT_SLACK_WEBHOOK_URL", async () => {
    process.env.SLACK_INFRA_WEBHOOK_URL = "https://hooks.slack.test/infra";
    process.env.CALENDAR_SYNC_ALERT_SLACK_WEBHOOK_URL = "https://hooks.slack.test/cal";
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    await alertCalendarSyncFailure({ action: "delete" });

    expect(fetchMock.mock.calls[0][0]).toBe("https://hooks.slack.test/cal");
  });

  test("never throws: no webhook configured, or Slack unreachable", async () => {
    await expect(alertCalendarSyncFailure({ action: "create" })).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();

    process.env.SLACK_INFRA_WEBHOOK_URL = "https://hooks.slack.test/infra";
    fetchMock.mockRejectedValue(new Error("ECONNRESET"));
    await expect(alertCalendarSyncFailure({ action: "create" })).resolves.toBeUndefined();
  });
});
