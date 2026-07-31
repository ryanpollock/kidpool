import { Component, useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  AvatarIcon,
  BackpackIcon,
  CalendarIcon,
  CheckCircledIcon,
  CheckIcon,
  ChevronRightIcon,
  ClockIcon,
  Cross2Icon,
  DashboardIcon,
  ExclamationTriangleIcon,
  GroupIcon,
  HomeIcon,
  MoonIcon,
  PersonIcon,
  ReloadIcon,
  SunIcon,
} from "@radix-ui/react-icons";
import { KeyboardInput, MobileScroll } from "./mobile";
import {
  CarpoolRepository,
  getSupabaseClient,
  type CheckinDetails,
  type HouseholdSetup,
  type MyDriverAssignment,
  type ScheduleVersionWithRosters,
  type Tables,
  type WeekOverview,
  type WeekWithTrips,
} from "./lib/supabase";
import type { AssignmentStatus, DrivePreference } from "./lib/supabase/database.types";

type AppTab = "home" | "plan" | "week" | "coordinate";

type IdentityState = {
  profile: Tables<"profiles">;
  group: Tables<"groups">;
  membership: Tables<"memberships"> | null;
};

function readableError(error: unknown) {
  const message = error instanceof Error ? error.message : "Something went wrong.";
  if (/invalid or expired/i.test(message)) return "That household code is invalid or expired.";
  if (/already belongs/i.test(message)) return "This Google account already belongs to a household.";
  if (/network|fetch/i.test(message)) return "We couldn’t reach the carpool service. Check your connection and try again.";
  return message;
}

function oauthErrorFromLocation() {
  const search = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  return search.get("error_description") ?? hash.get("error_description");
}

type AppErrorBoundaryProps = { children: React.ReactNode };
type AppErrorBoundaryState = { error: Error | null };

class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  constructor(props: AppErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error-boundary" data-testid="error-boundary" role="alert">
          <span className="error-boundary-mark"><ExclamationTriangleIcon width="28" height="28" /></span>
          <h1>Something went wrong.</h1>
          <p className="helper-copy">We hit an unexpected error while loading the carpool.</p>
          <button
            className="primary-button"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function AuthLoadingScreen() {
  return (
    <div className="auth-screen auth-loading-screen" data-testid="auth-loading">
      <span className="auth-mark"><PersonIcon width="25" height="25" /></span>
      <ReloadIcon className="auth-spinner" width="22" height="22" />
      <strong>Opening Midtown Carpool…</strong>
      <small>Checking your secure session</small>
    </div>
  );
}

function SignInScreen({
  error,
  working,
  onSignIn,
}: {
  error: string | null;
  working: boolean;
  onSignIn: () => void;
}) {
  return (
    <div className="auth-screen sign-in-screen" data-testid="sign-in-screen">
      <div className="auth-brand">
        <span className="auth-mark"><PersonIcon width="25" height="25" /></span>
        <span>
          <strong>Midtown Carpool</strong>
          <small>Clarendon families · Presidio Middle School</small>
        </span>
      </div>

      <div className="sign-in-copy">
        <span className="eyebrow">A simpler school week</span>
        <h1>Know who’s driving—and who’s riding.</h1>
        <p>
          Coordinate rides between Midtown Terrace and Presidio with the families
          you already know.
        </p>
      </div>

      <div className="trust-list" aria-label="How the carpool works">
        <span><CheckCircledIcon /> Parents and children are named clearly</span>
        <span><CheckCircledIcon /> Drivers confirm before the schedule is final</span>
        <span><CheckCircledIcon /> Carpool details stay behind sign-in</span>
      </div>

      {error ? <div className="auth-error" role="alert">{error}</div> : null}

      <button
        className="google-button"
        data-testid="google-sign-in"
        disabled={working}
        onClick={onSignIn}
      >
        <span className="google-g" aria-hidden="true">G</span>
        {working ? "Opening Google…" : "Continue with Google"}
      </button>
      <small className="auth-footnote">
        Use the Google account you want associated with your family’s driving schedule.
      </small>
    </div>
  );
}

function OnboardingScreen({
  identity,
  repository,
  onComplete,
  onSignOut,
}: {
  identity: IdentityState;
  repository: CarpoolRepository;
  onComplete: () => Promise<void>;
  onSignOut: () => void;
}) {
  const [fullName, setFullName] = useState(identity.profile.full_name);
  const [mode, setMode] = useState<"choose" | "create" | "join">("choose");
  const [householdName, setHouseholdName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [createdCode, setCreatedCode] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saveProfile = async () => {
    const normalizedName = fullName.trim().replace(/\s+/g, " ");
    if (normalizedName.split(" ").filter(Boolean).length < 2) {
      throw new Error("Please enter the full name other parents should see.");
    }
    await repository.updateCurrentProfile(normalizedName);
  };

  const createHousehold = async () => {
    setWorking(true);
    setError(null);
    try {
      await saveProfile();
      if (!householdName.trim()) throw new Error("Enter a household name.");
      const created = await repository.createHousehold(identity.group.id, householdName);
      setCreatedCode(created.join_code);
    } catch (nextError) {
      setError(readableError(nextError));
    } finally {
      setWorking(false);
    }
  };

  const joinHousehold = async () => {
    setWorking(true);
    setError(null);
    try {
      await saveProfile();
      if (!joinCode.trim()) throw new Error("Enter the household code.");
      await repository.joinHousehold(identity.group.id, joinCode);
      await onComplete();
    } catch (nextError) {
      setError(readableError(nextError));
    } finally {
      setWorking(false);
    }
  };

  if (createdCode) {
    return (
      <div className="screen-content onboarding-screen onboarding-success" data-testid="household-created">
        <span className="success-orb"><CheckCircledIcon width="30" height="30" /></span>
        <span className="eyebrow">Household created</span>
        <h1>Your family is connected.</h1>
        <p>Share this code with another parent in your household. They’ll sign in with their own Google account, then enter it once.</p>
        <div className="join-code-card">
          <small>Household join code</small>
          <strong>{createdCode}</strong>
        </div>
        <p className="onboarding-note">You can find this code again from your household profile.</p>
        <button className="primary-button" onClick={() => void onComplete()}>
          Enter Midtown Carpool <ChevronRightIcon />
        </button>
        <button className="onboarding-signout" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    );
  }

  return (
    <div className="screen-content onboarding-screen" data-testid="onboarding-screen">
      <header className="page-title">
        <span className="eyebrow">First-time setup</span>
        <h1>Let’s connect your family.</h1>
        <p>{identity.group.name}</p>
      </header>

      <label className="auth-field">
        <span>Your full name</span>
        <KeyboardInput
          value={fullName}
          onChange={(event) => setFullName(event.target.value)}
          autoComplete="name"
          placeholder="First and last name"
        />
        <small>This is how other parents will see you on driving schedules.</small>
      </label>

      {mode === "choose" ? (
        <div className="onboarding-choice">
          <p>Are you setting up your household, or joining one another parent already created?</p>
          <button className="choice-card" onClick={() => setMode("create")}>
            <span><HomeIcon /></span>
            <span><strong>Create my household</strong><small>I’m the first parent from my family</small></span>
            <ChevronRightIcon />
          </button>
          <button className="choice-card" onClick={() => setMode("join")}>
            <span><GroupIcon /></span>
            <span><strong>Join my household</strong><small>I received a code from another parent</small></span>
            <ChevronRightIcon />
          </button>
        </div>
      ) : null}

      {mode === "create" ? (
        <div className="onboarding-action">
          <button className="back-link" onClick={() => setMode("choose")}>← Back</button>
          <label className="auth-field">
            <span>Household name</span>
            <KeyboardInput
              value={householdName}
              onChange={(event) => setHouseholdName(event.target.value)}
              placeholder="For example, Pollock family"
              autoComplete="off"
            />
          </label>
          {error ? <div className="auth-error" role="alert">{error}</div> : null}
          <button className="primary-button" disabled={working} onClick={() => void createHousehold()}>
            {working ? "Creating household…" : "Create household"}
          </button>
        </div>
      ) : null}

      {mode === "join" ? (
        <div className="onboarding-action">
          <button className="back-link" onClick={() => setMode("choose")}>← Back</button>
          <label className="auth-field">
            <span>Household code</span>
            <KeyboardInput
              className="join-code-input"
              value={joinCode}
              onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
              placeholder="Enter 10-character code"
              autoCapitalize="characters"
              autoComplete="off"
            />
          </label>
          {error ? <div className="auth-error" role="alert">{error}</div> : null}
          <button className="primary-button" disabled={working} onClick={() => void joinHousehold()}>
            {working ? "Joining household…" : "Join household"}
          </button>
        </div>
      ) : null}
      <button className="onboarding-signout" onClick={onSignOut}>
        Sign out and use a different Google account
      </button>
    </div>
  );
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatTripDate(serviceDate: string) {
  const date = new Date(serviceDate + "T00:00:00");
  const weekday = WEEKDAY_LABELS[date.getDay()];
  const month = MONTH_LABELS[date.getMonth()];
  const day = date.getDate();
  return { weekday, short: `${month} ${day}`, full: `${weekday}, ${month} ${day}` };
}

function cycleDrivePreference(pref: DrivePreference): DrivePreference {
  if (pref === "prefer") return "can";
  if (pref === "can") return "cannot";
  return "prefer";
}

function preferenceLabel(pref: DrivePreference): string {
  if (pref === "prefer") return "Prefer to drive";
  if (pref === "can") return "Can if needed";
  return "Unavailable";
}

function nextMonday(): string {
  const today = new Date();
  const day = today.getDay();
  const daysUntilMonday = day === 0 ? 1 : 8 - day;
  const monday = new Date(today);
  monday.setDate(today.getDate() + daysUntilMonday);
  return monday.toISOString().slice(0, 10);
}

function AssignmentRow({
  trip,
  vehicle,
  riderCount,
  status,
}: {
  trip: Tables<"trips">;
  vehicle: Tables<"vehicles">;
  riderCount: number;
  status: AssignmentStatus;
}) {
  const period = trip.direction === "morning" ? "Morning" : "Afternoon";
  const PeriodIcon = trip.direction === "morning" ? SunIcon : MoonIcon;
  const dateInfo = formatTripDate(trip.service_date);
  const confirmed = status === "confirmed";
  const declined = status === "declined";

  return (
    <article className="assignment-row">
      <span className={`period-icon ${trip.direction === "morning" ? "period-icon--morning" : "period-icon--afternoon"}`}>
        <PeriodIcon width="22" height="22" />
      </span>
      <div className="assignment-copy">
        <div className="assignment-title">{dateInfo.full} · {period}</div>
        <div className="assignment-route">{trip.origin} → {trip.destination}</div>
        <div className="assignment-meta">
          <span>{vehicle.label}</span>
          <span>{riderCount} rider{riderCount !== 1 ? "s" : ""}</span>
        </div>
      </div>
      <span className={`status-label ${confirmed ? "status-label--confirmed" : declined ? "status-label--declined" : "status-label--tentative"}`}>
        {confirmed ? <CheckIcon width="13" height="13" /> : null}
        {confirmed ? "Confirmed" : declined ? "Declined" : "Tentative"}
      </span>
    </article>
  );
}

function HomeScreen({
  myAssignments,
  assignmentsLoading,
  assignmentsError,
  schedulePublished,
  onConfirmAll,
  onReview,
  onCoverage,
  onAccount,
  onRetryAssignments,
  working,
}: {
  myAssignments: MyDriverAssignment[];
  assignmentsLoading: boolean;
  assignmentsError: string | null;
  schedulePublished: boolean;
  onConfirmAll: () => void;
  onReview: () => void;
  onCoverage: () => void;
  onAccount: () => void;
  onRetryAssignments: () => void;
  working: boolean;
}) {
  const tentative = myAssignments.filter((a) => a.assignment.status === "tentative");
  const confirmed = myAssignments.filter((a) => a.assignment.status === "confirmed");
  const allConfirmed = tentative.length === 0 && confirmed.length > 0;
  const noAssignments = myAssignments.length === 0;

  return (
    <div className="screen-content home-screen" data-testid="home-screen">
      <header className="app-header">
        <div className="brand-lockup">
          <span className="brand-mark"><PersonIcon width="18" height="18" /></span>
          <span>
            <strong>Midtown Carpool</strong>
            <small>Presidio Middle School</small>
          </span>
        </div>
        <button className="avatar-button" aria-label="Open household profile" onClick={onAccount}>
          <AvatarIcon width="19" height="19" />
        </button>
      </header>

      {assignmentsLoading ? (
        <p className="helper-copy">Loading your drives…</p>
      ) : assignmentsError ? (
        <section className="confirmation-hero confirmation-hero--done">
          <span className="eyebrow">This week</span>
          <h1>We couldn’t load your drives</h1>
          <div className="auth-error" role="alert">{assignmentsError}</div>
          <button className="primary-button" data-testid="retry-load-assignments" onClick={onRetryAssignments}>Try again</button>
        </section>
      ) : noAssignments ? (
        <section className="confirmation-hero confirmation-hero--done">
          <span className="eyebrow">This week</span>
          <h1>No drives assigned</h1>
          <p className="hero-support">You haven’t been assigned to drive this week. Check the full schedule for details.</p>
        </section>
      ) : (
        <section className={`confirmation-hero ${allConfirmed ? "confirmation-hero--done" : ""}`}>
          <span className="eyebrow">{allConfirmed ? (schedulePublished ? "Published schedule" : "Sunday schedule") : "Action needed today"}</span>
          <h1>{allConfirmed ? "You’re all set" : "Confirm your drives"}</h1>
          <p className="hero-deadline">
            {allConfirmed ? (
              <><CheckCircledIcon width="18" height="18" /> {confirmed.length} drive{confirmed.length !== 1 ? "s" : ""} confirmed</>
            ) : (
              <>{tentative.length} assignment{tentative.length !== 1 ? "s" : ""} <span aria-hidden="true">·</span> <strong>Confirm by 3:00 PM</strong></>
            )}
          </p>
          <p className="hero-support">
            {allConfirmed
              ? "We’ll remind you the evening before each drive."
              : "These are tentative until you accept them. Opening this schedule does not count as confirmation."}
          </p>
        </section>
      )}

      {!noAssignments ? (
        <section className="assignment-section" aria-labelledby="assignment-heading">
          <div className="section-heading-row">
            <h2 id="assignment-heading">{allConfirmed ? "Your confirmed drives" : "Your tentative drives"}</h2>
          </div>
          <div className="assignment-list">
            {myAssignments.map((entry) => (
              <AssignmentRow
                key={entry.assignment.id}
                trip={entry.trip}
                vehicle={entry.vehicle}
                riderCount={entry.children.length}
                status={entry.assignment.status}
              />
            ))}
          </div>
          {!allConfirmed ? (
            <>
              <button className="primary-button" data-testid="confirm-drives" disabled={working} onClick={onConfirmAll}>
                <CheckIcon width="19" height="19" /> Confirm all drives
              </button>
              <button className="text-button" onClick={onReview}>Review individually</button>
            </>
          ) : (
            <button className="secondary-button" onClick={onReview}>View passenger rosters <ChevronRightIcon /></button>
          )}
        </section>
      ) : null}

      <button className="coverage-alert" onClick={onCoverage} data-testid="coverage-alert">
        <span><ExclamationTriangleIcon width="20" height="20" /></span>
        <span><strong>View full schedule</strong><small>See this week’s coverage</small></span>
        <ChevronRightIcon />
      </button>
    </div>
  );
}

function ReviewScreen({
  myAssignments,
  repository,
  onResponded,
  onBack,
}: {
  myAssignments: MyDriverAssignment[];
  repository: CarpoolRepository;
  onResponded: () => void;
  onBack: () => void;
}) {
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [decliningId, setDecliningId] = useState<string | null>(null);
  const [declineReason, setDeclineReason] = useState("");

  const respond = async (assignmentId: string, response: "confirmed" | "declined", reason?: string) => {
    setWorking(assignmentId);
    setError(null);
    try {
      await repository.respondToDriverAssignment(assignmentId, response, reason);
      setDecliningId(null);
      setDeclineReason("");
      onResponded();
    } catch (nextError) {
      setError(readableError(nextError));
    } finally {
      setWorking(null);
    }
  };

  return (
    <div className="screen-content detail-screen" data-testid="review-screen">
      <header className="subpage-header">
        <button onClick={onBack} aria-label="Back to home"><Cross2Icon /></button>
        <div><span className="eyebrow">Sunday confirmation</span><h1>Review your drives</h1></div>
      </header>
      <p className="detail-intro">Confirm each assignment only if the date, direction, vehicle, and seat count are correct.</p>
      {error ? <div className="auth-error" role="alert">{error}</div> : null}

      {myAssignments.length === 0 ? (
        <p className="helper-copy">No assignments to review.</p>
      ) : null}

      {myAssignments.map((entry) => {
        const dateInfo = formatTripDate(entry.trip.service_date);
        const period = entry.trip.direction === "morning" ? "Morning" : "Afternoon";
        const status = entry.assignment.status;
        const isDeclining = decliningId === entry.assignment.id;
        const roster = entry.children.length > 0
          ? entry.children.map((c) => `${c.first_name} ${c.last_name}`).join(" · ")
          : "No riders assigned";

        return (
          <div className="detail-card" key={entry.assignment.id}>
            <AssignmentRow
              trip={entry.trip}
              vehicle={entry.vehicle}
              riderCount={entry.children.length}
              status={status}
            />
            <div className="roster">
              <span>Passenger roster</span>
              <strong>{roster}</strong>
              <small>Meet at {entry.trip.meeting_time} · {entry.trip.origin} → {entry.trip.destination}</small>
            </div>
            {status === "tentative" ? (
              isDeclining ? (
                <div className="decline-form" data-testid="decline-form">
                  <label className="auth-field">
                    <span>Reason (optional)</span>
                    <KeyboardInput
                      value={declineReason}
                      onChange={(event) => setDeclineReason(event.target.value)}
                      placeholder="Help your coordinator find a replacement"
                      autoComplete="off"
                    />
                  </label>
                  <button className="decline-button" disabled={working === entry.assignment.id} onClick={() => void respond(entry.assignment.id, "declined", declineReason)}>
                    {working === entry.assignment.id ? "Declining…" : "Confirm decline"}
                  </button>
                  <button className="text-button" onClick={() => { setDecliningId(null); setDeclineReason(""); }}>Cancel</button>
                </div>
              ) : (
                <>
                  <button className="primary-button" disabled={working === entry.assignment.id} onClick={() => void respond(entry.assignment.id, "confirmed")}>
                    <CheckIcon /> Confirm this drive
                  </button>
                  <button className="decline-button" disabled={working === entry.assignment.id} onClick={() => setDecliningId(entry.assignment.id)}>
                    I can’t make this one
                  </button>
                </>
              )
            ) : status === "confirmed" ? (
              <div className="success-notice"><CheckCircledIcon /><span><strong>Confirmed</strong><small>{dateInfo.full} · {period}</small></span></div>
            ) : (
              <div className="declined-notice"><Cross2Icon /><span><strong>Declined</strong><small>This drive has been released.</small></span></div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PlanScreen({
  week,
  weekLoading,
  weekError,
  checkin,
  checkinDetails,
  checkinLoading,
  setup,
  repository,
  driverProfileId,
  groupId,
  onReloadCheckin,
  onReloadWeek,
  isCoordinator,
  onCreateWeek,
}: {
  week: WeekWithTrips | null;
  weekLoading: boolean;
  weekError: string | null;
  checkin: Tables<"weekly_checkins"> | null;
  checkinDetails: CheckinDetails | null;
  checkinLoading: boolean;
  setup: HouseholdSetup | null;
  repository: CarpoolRepository;
  driverProfileId: string;
  groupId: string;
  onReloadCheckin: () => void;
  onReloadWeek: () => void;
  isCoordinator: boolean;
  onCreateWeek: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [maxDrives, setMaxDrives] = useState("2");

  const submitted = checkin?.status === "submitted";
  const children = setup?.children ?? [];
  const activeVehicle = setup?.vehicles.find((vehicle) => vehicle.active) ?? null;

  useEffect(() => {
    if (checkin) setMaxDrives(String(checkin.max_drives || 2));
  }, [checkin]);

  if (weekLoading) {
    return (
      <div className="screen-content plan-screen" data-testid="plan-screen">
        <header className="page-title">
          <span className="eyebrow">Saturday check-in</span>
          <h1>Plan next week</h1>
        </header>
        <p className="helper-copy">Loading the upcoming week…</p>
      </div>
    );
  }

  if (weekError) {
    return (
      <div className="screen-content plan-screen" data-testid="plan-screen">
        <header className="page-title">
          <span className="eyebrow">Saturday check-in</span>
          <h1>Plan next week</h1>
        </header>
        <div className="auth-error" role="alert">{weekError}</div>
        <button className="primary-button" data-testid="retry-load-week" onClick={onReloadWeek}>Try again</button>
      </div>
    );
  }

  if (!week) {
    return (
      <div className="screen-content plan-screen" data-testid="plan-screen">
        <header className="page-title">
          <span className="eyebrow">Saturday check-in</span>
          <h1>Plan next week</h1>
        </header>
        <div className="empty-state">
          <p>No week has been created yet.</p>
          {isCoordinator ? (
            <button className="primary-button" data-testid="create-week-plan" onClick={onCreateWeek}>
              Create next week
            </button>
          ) : (
            <p className="helper-copy">A coordinator needs to create the week first. Check back soon.</p>
          )}
        </div>
      </div>
    );
  }

  if (children.length === 0) {
    return (
      <div className="screen-content plan-screen" data-testid="plan-screen">
        <header className="page-title">
          <span className="eyebrow">Saturday check-in</span>
          <h1>Plan next week</h1>
          <p>{formatTripDate(week.week.starts_on).short} – {formatTripDate(week.week.starts_on).short}</p>
        </header>
        <div className="empty-state">
          <p>Add your children in your account first, then come back to plan the week.</p>
        </div>
      </div>
    );
  }

  const tripsByDate = new Map<string, Tables<"trips">[]>();
  for (const trip of week.trips) {
    const existing = tripsByDate.get(trip.service_date) ?? [];
    existing.push(trip);
    tripsByDate.set(trip.service_date, existing);
  }
  const sortedDates = [...tripsByDate.keys()].sort();

  const rideMap = new Map<string, boolean>();
  for (const req of checkinDetails?.rideRequests ?? []) {
    rideMap.set(`${req.trip_id}:${req.child_id}`, req.needs_ride);
  }

  const driveMap = new Map<string, DrivePreference>();
  for (const avail of checkinDetails?.driverAvailability ?? []) {
    if (avail.driver_profile_id === driverProfileId) {
      driveMap.set(avail.trip_id, avail.preference);
    }
  }

  const toggleRide = async (tripId: string, childId: string) => {
    if (submitted || !checkin) return;
    const key = `${tripId}:${childId}`;
    const current = rideMap.get(key) ?? false;
    try {
      await repository.upsertRideRequest(checkin.id, tripId, childId, !current, groupId);
      onReloadCheckin();
    } catch (error) {
      setSubmitError(readableError(error));
    }
  };

  const toggleDrive = async (tripId: string) => {
    if (submitted || !checkin) return;
    const current = driveMap.get(tripId) ?? "cannot";
    const next = cycleDrivePreference(current);
    if (next !== "cannot" && !activeVehicle) {
      setSubmitError("Add a vehicle in your account before volunteering to drive.");
      return;
    }
    try {
      await repository.upsertDriverAvailability(
        checkin.id, tripId, driverProfileId,
        activeVehicle?.id ?? null, next, groupId,
      );
      onReloadCheckin();
    } catch (error) {
      setSubmitError(readableError(error));
    }
  };

  const submit = async () => {
    if (!checkin) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await repository.submitCheckin(checkin.id, Number(maxDrives) || 0);
      onReloadCheckin();
    } catch (error) {
      setSubmitError(readableError(error));
    } finally {
      setSubmitting(false);
    }
  };

  const reopen = async () => {
    if (!checkin) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await repository.reopenCheckin(checkin.id);
      onReloadCheckin();
    } catch (error) {
      setSubmitError(readableError(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="screen-content plan-screen" data-testid="plan-screen">
      <header className="page-title">
        <span className="eyebrow">Saturday check-in</span>
        <h1>Plan next week</h1>
        <p>{formatTripDate(week.week.starts_on).short} – {formatTripDate(sortedDates[sortedDates.length - 1] ?? week.week.starts_on).short}</p>
      </header>

      {submitted ? (
        <div className="success-banner">
          <CheckCircledIcon width="24" height="24" />
          <span><strong>Week submitted</strong><small>Your check-in is locked. Reopen to make changes.</small></span>
        </div>
      ) : null}

      {submitError ? <div className="auth-error" role="alert">{submitError}</div> : null}

      {sortedDates.map((serviceDate) => {
        const dateTrips = tripsByDate.get(serviceDate) ?? [];
        const dateInfo = formatTripDate(serviceDate);
        const morningTrip = dateTrips.find((trip) => trip.direction === "morning");
        const afternoonTrip = dateTrips.find((trip) => trip.direction === "afternoon");

        const renderTrip = (trip: Tables<"trips"> | undefined, direction: "morning" | "afternoon") => {
          if (!trip) return null;
          const PeriodIcon = direction === "morning" ? SunIcon : MoonIcon;
          return (
            <div className="checkin-trip" key={trip.id}>
              <div className="checkin-trip-header">
                <PeriodIcon width="16" height="16" />
                <span>{direction === "morning" ? "Morning" : "Afternoon"}</span>
                <small>{trip.meeting_time} · {trip.origin} → {trip.destination}</small>
              </div>
              <div className="checkin-rides">
                {children.map((child) => {
                  const key = `${trip.id}:${child.id}`;
                  const riding = rideMap.get(key) ?? false;
                  return (
                    <button
                      key={child.id}
                      className={riding ? "ride-pill ride-pill--on" : "ride-pill"}
                      disabled={submitted}
                      onClick={() => void toggleRide(trip.id, child.id)}
                      aria-pressed={riding}
                    >
                      {child.first_name}
                    </button>
                  );
                })}
              </div>
              <button
                className={`drive-cycle drive-cycle--${driveMap.get(trip.id) ?? "cannot"}`}
                disabled={submitted}
                onClick={() => void toggleDrive(trip.id)}
              >
                <span>You</span>
                <span>{preferenceLabel(driveMap.get(trip.id) ?? "cannot")}</span>
              </button>
            </div>
          );
        };

        return (
          <section className="checkin-day" key={serviceDate}>
            <div className="checkin-day-header">
              <strong>{dateInfo.weekday}</strong>
              <span>{dateInfo.short}</span>
            </div>
            {renderTrip(morningTrip, "morning")}
            {renderTrip(afternoonTrip, "afternoon")}
          </section>
        );
      })}

      {!submitted ? (
        <section className="checkin-max-drives">
          <label className="auth-field">
            <span>Max drives this week</span>
            <KeyboardInput
              value={maxDrives}
              onChange={(event) => setMaxDrives(event.target.value.replace(/[^0-9]/g, ""))}
              inputMode="numeric"
              placeholder="2"
              autoComplete="off"
            />
          </label>
        </section>
      ) : null}

      <div className="vehicle-summary">
        <span><DashboardIcon /></span>
        <span>
          <strong>{activeVehicle ? `${activeVehicle.label} · ${activeVehicle.child_passenger_capacity} seats` : "No vehicle"}</strong>
          <small>{activeVehicle ? "Includes your children when riding" : "Add one in your account to drive"}</small>
        </span>
      </div>

      {submitted ? (
        <button className="secondary-button" disabled={submitting} onClick={() => void reopen()}>
          {submitting ? "Reopening…" : "Reopen my check-in"}
        </button>
      ) : (
        <button className="primary-button" data-testid="submit-plan" disabled={submitting || checkinLoading} onClick={() => void submit()}>
          {submitting ? "Submitting…" : "Submit my week"}
        </button>
      )}
    </div>
  );
}

function WeekScreen({
  week,
  weekLoading,
  weekError,
  schedule,
  scheduleLoading,
  scheduleError,
  isCoordinator,
  onGenerate,
  generating,
  generateError,
  onReloadWeek,
  onReloadSchedule,
}: {
  week: WeekWithTrips | null;
  weekLoading: boolean;
  weekError: string | null;
  schedule: ScheduleVersionWithRosters | null;
  scheduleLoading: boolean;
  scheduleError: string | null;
  isCoordinator: boolean;
  onGenerate: () => void;
  generating: boolean;
  generateError: string | null;
  onReloadWeek: () => void;
  onReloadSchedule: () => void;
}) {
  if (weekLoading) {
    return (
      <div className="screen-content week-screen" data-testid="week-screen">
        <header className="page-title">
          <span className="eyebrow">Family schedule</span>
          <h1>This week</h1>
        </header>
        <p className="helper-copy">Loading…</p>
      </div>
    );
  }

  if (weekError) {
    return (
      <div className="screen-content week-screen" data-testid="week-screen">
        <header className="page-title">
          <span className="eyebrow">Family schedule</span>
          <h1>This week</h1>
        </header>
        <div className="auth-error" role="alert">{weekError}</div>
        <button className="primary-button" data-testid="retry-load-week" onClick={onReloadWeek}>Try again</button>
      </div>
    );
  }

  if (!week) {
    return (
      <div className="screen-content week-screen" data-testid="week-screen">
        <header className="page-title">
          <span className="eyebrow">Family schedule</span>
          <h1>This week</h1>
        </header>
        <div className="empty-state">
          <p>No week has been created yet.</p>
          {isCoordinator ? (
            <button className="primary-button" data-testid="generate-schedule-empty" disabled={generating} onClick={onGenerate}>
              {generating ? "Working…" : "Generate schedule"}
            </button>
          ) : (
            <p className="helper-copy">A coordinator needs to create the week first.</p>
          )}
        </div>
      </div>
    );
  }

  const startDate = formatTripDate(week.week.starts_on);
  const lastTripDate = week.trips[week.trips.length - 1]?.service_date ?? week.week.starts_on;
  const endDate = formatTripDate(lastTripDate);

  if (scheduleLoading) {
    return (
      <div className="screen-content week-screen" data-testid="week-screen">
        <header className="page-title">
          <span className="eyebrow">Family schedule</span>
          <h1>{startDate.short} – {endDate.short}</h1>
        </header>
        <p className="helper-copy">Loading schedule…</p>
      </div>
    );
  }

  if (scheduleError) {
    return (
      <div className="screen-content week-screen" data-testid="week-screen">
        <header className="page-title">
          <span className="eyebrow">Family schedule</span>
          <h1>{startDate.short} – {endDate.short}</h1>
        </header>
        <div className="auth-error" role="alert">{scheduleError}</div>
        <button className="primary-button" data-testid="retry-load-schedule" onClick={onReloadSchedule}>Try again</button>
      </div>
    );
  }

  if (!schedule) {
    return (
      <div className="screen-content week-screen" data-testid="week-screen">
        <header className="page-title">
          <span className="eyebrow">Family schedule</span>
          <h1>{startDate.short} – {endDate.short}</h1>
        </header>
        <div className="empty-state">
          <p>No draft schedule yet.</p>
          {isCoordinator ? (
            <>
              {generateError ? <div className="auth-error" role="alert">{generateError}</div> : null}
              <button className="primary-button" data-testid="generate-schedule" disabled={generating} onClick={onGenerate}>
                {generating ? "Generating…" : "Generate draft schedule"}
              </button>
            </>
          ) : (
            <p className="helper-copy">A coordinator needs to generate the draft.</p>
          )}
        </div>
      </div>
    );
  }

  const tripsByDate = new Map<string, Tables<"trips">[]>();
  for (const trip of week.trips) {
    const existing = tripsByDate.get(trip.service_date) ?? [];
    existing.push(trip);
    tripsByDate.set(trip.service_date, existing);
  }
  const sortedDates = [...tripsByDate.keys()].sort();

  const coveredCount = sortedDates.reduce((count, date) => {
    const dateTrips = tripsByDate.get(date) ?? [];
    for (const trip of dateTrips) {
      const rosters = schedule.rostersByTrip.get(trip.id) ?? [];
      const hasUncovered = rosters.length === 0;
      if (!hasUncovered) count++;
    }
    return count;
  }, 0);
  const totalTrips = week.trips.length;
  const uncoveredCount = totalTrips - coveredCount;

  const isPublished = schedule.version.status === "published";

  return (
    <div className="screen-content week-screen" data-testid="week-screen">
      <header className="page-title">
        <span className="eyebrow">Family schedule</span>
        <h1>{startDate.short} – {endDate.short}</h1>
        <p>
          <span className={`schedule-badge ${isPublished ? "schedule-badge--published" : "schedule-badge--draft"}`}>
            {isPublished ? "Published" : `Draft v${schedule.version.version_number}`}
          </span>
          {isPublished ? null : <span className="schedule-algo">{schedule.version.algorithm_version}</span>}
        </p>
      </header>

      {generateError ? <div className="auth-error" role="alert">{generateError}</div> : null}

      <div className="week-status-strip">
        <span><CheckCircledIcon /> {coveredCount} covered</span>
        {uncoveredCount > 0 ? <span><ExclamationTriangleIcon /> {uncoveredCount} needs assignment</span> : null}
      </div>

      {isCoordinator && !isPublished ? (
        <button className="secondary-button" data-testid="regenerate-schedule" disabled={generating} onClick={onGenerate}>
          {generating ? "Regenerating…" : "Regenerate draft"}
        </button>
      ) : null}

      <div className="week-list">
        {sortedDates.map((serviceDate) => {
          const dateTrips = tripsByDate.get(serviceDate) ?? [];
          const dateInfo = formatTripDate(serviceDate);
          return (
            <article className="week-day" key={serviceDate}>
              <div className="week-date"><strong>{dateInfo.weekday}</strong><span>{dateInfo.short}</span></div>
              {dateTrips.map((trip) => {
                const rosters = schedule.rostersByTrip.get(trip.id) ?? [];
                const PeriodIcon = trip.direction === "morning" ? SunIcon : MoonIcon;
                const uncovered = rosters.length === 0;
                return (
                  <div className={`leg ${uncovered ? "leg--alert" : ""}`} key={trip.id}>
                    <PeriodIcon />
                    <span>
                      <small>{trip.direction === "morning" ? "Morning" : "Afternoon"}</small>
                      <strong>{trip.meeting_time} · {trip.origin} → {trip.destination}</strong>
                    </span>
                    {uncovered ? (
                      <span className="mini-status mini-status--alert">No drivers</span>
                    ) : (
                      <span className="mini-status mini-status--confirmed">{rosters.length} car{rosters.length !== 1 ? "s" : ""}</span>
                    )}
                    {!uncovered ? (
                      <div className="trip-rosters">
                        {rosters.map((entry) => (
                          <div className="trip-roster" key={entry.driverAssignment.id}>
                            <div className="roster-driver">
                              <strong>{entry.driverProfile.full_name}</strong>
                              <small>{entry.vehicle.label} · {entry.vehicle.child_passenger_capacity} seats</small>
                            </div>
                            <div className="roster-children">
                              {entry.children.length ? entry.children.map((child) => (
                                <span key={child.id}>{child.first_name} {child.last_name}</span>
                              )) : <span className="roster-empty">No riders assigned</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function CoordinatorScreen({
  week,
  weekLoading,
  weekError,
  overview,
  overviewLoading,
  overviewError,
  isCoordinator,
  onCreateWeek,
  creatingWeek,
  createWeekError,
  onGenerate,
  generating,
  generateError,
  scheduleStatus,
  onPublish,
  publishing,
  onReloadWeek,
  onReloadOverview,
}: {
  week: WeekWithTrips | null;
  weekLoading: boolean;
  weekError: string | null;
  overview: WeekOverview | null;
  overviewLoading: boolean;
  overviewError: string | null;
  isCoordinator: boolean;
  onCreateWeek: () => void;
  creatingWeek: boolean;
  createWeekError: string | null;
  onGenerate: () => void;
  generating: boolean;
  generateError: string | null;
  scheduleStatus: "draft" | "published" | null;
  onPublish: () => void;
  publishing: boolean;
  onReloadWeek: () => void;
  onReloadOverview: () => void;
}) {
  if (weekLoading) {
    return (
      <div className="screen-content coordinator-screen" data-testid="coordinator-screen">
        <header className="page-title">
          <span className="eyebrow">Coordinator view</span>
          <h1>Weekly coverage</h1>
        </header>
        <p className="helper-copy">Loading…</p>
      </div>
    );
  }

  if (weekError) {
    return (
      <div className="screen-content coordinator-screen" data-testid="coordinator-screen">
        <header className="page-title">
          <span className="eyebrow">Coordinator view</span>
          <h1>Weekly coverage</h1>
        </header>
        <div className="auth-error" role="alert">{weekError}</div>
        <button className="primary-button" data-testid="retry-load-week" onClick={onReloadWeek}>Try again</button>
      </div>
    );
  }

  if (!week) {
    return (
      <div className="screen-content coordinator-screen" data-testid="coordinator-screen">
        <header className="page-title">
          <span className="eyebrow">Coordinator view</span>
          <h1>Weekly coverage</h1>
        </header>
        <div className="empty-state">
          <p>No week has been created yet.</p>
          {createWeekError ? <div className="auth-error" role="alert">{createWeekError}</div> : null}
          {isCoordinator ? (
            <button className="primary-button" data-testid="create-week-coord" disabled={creatingWeek} onClick={onCreateWeek}>
              {creatingWeek ? "Creating…" : "Create next week"}
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  const startDate = formatTripDate(week.week.starts_on);
  const lastTripDate = week.trips[week.trips.length - 1]?.service_date ?? week.week.starts_on;
  const endDate = formatTripDate(lastTripDate);

  const submittedCount = overview?.households.filter((h) => h.status === "submitted").length ?? 0;
  const draftCount = overview?.households.filter((h) => h.status === "draft").length ?? 0;
  const notStartedCount = overview?.households.filter((h) => h.status === "not_started").length ?? 0;

  return (
    <div className="screen-content coordinator-screen" data-testid="coordinator-screen">
      <header className="page-title">
        <span className="eyebrow">Coordinator view</span>
        <h1>Weekly coverage</h1>
        <p>{startDate.short} – {endDate.short}</p>
      </header>

      {createWeekError ? <div className="auth-error" role="alert">{createWeekError}</div> : null}

      {overviewError ? (
        <section className="coverage-summary coverage-summary--error">
          <div className="auth-error" role="alert">{overviewError}</div>
          <button className="secondary-button" data-testid="retry-load-overview" onClick={onReloadOverview}>Retry overview</button>
        </section>
      ) : (
        <section className="coverage-summary">
          <div><strong>{submittedCount}</strong><span>Submitted</span></div>
          <div><strong>{draftCount}</strong><span>In progress</span></div>
          <div className="coverage-summary--alert"><strong>{notStartedCount}</strong><span>Not started</span></div>
        </section>
      )}

      {isCoordinator ? (
        <button className="secondary-button" data-testid="create-week-coord" disabled={creatingWeek} onClick={onCreateWeek}>
          {creatingWeek ? "Creating…" : "Create next week"}
        </button>
      ) : null}

      {isCoordinator && week ? (
        <div className="coordinator-generate">
          {generateError ? <div className="auth-error" role="alert">{generateError}</div> : null}
          {scheduleStatus === "draft" ? (
            <>
              <button className="secondary-button" data-testid="generate-schedule-coord" disabled={generating} onClick={onGenerate}>
                {generating ? "Generating…" : "Regenerate draft"}
              </button>
              <button className="primary-button" data-testid="publish-schedule" disabled={publishing} onClick={onPublish}>
                {publishing ? "Publishing…" : "Publish schedule"}
              </button>
              <small className="helper-copy">Publishing locks this schedule for all families.</small>
            </>
            ) : scheduleStatus === "published" ? (
              <div className="publish-notice">
                <CheckCircledIcon width="18" height="18" />
                <span><strong>Schedule published</strong><small>Families can see the final roster.</small></span>
              </div>
            ) : (
              <>
                <button className="primary-button" data-testid="generate-schedule-coord" disabled={generating} onClick={onGenerate}>
                  {generating ? "Generating…" : "Generate draft schedule"}
                </button>
                <small className="helper-copy">Creates a new draft version using {`greedy-v1`}.</small>
              </>
            )}
        </div>
      ) : null}

      <section className="coordinator-section">
        <div className="section-heading-row"><h2>Household responses</h2></div>
        <div className="household-status-list">
          {overview?.households.length ? overview.households.map((h) => (
            <div className="household-status-row" key={h.household.id}>
              <strong>{h.household.name}</strong>
              <span className={`status-chip status-chip--${h.status}`}>
                {h.status === "submitted" ? "Submitted" : h.status === "draft" ? "In progress" : "Not started"}
              </span>
            </div>
          )) : (
            <p className="helper-copy">No households yet.</p>
          )}
        </div>
      </section>

      <section className="coordinator-section">
        <div className="section-heading-row"><h2>Trip demand</h2><span>Riders · seats</span></div>
        <div className="coverage-table">
          {overview?.trips.length ? overview.trips.map((tripOverview) => {
            const tripDate = formatTripDate(tripOverview.trip.service_date);
            const direction = tripOverview.trip.direction === "morning" ? "AM" : "PM";
            const covered = tripOverview.seatCount >= tripOverview.riderCount && tripOverview.riderCount > 0;
            const noRiders = tripOverview.riderCount === 0;
            return (
              <div className="coverage-row" key={tripOverview.trip.id}>
                <strong>{tripDate.weekday} · {direction}</strong>
                <span>{tripOverview.riderCount} riders</span>
                <span>{tripOverview.seatCount} seats</span>
                <span className={noRiders ? "neutral" : covered ? "positive" : "negative"}>
                  {noRiders ? "No riders" : covered ? "Covered" : "Short"}
                </span>
              </div>
            );
          }) : (
            <p className="helper-copy">No trips yet.</p>
          )}
        </div>
      </section>
    </div>
  );
}

function AccountScreen({
  profile,
  setup,
  setupLoading,
  setupError,
  repository,
  householdId,
  groupId,
  onReloadHousehold,
  onBack,
  onSignOut,
  working,
}: {
  profile: Tables<"profiles">;
  setup: HouseholdSetup | null;
  setupLoading: boolean;
  setupError: string | null;
  repository: CarpoolRepository;
  householdId: string;
  groupId: string;
  onReloadHousehold: () => void;
  onBack: () => void;
  onSignOut: () => void;
  working: boolean;
}) {
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(profile.full_name);
  const [nameWorking, setNameWorking] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);

  const [newChildFirst, setNewChildFirst] = useState("");
  const [newChildLast, setNewChildLast] = useState("");
  const [childWorking, setChildWorking] = useState(false);
  const [childError, setChildError] = useState<string | null>(null);

  const [vehicleLabel, setVehicleLabel] = useState("");
  const [vehicleCapacity, setVehicleCapacity] = useState("4");
  const [vehicleNotes, setVehicleNotes] = useState("");
  const [vehicleWorking, setVehicleWorking] = useState(false);
  const [vehicleError, setVehicleError] = useState<string | null>(null);

  const activeVehicle = setup?.vehicles.find((vehicle) => vehicle.active) ?? null;

  useEffect(() => {
    if (activeVehicle) {
      setVehicleLabel(activeVehicle.label);
      setVehicleCapacity(String(activeVehicle.child_passenger_capacity));
      setVehicleNotes(activeVehicle.notes ?? "");
    }
  }, [activeVehicle]);

  const saveName = async () => {
    const normalized = nameDraft.trim().replace(/\s+/g, " ");
    if (normalized.split(" ").filter(Boolean).length < 2) {
      setNameError("Please enter the full name other parents should see.");
      return;
    }
    setNameWorking(true);
    setNameError(null);
    try {
      await repository.updateCurrentProfile(normalized);
      setEditingName(false);
      await onReloadHousehold();
    } catch (nextError) {
      setNameError(readableError(nextError));
    } finally {
      setNameWorking(false);
    }
  };

  const addChild = async () => {
    setChildWorking(true);
    setChildError(null);
    try {
      await repository.addChild(householdId, groupId, newChildFirst, newChildLast);
      setNewChildFirst("");
      setNewChildLast("");
      await onReloadHousehold();
    } catch (nextError) {
      setChildError(readableError(nextError));
    } finally {
      setChildWorking(false);
    }
  };

  const removeChild = async (childId: string) => {
    setChildWorking(true);
    setChildError(null);
    try {
      await repository.deactivateChild(childId);
      await onReloadHousehold();
    } catch (nextError) {
      setChildError(readableError(nextError));
    } finally {
      setChildWorking(false);
    }
  };

  const saveVehicle = async () => {
    const capacity = Number(vehicleCapacity);
    if (!Number.isFinite(capacity)) {
      setVehicleError("Enter a number of passenger seats.");
      return;
    }
    setVehicleWorking(true);
    setVehicleError(null);
    try {
      await repository.upsertVehicle(householdId, groupId, {
        label: vehicleLabel,
        childPassengerCapacity: capacity,
        notes: vehicleNotes || undefined,
      });
      await onReloadHousehold();
    } catch (nextError) {
      setVehicleError(readableError(nextError));
    } finally {
      setVehicleWorking(false);
    }
  };

  return (
    <div className="screen-content detail-screen account-screen" data-testid="account-screen">
      <header className="subpage-header">
        <button onClick={onBack} aria-label="Back to home"><Cross2Icon /></button>
        <div><span className="eyebrow">Your account</span><h1>Household profile</h1></div>
      </header>
      <section className="account-card">
        <span className="account-avatar">
          {profile.avatar_url ? <img src={profile.avatar_url} alt="" /> : <PersonIcon />}
        </span>
        <div><strong>{profile.full_name}</strong><small>{profile.email}</small></div>
      </section>

      <section className="household-section" aria-labelledby="name-section-heading">
        <div className="section-heading-row">
          <h2 id="name-section-heading">Your name</h2>
          {!editingName ? <button className="inline-action" onClick={() => { setNameDraft(profile.full_name); setEditingName(true); }}>Edit</button> : null}
        </div>
        {editingName ? (
          <div className="household-form">
            <label className="auth-field">
              <span>Full name</span>
              <KeyboardInput
                value={nameDraft}
                onChange={(event) => setNameDraft(event.target.value)}
                autoComplete="name"
                placeholder="First and last name"
              />
            </label>
            {nameError ? <div className="auth-error" role="alert">{nameError}</div> : null}
            <button className="primary-button" disabled={nameWorking} onClick={() => void saveName()}>
              {nameWorking ? "Saving…" : "Save name"}
            </button>
            <button className="text-button" disabled={nameWorking} onClick={() => { setEditingName(false); setNameError(null); }}>Cancel</button>
          </div>
        ) : (
          <p className="household-static">{profile.full_name}</p>
        )}
      </section>

      <section className="household-section" aria-labelledby="children-section-heading">
        <div className="section-heading-row">
          <h2 id="children-section-heading">Children</h2>
        </div>
        {setupLoading && !setup ? <p className="household-static">Loading…</p> : null}
        {setupError ? <div className="auth-error" role="alert">{setupError}</div> : null}
        <ul className="household-list" data-testid="child-list">
          {setup?.children.length ? setup.children.map((child) => (
            <li key={child.id} className="household-list-row">
              <span><strong>{child.first_name} {child.last_name}</strong></span>
              <button
                className="text-button household-remove"
                disabled={childWorking}
                onClick={() => void removeChild(child.id)}
                aria-label={`Remove ${child.first_name} ${child.last_name}`}
              >
                Remove
              </button>
            </li>
          )) : (
            <li className="household-empty">No children added yet. Add your first child below.</li>
          )}
        </ul>
        <div className="household-form" data-testid="add-child-form">
          <div className="household-name-row">
            <label className="auth-field">
              <span>First name</span>
              <KeyboardInput
                value={newChildFirst}
                onChange={(event) => setNewChildFirst(event.target.value)}
                placeholder="First name"
                autoComplete="off"
              />
            </label>
            <label className="auth-field">
              <span>Last name</span>
              <KeyboardInput
                value={newChildLast}
                onChange={(event) => setNewChildLast(event.target.value)}
                placeholder="Last name"
                autoComplete="off"
              />
            </label>
          </div>
          {childError ? <div className="auth-error" role="alert">{childError}</div> : null}
          <button className="primary-button" disabled={childWorking} onClick={() => void addChild()}>
            {childWorking ? "Saving…" : "Add child"}
          </button>
        </div>
      </section>

      <section className="household-section" aria-labelledby="vehicle-section-heading">
        <div className="section-heading-row">
          <h2 id="vehicle-section-heading">Vehicle</h2>
        </div>
        <div className="household-form" data-testid="vehicle-form">
          <label className="auth-field">
            <span>Vehicle label</span>
            <KeyboardInput
              value={vehicleLabel}
              onChange={(event) => setVehicleLabel(event.target.value)}
              placeholder="For example, Blue Subaru"
              autoComplete="off"
            />
          </label>
          <label className="auth-field">
            <span>Passenger seats</span>
            <KeyboardInput
              value={vehicleCapacity}
              onChange={(event) => setVehicleCapacity(event.target.value.replace(/[^0-9]/g, ""))}
              inputMode="numeric"
              placeholder="1 to 12"
              autoComplete="off"
            />
            <small>Total child-passenger capacity. Includes your own children when riding.</small>
          </label>
          <label className="auth-field">
            <span>Notes (optional)</span>
            <KeyboardInput
              value={vehicleNotes}
              onChange={(event) => setVehicleNotes(event.target.value)}
              placeholder="Anything drivers need to know"
              autoComplete="off"
            />
          </label>
          {vehicleError ? <div className="auth-error" role="alert">{vehicleError}</div> : null}
          <button className="primary-button" disabled={vehicleWorking} onClick={() => void saveVehicle()}>
            {vehicleWorking ? "Saving…" : activeVehicle ? "Update vehicle" : "Add vehicle"}
          </button>
        </div>
      </section>

      <section className="account-info">
        <span>Signed in with Google</span>
        <p>Your parent profile is separate from every other adult in your household, so driving availability and confirmations stay clear.</p>
      </section>
      <button className="secondary-button sign-out-button" disabled={working} onClick={onSignOut}>
        {working ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}

export default function Prototype() {
  const supabase = useMemo(() => getSupabaseClient(), []);
  const repository = useMemo(() => new CarpoolRepository(supabase), [supabase]);
  const [session, setSession] = useState<Session | null>(null);
  const [authInitialized, setAuthInitialized] = useState(false);
  const [identity, setIdentity] = useState<IdentityState | null>(null);
  const [identityLoading, setIdentityLoading] = useState(false);
  const [householdSetup, setHouseholdSetup] = useState<HouseholdSetup | null>(null);
  const [householdLoading, setHouseholdLoading] = useState(false);
  const [householdError, setHouseholdError] = useState<string | null>(null);
  const [weekData, setWeekData] = useState<WeekWithTrips | null>(null);
  const [weekLoading, setWeekLoading] = useState(false);
  const [weekError, setWeekError] = useState<string | null>(null);
  const [checkin, setCheckin] = useState<Tables<"weekly_checkins"> | null>(null);
  const [checkinDetails, setCheckinDetails] = useState<CheckinDetails | null>(null);
  const [checkinLoading, setCheckinLoading] = useState(false);
  const [overview, setOverview] = useState<WeekOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<ScheduleVersionWithRosters | null>(null);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [myAssignments, setMyAssignments] = useState<MyDriverAssignment[]>([]);
  const [assignmentsLoading, setAssignmentsLoading] = useState(false);
  const [assignmentsError, setAssignmentsError] = useState<string | null>(null);
  const [confirmWorking, setConfirmWorking] = useState(false);
  const [creatingWeek, setCreatingWeek] = useState(false);
  const [createWeekError, setCreateWeekError] = useState<string | null>(null);
  const [authWorking, setAuthWorking] = useState(false);
  const [authError, setAuthError] = useState<string | null>(() => oauthErrorFromLocation());
  const [activeTab, setActiveTab] = useState<AppTab>("home");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);

  const loadIdentity = useCallback(async () => {
    setIdentityLoading(true);
    setAuthError(null);
    try {
      const [profile, groups] = await Promise.all([
        repository.getCurrentProfile(),
        repository.listAvailableGroups(),
      ]);
      const group = groups[0];
      if (!profile) throw new Error("Your parent profile is still being prepared. Try again.");
      if (!group) throw new Error("The Midtown carpool group has not been configured.");
      const membership = await repository.getCurrentMembership(group.id);
      setIdentity({ profile, group, membership });
    } catch (error) {
      setIdentity(null);
      setAuthError(readableError(error));
    } finally {
      setIdentityLoading(false);
    }
  }, [repository]);

  const loadHousehold = useCallback(async () => {
    if (!identity?.membership) return;
    setHouseholdLoading(true);
    setHouseholdError(null);
    try {
      const setup = await repository.getHouseholdSetup(identity.membership.household_id);
      setHouseholdSetup(setup);
    } catch (error) {
      setHouseholdError(readableError(error));
    } finally {
      setHouseholdLoading(false);
    }
  }, [identity?.membership, repository]);

  useEffect(() => {
    if (identity?.membership) void loadHousehold();
  }, [identity?.membership, loadHousehold]);

  const loadWeek = useCallback(async () => {
    if (!identity?.group) return;
    setWeekLoading(true);
    setWeekError(null);
    try {
      const data = await repository.getLatestWeek(identity.group.id);
      setWeekData(data);
    } catch (error) {
      setWeekError(readableError(error));
    } finally {
      setWeekLoading(false);
    }
  }, [identity?.group, repository]);

  const loadCheckin = useCallback(async () => {
    if (!identity?.membership || !weekData) return;
    setCheckinLoading(true);
    try {
      const checkinRow = await repository.getOrCreateCheckin(
        weekData.week.id, identity.membership.household_id, identity.group.id,
      );
      setCheckin(checkinRow);
      const details = await repository.getCheckinDetails(checkinRow.id);
      setCheckinDetails(details);
    } catch (error) {
      setCheckin(null);
      setCheckinDetails(null);
    } finally {
      setCheckinLoading(false);
    }
  }, [identity?.membership, identity?.group, weekData, repository]);

  const loadOverview = useCallback(async () => {
    if (!identity?.group || !weekData) return;
    setOverviewLoading(true);
    setOverviewError(null);
    try {
      const data = await repository.getWeekOverview(weekData.week.id, identity.group.id);
      setOverview(data);
    } catch (error) {
      setOverview(null);
      setOverviewError(readableError(error));
    } finally {
      setOverviewLoading(false);
    }
  }, [identity?.group, weekData, repository]);

  useEffect(() => {
    if (identity?.membership) void loadWeek();
  }, [identity?.membership, loadWeek]);

  useEffect(() => {
    if (weekData) void loadCheckin();
  }, [weekData, loadCheckin]);

  useEffect(() => {
    if (activeTab === "coordinate" && weekData) void loadOverview();
  }, [activeTab, weekData, loadOverview]);

  const loadSchedule = useCallback(async () => {
    if (!identity?.group || !weekData) return;
    setScheduleLoading(true);
    setScheduleError(null);
    try {
      const roster = await repository.getGroupRoster(identity.group.id);
      const version = await repository.getLatestScheduleVersion(
        weekData.week.id, identity.group.id, weekData.trips,
        roster.children, roster.vehicles, roster.profiles,
      );
      setSchedule(version);
    } catch (error) {
      setSchedule(null);
      setScheduleError(readableError(error));
    } finally {
      setScheduleLoading(false);
    }
  }, [identity?.group, weekData, repository]);

  useEffect(() => {
    if (weekData) void loadSchedule();
  }, [weekData, loadSchedule]);

  const generateSchedule = useCallback(async () => {
    if (!weekData) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      const result = await repository.generateDraftSchedule(weekData.week.id);
      if (!result.success) {
        setGenerateError(result.error ?? "Failed to generate schedule.");
      } else {
        await loadSchedule();
        await loadOverview();
      }
    } catch (error) {
      setGenerateError(readableError(error));
    } finally {
      setGenerating(false);
    }
  }, [weekData, repository, loadSchedule, loadOverview]);

  const loadMyAssignments = useCallback(async () => {
    if (!identity?.group || !schedule) return;
    setAssignmentsLoading(true);
    setAssignmentsError(null);
    try {
      const roster = await repository.getGroupRoster(identity.group.id);
      const assignments = await repository.getMyDriverAssignments(
        schedule.version.id,
        identity.profile.id,
        identity.group.id,
        schedule.trips,
        roster.children,
        roster.vehicles,
      );
      setMyAssignments(assignments);
    } catch (error) {
      setMyAssignments([]);
      setAssignmentsError(readableError(error));
    } finally {
      setAssignmentsLoading(false);
    }
  }, [identity?.group, identity?.profile, schedule, repository]);

  useEffect(() => {
    if (schedule) void loadMyAssignments();
  }, [schedule, loadMyAssignments]);

  const confirmAll = useCallback(async () => {
    const tentative = myAssignments.filter((a) => a.assignment.status === "tentative");
    if (tentative.length === 0) return;
    setConfirmWorking(true);
    try {
      for (const entry of tentative) {
        await repository.respondToDriverAssignment(entry.assignment.id, "confirmed");
      }
      await loadMyAssignments();
    } catch (error) {
      setGenerateError(readableError(error));
    } finally {
      setConfirmWorking(false);
    }
  }, [myAssignments, repository, loadMyAssignments]);

  const publishSchedule = useCallback(async () => {
    if (!schedule) return;
    setPublishing(true);
    try {
      await repository.publishSchedule(schedule.version.id);
      await loadSchedule();
    } catch (error) {
      setGenerateError(readableError(error));
    } finally {
      setPublishing(false);
    }
  }, [schedule, repository, loadSchedule]);

  const createWeek = useCallback(async () => {
    if (!identity?.group) return;
    setCreatingWeek(true);
    setCreateWeekError(null);
    try {
      await repository.createWeekWithTrips(
        identity.group.id, nextMonday(),
        identity.group.meeting_point, identity.group.school_name,
      );
      await loadWeek();
    } catch (error) {
      setCreateWeekError(readableError(error));
    } finally {
      setCreatingWeek(false);
    }
  }, [identity?.group, repository, loadWeek]);

  useEffect(() => {
    let mounted = true;

    void supabase.auth.getSession().then(({ data, error }) => {
      if (!mounted) return;
      if (error) setAuthError(readableError(error));
      setSession(data.session);
      setAuthInitialized(true);
      if (data.session) void loadIdentity();
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!mounted) return;
      setSession(nextSession);
      setAuthInitialized(true);
      if (nextSession) {
        window.setTimeout(() => {
          if (mounted) void loadIdentity();
        }, 0);
      } else {
        setIdentity(null);
      }
    });

    if (window.location.search.includes("error=") || window.location.hash.includes("error=")) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, [loadIdentity, supabase]);

  const signIn = async () => {
    setAuthWorking(true);
    setAuthError(null);
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: window.location.origin },
      });
      if (error) throw error;
    } catch (error) {
      setAuthError(readableError(error));
      setAuthWorking(false);
    }
  };

  const signOut = async () => {
    setAuthWorking(true);
    setAuthError(null);
    const { error } = await supabase.auth.signOut();
    if (error) {
      setAuthError(readableError(error));
    } else {
      setAccountOpen(false);
      setReviewOpen(false);
      setActiveTab("home");
    }
    setAuthWorking(false);
  };

  const navItems = useMemo(() => [
    { id: "home" as const, label: "Home", icon: HomeIcon },
    { id: "plan" as const, label: "Plan", icon: BackpackIcon },
    { id: "week" as const, label: "Week", icon: CalendarIcon },
    { id: "coordinate" as const, label: "Cover", icon: GroupIcon },
  ], []);

  const navigate = (tab: AppTab) => {
    setReviewOpen(false);
    setAccountOpen(false);
    setActiveTab(tab);
  };

  const renderContent = () => {
    if (!identity) return null;
    if (accountOpen && identity) {
      return (
        <AccountScreen
          profile={identity.profile}
          setup={householdSetup}
          setupLoading={householdLoading}
          setupError={householdError}
          repository={repository}
          householdId={identity.membership?.household_id ?? ""}
          groupId={identity.group.id}
          onReloadHousehold={() => void loadHousehold()}
          onBack={() => setAccountOpen(false)}
          onSignOut={() => void signOut()}
          working={authWorking}
        />
      );
    }

    if (reviewOpen) {
      return (
        <ReviewScreen
          myAssignments={myAssignments}
          repository={repository}
          onResponded={() => void loadMyAssignments()}
          onBack={() => setReviewOpen(false)}
        />
      );
    }

    if (activeTab === "plan") {
      return (
        <PlanScreen
          week={weekData}
          weekLoading={weekLoading}
          weekError={weekError}
          checkin={checkin}
          checkinDetails={checkinDetails}
          checkinLoading={checkinLoading}
          setup={householdSetup}
          repository={repository}
          driverProfileId={identity.profile.id}
          groupId={identity.group.id}
          onReloadCheckin={() => void loadCheckin()}
          onReloadWeek={() => void loadWeek()}
          isCoordinator={identity.membership?.role === "coordinator"}
          onCreateWeek={() => void createWeek()}
        />
      );
    }

    if (activeTab === "week") {
      return (
        <WeekScreen
          week={weekData}
          weekLoading={weekLoading}
          weekError={weekError}
          schedule={schedule}
          scheduleLoading={scheduleLoading}
          scheduleError={scheduleError}
          isCoordinator={identity.membership?.role === "coordinator"}
          onGenerate={() => void generateSchedule()}
          generating={generating}
          generateError={generateError}
          onReloadWeek={() => void loadWeek()}
          onReloadSchedule={() => void loadSchedule()}
        />
      );
    }

    if (activeTab === "coordinate") {
      return (
        <CoordinatorScreen
          week={weekData}
          weekLoading={weekLoading}
          weekError={weekError}
          overview={overview}
          overviewLoading={overviewLoading}
          overviewError={overviewError}
          isCoordinator={identity.membership?.role === "coordinator"}
          onCreateWeek={() => void createWeek()}
          creatingWeek={creatingWeek}
          createWeekError={createWeekError}
          onGenerate={() => void generateSchedule()}
          generating={generating}
          generateError={generateError}
          scheduleStatus={schedule?.version.status === "published" ? "published" : schedule?.version.status === "draft" ? "draft" : null}
          onPublish={() => void publishSchedule()}
          publishing={publishing}
          onReloadWeek={() => void loadWeek()}
          onReloadOverview={() => void loadOverview()}
        />
      );
    }

    return (
      <HomeScreen
        myAssignments={myAssignments}
        assignmentsLoading={assignmentsLoading}
        assignmentsError={assignmentsError}
        schedulePublished={schedule?.version.status === "published"}
        onConfirmAll={() => void confirmAll()}
        onReview={() => setReviewOpen(true)}
        onCoverage={() => navigate("week")}
        onAccount={() => setAccountOpen(true)}
        onRetryAssignments={() => void loadMyAssignments()}
        working={confirmWorking}
      />
    );
  };

  if (!authInitialized || (session && identityLoading && !identity)) {
    return (
      <div className="prototype-shell">
        <MobileScroll className="app-screen">
          <main className="app-main" aria-label="Midtown Carpool app">
            <AuthLoadingScreen />
          </main>
        </MobileScroll>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="prototype-shell">
        <MobileScroll className="app-screen">
          <main className="app-main" aria-label="Midtown Carpool sign in">
            <SignInScreen error={authError} working={authWorking} onSignIn={() => void signIn()} />
          </main>
        </MobileScroll>
      </div>
    );
  }

  if (authError && !identity) {
    return (
      <div className="prototype-shell">
        <MobileScroll className="app-screen">
          <main className="app-main" aria-label="Midtown Carpool connection error">
            <div className="auth-screen auth-recovery-screen">
              <span className="auth-mark"><ExclamationTriangleIcon width="24" height="24" /></span>
              <h1>We couldn’t finish signing you in.</h1>
              <div className="auth-error" role="alert">{authError}</div>
              <button className="primary-button" onClick={() => void loadIdentity()}>Try again</button>
              <button className="text-button" onClick={() => void signOut()}>Sign out</button>
            </div>
          </main>
        </MobileScroll>
      </div>
    );
  }

  if (identity && !identity.membership) {
    return (
      <div className="prototype-shell">
        <MobileScroll className="app-screen">
          <main className="app-main" aria-label="Midtown Carpool onboarding">
            <OnboardingScreen
              identity={identity}
              repository={repository}
              onComplete={loadIdentity}
              onSignOut={() => void signOut()}
            />
          </main>
        </MobileScroll>
      </div>
    );
  }

  if (!identity) {
    return (
      <div className="prototype-shell">
        <MobileScroll className="app-screen">
          <main className="app-main" aria-label="Midtown Carpool app">
            <AuthLoadingScreen />
          </main>
        </MobileScroll>
      </div>
    );
  }

  return (
    <div className="prototype-shell">
      <AppErrorBoundary>
        <MobileScroll className="app-screen">
          <main className="app-main" aria-label="Midtown Carpool app">
            {renderContent()}
          </main>
        </MobileScroll>
      </AppErrorBoundary>
      {!reviewOpen && !accountOpen ? (
        <nav className="bottom-nav" aria-label="Primary navigation">
          {navItems.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={activeTab === id ? "nav-button nav-button--active" : "nav-button"}
              aria-current={activeTab === id ? "page" : undefined}
              onClick={() => navigate(id)}
              data-testid={`nav-${id}`}
            >
              <Icon width="20" height="20" />
              <span>{label}</span>
              {id === "home" && myAssignments.some((a) => a.assignment.status === "tentative") ? <i aria-label="Action needed" /> : null}
            </button>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
