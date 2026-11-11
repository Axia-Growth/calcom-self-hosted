import oAuthManagerMock, {
  defaultMockOAuthManager,
  setFullMockOAuthManagerRequest,
} from "../../../tests/__mocks__/OAuthManager";
import "../__mocks__/features.repository";
import "../__mocks__/getGoogleAppKeys";
import { calendarMock, setLastCreatedJWT, setLastCreatedOAuth2Client } from "../__mocks__/googleapis";
import { beforeEach, describe, expect, test, vi } from "vitest";

const alertMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@calcom/features/calendars/lib/calendarSyncAlert", () => ({
  alertCalendarSyncFailure: alertMock,
}));

import { MeetLocationType } from "@calcom/app-store/constants";
import type { CredentialForCalendarServiceWithEmail } from "@calcom/types/Credential";
import BuildCalendarService from "../CalendarService";

/**
 * Regression tests for the Axia Scheduling incident (Nov 2026): Google created the event, a follow-up
 * call threw, Cal.com stored BookingReference.uid = "" and every later reschedule/cancel skipped Google.
 */

const mockCredential: CredentialForCalendarServiceWithEmail = {
  id: 1,
  userId: 1,
  appId: "google-calendar",
  type: "google_calendar",
  key: { access_token: "<INVALID_TOKEN>" },
  user: { email: "user@example.com" },
  delegationCredentialId: null,
  delegatedTo: null,
  invalid: false,
  teamId: null,
  encryptedKey: null,
};

const HANGOUT = "https://meet.google.com/abc-defg-hij";
const ICAL_UID = "bookinguid123@Axia Scheduling";

const buildCalEvent = (overrides: Record<string, unknown> = {}) => ({
  type: "test-event-type",
  uid: "bookinguid123",
  iCalUID: ICAL_UID,
  title: "Mike <> Test",
  startTime: "2026-12-01T00:45:00Z",
  endTime: "2026-12-01T01:00:00Z",
  organizer: {
    id: 1,
    name: "Test Organizer",
    email: "organizer@example.com",
    timeZone: "UTC",
    language: { translate: (...args: unknown[]) => args[0], locale: "en" },
  },
  attendees: [],
  location: MeetLocationType,
  calendarDescription: "desc",
  destinationCalendar: [
    {
      id: 1,
      integration: "google_calendar",
      externalId: "primary",
      primaryEmail: null,
      userId: mockCredential.userId,
      eventTypeId: null,
      credentialId: mockCredential.id,
      delegationCredentialId: null,
      domainWideDelegationCredentialId: null,
      createdAt: new Date("2026-11-11T00:00:00Z"),
      updatedAt: new Date("2026-11-11T00:00:00Z"),
      customCalendarReminder: null,
    },
  ],
  ...overrides,
});

const events = () => calendarMock.calendar_v3.Calendar().events as Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  vi.clearAllMocks();
  oAuthManagerMock.OAuthManager = defaultMockOAuthManager;
  setLastCreatedJWT(null);
  setLastCreatedOAuth2Client(null);
  setFullMockOAuthManagerRequest();
  const ev = events();
  ev.insert = vi.fn();
  ev.patch = vi.fn();
  ev.update = vi.fn();
  ev.list = vi.fn();
  ev.delete = vi.fn();
});

describe("createEvent keeps the Google event id when a follow-up call fails", () => {
  test("Meet-link patch failure is non-fatal: returns the created event id and alerts", async () => {
    const created = { id: "gcal-event-1", iCalUID: ICAL_UID, hangoutLink: HANGOUT };
    events().insert.mockResolvedValue({ data: created });
    events().patch.mockRejectedValue(Object.assign(new Error("Backend Error"), { code: 503 }));

    const service = BuildCalendarService(mockCredential);
    const result = await service.createEvent(buildCalEvent() as never, mockCredential.id);

    expect(result.id).toBe("gcal-event-1");
    expect(result.additionalInfo?.hangoutLink).toBe(HANGOUT);
    // retried once, then gave up without throwing
    expect(events().patch).toHaveBeenCalledTimes(2);
    expect(alertMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "meet-link-patch", bookingUid: "bookinguid123" })
    );
  });

  test("insert throws but the event exists on Google -> adopts it by iCalUID", async () => {
    events().insert.mockRejectedValue(
      Object.assign(new Error("The requested identifier already exists."), { code: 409, config: {} })
    );
    events().list.mockResolvedValue({
      data: {
        items: [{ id: "gcal-existing", iCalUID: ICAL_UID, status: "confirmed", hangoutLink: HANGOUT }],
      },
    });
    events().patch.mockResolvedValue({ data: {} });

    const service = BuildCalendarService(mockCredential);
    const result = await service.createEvent(buildCalEvent() as never, mockCredential.id);

    expect(events().list).toHaveBeenCalledWith(expect.objectContaining({ iCalUID: ICAL_UID }));
    expect(result.id).toBe("gcal-existing");
    expect(events().patch.mock.calls[0][0].requestBody.location).toBe(HANGOUT);
    expect(alertMock).toHaveBeenCalledWith(expect.objectContaining({ action: "create-recovered" }));
  });

  test("insert throws and nothing exists on Google -> still throws", async () => {
    events().insert.mockRejectedValue(Object.assign(new Error("Forbidden"), { code: 403, config: {} }));
    events().list.mockResolvedValue({ data: { items: [] } });

    const service = BuildCalendarService(mockCredential);
    await expect(service.createEvent(buildCalEvent() as never, mockCredential.id)).rejects.toThrow(
      "Forbidden"
    );
  });
});

describe("updateEvent / deleteEvent with an empty stored Google event id", () => {
  test("updateEvent('') finds the event by iCalUID and updates it (reschedule lands on the calendar)", async () => {
    events().list.mockResolvedValue({
      data: { items: [{ id: "gcal-orphan", iCalUID: ICAL_UID, status: "confirmed" }] },
    });
    events().update.mockResolvedValue({ data: { id: "gcal-orphan", hangoutLink: HANGOUT } });
    events().patch.mockResolvedValue({ data: {} });

    const service = BuildCalendarService(mockCredential);
    const result = await service.updateEvent("", buildCalEvent() as never, "primary");

    expect(events().update).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "gcal-orphan", sendUpdates: "all" })
    );
    expect(events().patch.mock.calls[0][0].requestBody.location).toBe(HANGOUT);
    expect(result.id).toBe("gcal-orphan");
  });

  test("updateEvent('') with no event on Google creates it instead of silently doing nothing", async () => {
    events().list.mockResolvedValue({ data: { items: [] } });
    events().insert.mockResolvedValue({ data: { id: "gcal-new", iCalUID: ICAL_UID } });

    const service = BuildCalendarService(mockCredential);
    const result = await service.updateEvent("", buildCalEvent() as never, "primary");

    expect(events().update).not.toHaveBeenCalled();
    expect(events().insert).toHaveBeenCalledTimes(1);
    expect(result.id).toBe("gcal-new");
  });

  test("deleteEvent('') finds the event by iCalUID and deletes it (cancel lands on the calendar)", async () => {
    events().list.mockResolvedValue({
      data: { items: [{ id: "gcal-orphan", iCalUID: ICAL_UID, status: "confirmed" }] },
    });
    events().delete.mockResolvedValue({ data: undefined });

    const service = BuildCalendarService(mockCredential);
    await service.deleteEvent("", buildCalEvent() as never, "primary");

    expect(events().delete).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "gcal-orphan", sendUpdates: "all" })
    );
  });

  test("deleteEvent('') with nothing on Google is a no-op", async () => {
    events().list.mockResolvedValue({ data: { items: [] } });

    const service = BuildCalendarService(mockCredential);
    await service.deleteEvent("", buildCalEvent() as never, "primary");

    expect(events().delete).not.toHaveBeenCalled();
  });

  test("a stored id is used as-is without any iCalUID lookup", async () => {
    events().update.mockResolvedValue({ data: { id: "gcal-known" } });

    const service = BuildCalendarService(mockCredential);
    await service.updateEvent("gcal-known", buildCalEvent({ location: "Office" }) as never, "primary");

    expect(events().list).not.toHaveBeenCalled();
    expect(events().update).toHaveBeenCalledWith(expect.objectContaining({ eventId: "gcal-known" }));
  });
});
