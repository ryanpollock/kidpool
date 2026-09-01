export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type AppRole = "member" | "coordinator";
export type MembershipStatus = "active" | "suspended" | "removed";
export type WeekStatus = "open" | "draft" | "confirming" | "published" | "closed";
export type TripDirection = "morning" | "afternoon";
export type TripSlot = "am" | "pm_early" | "pm_late";
export type RidePreference = "specific" | "either";
export type TripStatus = "scheduled" | "covered" | "uncovered" | "canceled";
export type CheckinStatus = "draft" | "submitted";
export type DrivePreference = "prefer" | "can" | "cannot";
export type ScheduleStatus = "draft" | "published" | "superseded";
export type AssignmentStatus = "tentative" | "confirmed" | "declined" | "expired" | "released";
export type ConfirmationResponse = "confirmed" | "declined";
export type ReassignmentStatus = "pending" | "accepted" | "declined" | "cancelled";

type Table<Row, Insert, Update = Partial<Insert>> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};

type Timestamps = {
  created_at: string;
  updated_at: string;
};

export type DefaultDrivePref = {
  day: number;
  direction: TripDirection;
  slot: TripSlot;
  preference: DrivePreference;
};

export type DefaultRideNeed = {
  child_id: string;
  day: number;
  direction: TripDirection;
  slot: TripSlot | "pm_either";
  needs_ride: boolean;
};

export type ProfileRow = Timestamps & {
  id: string;
  email: string;
  full_name: string;
  avatar_url: string | null;
  default_drive_preferences: DefaultDrivePref[] | null;
  phone: string | null;
  share_phone: boolean;
  share_email: boolean;
};

export type GroupRow = Timestamps & {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  meeting_point: string;
  school_name: string;
};

export type HouseholdRow = Timestamps & {
  id: string;
  group_id: string;
  name: string;
  created_by: string;
  default_ride_needs: DefaultRideNeed[] | null;
};

export type MembershipRow = Timestamps & {
  id: string;
  group_id: string;
  household_id: string;
  profile_id: string;
  role: AppRole;
  status: MembershipStatus;
};

export type ChildRow = Timestamps & {
  id: string;
  group_id: string;
  household_id: string;
  first_name: string;
  last_name: string;
  active: boolean;
  created_by: string;
  preferred_buddy_child_id: string | null;
  photo_url: string | null;
  is_priority: boolean;
  phone: string | null;
};

export type VehicleRow = Timestamps & {
  id: string;
  group_id: string;
  household_id: string;
  default_driver_id: string | null;
  label: string;
  child_passenger_capacity: number;
  notes: string | null;
  active: boolean;
  created_by: string;
};

export type WeekRow = Timestamps & {
  id: string;
  group_id: string;
  starts_on: string;
  status: WeekStatus;
  checkin_deadline: string | null;
  confirmation_deadline: string | null;
  published_at: string | null;
};

export type TripRow = Timestamps & {
  id: string;
  group_id: string;
  week_id: string;
  service_date: string;
  direction: TripDirection;
  meeting_time: string;
  departure_time: string;
  origin: string;
  destination: string;
  status: TripStatus;
  slot: TripSlot;
};

export type WeeklyCheckinRow = Timestamps & {
  id: string;
  group_id: string;
  week_id: string;
  household_id: string;
  status: CheckinStatus;
  max_drives: number;
  submitted_by: string | null;
  submitted_at: string | null;
};

export type RideRequestRow = Timestamps & {
  id: string;
  group_id: string;
  checkin_id: string;
  trip_id: string;
  child_id: string;
  needs_ride: boolean;
  created_by: string;
  preference: RidePreference;
};

export type DriverAvailabilityRow = Timestamps & {
  id: string;
  group_id: string;
  checkin_id: string;
  trip_id: string;
  driver_profile_id: string;
  vehicle_id: string | null;
  preference: DrivePreference;
};

export type ScheduleVersionRow = {
  id: string;
  group_id: string;
  week_id: string;
  version_number: number;
  status: ScheduleStatus;
  algorithm_version: string;
  change_summary: string | null;
  generated_by: string | null;
  generated_at: string;
  published_at: string | null;
};

export type DriverAssignmentRow = Timestamps & {
  id: string;
  group_id: string;
  schedule_version_id: string;
  trip_id: string;
  driver_profile_id: string;
  vehicle_id: string;
  status: AssignmentStatus;
  child_passenger_capacity: number;
};

export type RiderAssignmentRow = {
  id: string;
  group_id: string;
  schedule_version_id: string;
  trip_id: string;
  driver_assignment_id: string;
  child_id: string;
  created_at: string;
};

export type ReassignmentRequestRow = {
  id: string;
  group_id: string;
  assignment_id: string;
  target_profile_id: string;
  requested_by: string;
  status: ReassignmentStatus;
  created_at: string;
  responded_at: string | null;
};

export type DriverConfirmationRow = {
  id: string;
  group_id: string;
  driver_assignment_id: string;
  driver_profile_id: string;
  response: ConfirmationResponse;
  decline_reason: string | null;
  responded_at: string;
};

export type AuditEventRow = {
  id: number;
  group_id: string;
  actor_profile_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  details: Json;
  occurred_at: string;
};

export type PushSubscriptionRow = Timestamps & {
  id: string;
  profile_id: string;
  group_id: string;
  endpoint: string;
  p256dh_key: string;
  auth_key: string;
};

export type DriveStatusRow = Timestamps & {
  id: string;
  group_id: string;
  driver_assignment_id: string;
  trip_id: string;
  profile_id: string;
  child_id: string | null;
  status: "on_my_way" | "ready";
  set_at: string;
};

export type Database = {
  public: {
    Tables: {
      profiles: Table<
        ProfileRow,
        {
          id: string;
          email: string;
          full_name: string;
          avatar_url?: string | null;
          default_drive_preferences?: DefaultDrivePref[] | null;
          phone?: string | null;
          share_phone?: boolean;
          share_email?: boolean;
          created_at?: string;
          updated_at?: string;
        }
      >;
      groups: Table<
        GroupRow,
        {
          id?: string;
          name: string;
          slug: string;
          timezone?: string;
          meeting_point: string;
          school_name: string;
          created_at?: string;
          updated_at?: string;
        }
      >;
      households: Table<
        HouseholdRow,
        {
          id?: string;
          group_id: string;
          name: string;
          created_by: string;
          default_ride_needs?: DefaultRideNeed[] | null;
          created_at?: string;
          updated_at?: string;
        }
      >;
      memberships: Table<
        MembershipRow,
        {
          id?: string;
          group_id: string;
          household_id: string;
          profile_id: string;
          role?: AppRole;
          status?: MembershipStatus;
          created_at?: string;
          updated_at?: string;
        }
      >;
      household_join_codes: Table<
        {
          household_id: string;
          group_id: string;
          code_hash: string;
          expires_at: string | null;
          created_by: string;
          created_at: string;
        },
        {
          household_id: string;
          group_id: string;
          code_hash: string;
          expires_at?: string | null;
          created_by: string;
          created_at?: string;
        }
      >;
      children: Table<
        ChildRow,
        {
          id?: string;
          group_id: string;
          household_id: string;
          first_name: string;
          last_name: string;
          active?: boolean;
          created_by: string;
          created_at?: string;
          updated_at?: string;
          preferred_buddy_child_id?: string | null;
          photo_url?: string | null;
          phone?: string | null;
        }
      >;
      vehicles: Table<
        VehicleRow,
        {
          id?: string;
          group_id: string;
          household_id: string;
          default_driver_id?: string | null;
          label: string;
          child_passenger_capacity: number;
          notes?: string | null;
          active?: boolean;
          created_by: string;
          created_at?: string;
          updated_at?: string;
        }
      >;
      weeks: Table<
        WeekRow,
        {
          id?: string;
          group_id: string;
          starts_on: string;
          status?: WeekStatus;
          checkin_deadline?: string | null;
          confirmation_deadline?: string | null;
          published_at?: string | null;
          created_at?: string;
          updated_at?: string;
        }
      >;
      trips: Table<
        TripRow,
        {
          id?: string;
          group_id: string;
          week_id: string;
          service_date: string;
          direction: TripDirection;
          meeting_time: string;
          departure_time: string;
          origin: string;
          destination: string;
          status?: TripStatus;
          slot: TripSlot;
          created_at?: string;
          updated_at?: string;
        }
      >;
      weekly_checkins: Table<
        WeeklyCheckinRow,
        {
          id?: string;
          group_id: string;
          week_id: string;
          household_id: string;
          status?: CheckinStatus;
          max_drives?: number;
          submitted_by?: string | null;
          submitted_at?: string | null;
          created_at?: string;
          updated_at?: string;
        }
      >;
      ride_requests: Table<
        RideRequestRow,
        {
          id?: string;
          group_id: string;
          checkin_id: string;
          trip_id: string;
          child_id: string;
          needs_ride?: boolean;
          created_by: string;
          preference?: RidePreference;
          created_at?: string;
          updated_at?: string;
        }
      >;
      driver_availability: Table<
        DriverAvailabilityRow,
        {
          id?: string;
          group_id: string;
          checkin_id: string;
          trip_id: string;
          driver_profile_id: string;
          vehicle_id?: string | null;
          preference: DrivePreference;
          created_at?: string;
          updated_at?: string;
        }
      >;
      schedule_versions: Table<
        ScheduleVersionRow,
        {
          id?: string;
          group_id: string;
          week_id: string;
          version_number: number;
          status?: ScheduleStatus;
          algorithm_version?: string;
          change_summary?: string | null;
          generated_by?: string | null;
          generated_at?: string;
          published_at?: string | null;
        }
      >;
      driver_assignments: Table<
        DriverAssignmentRow,
        {
          id?: string;
          group_id: string;
          schedule_version_id: string;
          trip_id: string;
          driver_profile_id: string;
          vehicle_id: string;
          status?: AssignmentStatus;
          child_passenger_capacity: number;
          created_at?: string;
          updated_at?: string;
        }
      >;
      rider_assignments: Table<
        RiderAssignmentRow,
        {
          id?: string;
          group_id: string;
          schedule_version_id: string;
          trip_id: string;
          driver_assignment_id: string;
          child_id: string;
          created_at?: string;
        }
      >;
      driver_confirmations: Table<
        DriverConfirmationRow,
        {
          id?: string;
          group_id: string;
          driver_assignment_id: string;
          driver_profile_id: string;
          response: ConfirmationResponse;
          decline_reason?: string | null;
          responded_at?: string;
        }
      >;
      audit_events: Table<
        AuditEventRow,
        {
          id?: never;
          group_id: string;
          actor_profile_id?: string | null;
          action: string;
          entity_type: string;
          entity_id?: string | null;
          details?: Json;
          occurred_at?: string;
        }
      >;
      push_subscriptions: Table<
        PushSubscriptionRow,
        {
          id?: never;
          profile_id: string;
          group_id: string;
          endpoint: string;
          p256dh_key: string;
          auth_key: string;
          created_at?: string;
        }
      >;
      drive_status: Table<
        DriveStatusRow,
        {
          id?: never;
          group_id: string;
          driver_assignment_id: string;
          trip_id: string;
          profile_id: string;
          child_id?: string | null;
          status: "on_my_way" | "ready";
          set_at?: string;
        }
      >;
    };
    Views: Record<string, never>;
    Functions: {
      create_household_with_membership: {
        Args: { target_group_id: string; household_name: string };
        Returns: { household_id: string; join_code: string }[];
      };
      join_household_by_code: {
        Args: { target_group_id: string; supplied_join_code: string };
        Returns: string;
      };
      regenerate_join_code: {
        Args: { target_household_id: string };
        Returns: string;
      };
      respond_to_driver_assignment: {
        Args: {
          target_assignment_id: string;
          driver_response: ConfirmationResponse;
          decline_reason?: string | null;
        };
        Returns: DriverAssignmentRow;
      };
      is_group_member: {
        Args: { target_group_id: string };
        Returns: boolean;
      };
      is_group_coordinator: {
        Args: { target_group_id: string };
        Returns: boolean;
      };
      is_household_member: {
        Args: { target_household_id: string };
        Returns: boolean;
      };
      shares_group_with_profile: {
        Args: { target_profile_id: string };
        Returns: boolean;
      };
      volunteer_for_declined_drive: {
        Args: { target_assignment_id: string };
        Returns: DriverAssignmentRow;
      };
      cancel_ride_for_child: {
        Args: { p_child_id: string; p_driver_assignment_id: string };
        Returns: void;
      };
      cancel_ride_for_child_by_coordinator: {
        Args: { p_child_id: string; p_driver_assignment_id: string };
        Returns: void;
      };
      add_ride_back_for_child: {
        Args: {
          p_child_id: string;
          p_driver_assignment_id: string;
          p_trip_id: string;
          p_schedule_version_id: string;
          p_group_id: string;
        };
        Returns: void;
      };
      volunteer_for_uncovered_trip: {
        Args: { p_trip_id: string; p_schedule_version_id: string };
        Returns: DriverAssignmentRow;
      };
      list_group_profiles: {
        Args: { target_group_id: string };
        Returns: Array<{
          id: string;
          full_name: string;
          avatar_url: string | null;
          default_drive_preferences: DefaultDrivePref[] | null;
          created_at: string;
          updated_at: string;
        }>;
      };
      list_group_directory: {
        Args: { target_group_id: string };
        Returns: Array<{
          id: string;
          full_name: string;
          avatar_url: string | null;
          email: string | null;
          phone: string | null;
          share_phone: boolean;
          share_email: boolean;
          household_id: string;
          household_name: string;
          role: string;
        }>;
      };
      publish_schedule: {
        Args: { p_group_id: string; p_version_id: string };
        Returns: Record<string, unknown>;
      };
      publish_schedule_internal: {
        Args: { p_group_id: string; p_version_id: string; p_actor_id: string | null };
        Returns: Record<string, unknown>;
      };
      manually_assign_driver: {
        Args: {
          p_trip_id: string;
          p_schedule_version_id: string;
          p_driver_profile_id: string;
          p_vehicle_id: string;
        };
        Returns: DriverAssignmentRow;
      };
      request_drive_reassignment: {
        Args: {
          p_assignment_id: string;
          p_target_profile_id: string;
        };
        Returns: ReassignmentRequestRow;
      };
      respond_to_reassignment_request: {
        Args: {
          p_request_id: string;
          p_response: string;
        };
        Returns: ReassignmentRequestRow;
      };
      cancel_reassignment_request: {
        Args: {
          p_request_id: string;
        };
        Returns: ReassignmentRequestRow;
      };
      switch_child_afternoon_trip: {
        Args: {
          p_child_id: string;
          p_driver_assignment_id: string;
        };
        Returns: Record<string, unknown>;
      };
    };
    Enums: {
      app_role: AppRole;
      membership_status: MembershipStatus;
      week_status: WeekStatus;
      trip_direction: TripDirection;
      trip_slot: TripSlot;
      ride_preference: RidePreference;
      trip_status: TripStatus;
      checkin_status: CheckinStatus;
      drive_preference: DrivePreference;
      schedule_status: ScheduleStatus;
      assignment_status: AssignmentStatus;
      confirmation_response: ConfirmationResponse;
      reassignment_status: ReassignmentStatus;
    };
    CompositeTypes: Record<string, never>;
  };
};

export type Tables<
  Name extends keyof Database["public"]["Tables"],
> = Database["public"]["Tables"][Name]["Row"];

export type TablesInsert<
  Name extends keyof Database["public"]["Tables"],
> = Database["public"]["Tables"][Name]["Insert"];

export type TablesUpdate<
  Name extends keyof Database["public"]["Tables"],
> = Database["public"]["Tables"][Name]["Update"];
