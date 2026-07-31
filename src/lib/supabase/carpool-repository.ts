import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  ConfirmationResponse,
  Database,
  Tables,
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
