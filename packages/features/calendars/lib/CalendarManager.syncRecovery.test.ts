import { prisma } from "@calcom/prisma/__mocks__/prisma";
import { getCalendar } from "@calcom/app-store/_utils/getCalendar";
import type { CalendarEvent } from "@calcom/types/Calendar";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEvent, deleteEvent, updateEvent } from "./CalendarManager";

const alertMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("./calendarSyncAlert", () => ({ alertCalendarSyncFailure: alertMock }));
vi.mock("@calcom/prisma", () => ({ prisma }));
vi.mock("@calcom/app-store/_utils/getCalendar", () => ({ getCalendar: vi.fn() }));
vi.mock("@calcom/lib/constants", () => ({ ORGANIZER_EMAIL_EXEMPT_DOMAINS: "", IS_PRODUCTION: false }));
vi.mock("@calcom/app-store/locations", () => ({ MeetLocationType: "integrations:google:meet" }));
vi.mock("@calcom/lib/CalEventParser", () => ({
  getRichDescription: vi.fn(() => "Test description"),
  getUid: vi.fn((uid?: string) => uid ?? "generated-uid"),
}));
vi.mock("@calcom/app-store/delegationCredential", () => ({
  enrichHostsWithDelegationCredentials: vi.fn(),
  getUsersCredentialsIncludeServiceAccountKey: vi.fn(),
  getCredentialForSelectedCalendar: vi.fn(),
  findUniqueDelegationCalendarCredential: vi.fn(),
  getAllDelegationCredentialsForUserIncludeServiceAccountKey: vi.fn(),
  getDelegationCredentialOrFindRegularCredential: vi.fn(),
}));

const credential = (type = "google_calendar") => ({
  id: 27,
  type,
  key: { access_token: "x" },
  encryptedKey: null,
  userId: 26,
  user: { email: "host@example.com" },
  teamId: null,
  appId: type === "google_calendar" ? "google-calendar" : "office365-calendar",
  invalid: false,
  delegationCredentialId: null,
  delegatedTo: null,
});

const calEvent = (overrides: Partial<CalendarEvent> = {}) =>
  ({
    type: "30min",
    title: "Mike <> Test",
    uid: "bookinguid123",
    iCalUID: "bookinguid123@Axia Scheduling",
    startTime: "2026-12-01T00:45:00Z",
    endTime: "2026-12-01T01:00:00Z",
    organizer: {
      name: "Host",
      email: "host@example.com",
      timeZone: "UTC",
      language: { translate: (s: string) => s, locale: "en" },
    },
    attendees: [],
    ...overrides,
  }) as unknown as CalendarEvent;

describe("CalendarManager: never lose a calendar write silently", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updateEvent with empty bookingRefUid still calls the Google adapter so it can recover by iCalUID", async () => {
    const updateEventMock = vi.fn().mockResolvedValue({ id: "gcal-orphan" });
    vi.mocked(getCalendar).mockResolvedValue({ updateEvent: updateEventMock } as never);

    const result = await updateEvent(credential() as never, calEvent(), "", "host@example.com");

    expect(updateEventMock).toHaveBeenCalledWith("", expect.anything(), "host@example.com");
    expect(result.success).toBe(true);
    expect(alertMock).not.toHaveBeenCalled();
  });

  it("updateEvent with empty bookingRefUid on a non-Google calendar is skipped and alerts", async () => {
    const updateEventMock = vi.fn();
    vi.mocked(getCalendar).mockResolvedValue({ updateEvent: updateEventMock } as never);

    const result = await updateEvent(credential("office365_calendar") as never, calEvent(), "", null);

    expect(updateEventMock).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(alertMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "update", bookingUid: "bookinguid123" })
    );
  });

  it("updateEvent alerts when the calendar call throws", async () => {
    vi.mocked(getCalendar).mockResolvedValue({
      updateEvent: vi.fn().mockRejectedValue(Object.assign(new Error("Not Found"), { code: 404 })),
    } as never);

    const result = await updateEvent(credential() as never, calEvent(), "gcal-1", null);

    expect(result.success).toBe(false);
    expect(alertMock).toHaveBeenCalledWith(expect.objectContaining({ action: "update" }));
  });

  it("createEvent alerts when the calendar write fails", async () => {
    vi.mocked(getCalendar).mockResolvedValue({
      createEvent: vi.fn().mockRejectedValue(Object.assign(new Error("Backend Error"), { code: 503 })),
    } as never);

    const result = await createEvent(credential() as never, calEvent());

    expect(result.success).toBe(false);
    expect(alertMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "create", bookingUid: "bookinguid123", credentialId: 27 })
    );
  });

  it("deleteEvent with empty bookingRefUid reaches the Google adapter when iCalUID is known", async () => {
    const deleteEventMock = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getCalendar).mockResolvedValue({ deleteEvent: deleteEventMock } as never);

    await deleteEvent({ credential: credential() as never, bookingRefUid: "", event: calEvent() });

    expect(deleteEventMock).toHaveBeenCalledWith("", expect.anything(), undefined);
  });

  it("deleteEvent alerts and rethrows when the calendar call throws", async () => {
    vi.mocked(getCalendar).mockResolvedValue({
      deleteEvent: vi.fn().mockRejectedValue(new Error("Forbidden")),
    } as never);

    await expect(
      deleteEvent({ credential: credential() as never, bookingRefUid: "gcal-1", event: calEvent() })
    ).rejects.toThrow("Forbidden");
    expect(alertMock).toHaveBeenCalledWith(expect.objectContaining({ action: "delete" }));
  });
});
