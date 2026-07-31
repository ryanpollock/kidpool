import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  ConfirmationResponse,
  Database,
  DrivePreference,
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

function unwrap<T>(result: { data: T; error: { message: string } | null }): T {
  if (result.error) throw new Error(result.error.message);
  return result.data;
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

  async updateCurrentProfile(fullName: string) {
    const normalizedName = fullName.trim().replace(/\s+/g, " ");
    if (!normalizedName) throw new Error("Enter your full name.");

    const userResult = await this.client.auth.getUser();
    if (userResult.error) throw new Error(userResult.error.message);
    if (!userResult.data.user) throw new Error("Sign in again to continue.");

    return unwrapRequired(
      await this.client
        .from("profiles")
        .update({ full_name: normalizedName })
        .eq("id", userResult.data.user.id)
        .select("*")
        .single(),
    );
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

  async joinHousehold(groupId: string, joinCode: string) {
    return unwrap(
      await this.client.rpc("join_household_by_code", {
        target_group_id: groupId,
        supplied_join_code: joinCode.trim(),
      }),
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

    const profiles = membershipRows.length
      ? unwrapRequired(
          await this.client
            .from("profiles")
            .select("*")
            .in(
              "id",
              membershipRows.map((membership) => membership.profile_id),
            ),
        )
      : [];
    const profileById = new Map(profiles.map((profile) => [profile.id, profile]));

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

    return unwrapRequired(
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
  }

  async updateChild(childId: string, updates: { firstName?: string; lastName?: string }) {
    if (updates.firstName !== undefined) {
      const trimmed = updates.firstName.trim();
      if (!trimmed) throw new Error("First name cannot be empty.");
      unwrap(
        await this.client
          .from("children")
          .update({ first_name: trimmed })
          .eq("id", childId),
      );
    }
    if (updates.lastName !== undefined) {
      const trimmed = updates.lastName.trim();
      if (!trimmed) throw new Error("Last name cannot be empty.");
      unwrap(
        await this.client
          .from("children")
          .update({ last_name: trimmed })
          .eq("id", childId),
      );
    }
  }

  async deactivateChild(childId: string) {
    unwrap(
      await this.client
        .from("children")
        .update({ active: false })
        .eq("id", childId),
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
      return unwrapRequired(
        await this.client
          .from("vehicles")
          .update(payload)
          .eq("id", existing.id)
          .select("*")
          .single(),
      );
    }

    return unwrapRequired(
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

  async getLatestWeek(groupId: string): Promise<WeekWithTrips | null> {
    const weeks = await this.listWeeks(groupId);
    const latest = weeks[0];
    if (!latest) return null;
    const trips = await this.listTripsForWeek(latest.id);
    return { week: latest, trips };
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

    const startDate = new Date(startsOn + "T00:00:00");
    const day = startDate.getDay();
    if (day !== 1) throw new Error("Week must start on a Monday.");

    const week = unwrapRequired<Tables<"weeks">>(
      await this.client
        .from("weeks")
        .insert({
          group_id: groupId,
          starts_on: startsOn,
          status: "open",
        })
        .select("*")
        .single(),
    );

    const tripInserts: TablesInsert<"trips">[] = [];
    for (let offset = 0; offset < 5; offset++) {
      const date = new Date(startDate);
      date.setDate(date.getDate() + offset);
      const serviceDate = date.toISOString().slice(0, 10);

      tripInserts.push({
        group_id: groupId,
        week_id: week.id,
        service_date: serviceDate,
        direction: "morning",
        meeting_time: "07:35",
        departure_time: "07:40",
        origin: meetingPoint,
        destination: schoolName,
      });
      tripInserts.push({
        group_id: groupId,
        week_id: week.id,
        service_date: serviceDate,
        direction: "afternoon",
        meeting_time: "15:20",
        departure_time: "15:25",
        origin: schoolName,
        destination: meetingPoint,
      });
    }

    unwrapRequired(
      await this.client.from("trips").insert(tripInserts).select("*"),
    );

    const trips = await this.listTripsForWeek(week.id);
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

    return unwrapRequired<Tables<"weekly_checkins">>(
      await this.client
        .from("weekly_checkins")
        .insert({
          group_id: groupId,
          week_id: weekId,
          household_id: householdId,
          status: "draft",
          max_drives: 0,
        })
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

  async submitCheckin(checkinId: string, maxDrives: number) {
    const userResult = await this.client.auth.getUser();
    if (userResult.error) throw new Error(userResult.error.message);
    if (!userResult.data.user) throw new Error("Sign in again to continue.");

    unwrapRequired(
      await this.client
        .from("weekly_checkins")
        .update({
          status: "submitted",
          max_drives: maxDrives,
          submitted_by: userResult.data.user.id,
          submitted_at: new Date().toISOString(),
        })
        .eq("id", checkinId)
        .select("*")
        .single(),
    );
  }

  async reopenCheckin(checkinId: string) {
    unwrap(
      await this.client
        .from("weekly_checkins")
        .update({
          status: "draft",
          submitted_by: null,
          submitted_at: null,
        })
        .eq("id", checkinId),
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

    const existing = unwrap(
      await this.client
        .from("ride_requests")
        .select("*")
        .eq("checkin_id", checkinId)
        .eq("trip_id", tripId)
        .eq("child_id", childId)
        .maybeSingle(),
    );

    if (existing) {
      unwrap(
        await this.client
          .from("ride_requests")
          .update({ needs_ride: needsRide })
          .eq("id", existing.id),
      );
      return;
    }

    unwrapRequired(
      await this.client.from("ride_requests").insert({
        group_id: groupId,
        checkin_id: checkinId,
        trip_id: tripId,
        child_id: childId,
        needs_ride: needsRide,
        created_by: userResult.data.user.id,
      }),
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

    unwrapRequired(
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
  ) {
    return unwrap(
      await this.client.rpc("respond_to_driver_assignment", {
        target_assignment_id: assignmentId,
        driver_response: response,
      }),
    );
  }
}
