// Scheduling types shared between the Edge Function and Node tests.
// This module has zero imports so it runs in both Deno and Node.

export type DrivePreference = "prefer" | "can" | "cannot";

export type SchedulingTrip = {
  id: string;
  service_date: string;
  direction: "morning" | "afternoon";
};

export type SchedulingChild = {
  id: string;
  household_id: string;
  first_name: string;
  last_name: string;
  preferred_buddy_child_id: string | null;
  is_priority?: boolean;
};

export type SchedulingVehicle = {
  id: string;
  household_id: string;
  label: string;
  child_passenger_capacity: number;
};

export type SchedulingProfile = {
  id: string;
  full_name: string;
  household_id: string;
};

export type SchedulingRideRequest = {
  trip_id: string;
  child_id: string;
  needs_ride: boolean;
};

export type SchedulingAvailability = {
  trip_id: string;
  driver_profile_id: string;
  vehicle_id: string | null;
  preference: DrivePreference;
};

export type SchedulingAssignment = {
  trip_id: string;
  driver_profile_id: string;
  household_id: string;
  vehicle_id: string;
  child_passenger_capacity: number;
  confirmed: boolean;
};

export type SchedulingInputs = {
  trips: SchedulingTrip[];
  children: SchedulingChild[];
  vehicles: SchedulingVehicle[];
  profiles: SchedulingProfile[];
  rideRequests: SchedulingRideRequest[];
  availability: SchedulingAvailability[];
  maxDrivesByDriver: Map<string, number>;
  existingAssignments: SchedulingAssignment[];
  declinedTripsByDriver: Map<string, Set<string>>;
  expiredTripsByDriver: Map<string, Set<string>>;
};

export type SchedulingDriverAssignment = {
  trip_id: string;
  driver_profile_id: string;
  vehicle_id: string;
  child_passenger_capacity: number;
  assigned_child_ids: string[];
  confirmed: boolean;
};

export type SchedulingTripResult = {
  trip_id: string;
  rider_count: number;
  assigned_rider_count: number;
  uncovered_rider_count: number;
  driver_count: number;
  seat_count: number;
  assignments: SchedulingDriverAssignment[];
  uncovered: boolean;
};

export type SchedulingOutputs = {
  trips: SchedulingTripResult[];
  algorithm_version: string;
};