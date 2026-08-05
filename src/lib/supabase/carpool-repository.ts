import type { SupabaseClient } from "@supabase/supabase-js";

import { isNoSchoolDay, todayInTimezone, PILOT_TIMEZONE } from "../school-calendar";
import type {
  ConfirmationResponse,
  Database,
  DefaultDrivePref,
  DefaultRideNeed,
  DrivePreference,
  Json,
  Tables,
  TablesInsert,
} from "./database.types";

export type HouseholdSetup = {
  household: Tables<"households">;
  adults: Array<{
    membership: Tables<"memberships">;
    profile: Tables<"profiles">;
  }>;
  children: Tables<"children">[];
  vehicles: Tables<"vehicles">[];
};

export type WeekWithTrips = {
  week: Tables<"weeks">;
  trips: Tables<"trips">[];
};

export type CheckinDetails = {
  checkin: Tables<"weekly_checkins">;
  rideRequests: Tables<"ride_requests">[];
  driverAvailability: Tables<"driver_availability">[];
};

export type TripOverview = {
  trip: Tables<"trips">;
  riderCount: number;
  driverCount: number;
  seatCount: number;
};

export type HouseholdCheckinStatus = {
  household: Tables<"households">;
  status: "not_started" | "draft" | "submitted";
};

export type WeekOverview = {
  trips: TripOverview[];
  households: HouseholdCheckinStatus[];
};

export type ScheduleRosterEntry = {
  driverAssignment: Tables<"driver_assignments">;
  driverProfile: Tables<"profiles">;
  vehicle: Tables<"vehicles">;
  children: Tables<"children">[];
};

export type ScheduleVersionWithRosters = {
  version: Tables<"schedule_versions">;
  trips: Tables<"trips">[];
  rostersByTrip: Map<string, ScheduleRosterEntry[]>;
  uncoveredRidersByTrip: Map<string, Tables<"children">[]>;
};

export type GenerateScheduleResult = {
  success: boolean;
  version?: { id: string; version_number: number };
  algorithm?: string;
  uncovered_trips?: number;
  warning?: string | null;
  trips?: Array<{
    trip_id: string;
    rider_count: number;
    assigned_rider_count: number;
    uncovered_rider_count: number;
    driver_count: number;
    uncovered: boolean;
  }>;
  error?: string;
};

export type MyDriverAssignment = {
  assignment: Tables<"driver_assignments">;
  trip: Tables<"trips">;
  vehicle: Tables<"vehicles">;
  children: Tables<"children">[];
};

export type DeclinedDriveAlert = {
  assignment: Tables<"driver_assignments">;
  trip: Tables<"trips">;
  vehicle: Tables<"vehicles"> | null;
  driverProfile: Tables<"profiles"> | null;
  children: Tables<"children">[];
  myChildren: Tables<"children">[];
  volunteerVehicleCapacity: number | null;
};

export type UncoveredChildAlert = {
  trip: Tables<"trips">;
  children: Tables<"children">[];
  volunteerVehicleCapacity: number | null;
};

function unwrap<T>(result: { data: T; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

function tripSortKey(trip: { service_date: string; direction: string }): string {
  return `${trip.service_date}|${trip.direction === "morning" ? "0" : "1"}`;
}

function unwrapRequired<T>(
  result: { data: T | null; error: { message: string } | null },
  message = "The database returned no data.",
): T {
  if (result.error) throw new Error(result.error.message);
  if (result.data === null) throw new Error(message);
  return result.data;
}

export class CarpoolRepository {
  constructor(private readonly client: SupabaseClient<Database>) {}

  /**
   * Best-effort audit trail append. Audit failures are swallowed so the
   * user's primary action is never blocked by an audit write. The RLS
   * policy on audit_events requires actor_profile_id = auth.uid().
   */
  private async recordAudit(
    groupId: string,
    action: string,
    entityType: string,
    entityId: string | null = null,
    details: Json = {},
  ): Promise<void> {
    try {
      const userResult = await this.client.auth.getUser();
      if (userResult.error || !userResult.data.user) return;
      await this.client.from("audit_events").insert({
        group_id: groupId,
        actor_profile_id: userResult.data.user.id,
        action,
        entity_type: entityType,
        entity_id: entityId,
        details,
      });
    } catch {
      // Best-effort: do not surface audit failures to the user.
    }
  }

  /**
   * Fetch all profiles in a group via the list_group_profiles RPC.
   * Returns rows with email="" placeholder (email is excluded from
   * group-scoped reads for privacy).
   */
  private async fetchGroupProfiles(
    groupId: string,
  ): Promise<Tables<"profiles">[]> {
    const rows = unwrapRequired(
      await this.client.rpc("list_group_profiles", {
        target_group_id: groupId,
      }),
    );
    return rows.map((r) => ({
      id: r.id,
      email: "",
      full_name: r.full_name,
      avatar_url: r.avatar_url,
      default_drive_preferences: r.default_drive_preferences as
        | DefaultDrivePref[]
        | null,
      phone: null,
      share_phone: true,
      share_email: true,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
  }

  /**
   * Fetch the parent directory for a group: all active members with
   * phone/email returned only when the owner has opted in (share_phone/
   * share_email). Includes household_name and role.
   */
  async listGroupDirectory(groupId: string) {
    return unwrapRequired(
      await this.client.rpc("list_group_directory", {
        target_group_id: groupId,
      }),
    );
  }

  async getCurrentProfile() {
    const userResult = await this.client.auth.getUser();
    if (userResult.error) throw new Error(userResult.error.message);
    if (!userResult.data.user) return null;

    return unwrap(
      await this.client
        .from("profiles")
        .select("*")
        .eq("id", userResult.data.user.id)
        .maybeSingle(),
    );
  }

  async updateCurrentProfile(
    fields: { fullName?: string; phone?: string | null; sharePhone?: boolean; shareEmail?: boolean },
  ): Promise<Tables<"profiles">>;
  async updateCurrentProfile(fullName: string): Promise<Tables<"profiles">>;
  async updateCurrentProfile(
    fields:
      | string
      | { fullName?: string; phone?: string | null; sharePhone?: boolean; shareEmail?: boolean },
  ): Promise<Tables<"profiles">> {
    const payload: {
      full_name?: string;
      phone?: string | null;
      share_phone?: boolean;
      share_email?: boolean;
    } = {};
    if (typeof fields === "string") {
      const normalizedName = fields.trim().replace(/\s+/g, " ");
      if (!normalizedName) throw new Error("Enter your full name.");
      payload.full_name = normalizedName;
    } else {
      if (fields.fullName !== undefined) {
        const normalizedName = fields.fullName.trim().replace(/\s+/g, " ");
        if (!normalizedName) throw new Error("Enter your full name.");
        payload.full_name = normalizedName;
      }
      if (fields.phone !== undefined) payload.phone = fields.phone;
      if (fields.sharePhone !== undefined) payload.share_phone = fields.sharePhone;
      if (fields.shareEmail !== undefined) payload.share_email = fields.shareEmail;
    }

    const userResult = await this.client.auth.getUser();
    if (userResult.error) throw new Error(userResult.error.message);
    if (!userResult.data.user) throw new Error("Sign in again to continue.");

    return unwrapRequired(
      await this.client
        .from("profiles")
        .update(payload)
        .eq("id", userResult.data.user.id)
        .select("*")
        .single(),
    );
  }

  async getDefaultDrivePreferences(profileId: string): Promise<DefaultDrivePref[]> {
    const row = unwrap(
      await this.client
        .from("profiles")
        .select("default_drive_preferences")
        .eq("id", profileId)
        .maybeSingle(),
    );
    if (!row) return [];
    const prefs = row.default_drive_preferences;
    if (!Array.isArray(prefs)) return [];
    return prefs as unknown as DefaultDrivePref[];
  }

  async saveDefaultDrivePreferences(preferences: DefaultDrivePref[]): Promise<void> {
    const userResult = await this.client.auth.getUser();
    if (userResult.error) throw new Error(userResult.error.message);
    if (!userResult.data.user) throw new Error("Sign in again to continue.");

    unwrap(
      await this.client
        .from("profiles")
        .update({ default_drive_preferences: preferences })
        .eq("id", userResult.data.user.id),
    );
  }

  async applyDefaultDrivePreferences(
    checkinId: string,
    profileId: string,
    trips: Tables<"trips">[],
    vehicleId: string | null,
    groupId: string,
  ): Promise<void> {
    const defaults = await this.getDefaultDrivePreferences(profileId);
    if (defaults.length === 0) return;

    for (const trip of trips) {
      const tripDate = new Date(trip.service_date + "T00:00:00");
      const isoDay = tripDate.getDay() === 0 ? 7 : tripDate.getDay();
      const match = defaults.find(
        (d) => d.day === isoDay && d.direction === trip.direction,
      );
      if (match) {
        await this.upsertDriverAvailability(
          checkinId, trip.id, profileId,
          match.preference === "cannot" ? null : vehicleId,
          match.preference, groupId,
        );
      }
    }
  }

  async getDefaultRideNeeds(householdId: string): Promise<DefaultRideNeed[]> {
    const row = unwrap(
      await this.client
        .from("households")
        .select("default_ride_needs")
        .eq("id", householdId)
        .maybeSingle(),
    );
    if (!row) return [];
    const needs = row.default_ride_needs;
    if (!Array.isArray(needs)) return [];
    return needs as unknown as DefaultRideNeed[];
  }

  async saveDefaultRideNeeds(householdId: string, needs: DefaultRideNeed[]): Promise<void> {
    const userResult = await this.client.auth.getUser();
    if (userResult.error) throw new Error(userResult.error.message);
    if (!userResult.data.user) throw new Error("Sign in again to continue.");

    unwrap(
      await this.client
        .from("households")
        .update({ default_ride_needs: needs })
        .eq("id", householdId),
    );
  }

  async applyDefaultRideNeeds(
    checkinId: string,
    householdId: string,
    trips: Tables<"trips">[],
    children: Tables<"children">[],
    groupId: string,
    createdBy: string,
  ): Promise<void> {
    const defaults = await this.getDefaultRideNeeds(householdId);
    if (defaults.length === 0) return;

    const rows: TablesInsert<"ride_requests">[] = [];
    for (const trip of trips) {
      const tripDate = new Date(trip.service_date + "T00:00:00");
      const isoDay = tripDate.getDay() === 0 ? 7 : tripDate.getDay();
      for (const child of children) {
        const match = defaults.find(
          (d) => d.child_id === child.id && d.day === isoDay && d.direction === trip.direction,
        );
        rows.push({
          group_id: groupId,
          checkin_id: checkinId,
          trip_id: trip.id,
          child_id: child.id,
          needs_ride: match?.needs_ride ?? false,
          created_by: createdBy,
        });
      }
    }

    if (rows.length > 0) {
      unwrap(
        await this.client
          .from("ride_requests")
          .upsert(rows, { onConflict: "trip_id,child_id" }),
      );
    }
  }

  async listAvailableGroups() {
    return unwrapRequired(
      await this.client
        .from("groups")
        .select("*")
        .order("name", { ascending: true }),
    );
  }

  async getCurrentMembership(groupId: string) {
    const userResult = await this.client.auth.getUser();
    if (userResult.error) throw new Error(userResult.error.message);
    if (!userResult.data.user) return null;

    return unwrap(
      await this.client
        .from("memberships")
        .select("*")
        .eq("group_id", groupId)
        .eq("profile_id", userResult.data.user.id)
        .maybeSingle(),
    );
  }

  async createHousehold(groupId: string, householdName: string) {
    const result = await this.client.rpc("create_household_with_membership", {
      target_group_id: groupId,
      household_name: householdName.trim(),
    });
    const rows = unwrapRequired(result);
    const created = rows[0];
    if (!created) throw new Error("The household was not created.");
    return created;
  }

  async listGroupHouseholdNames(groupId: string): Promise<string[]> {
    const rows = unwrapRequired(
      await this.client
        .from("households")
        .select("name")
        .eq("group_id", groupId)
        .order("name"),
    );
    return rows.map((r: { name: string }) => r.name);
  }

  async joinHousehold(groupId: string, joinCode: string) {
    return unwrap(
      await this.client.rpc("join_household_by_code", {
        target_group_id: groupId,
        supplied_join_code: joinCode.trim(),
      }),
    );
  }

  async regenerateJoinCode(householdId: string): Promise<string> {
    return unwrapRequired(
      await this.client.rpc("regenerate_join_code", {
        target_household_id: householdId,
      }),
      "Failed to generate join code.",
    );
  }

  async getHouseholdSetup(householdId: string): Promise<HouseholdSetup | null> {
    const household = unwrap(
      await this.client
        .from("households")
        .select("*")
        .eq("id", householdId)
        .maybeSingle(),
    );
    if (!household) return null;

    const [membershipRows, children, vehicles] = await Promise.all([
      unwrapRequired(
        await this.client
          .from("memberships")
          .select("*")
          .eq("household_id", householdId)
          .eq("status", "active"),
      ),
      unwrapRequired(
        await this.client
          .from("children")
          .select("*")
          .eq("household_id", householdId)
          .eq("active", true)
          .order("first_name"),
      ),
      unwrapRequired(
        await this.client
          .from("vehicles")
          .select("*")
          .eq("household_id", householdId)
          .eq("active", true)
          .order("label"),
      ),
    ]);

    const allProfiles = await this.fetchGroupProfiles(household.group_id);
    const profileById = new Map(allProfiles.map((profile) => [profile.id, profile]));

    return {
      household,
      adults: membershipRows.flatMap((membership) => {
        const profile = profileById.get(membership.profile_id);
        return profile ? [{ membership, profile }] : [];
      }),
      children,
      vehicles,
    };
  }

  async addChild(householdId: string, groupId: string, firstName: string, lastName: string) {
    const userResult = await this.client.auth.getUser();
    if (userResult.error) throw new Error(userResult.error.message);
    if (!userResult.data.user) throw new Error("Sign in again to continue.");

    const trimmedFirst = firstName.trim();
    const trimmedLast = lastName.trim();
    if (!trimmedFirst || !trimmedLast) {
      throw new Error("Enter your child's first and last name.");
    }

    const created = unwrapRequired<Tables<"children">>(
      await this.client
        .from("children")
        .insert({
          group_id: groupId,
          household_id: householdId,
          first_name: trimmedFirst,
          last_name: trimmedLast,
          created_by: userResult.data.user.id,
        })
        .select("*")
        .single(),
    );
    await this.recordAudit(
      groupId,
      "child_added",
      "child",
      created.id,
      { household_id: householdId, first_name: trimmedFirst, last_name: trimmedLast },
    );
    return created;
  }

  async updateChild(childId: string, updates: { firstName?: string; lastName?: string; preferredBuddyChildId?: string | null; photoUrl?: string | null }) {
    const updatePayload: Partial<{ first_name: string; last_name: string; preferred_buddy_child_id: string | null; photo_url: string | null }> = {};
    if (updates.firstName !== undefined) {
      const trimmed = updates.firstName.trim();
      if (!trimmed) throw new Error("First name cannot be empty.");
      updatePayload.first_name = trimmed;
    }
    if (updates.lastName !== undefined) {
      const trimmed = updates.lastName.trim();
      if (!trimmed) throw new Error("Last name cannot be empty.");
      updatePayload.last_name = trimmed;
    }
    if (updates.preferredBuddyChildId !== undefined) {
      if (updates.preferredBuddyChildId === childId) {
        throw new Error("A child cannot be their own riding buddy.");
      }
      updatePayload.preferred_buddy_child_id = updates.preferredBuddyChildId;
    }
    if (updates.photoUrl !== undefined) {
      updatePayload.photo_url = updates.photoUrl;
    }
    if (Object.keys(updatePayload).length === 0) return;

    const updated = unwrapRequired<Tables<"children">>(
      await this.client
        .from("children")
        .update(updatePayload)
        .eq("id", childId)
        .select("*")
        .single(),
    );
    await this.recordAudit(
      updated.group_id,
      "child_updated",
      "child",
      childId,
      { updates },
    );
  }

  async listGroupChildren(groupId: string): Promise<Tables<"children">[]> {
    return unwrapRequired(
      await this.client
        .from("children")
        .select("id, group_id, household_id, first_name, last_name, active, created_by, created_at, updated_at, preferred_buddy_child_id, photo_url, is_priority")
        .eq("group_id", groupId)
        .eq("active", true)
        .order("first_name")
        .order("last_name"),
    );
  }

  /**
   * Upload a child photo to the child-photos Storage bucket and return
   * the public URL. Object path: <household_id>/<child_id>.<ext>
   */
  async uploadChildPhoto(
    householdId: string,
    childId: string,
    file: File,
  ): Promise<string> {
    const ext = (file.name.split(".").pop() ?? "jpg").toLowerCase();
    const safeExt = /^[a-z0-9]+$/.test(ext) ? ext : "jpg";
    const path = `${householdId}/${childId}.${safeExt}`;
    const { error } = await this.client.storage
      .from("child-photos")
      .upload(path, file, { upsert: true, contentType: file.type || undefined });
    if (error) throw new Error(`Photo upload failed: ${error.message}`);
    return this.client.storage.from("child-photos").getPublicUrl(path).data.publicUrl;
  }

  async deactivateChild(childId: string) {
    const updated = unwrapRequired<Tables<"children">>(
      await this.client
        .from("children")
        .update({ active: false })
        .eq("id", childId)
        .select("*")
        .single(),
    );
    await this.recordAudit(
      updated.group_id,
      "child_removed",
      "child",
      childId,
      { first_name: updated.first_name, last_name: updated.last_name },
    );
  }

  async upsertVehicle(
    householdId: string,
    groupId: string,
    fields: { label: string; childPassengerCapacity: number; notes?: string },
  ) {
    const userResult = await this.client.auth.getUser();
    if (userResult.error) throw new Error(userResult.error.message);
    if (!userResult.data.user) throw new Error("Sign in again to continue.");

    const trimmedLabel = fields.label.trim();
    if (!trimmedLabel) throw new Error("Enter a vehicle label.");
    if (fields.childPassengerCapacity < 1 || fields.childPassengerCapacity > 12) {
      throw new Error("Passenger seats must be between 1 and 12.");
    }
    const trimmedNotes = fields.notes ? fields.notes.trim().slice(0, 500) : null;
    if (trimmedNotes && trimmedNotes.length > 500) {
      throw new Error("Vehicle notes must be 500 characters or fewer.");
    }

    const existing = unwrap(
      await this.client
        .from("vehicles")
        .select("*")
        .eq("household_id", householdId)
        .eq("active", true)
        .order("label")
        .maybeSingle(),
    );

    const payload = {
      label: trimmedLabel,
      child_passenger_capacity: fields.childPassengerCapacity,
      notes: trimmedNotes || null,
    };

    if (existing) {
      const updated = unwrapRequired<Tables<"vehicles">>(
        await this.client
          .from("vehicles")
          .update(payload)
          .eq("id", existing.id)
          .select("*")
          .single(),
      );
      await this.recordAudit(
        groupId,
        "vehicle_updated",
        "vehicle",
        updated.id,
        { label: trimmedLabel, child_passenger_capacity: fields.childPassengerCapacity },
      );
      return updated;
    }

    const created = unwrapRequired<Tables<"vehicles">>(
      await this.client
        .from("vehicles")
        .insert({
          ...payload,
          group_id: groupId,
          household_id: householdId,
          created_by: userResult.data.user.id,
        })
        .select("*")
        .single(),
    );
    await this.recordAudit(
      groupId,
      "vehicle_added",
      "vehicle",
      created.id,
      { household_id: householdId, label: trimmedLabel, child_passenger_capacity: fields.childPassengerCapacity },
    );
    return created;
  }

  async deactivateVehicle(vehicleId: string, groupId: string) {
    const result = unwrap(
      await this.client
        .from("vehicles")
        .update({ active: false })
        .eq("id", vehicleId)
        .select("*")
        .single(),
    );
    const label = result?.label ?? "";
    await this.recordAudit(
      groupId,
      "vehicle_removed",
      "vehicle",
      vehicleId,
      { label },
    );
    return result;
  }

  async listWeeks(groupId: string) {
    return unwrapRequired(
      await this.client
        .from("weeks")
        .select("*")
        .eq("group_id", groupId)
        .order("starts_on", { ascending: false }),
    );
  }

  async getCurrentWeek(groupId: string): Promise<WeekWithTrips | null> {
    const todayStr = todayInTimezone();

    // Most recent week that started on or before today.
    const pastRows = unwrapRequired(
      await this.client
        .from("weeks")
        .select("*")
        .eq("group_id", groupId)
        .lte("starts_on", todayStr)
        .order("starts_on", { ascending: false })
        .limit(1),
    );
    const mostRecent = pastRows[0];

    // If today falls within that week (Mon–Fri), it is the current week.
    if (mostRecent) {
      const weekStart = new Date(mostRecent.starts_on + "T00:00:00");
      const friday = new Date(weekStart);
      friday.setDate(weekStart.getDate() + 4);
      const fridayStr = friday.toISOString().slice(0, 10);
      if (todayStr >= mostRecent.starts_on && todayStr <= fridayStr) {
        const trips = await this.listTripsForWeek(mostRecent.id);
        return { week: mostRecent, trips };
      }
    }

    // Otherwise the upcoming week: earliest week with starts_on >= today.
    const futureRows = unwrapRequired(
      await this.client
        .from("weeks")
        .select("*")
        .eq("group_id", groupId)
        .gte("starts_on", todayStr)
        .order("starts_on", { ascending: true })
        .limit(1),
    );
    const upcoming = futureRows[0];
    if (upcoming) {
      const trips = await this.listTripsForWeek(upcoming.id);
      return { week: upcoming, trips };
    }

    // School year is over: return the most recent past week, if any.
    if (mostRecent) {
      const trips = await this.listTripsForWeek(mostRecent.id);
      return { week: mostRecent, trips };
    }
    return null;
  }

  /**
   * Returns a specific week by id, including trips. Used for week navigation.
   */
  async getWeekById(weekId: string): Promise<WeekWithTrips | null> {
    const week = unwrap(
      await this.client
        .from("weeks")
        .select("*")
        .eq("id", weekId)
        .maybeSingle(),
    );
    if (!week) return null;
    const trips = await this.listTripsForWeek(weekId);
    return { week, trips };
  }

  async createWeekWithTrips(
    groupId: string,
    startsOn: string,
    meetingPoint: string,
    schoolName: string,
  ): Promise<WeekWithTrips> {
    const userResult = await this.client.auth.getUser();
    if (userResult.error) throw new Error(userResult.error.message);
    if (!userResult.data.user) throw new Error("Sign in again to continue.");

    // Deadlines: check-in by Saturday 3 PM Pacific, confirmation by Sunday 8 PM Pacific.
    // Compute in the pilot timezone to avoid UTC drift for SF families.
    const startDate = new Date(startsOn + "T00:00:00");
    const day = startDate.getDay();
    if (day !== 1) throw new Error("Week must start on a Monday.");

    const saturdayStr = new Date(startDate);
    saturdayStr.setDate(startDate.getDate() - 2);
    const saturdayDate = saturdayStr.toISOString().slice(0, 10);
    const sundayStr = new Date(startDate);
    sundayStr.setDate(startDate.getDate() - 1);
    const sundayDate = sundayStr.toISOString().slice(0, 10);

    const checkinDeadline = new Date(`${saturdayDate}T15:00:00-07:00`);
    const confirmationDeadline = new Date(`${sundayDate}T20:00:00-07:00`);

    const week = unwrapRequired<Tables<"weeks">>(
      await this.client
        .from("weeks")
        .insert({
          group_id: groupId,
          starts_on: startsOn,
          status: "open",
          checkin_deadline: checkinDeadline.toISOString(),
          confirmation_deadline: confirmationDeadline.toISOString(),
        })
        .select("*")
        .single(),
    );

    const tripInserts: TablesInsert<"trips">[] = [];
    for (let offset = 0; offset < 5; offset++) {
      const date = new Date(startDate);
      date.setDate(date.getDate() + offset);
      const serviceDate = date.toISOString().slice(0, 10);

      if (isNoSchoolDay(serviceDate)) continue;

      tripInserts.push({
        group_id: groupId,
        week_id: week.id,
        service_date: serviceDate,
        direction: "morning",
        meeting_time: "08:40",
        departure_time: "08:45",
        origin: meetingPoint,
        destination: schoolName,
      });
      tripInserts.push({
        group_id: groupId,
        week_id: week.id,
        service_date: serviceDate,
        direction: "afternoon",
        meeting_time: "17:15",
        departure_time: "17:20",
        origin: schoolName,
        destination: meetingPoint,
      });
    }

    unwrapRequired(
      await this.client.from("trips").insert(tripInserts).select("*"),
    );

    const trips = await this.listTripsForWeek(week.id);
    await this.recordAudit(
      groupId,
      "week_created",
      "week",
      week.id,
      { starts_on: startsOn, trip_count: trips.length },
    );
    return { week, trips };
  }

  async getOrCreateCheckin(
    weekId: string,
    householdId: string,
    groupId: string,
  ): Promise<Tables<"weekly_checkins">> {
    const existing = unwrap(
      await this.client
        .from("weekly_checkins")
        .select("*")
        .eq("week_id", weekId)
        .eq("household_id", householdId)
        .maybeSingle(),
    );
    if (existing) return existing;

    // Use upsert with onConflict to handle the co-parent race condition:
    // two parents in the same household opening the check-in simultaneously
    // both see no existing row and both try to insert. The unique constraint
    // on (week_id, household_id) would cause a duplicate key error without this.
    return unwrapRequired<Tables<"weekly_checkins">>(
      await this.client
        .from("weekly_checkins")
        .upsert({
          group_id: groupId,
          week_id: weekId,
          household_id: householdId,
          status: "draft",
          max_drives: 10,
        }, { onConflict: "week_id,household_id" })
        .select("*")
        .single(),
    );
  }

  async getCheckinDetails(checkinId: string): Promise<CheckinDetails> {
    const checkin = unwrapRequired<Tables<"weekly_checkins">>(
      await this.client
        .from("weekly_checkins")
        .select("*")
        .eq("id", checkinId)
        .maybeSingle(),
      "Check-in not found.",
    );

    const [rideRequests, driverAvailability] = await Promise.all([
      unwrapRequired(
        await this.client
          .from("ride_requests")
          .select("*")
          .eq("checkin_id", checkinId),
      ),
      unwrapRequired(
        await this.client
          .from("driver_availability")
          .select("*")
          .eq("checkin_id", checkinId),
      ),
    ]);

    return { checkin, rideRequests, driverAvailability };
  }

  async submitCheckin(checkinId: string) {
    const userResult = await this.client.auth.getUser();
    if (userResult.error) throw new Error(userResult.error.message);
    if (!userResult.data.user) throw new Error("Sign in again to continue.");

    const updated = unwrapRequired<Tables<"weekly_checkins">>(
      await this.client
        .from("weekly_checkins")
        .update({
          status: "submitted",
          submitted_by: userResult.data.user.id,
          submitted_at: new Date().toISOString(),
        })
        .eq("id", checkinId)
        .select("*")
        .single(),
    );
    await this.recordAudit(
      updated.group_id,
      "checkin_submitted",
      "weekly_checkin",
      checkinId,
      {},
    );
  }

  async reopenCheckin(checkinId: string) {
    const updated = unwrapRequired<Tables<"weekly_checkins">>(
      await this.client
        .from("weekly_checkins")
        .update({
          status: "draft",
          submitted_by: null,
          submitted_at: null,
        })
        .eq("id", checkinId)
        .select("*")
        .single(),
    );
    await this.recordAudit(
      updated.group_id,
      "checkin_reopened",
      "weekly_checkin",
      checkinId,
    );
  }

  async upsertRideRequest(
    checkinId: string,
    tripId: string,
    childId: string,
    needsRide: boolean,
    groupId: string,
  ) {
    const userResult = await this.client.auth.getUser();
    if (userResult.error) throw new Error(userResult.error.message);
    if (!userResult.data.user) throw new Error("Sign in again to continue.");

    unwrap(
      await this.client.from("ride_requests").upsert(
        {
          group_id: groupId,
          checkin_id: checkinId,
          trip_id: tripId,
          child_id: childId,
          needs_ride: needsRide,
          created_by: userResult.data.user.id,
        },
        { onConflict: "trip_id,child_id" },
      ),
    );
  }

  async upsertDriverAvailability(
    checkinId: string,
    tripId: string,
    driverProfileId: string,
    vehicleId: string | null,
    preference: DrivePreference,
    groupId: string,
  ) {
    const existing = unwrap(
      await this.client
        .from("driver_availability")
        .select("*")
        .eq("checkin_id", checkinId)
        .eq("trip_id", tripId)
        .eq("driver_profile_id", driverProfileId)
        .maybeSingle(),
    );

    const payload = {
      vehicle_id: preference === "cannot" ? null : vehicleId,
      preference,
    };

    if (existing) {
      unwrap(
        await this.client
          .from("driver_availability")
          .update(payload)
          .eq("id", existing.id),
      );
      return;
    }

    unwrap(
      await this.client.from("driver_availability").insert({
        group_id: groupId,
        checkin_id: checkinId,
        trip_id: tripId,
        driver_profile_id: driverProfileId,
        ...payload,
      }),
    );
  }

  async getWeekOverview(weekId: string, groupId: string): Promise<WeekOverview> {
    const [trips, checkins, memberships, households] = await Promise.all([
      this.listTripsForWeek(weekId),
      unwrapRequired(
        await this.client
          .from("weekly_checkins")
          .select("*")
          .eq("week_id", weekId),
      ),
      unwrapRequired(
        await this.client
          .from("memberships")
          .select("*")
          .eq("group_id", groupId)
          .eq("status", "active"),
      ),
      unwrapRequired(
        await this.client
          .from("households")
          .select("*")
          .eq("group_id", groupId),
      ),
    ]);

    const tripIds = trips.map((trip) => trip.id);
    const [rideRequests, driverAvailability, vehicles] = tripIds.length
      ? await Promise.all([
          unwrapRequired(
            await this.client
              .from("ride_requests")
              .select("*")
              .in("trip_id", tripIds),
          ),
          unwrapRequired(
            await this.client
              .from("driver_availability")
              .select("*")
              .in("trip_id", tripIds),
          ),
          unwrapRequired(
            await this.client
              .from("vehicles")
              .select("*")
              .eq("group_id", groupId)
              .eq("active", true),
          ),
        ])
      : [[], [], []];

    const vehicleById = new Map(vehicles.map((v) => [v.id, v]));

    const tripOverviews: TripOverview[] = trips.map((trip) => {
      const riders = rideRequests.filter(
        (r) => r.trip_id === trip.id && r.needs_ride,
      ).length;
      const drivers = driverAvailability.filter(
        (a) => a.trip_id === trip.id && a.preference !== "cannot",
      );
      const seats = drivers.reduce((sum, driver) => {
        const vehicle = driver.vehicle_id ? vehicleById.get(driver.vehicle_id) : null;
        return sum + (vehicle?.child_passenger_capacity ?? 0);
      }, 0);
      return {
        trip,
        riderCount: riders,
        driverCount: drivers.length,
        seatCount: seats,
      };
    });

    const householdById = new Map(households.map((h) => [h.id, h]));
    const checkinByHousehold = new Map(checkins.map((c) => [c.household_id, c]));
    const householdIds = new Set(memberships.map((m) => m.household_id));

    const householdStatuses: HouseholdCheckinStatus[] = [...householdIds]
      .map((householdId) => {
        const household = householdById.get(householdId);
        if (!household) return null;
        const checkin = checkinByHousehold.get(householdId);
        const status: HouseholdCheckinStatus["status"] = checkin
          ? checkin.status === "submitted"
            ? "submitted"
            : "draft"
          : "not_started";
        return { household, status };
      })
      .filter((h): h is HouseholdCheckinStatus => h !== null)
      .sort((a, b) => a.household.name.localeCompare(b.household.name));

    return { trips: tripOverviews, households: householdStatuses };
  }

  async listTripsForWeek(weekId: string) {
    return unwrapRequired(
      await this.client
        .from("trips")
        .select("*")
        .eq("week_id", weekId)
        .order("service_date")
        .order("direction"),
    );
  }

  async respondToDriverAssignment(
    assignmentId: string,
    response: ConfirmationResponse,
    declineReason?: string,
  ) {
    return unwrap(
      await this.client.rpc("respond_to_driver_assignment", {
        target_assignment_id: assignmentId,
        driver_response: response,
        decline_reason: declineReason ?? null,
      }),
    );
  }

  async volunteerForDrive(assignmentId: string) {
    return unwrap(
      await this.client.rpc("volunteer_for_declined_drive", {
        target_assignment_id: assignmentId,
      }),
    );
  }

  async volunteerForUncoveredTrip(tripId: string, scheduleVersionId: string) {
    return unwrap(
      await this.client.rpc("volunteer_for_uncovered_trip", {
        p_trip_id: tripId,
        p_schedule_version_id: scheduleVersionId,
      }),
    );
  }

  async getAffectedDeclinedDrives(
    scheduleVersionId: string,
    profileId: string,
    groupId: string,
    weekId: string,
  ): Promise<DeclinedDriveAlert[]> {
    const [driverAssignments, riderAssignments, children, trips, vehicles, memberships] = await Promise.all([
      unwrapRequired(
        await this.client
          .from("driver_assignments")
          .select("*")
          .eq("schedule_version_id", scheduleVersionId)
          .eq("group_id", groupId)
          .eq("status", "declined"),
      ),
      unwrapRequired(
        await this.client
          .from("rider_assignments")
          .select("*")
          .eq("schedule_version_id", scheduleVersionId)
          .eq("group_id", groupId),
      ),
      unwrapRequired(
        await this.client
          .from("children")
          .select("*")
          .eq("group_id", groupId)
          .eq("active", true),
      ),
      unwrapRequired(
        await this.client
          .from("trips")
          .select("*")
          .eq("group_id", groupId)
          .eq("week_id", weekId),
      ),
      unwrapRequired(
        await this.client
          .from("vehicles")
          .select("*")
          .eq("group_id", groupId)
          .eq("active", true),
      ),
      unwrapRequired(
        await this.client
          .from("memberships")
          .select("*")
          .eq("group_id", groupId)
          .eq("status", "active"),
      ),
    ]);

    const profiles = await this.fetchGroupProfiles(groupId);

    const childById = new Map(children.map((c) => [c.id, c]));
    const tripById = new Map(trips.map((t) => [t.id, t]));
    const vehicleById = new Map(vehicles.map((v) => [v.id, v]));
    const profileById = new Map(profiles.map((p) => [p.id, p]));

    const householdIds = new Set<string>();
    for (const m of memberships.filter((m) => m.profile_id === profileId)) {
      householdIds.add(m.household_id);
    }

    const volunteerVehicles = vehicles.filter((v) => householdIds.has(v.household_id));
    const volunteerVehicleCapacity = volunteerVehicles.length
      ? Math.max(...volunteerVehicles.map((v) => v.child_passenger_capacity))
      : null;

    const ridersByAssignment = new Map<string, Tables<"children">[]>();
    for (const ra of riderAssignments) {
      const existing = ridersByAssignment.get(ra.driver_assignment_id) ?? [];
      const child = childById.get(ra.child_id);
      if (child) existing.push(child);
      ridersByAssignment.set(ra.driver_assignment_id, existing);
    }

    const alerts: DeclinedDriveAlert[] = [];
    for (const da of driverAssignments) {
      const riders = ridersByAssignment.get(da.id) ?? [];
      const myChildren = riders.filter((r) => householdIds.has(r.household_id));
      if (myChildren.length === 0) continue;

      // Don't show the declined alert to the driver who declined.
      // They should use the Review screen to re-accept, not volunteer.
      if (da.driver_profile_id === profileId) continue;

      const trip = tripById.get(da.trip_id);
      if (!trip) continue;

      const vehicle = vehicleById.get(da.vehicle_id) ?? null;
      const driverProfile = profileById.get(da.driver_profile_id) ?? null;

      alerts.push({
        assignment: da,
        trip,
        vehicle,
        driverProfile,
        children: riders,
        myChildren,
        volunteerVehicleCapacity,
      });
    }
    alerts.sort((a, b) => tripSortKey(a.trip).localeCompare(tripSortKey(b.trip)));
    return alerts;
  }

  async getMyDriverAssignments(
    scheduleVersionId: string,
    driverProfileId: string,
    groupId: string,
    trips: Tables<"trips">[],
    children: Tables<"children">[],
    vehicles: Tables<"vehicles">[],
  ): Promise<MyDriverAssignment[]> {
    const assignments = unwrapRequired(
      await this.client
        .from("driver_assignments")
        .select("*")
        .eq("schedule_version_id", scheduleVersionId)
        .eq("driver_profile_id", driverProfileId)
        .eq("group_id", groupId)
        .order("trip_id"),
    );

    if (assignments.length === 0) return [];

    const tripById = new Map(trips.map((t) => [t.id, t]));
    const vehicleById = new Map(vehicles.map((v) => [v.id, v]));

    const riderAssignments = unwrapRequired(
      await this.client
        .from("rider_assignments")
        .select("*")
        .eq("schedule_version_id", scheduleVersionId)
        .eq("group_id", groupId)
        .in(
          "driver_assignment_id",
          assignments.map((a) => a.id),
        ),
    );

    const childById = new Map(children.map((c) => [c.id, c]));
    const ridersByAssignment = new Map<string, Tables<"children">[]>();
    for (const rider of riderAssignments) {
      const existing = ridersByAssignment.get(rider.driver_assignment_id) ?? [];
      const child = childById.get(rider.child_id);
      if (child) existing.push(child);
      ridersByAssignment.set(rider.driver_assignment_id, existing);
    }

    return assignments
      .map((assignment) => {
        const trip = tripById.get(assignment.trip_id);
        const vehicle = vehicleById.get(assignment.vehicle_id);
        if (!trip || !vehicle) return null;
        return {
          assignment,
          trip,
          vehicle,
          children: ridersByAssignment.get(assignment.id) ?? [],
        };
      })
      .filter((entry): entry is MyDriverAssignment => entry !== null)
      .sort((a, b) => tripSortKey(a.trip).localeCompare(tripSortKey(b.trip)));
  }

  async publishSchedule(scheduleVersionId: string, groupId: string): Promise<{ expiredCount: number }> {
    const result = unwrap(
      await this.client.rpc("publish_schedule", {
        p_group_id: groupId,
        p_version_id: scheduleVersionId,
      }),
    );
    if (result && typeof result === "object" && "error" in result) {
      const err = result as { error: string; count?: number };
      if (err.error === "tentative_awaiting_confirmation") {
        throw new Error(
          `${err.count ?? 0} driver${(err.count ?? 0) !== 1 ? "s" : ""} haven't confirmed yet. Wait for confirmations or the confirmation deadline.`,
        );
      }
      if (err.error === "not_coordinator") {
        throw new Error("Only coordinators can publish schedules.");
      }
      throw new Error(`Publish failed: ${err.error}`);
    }
    const ok = result as { success?: boolean; expired_count?: number };
    return { expiredCount: ok.expired_count ?? 0 };
  }

  async getGroupRoster(groupId: string): Promise<{
    children: Tables<"children">[];
    vehicles: Tables<"vehicles">[];
    profiles: Tables<"profiles">[];
    memberships: Tables<"memberships">[];
  }> {
    const [children, vehicles, memberships] = await Promise.all([
      unwrapRequired(
        await this.client
          .from("children")
          .select("*")
          .eq("group_id", groupId)
          .eq("active", true)
          .order("first_name"),
      ),
      unwrapRequired(
        await this.client
          .from("vehicles")
          .select("*")
          .eq("group_id", groupId)
          .eq("active", true)
          .order("label"),
      ),
      unwrapRequired(
        await this.client
          .from("memberships")
          .select("*")
          .eq("group_id", groupId)
          .eq("status", "active"),
      ),
    ]);

    const profiles = await this.fetchGroupProfiles(groupId);

    return { children, vehicles, profiles, memberships };
  }

  async generateDraftSchedule(weekId: string): Promise<GenerateScheduleResult> {
    const result = await this.client.functions.invoke("generate-schedule", {
      body: { weekId },
    });
    if (result.error) {
      return { success: false, error: result.error.message };
    }
    return result.data as GenerateScheduleResult;
  }

  async sendPushNotification(
    assignmentId: string | null,
    versionId: string | null,
    type: "declined" | "uncovered" | "published" | "volunteered",
  ): Promise<void> {
    try {
      await this.client.functions.invoke("send-push", {
        body: { assignment_id: assignmentId, version_id: versionId, type },
      });
    } catch (err) {
      console.error("[carpool] send-push invocation failed:", err);
    }
  }

  async savePushSubscription(
    endpoint: string,
    p256dhKey: string,
    authKey: string,
  ): Promise<void> {
    const userResult = await this.client.auth.getUser();
    if (userResult.error || !userResult.data.user) return;
    const { data: membership } = await this.client
      .from("memberships")
      .select("group_id")
      .eq("profile_id", userResult.data.user.id)
      .eq("status", "active")
      .maybeSingle();
    if (!membership) return;

    unwrap(
      await this.client.from("push_subscriptions").upsert(
        {
          profile_id: userResult.data.user.id,
          group_id: membership.group_id,
          endpoint,
          p256dh_key: p256dhKey,
          auth_key: authKey,
        },
        { onConflict: "profile_id,endpoint" },
      ),
    );
  }

  async removePushSubscription(endpoint: string): Promise<void> {
    unwrap(
      await this.client
        .from("push_subscriptions")
        .delete()
        .eq("endpoint", endpoint),
    );
  }

  async getUncoveredChildren(
    scheduleVersionId: string,
    profileId: string,
    groupId: string,
    weekId: string,
  ): Promise<UncoveredChildAlert[]> {
    const [trips, rideRequests, children, driverAssignments, riderAssignments, memberships, vehicles] = await Promise.all([
      unwrapRequired(
        await this.client.from("trips").select("*").eq("group_id", groupId).eq("week_id", weekId),
      ),
      unwrapRequired(
        await this.client.from("ride_requests").select("*").eq("group_id", groupId),
      ),
      unwrapRequired(
        await this.client.from("children").select("*").eq("group_id", groupId).eq("active", true),
      ),
      unwrapRequired(
        await this.client.from("driver_assignments").select("*").eq("schedule_version_id", scheduleVersionId).eq("group_id", groupId),
      ),
      unwrapRequired(
        await this.client.from("rider_assignments").select("*").eq("schedule_version_id", scheduleVersionId).eq("group_id", groupId),
      ),
      unwrapRequired(
        await this.client.from("memberships").select("*").eq("profile_id", profileId).eq("status", "active"),
      ),
      unwrapRequired(
        await this.client.from("vehicles").select("*").eq("group_id", groupId).eq("active", true),
      ),
    ]);

    const householdIds = new Set(memberships.map((m) => m.household_id));
    const myChildren = children.filter((c) => householdIds.has(c.household_id));
    const myChildIds = new Set(myChildren.map((c) => c.id));
    const childById = new Map(children.map((c) => [c.id, c]));
    const tripById = new Map(trips.map((t) => [t.id, t]));

    const volunteerVehicles = vehicles.filter((v) => householdIds.has(v.household_id));
    const volunteerVehicleCapacity = volunteerVehicles.length
      ? Math.max(...volunteerVehicles.map((v) => v.child_passenger_capacity))
      : null;

    const handledDriverAssignments = new Set(
      driverAssignments
        .filter((da) => da.status === "tentative" || da.status === "confirmed" || da.status === "declined")
        .map((da) => da.id),
    );

    const coveredChildrenByTrip = new Map<string, Set<string>>();
    for (const ra of riderAssignments) {
      if (!handledDriverAssignments.has(ra.driver_assignment_id)) continue;
      const existing = coveredChildrenByTrip.get(ra.trip_id) ?? new Set<string>();
      existing.add(ra.child_id);
      coveredChildrenByTrip.set(ra.trip_id, existing);
    }

    const alerts: UncoveredChildAlert[] = [];
    for (const rr of rideRequests) {
      if (!rr.needs_ride) continue;
      if (!myChildIds.has(rr.child_id)) continue;

      const covered = coveredChildrenByTrip.get(rr.trip_id) ?? new Set<string>();
      if (covered.has(rr.child_id)) continue;

      const trip = tripById.get(rr.trip_id);
      const child = childById.get(rr.child_id);
      if (!trip || !child) continue;

      const existing = alerts.find((a) => a.trip.id === trip.id);
      if (existing) {
        existing.children.push(child);
      } else {
        alerts.push({ trip, children: [child], volunteerVehicleCapacity });
      }
    }
    alerts.sort((a, b) => tripSortKey(a.trip).localeCompare(tripSortKey(b.trip)));
    return alerts;
  }

async getLatestScheduleVersion(
    weekId: string,
    groupId: string,
    trips: Tables<"trips">[],
    children: Tables<"children">[],
    vehicles: Tables<"vehicles">[],
    profiles: Tables<"profiles">[],
  ): Promise<ScheduleVersionWithRosters | null> {
    const version = unwrap(
      await this.client
        .from("schedule_versions")
        .select("*")
        .eq("week_id", weekId)
        .eq("group_id", groupId)
        .order("version_number", { ascending: false })
        .limit(1)
        .maybeSingle(),
    );
    if (!version) return null;

    const tripIds = trips.map((t) => t.id);
    const [driverAssignments, riderAssignments, rideRequestsData] = await Promise.all([
      unwrapRequired(
        await this.client
          .from("driver_assignments")
          .select("*")
          .eq("schedule_version_id", version.id)
          .eq("group_id", groupId)
          .order("driver_profile_id"),
      ),
      unwrapRequired(
        await this.client
          .from("rider_assignments")
          .select("*")
          .eq("schedule_version_id", version.id)
          .eq("group_id", groupId),
      ),
      tripIds.length
        ? unwrapRequired(
            await this.client
              .from("ride_requests")
              .select("*")
              .eq("group_id", groupId)
              .in("trip_id", tripIds),
          )
        : [],
    ]);

    const vehicleById = new Map(vehicles.map((v) => [v.id, v]));
    const childById = new Map(children.map((c) => [c.id, c]));
    const profileById = new Map(profiles.map((p) => [p.id, p]));
    const ridersByAssignment = new Map<string, Tables<"children">[]>();
    for (const rider of riderAssignments) {
      const existing = ridersByAssignment.get(rider.driver_assignment_id) ?? [];
      const child = childById.get(rider.child_id);
      if (child) existing.push(child);
      ridersByAssignment.set(rider.driver_assignment_id, existing);
    }

    const rostersByTrip = new Map<string, ScheduleRosterEntry[]>();
    for (const assignment of driverAssignments) {
      const profile = profileById.get(assignment.driver_profile_id);
      const vehicle = vehicleById.get(assignment.vehicle_id);
      if (!profile || !vehicle) continue;
      const entry: ScheduleRosterEntry = {
        driverAssignment: assignment,
        driverProfile: profile,
        vehicle,
        children: ridersByAssignment.get(assignment.id) ?? [],
      };
      const existing = rostersByTrip.get(assignment.trip_id) ?? [];
      existing.push(entry);
      rostersByTrip.set(assignment.trip_id, existing);
    }

    // Compute uncovered riders per trip: children who need a ride but are not
    // assigned to any confirmed driver assignment. Tentative assignments do
    // not count as covering — the PRD's central safety property.
    const confirmedDriverAssignmentIds = new Set(
      driverAssignments
        .filter((da) => da.status === "confirmed")
        .map((da) => da.id),
    );
    const coveredChildIdsByTrip = new Map<string, Set<string>>();
    for (const ra of riderAssignments) {
      if (!confirmedDriverAssignmentIds.has(ra.driver_assignment_id)) continue;
      const existing = coveredChildIdsByTrip.get(ra.trip_id) ?? new Set<string>();
      existing.add(ra.child_id);
      coveredChildIdsByTrip.set(ra.trip_id, existing);
    }
    const uncoveredRidersByTrip = new Map<string, Tables<"children">[]>();
    for (const rr of rideRequestsData ?? []) {
      if (!rr.needs_ride) continue;
      const covered = coveredChildIdsByTrip.get(rr.trip_id) ?? new Set<string>();
      if (covered.has(rr.child_id)) continue;
      const child = childById.get(rr.child_id);
      if (!child) continue;
      const existing = uncoveredRidersByTrip.get(rr.trip_id) ?? [];
      existing.push(child);
      uncoveredRidersByTrip.set(rr.trip_id, existing);
    }

    return { version, trips, rostersByTrip, uncoveredRidersByTrip };
  }

  async publishedVersionExists(weekId: string, groupId: string): Promise<boolean> {
    const rows = unwrap(
      await this.client
        .from("schedule_versions")
        .select("id")
        .eq("week_id", weekId)
        .eq("group_id", groupId)
        .eq("status", "published")
        .limit(1),
    );
    return (rows ?? []).length > 0;
  }

  async getActivePublishedWeek(groupId: string): Promise<WeekWithTrips | null> {
    const todayStr = todayInTimezone();

    const versions = unwrapRequired(
      await this.client
        .from("schedule_versions")
        .select("week_id, weeks!inner(id, group_id, starts_on, checkin_deadline, confirmation_deadline, published_at, status)")
        .eq("group_id", groupId)
        .eq("status", "published"),
    );

    if (versions.length === 0) return null;

    const weeks = versions
      .map((v) => v.weeks as unknown as Tables<"weeks">)
      .filter((w): w is Tables<"weeks"> => w != null && w.group_id === groupId);

    if (weeks.length === 0) return null;

    const underway = weeks.find((w) => {
      const start = new Date(w.starts_on + "T00:00:00");
      const fri = new Date(start);
      fri.setDate(start.getDate() + 4);
      return todayStr >= w.starts_on && todayStr <= fri.toISOString().slice(0, 10);
    });
    if (underway) {
      const trips = await this.listTripsForWeek(underway.id);
      return { week: underway, trips };
    }

    const upcoming = weeks
      .filter((w) => w.starts_on > todayStr)
      .sort((a, b) => a.starts_on.localeCompare(b.starts_on))[0];
    if (upcoming) {
      const trips = await this.listTripsForWeek(upcoming.id);
      return { week: upcoming, trips };
    }

    const past = weeks.sort((a, b) => b.starts_on.localeCompare(a.starts_on))[0];
    if (past) {
      const trips = await this.listTripsForWeek(past.id);
      return { week: past, trips };
    }
    return null;
  }

  async getNextPlanWeek(groupId: string): Promise<WeekWithTrips | null> {
    const todayStr = todayInTimezone();

    const futureRows = unwrapRequired(
      await this.client
        .from("weeks")
        .select("*")
        .eq("group_id", groupId)
        .gt("starts_on", todayStr)
        .order("starts_on", { ascending: true }),
    );

    for (const week of futureRows) {
      const published = await this.publishedVersionExists(week.id, groupId);
      if (!published) {
        const trips = await this.listTripsForWeek(week.id);
        return { week, trips };
      }
    }

    if (futureRows.length > 0) {
      const trips = await this.listTripsForWeek(futureRows[0].id);
      return { week: futureRows[0], trips };
    }
    return null;
  }

  async getLatestPublishedVersion(
    weekId: string,
    groupId: string,
    trips: Tables<"trips">[],
    children: Tables<"children">[],
    vehicles: Tables<"vehicles">[],
    profiles: Tables<"profiles">[],
  ): Promise<ScheduleVersionWithRosters | null> {
    const version = unwrap(
      await this.client
        .from("schedule_versions")
        .select("*")
        .eq("week_id", weekId)
        .eq("group_id", groupId)
        .eq("status", "published")
        .order("version_number", { ascending: false })
        .limit(1)
        .maybeSingle(),
    );
    if (!version) return null;

    const tripIds = trips.map((t) => t.id);
    const [driverAssignments, riderAssignments, rideRequestsData] = await Promise.all([
      unwrapRequired(
        await this.client
          .from("driver_assignments")
          .select("*")
          .eq("schedule_version_id", version.id)
          .eq("group_id", groupId)
          .order("driver_profile_id"),
      ),
      unwrapRequired(
        await this.client
          .from("rider_assignments")
          .select("*")
          .eq("schedule_version_id", version.id)
          .eq("group_id", groupId),
      ),
      tripIds.length
        ? unwrapRequired(
            await this.client
              .from("ride_requests")
              .select("*")
              .eq("group_id", groupId)
              .in("trip_id", tripIds),
          )
        : [],
    ]);

    const vehicleById = new Map(vehicles.map((v) => [v.id, v]));
    const childById = new Map(children.map((c) => [c.id, c]));
    const profileById = new Map(profiles.map((p) => [p.id, p]));
    const ridersByAssignment = new Map<string, Tables<"children">[]>();
    for (const rider of riderAssignments) {
      const existing = ridersByAssignment.get(rider.driver_assignment_id) ?? [];
      const child = childById.get(rider.child_id);
      if (child) {
        existing.push(child);
        ridersByAssignment.set(rider.driver_assignment_id, existing);
      }
    }

    const rostersByTrip = new Map<string, ScheduleRosterEntry[]>();
    for (const assignment of driverAssignments) {
      const profile = profileById.get(assignment.driver_profile_id);
      const vehicle = vehicleById.get(assignment.vehicle_id);
      if (!profile || !vehicle) continue;
      const entry: ScheduleRosterEntry = {
        driverAssignment: assignment,
        driverProfile: profile,
        vehicle,
        children: ridersByAssignment.get(assignment.id) ?? [],
      };
      const existing = rostersByTrip.get(assignment.trip_id) ?? [];
      existing.push(entry);
      rostersByTrip.set(assignment.trip_id, existing);
    }

    const confirmedDriverAssignmentIds = new Set(
      driverAssignments
        .filter((da) => da.status === "confirmed")
        .map((da) => da.id),
    );
    const coveredChildIdsByTrip = new Map<string, Set<string>>();
    for (const ra of riderAssignments) {
      if (!confirmedDriverAssignmentIds.has(ra.driver_assignment_id)) continue;
      const existing = coveredChildIdsByTrip.get(ra.trip_id) ?? new Set<string>();
      existing.add(ra.child_id);
      coveredChildIdsByTrip.set(ra.trip_id, existing);
    }
    const uncoveredRidersByTrip = new Map<string, Tables<"children">[]>();
    for (const rr of rideRequestsData ?? []) {
      if (!rr.needs_ride) continue;
      const covered = coveredChildIdsByTrip.get(rr.trip_id) ?? new Set<string>();
      if (covered.has(rr.child_id)) continue;
      const child = childById.get(rr.child_id);
      if (!child) continue;
      const existing = uncoveredRidersByTrip.get(rr.trip_id) ?? [];
      existing.push(child);
      uncoveredRidersByTrip.set(rr.trip_id, existing);
    }

    return { version, trips, rostersByTrip, uncoveredRidersByTrip };
  }
}
