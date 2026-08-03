import { Component, useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  AvatarIcon,
  BackpackIcon,
  BellIcon,
  CalendarIcon,
  CheckCircledIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  Cross2Icon,
  DashboardIcon,
  ExclamationTriangleIcon,
  GroupIcon,
  HomeIcon,
  MoonIcon,
  PersonIcon,
  QuestionMarkCircledIcon,
  ReloadIcon,
  Share2Icon,
  SunIcon,
} from "@radix-ui/react-icons";
import { KeyboardInput, MobileScroll, BottomSheet } from "./mobile";
import {
  buildGoogleCalendarUrl,
  buildIcsCalendar,
  buildOutlookUrl,
  downloadIcs,
} from "./lib/calendar";
import {
  CarpoolRepository,
  getSupabaseClient,
  type CheckinDetails,
  type DeclinedDriveAlert,
  type HouseholdSetup,
  type MyDriverAssignment,
  type ScheduleRosterEntry,
  type ScheduleVersionWithRosters,
  type Tables,
  type UncoveredChildAlert,
  type WeekOverview,
  type WeekWithTrips,
} from "./lib/supabase";
import type { AssignmentStatus, DefaultDrivePref, DefaultRideNeed, DrivePreference } from "./lib/supabase/database.types";

type AppTab = "home" | "plan" | "week" | "coordinate";

// Staging detection: the Supabase URL is baked at build time. On staging
// builds it contains the staging project ref; on production it doesn't.
const isStaging = (import.meta.env.VITE_SUPABASE_URL ?? "").includes("jfyjgmhqnlbdcafoarrg");

const DEMO_ACCOUNTS = [
  { name: "Chen", email: "chen@seed.kidpool", password: "SeedPass123!" },
  { name: "Garcia", email: "garcia@seed.kidpool", password: "SeedPass123!" },
  { name: "Johnson", email: "johnson@seed.kidpool", password: "SeedPass123!" },
  { name: "Patel", email: "patel@seed.kidpool", password: "SeedPass123!" },
  { name: "Williams", email: "williams@seed.kidpool", password: "SeedPass123!" },
  { name: "OBrien", email: "obrien@seed.kidpool", password: "SeedPass123!" },
  { name: "Anderson", email: "anderson@seed.kidpool", password: "SeedPass123!" },
  { name: "Thompson", email: "thompson@seed.kidpool", password: "SeedPass123!" },
  { name: "Martinez", email: "martinez@seed.kidpool", password: "SeedPass123!" },
  { name: "Lee", email: "lee@seed.kidpool", password: "SeedPass123!" },
];

function CarIcon({ width = 18, height = 18 }: { width?: number | string; height?: number | string }) {
  return (
    <svg width={width} height={height} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 17h14M3 17l1.5-6.5a2 2 0 0 1 2-1.5h11a2 2 0 0 1 2 1.5L21 17M7 17v2M17 17v2M5 13h14" />
      <circle cx="7.5" cy="17" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="16.5" cy="17" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

function AppHeader({ avatarUrl, onAccount }: { avatarUrl: string | null; onAccount: () => void }) {
  return (
    <header className="app-header">
      <div className="brand-lockup">
        <span className="brand-mark"><CarIcon width="18" height="18" /></span>
        <span>
          <strong>Carpool Crew</strong>
          <small>Presidio Middle School</small>
        </span>
      </div>
      <button className="avatar-button" aria-label="Open household profile" onClick={onAccount}>
        {avatarUrl ? <img src={avatarUrl} alt="" /> : <AvatarIcon width="19" height="19" />}
      </button>
    </header>
  );
}

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
      <strong>Opening Carpool Crew…</strong>
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
<span className="auth-mark"><CarIcon width="22" height="22" /></span>
        <span>
          <strong>Carpool Crew</strong>
          <small>Clarendon families · Presidio Middle School</small>
        </span>
      </div>

      <div className="sign-in-copy">
        <span className="eyebrow">A simpler school week</span>
        <h1>Know who's driving—and who's riding.</h1>
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
        Use the Google account you want associated with your family's driving schedule.
      </small>

      {isStaging ? (
        <div className="demo-accounts-panel" data-testid="demo-accounts">
          <p className="demo-accounts-label">Demo accounts (staging only)</p>
          <div className="demo-accounts-grid">
            {DEMO_ACCOUNTS.map((acct) => (
              <a
                key={acct.email}
                className="demo-account-chip"
                href={`/?testAuth=${acct.email}|${acct.password}`}
              >
                {acct.name}
              </a>
            ))}
          </div>
        </div>
      ) : null}
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
  const [phone, setPhone] = useState(identity.profile.phone ?? "");
  const [mode, setMode] = useState<"choose" | "create" | "join">("choose");
  const [householdName, setHouseholdName] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [createdCode, setCreatedCode] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existingNames, setExistingNames] = useState<string[]>([]);
  const [nameWarning, setNameWarning] = useState<string | null>(null);

  const [step, setStep] = useState<"household" | "children" | "vehicle" | "standard_week">("household");

  const [householdId, setHouseholdId] = useState<string | null>(null);
  const [onboardingChildren, setOnboardingChildren] = useState<Tables<"children">[]>([]);
  const [childFirst, setChildFirst] = useState("");
  const [childLast, setChildLast] = useState("");
  const [childWorking, setChildWorking] = useState(false);
  const [childError, setChildError] = useState<string | null>(null);

  const [vehicleLabel, setVehicleLabel] = useState("");
  const [vehicleCapacity, setVehicleCapacity] = useState("4");
  const [vehicleNotes, setVehicleNotes] = useState("");
  const [vehicleId, setVehicleId] = useState<string | null>(null);
  const [vehicleWorking, setVehicleWorking] = useState(false);
  const [vehicleError, setVehicleError] = useState<string | null>(null);

  const [driveDefaults, setDriveDefaults] = useState<DefaultDrivePref[]>(emptyDriveDefaults());
  const [rideNeeds, setRideNeeds] = useState<DefaultRideNeed[]>([]);
  const [standardWeekSaving, setStandardWeekSaving] = useState(false);
  const [standardWeekError, setStandardWeekError] = useState<string | null>(null);

  const saveProfile = async () => {
    const normalizedName = fullName.trim().replace(/\s+/g, " ");
    if (normalizedName.split(" ").filter(Boolean).length < 2) {
      throw new Error("Please enter the full name other parents should see.");
    }
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 7) {
      throw new Error("Enter a phone number so other parents can reach you.");
    }
    await repository.updateCurrentProfile({ fullName: normalizedName, phone });
  };

  const createHousehold = async () => {
    setWorking(true);
    setError(null);
    try {
      await saveProfile();
      if (!householdName.trim()) throw new Error("Enter a household name.");
      const created = await repository.createHousehold(identity.group.id, householdName);
      setHouseholdId(created.household_id);
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
      const joinedHouseholdId = await repository.joinHousehold(identity.group.id, joinCode) as unknown as string;
      setHouseholdId(joinedHouseholdId);

      const setup = await repository.getHouseholdSetup(joinedHouseholdId);
      if (setup?.children.length) setOnboardingChildren(setup.children);

      if (setup?.vehicles.length) {
        const v = setup.vehicles[0];
        setVehicleId(v.id);
        setVehicleLabel(v.label);
        setVehicleCapacity(String(v.child_passenger_capacity));
        setVehicleNotes(v.notes ?? "");
      }

      const existingNeeds = await repository.getDefaultRideNeeds(joinedHouseholdId);
      if (existingNeeds.length) setRideNeeds(existingNeeds);

      setStep("children");
    } catch (nextError) {
      setError(readableError(nextError));
    } finally {
      setWorking(false);
    }
  };

  const checkNameMatch = (typed: string) => {
    if (!typed.trim() || existingNames.length === 0) {
      setNameWarning(null);
      return;
    }
    const typedLower = typed.trim().toLowerCase();
    for (const existing of existingNames) {
      const existingLower = existing.trim().toLowerCase();
      const firstWordTyped = typedLower.split(/\s+/)[0];
      const firstWordExisting = existingLower.split(/\s+/)[0];
      if (
        firstWordTyped === firstWordExisting ||
        typedLower.includes(existingLower) ||
        existingLower.includes(typedLower)
      ) {
        setNameWarning(
          `A household called "${existing}" already exists. If that's yours, ask them for your join code instead.`,
        );
        return;
      }
    }
    setNameWarning(null);
  };

  const onHouseholdNameChange = (value: string) => {
    setHouseholdName(value);
    checkNameMatch(value);
  };

  const addChildInOnboarding = async () => {
    if (!householdId) return;
    setChildWorking(true);
    setChildError(null);
    try {
      const child = await repository.addChild(householdId, identity.group.id, childFirst, childLast);
      setOnboardingChildren((prev) => [...prev, child]);
      setChildFirst("");
      setChildLast("");
    } catch (nextError) {
      setChildError(readableError(nextError));
    } finally {
      setChildWorking(false);
    }
  };

  const addVehicleInOnboarding = async () => {
    if (!householdId) return;
    const capacity = Number(vehicleCapacity);
    if (!vehicleLabel.trim()) {
      setVehicleError("Enter a vehicle label.");
      return;
    }
    if (!Number.isFinite(capacity) || capacity < 1 || capacity > 12) {
      setVehicleError("Passenger seats must be between 1 and 12.");
      return;
    }
    setVehicleWorking(true);
    setVehicleError(null);
    try {
      const vehicle = await repository.upsertVehicle(householdId, identity.group.id, {
        label: vehicleLabel,
        childPassengerCapacity: capacity,
        notes: vehicleNotes || undefined,
      });
      setVehicleId(vehicle.id);
    } catch (nextError) {
      setVehicleError(readableError(nextError));
    } finally {
      setVehicleWorking(false);
    }
  };

  const saveStandardWeek = async () => {
    if (!householdId) return;
    setStandardWeekSaving(true);
    setStandardWeekError(null);
    try {
      // Only save household ride needs if they don't already exist
      // (prevents a joining co-parent from overwriting the creator's defaults)
      if (onboardingChildren.length > 0) {
        const existing = await repository.getDefaultRideNeeds(householdId);
        if (existing.length === 0) {
          await repository.saveDefaultRideNeeds(householdId, rideNeeds);
        }
      }
      await repository.saveDefaultDrivePreferences(driveDefaults);
      await onComplete();
    } catch (nextError) {
      setStandardWeekError(readableError(nextError));
    } finally {
      setStandardWeekSaving(false);
    }
  };

  if (createdCode && step === "household") {
    return (
      <div className="screen-content onboarding-screen onboarding-success" data-testid="household-created">
        <span className="success-orb"><CheckCircledIcon width="30" height="30" /></span>
        <span className="eyebrow">Household created</span>
        <h1>Your family is connected.</h1>
        <p>Share this code with another parent in your household. They'll sign in with their own Google account, then enter it once.</p>
        <div className="join-code-card">
          <small>Household join code</small>
          <strong>{createdCode}</strong>
        </div>
        <p className="onboarding-note">You can find this code again from your household profile.</p>
        <button className="primary-button" onClick={() => setStep("children")}>
          Continue <ChevronRightIcon />
        </button>
        <button className="onboarding-signout" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    );
  }

  if (step === "children") {
    return (
      <div className="screen-content onboarding-screen" data-testid="onboarding-children">
        <header className="page-title">
          <span className="eyebrow">Children</span>
          <h1>Who needs rides?</h1>
          <p>Add the children in your household who'll be carpooling.</p>
        </header>

        {onboardingChildren.length > 0 ? (
          <ul className="household-list">
            {onboardingChildren.map((child) => (
              <li key={child.id} className="household-list-row">
                <span><strong>{child.first_name} {child.last_name}</strong></span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="helper-copy">No children added yet.</p>
        )}

        <div className="household-form" data-testid="add-child-form">
          <div className="household-name-row">
            <label className="auth-field">
              <span>First name</span>
              <KeyboardInput
                value={childFirst}
                onChange={(event) => setChildFirst(event.target.value)}
                placeholder="First name"
                autoComplete="off"
              />
            </label>
            <label className="auth-field">
              <span>Last name</span>
              <KeyboardInput
                value={childLast}
                onChange={(event) => setChildLast(event.target.value)}
                placeholder="Last name"
                autoComplete="off"
              />
            </label>
          </div>
          {childError ? <div className="auth-error" role="alert">{childError}</div> : null}
          <button
            className="primary-button"
            disabled={childWorking || (!childFirst.trim() && !childLast.trim())}
            onClick={() => void addChildInOnboarding()}
          >
            {childWorking ? "Adding…" : "Add child"}
          </button>
        </div>

        <button
          className="primary-button"
          onClick={() => setStep("vehicle")}
        >
          {onboardingChildren.length > 0 ? "Continue" : "Skip — no children yet"} <ChevronRightIcon />
        </button>
        <button className="onboarding-signout" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    );
  }

  if (step === "vehicle") {
    return (
      <div className="screen-content onboarding-screen" data-testid="onboarding-vehicle">
        <header className="page-title">
          <span className="eyebrow">Vehicle</span>
          <h1>Can you drive?</h1>
          <p>Add a vehicle if you plan to drive. You can skip this and add one later.</p>
        </header>

        {vehicleId ? (
          <div className="success-banner">
            <CheckCircledIcon width="24" height="24" />
            <span>
              <strong>{vehicleLabel}</strong>
              <small>{vehicleCapacity} passenger seats</small>
            </span>
          </div>
        ) : (
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
            <button
              className="primary-button"
              disabled={vehicleWorking}
              onClick={() => void addVehicleInOnboarding()}
            >
              {vehicleWorking ? "Adding…" : "Add vehicle"}
            </button>
          </div>
        )}

        <button
          className="primary-button"
          onClick={() => setStep("standard_week")}
        >
          {vehicleId ? "Continue" : "Skip — no vehicle yet"} <ChevronRightIcon />
        </button>
        <button className="onboarding-signout" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    );
  }

  if (step === "standard_week") {
    const hasVehicle = vehicleId !== null;
    return (
      <div className="screen-content onboarding-screen" data-testid="standard-week-step">
        <header className="page-title">
          <span className="eyebrow">Standard week</span>
          <h1>Your typical week</h1>
          <p>Set your family's defaults for a normal school week. New weeks start with these — you can still adjust any week before submitting.</p>
        </header>
        <p className="standard-week-intro">Morning pickup is 8:40 AM from Midtown Terrace. Afternoon pickup is 5:15 PM from Presidio.</p>

        {onboardingChildren.length > 0 ? (
          <div className="standard-week-subsection">
            <h3 className="standard-week-label">Rides for</h3>
            <p className="standard-week-caption">Which days does your child need a ride? Tap to toggle each trip.</p>
            <RideNeedsGrid
              children={onboardingChildren}
              needs={rideNeeds}
              onChange={setRideNeeds}
              disabled={standardWeekSaving}
            />
          </div>
        ) : null}

        <div className="standard-week-subsection">
          <h3 className="standard-week-label">Your driving</h3>
          <p className="standard-week-caption">Tell us when you're available to drive.</p>
          <DrivePreferenceGrid
            preferences={driveDefaults}
            onChange={setDriveDefaults}
            hasVehicle={hasVehicle}
            disabled={standardWeekSaving}
          />
          {!hasVehicle ? (
            <p className="helper-copy">Add a vehicle in your account to unlock driving.</p>
          ) : null}
        </div>

        {standardWeekError ? <div className="auth-error" role="alert">{standardWeekError}</div> : null}

        <button
          className="primary-button"
          disabled={standardWeekSaving}
          onClick={() => void saveStandardWeek()}
        >
          {standardWeekSaving ? "Saving…" : "Save and continue"}
        </button>
        <button
          className="text-button"
          disabled={standardWeekSaving}
          onClick={() => void onComplete()}
        >
          Skip for now
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
        <h1>Let's connect your family.</h1>
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

      <label className="auth-field">
        <span>Your phone number</span>
        <KeyboardInput
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          autoComplete="tel"
          inputMode="tel"
          placeholder="(415) 555-0100"
        />
        <small>Shared with other parents in the carpool directory.</small>
      </label>

      {mode === "choose" ? (
        <div className="onboarding-choice">
          <p>Are you setting up your household, or joining one another parent already created?</p>
          <button className="choice-card" onClick={async () => {
            try {
              const names = await repository.listGroupHouseholdNames(identity.group.id);
              setExistingNames(names);
            } catch { /* silent — worst case, no warning shows */ }
            setMode("create");
          }}>
            <span><HomeIcon /></span>
            <span><strong>Create my household</strong><small>I'm the first parent from my family</small></span>
            <ChevronRightIcon />
          </button>
          <button className="choice-card" onClick={() => setMode("join")}>
            <span><GroupIcon /></span>
            <span><strong>Join my household</strong><small>I received a code from another parent</small></span>
            <ChevronRightIcon />
          </button>
          <p>Not sure which to choose? If your spouse already signed up, ask them for your household code. If you're the first in your family, create a new household and share the code with them.</p>
        </div>
      ) : null}

      {mode === "create" ? (
        <div className="onboarding-action">
          <button className="back-link" onClick={() => { setMode("choose"); setNameWarning(null); }}>← Back</button>
          <label className="auth-field">
            <span>Household name</span>
            <KeyboardInput
              value={householdName}
              onChange={(event) => onHouseholdNameChange(event.target.value)}
              placeholder="For example, Pollock family"
              autoComplete="off"
            />
          </label>
          {nameWarning ? <div className="name-warning" role="note">{nameWarning}</div> : null}
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

function weekLabel(startsOn: string): string {
  const start = formatTripDate(startsOn);
  const endDate = new Date(startsOn + "T00:00:00");
  endDate.setDate(endDate.getDate() + 4);
  const end = formatTripDate(endDate.toISOString().slice(0, 10));
  return `Week of ${start.short} – ${end.short}`;
}

function tripLabel(trip: Tables<"trips">): string {
  const dateInfo = formatTripDate(trip.service_date);
  const period = trip.direction === "morning" ? "Morning" : "Afternoon";
  return `${dateInfo.full} · ${period}`;
}

function countDeclinedRosters(schedule: ScheduleVersionWithRosters): number {
  let count = 0;
  for (const rosters of schedule.rostersByTrip.values()) {
    count += rosters.filter(
      (r) => r.driverAssignment.status === "declined" || r.driverAssignment.status === "released",
    ).length;
  }
  return count;
}

function countUncoveredTrips(schedule: ScheduleVersionWithRosters): number {
  let count = 0;
  for (const trip of schedule.trips) {
    const rosters = schedule.rostersByTrip.get(trip.id) ?? [];
    const active = rosters.filter(
      (r) => r.driverAssignment.status !== "declined" && r.driverAssignment.status !== "released",
    );
    const uncovered = schedule.uncoveredRidersByTrip.get(trip.id) ?? [];
    if (active.length === 0 || uncovered.length > 0) count++;
  }
  return count;
}

function findDriveDetail(
  schedule: ScheduleVersionWithRosters,
  assignmentId: string,
): { entry: ScheduleRosterEntry; trip: Tables<"trips">; serviceDate: string } | null {
  for (const trip of schedule.trips) {
    const rosters = schedule.rostersByTrip.get(trip.id);
    if (!rosters) continue;
    const entry = rosters.find((r) => r.driverAssignment.id === assignmentId);
    if (entry) {
      return { entry, trip, serviceDate: trip.service_date };
    }
  }
  return null;
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

const TEMPLATE_DAYS = [1, 2, 3, 4, 5];
const MORNING_LABEL = "8:40 AM";
const AFTERNOON_LABEL = "5:15 PM";

function emptyDriveDefaults(): DefaultDrivePref[] {
  return TEMPLATE_DAYS.flatMap((day) =>
    (["morning", "afternoon"] as const).map((direction) => ({
      day,
      direction,
      preference: "cannot" as const,
    })),
  );
}

function DrivePreferenceGrid({
  preferences,
  onChange,
  hasVehicle,
  disabled,
}: {
  preferences: DefaultDrivePref[];
  onChange: (next: DefaultDrivePref[]) => void;
  hasVehicle: boolean;
  disabled: boolean;
}) {
  const update = (day: number, direction: "morning" | "afternoon", pref: DrivePreference) => {
    if (disabled) return;
    if (pref !== "cannot" && !hasVehicle) return;
    onChange(
      preferences.map((p) =>
        p.day === day && p.direction === direction ? { ...p, preference: pref } : p,
      ),
    );
  };

  return (
    <div className="drive-template-grid" data-testid="drive-preference-grid">
      <div className="drive-template-header" aria-hidden="true">
        <span />
        <span className="drive-template-header-label">AM<small>{MORNING_LABEL}</small></span>
        <span className="drive-template-header-label">PM<small>{AFTERNOON_LABEL}</small></span>
      </div>
      {TEMPLATE_DAYS.map((day) => {
        const dayLabel = WEEKDAY_LABELS[day];
        return (
          <div className="drive-template-row" key={day}>
            <strong className="drive-template-day">{dayLabel}</strong>
            {(["morning", "afternoon"] as const).map((direction) => {
              const entry = preferences.find((p) => p.day === day && p.direction === direction);
              const current = entry?.preference ?? "cannot";
              return (
                <div
                  className="drive-segments"
                  role="group"
                  aria-label={`${dayLabel} ${direction === "morning" ? "morning" : "afternoon"}`}
                  key={direction}
                >
                  {(["prefer", "can", "cannot"] as const).map((pref) => {
                    const active = current === pref;
                    const blocked = pref !== "cannot" && !hasVehicle;
                    return (
                      <button
                        key={pref}
                        className={`drive-segment drive-segment--${pref}${active ? " drive-segment--active" : ""}`}
                        disabled={disabled || blocked}
                        onClick={() => update(day, direction, pref)}
                        aria-pressed={active}
                        aria-label={preferenceLabel(pref)}
                        type="button"
                      >
                        {pref === "prefer" ? "Prefer" : pref === "can" ? "Can" : "Can't"}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        );
      })}
      <p className="drive-template-caption">Prefer = you'd like to drive · Can = you can if needed · Can't = not available</p>
    </div>
  );
}

function RideNeedsGrid({
  children,
  needs,
  onChange,
  disabled,
}: {
  children: Tables<"children">[];
  needs: DefaultRideNeed[];
  onChange: (next: DefaultRideNeed[]) => void;
  disabled: boolean;
}) {
  const toggle = (childId: string, day: number, direction: "morning" | "afternoon") => {
    if (disabled) return;
    const existing = needs.find(
      (n) => n.child_id === childId && n.day === day && n.direction === direction,
    );
    if (existing) {
      onChange(needs.map((n) => (n === existing ? { ...n, needs_ride: !n.needs_ride } : n)));
    } else {
      onChange([...needs, { child_id: childId, day, direction, needs_ride: true }]);
    }
  };

  return (
    <div className="ride-needs-grid" data-testid="ride-needs-grid">
      <div className="ride-needs-header" aria-hidden="true">
        <span />
        <span className="drive-template-header-label">AM<small>{MORNING_LABEL}</small></span>
        <span className="drive-template-header-label">PM<small>{AFTERNOON_LABEL}</small></span>
      </div>
      {children.map((child) => (
        <div className="ride-needs-child" key={child.id}>
          <strong className="ride-needs-name">{child.first_name}</strong>
          {TEMPLATE_DAYS.map((day) => {
            const dayLabel = WEEKDAY_LABELS[day];
            return (
              <div className="ride-needs-row" key={day}>
                <span className="ride-needs-day">{dayLabel}</span>
                {(["morning", "afternoon"] as const).map((direction) => {
                  const entry = needs.find(
                    (n) => n.child_id === child.id && n.day === day && n.direction === direction,
                  );
                  const riding = entry?.needs_ride ?? false;
                  return (
                    <button
                      key={direction}
                      className={riding ? "ride-pill ride-pill--on" : "ride-pill"}
                      disabled={disabled}
                      onClick={() => toggle(child.id, day, direction)}
                      aria-pressed={riding}
                      aria-label={`${child.first_name} ${dayLabel} ${direction}`}
                      type="button"
                    >
                      {direction === "morning" ? "AM" : "PM"}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      ))}
      <p className="drive-template-caption">Tap AM or PM for each day your child needs a ride.</p>
    </div>
  );
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
  confirmError,
  schedulePublished,
  onConfirmAll,
  onReview,
  onCoverage,
  onDirectory,
  onAccount,
  onFaq,
  onRetryAssignments,
  onVolunteer,
  working,
  volunteerWorking,
  volunteerError,
  avatarUrl,
  weekStartsOn,
  confirmationDeadline,
  declinedAlerts,
  uncoveredAlerts,
  showPushBanner,
  onAllowPush,
  onDismissPush,
  pushSubscribing,
  showIOSInstallBanner,
  onDismissIOSInstall,
  timezone,
}: {
  myAssignments: MyDriverAssignment[];
  assignmentsLoading: boolean;
  assignmentsError: string | null;
  confirmError: string | null;
  schedulePublished: boolean;
  onConfirmAll: () => void;
  onReview: () => void;
  onCoverage: () => void;
  onDirectory: () => void;
  onAccount: () => void;
  onFaq: () => void;
  onRetryAssignments: () => void;
  onVolunteer: (assignmentId: string) => void;
  working: boolean;
  volunteerWorking: boolean;
  volunteerError: string | null;
  avatarUrl: string | null;
  weekStartsOn: string | null;
  confirmationDeadline: string | null;
  declinedAlerts: DeclinedDriveAlert[];
  uncoveredAlerts: UncoveredChildAlert[];
  showPushBanner: boolean;
  onAllowPush: () => void;
  onDismissPush: () => void;
  pushSubscribing: boolean;
  showIOSInstallBanner: boolean;
  onDismissIOSInstall: () => void;
  timezone: string;
}) {
  const [confirmAllOpen, setConfirmAllOpen] = useState(false);
  const tentative = myAssignments.filter((a) => a.assignment.status === "tentative");
  const confirmed = myAssignments.filter((a) => a.assignment.status === "confirmed");
  const declined = myAssignments.filter((a) => a.assignment.status === "declined");
  const allConfirmed = tentative.length === 0 && confirmed.length > 0 && declined.length === 0;
  const noAssignments = myAssignments.length === 0;
  const weekEyebrow = weekStartsOn ? weekLabel(weekStartsOn) : "This week";
  const deadlineLabel = confirmationDeadline
    ? new Date(confirmationDeadline).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" })
    : "3:00 PM";

  return (
    <div className="screen-content home-screen" data-testid="home-screen">
      <AppHeader avatarUrl={avatarUrl} onAccount={onAccount} />

      {showPushBanner ? (
        <div className="push-banner" data-testid="push-banner">
          <BellIcon width="20" height="20" />
          <div className="push-banner-body">
            <strong>Get notified</strong>
            <small>We'll alert you when your child's drive changes.</small>
          </div>
          <button className="primary-button push-banner-allow" disabled={pushSubscribing} onClick={onAllowPush}>
            {pushSubscribing ? "…" : "Allow"}
          </button>
          <button className="text-button push-banner-dismiss" aria-label="Dismiss" onClick={onDismissPush}>
            <Cross2Icon width="14" height="14" />
          </button>
        </div>
      ) : null}

      {showIOSInstallBanner ? (
        <div className="push-banner push-banner--ios" data-testid="ios-install-banner">
          <BellIcon width="20" height="20" />
          <div className="push-banner-body">
            <strong>Get notifications</strong>
            <small>Tap <Share2Icon width="11" height="11" style={{ display: "inline", verticalAlign: "middle" }} /> Share, then &ldquo;Add to Home Screen&rdquo; to enable alerts.</small>
          </div>
          <button className="text-button push-banner-dismiss" aria-label="Dismiss" onClick={onDismissIOSInstall}>
            <Cross2Icon width="14" height="14" />
          </button>
        </div>
      ) : null}

      {assignmentsLoading ? (
        <p className="helper-copy">Loading your drives…</p>
      ) : assignmentsError ? (
        <section className="confirmation-hero confirmation-hero--done">
          <span className="eyebrow">{weekEyebrow}</span>
          <h1>We couldn’t load your drives</h1>
          <div className="auth-error" role="alert">{assignmentsError}</div>
          <button className="primary-button" data-testid="retry-load-assignments" onClick={onRetryAssignments}>Try again</button>
        </section>
      ) : noAssignments ? (
        <section className="confirmation-hero confirmation-hero--done">
          <span className="eyebrow">{weekEyebrow}</span>
          <h1>No drives assigned</h1>
          <p className="hero-support">You haven’t been assigned to drive this week. Check the full schedule for details.</p>
        </section>
      ) : (
        <section className={`confirmation-hero ${allConfirmed ? "confirmation-hero--done" : ""}`}>
          <span className="eyebrow">{allConfirmed ? (schedulePublished ? "Published schedule" : "Schedule ready") : "Action needed"}</span>
          <h1>{allConfirmed ? "You're all set" : "Confirm your drives"}</h1>
          <p className="hero-deadline">
            {allConfirmed ? (
              <><CheckCircledIcon width="18" height="18" /> {confirmed.length} drive{confirmed.length !== 1 ? "s" : ""} confirmed</>
            ) : (
              <>{tentative.length} assignment{tentative.length !== 1 ? "s" : ""} <span aria-hidden="true">·</span> <strong>Confirm by {deadlineLabel}</strong></>
            )}
          </p>
<p className="hero-support">
            {allConfirmed
              ? "We'll remind you the evening before each drive."
              : "These are tentative until you accept them. Opening this schedule does not count as confirmation."}
          </p>
          {allConfirmed ? (
            <AddToCalendarButton assignments={confirmed} timezone={timezone} label="Add all to calendar" />
          ) : null}
        </section>
      )}

      {confirmError ? <div className="auth-error" role="alert">{confirmError}</div> : null}

      {declinedAlerts.length > 0 ? (
        <section className="decline-alert" data-testid="decline-alert" aria-labelledby="decline-alert-heading">
          <div className="decline-alert-header">
            <ExclamationTriangleIcon width="20" height="20" />
            <h2 id="decline-alert-heading">Your child’s drive was cancelled</h2>
          </div>
          <p className="decline-alert-body">
            A driver declined the following {declinedAlerts.length === 1 ? "trip" : "trips"} that include your child. Another parent on the route can take it over.
          </p>
          {volunteerError ? <div className="auth-error" role="alert">{volunteerError}</div> : null}
          <ul className="decline-alert-list">
            {declinedAlerts.map((alert) => (
              <li key={alert.assignment.id}>
                <div className="decline-alert-trip">
                  <strong>{tripLabel(alert.trip)}</strong>
                  <span className="decline-alert-children">
                    {alert.myChildren.map((c) => `${c.first_name} ${c.last_name}`).join(", ")}
                  </span>
                </div>
                {(() => {
                  const riderCount = alert.children.length;
                  const capacity = alert.volunteerVehicleCapacity;
                  const tooSmall = capacity !== null && capacity < riderCount;
                  return (
                    <>
                      <p className="decline-alert-meta">
                        {riderCount} child{riderCount !== 1 ? "ren" : ""} need{riderCount === 1 ? "s" : ""} a ride
                        {capacity !== null ? ` · Your car seats ${capacity}` : ""}
                        {tooSmall ? ` — not enough seats` : ""}
                      </p>
                      <button
                        className="primary-button decline-alert-volunteer"
                        data-testid={`volunteer-${alert.assignment.id}`}
                        disabled={volunteerWorking || tooSmall}
                        onClick={() => onVolunteer(alert.assignment.id)}
                      >
                        <CheckIcon width="18" height="18" /> {tooSmall ? "Car too small" : "I can drive"}
                      </button>
                    </>
                  );
                })()}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {uncoveredAlerts.length > 0 ? (
        <section className="decline-alert" data-testid="uncovered-alert" aria-labelledby="uncovered-heading">
          <div className="decline-alert-header">
            <ExclamationTriangleIcon width="20" height="20" />
            <h2 id="uncovered-heading">Your child needs a ride</h2>
          </div>
          <p className="decline-alert-body">
            The schedule doesn't have a driver for the following {uncoveredAlerts.length === 1 ? "trip" : "trips"}. Contact the admin or check the full schedule.
          </p>
          <ul className="decline-alert-list">
            {uncoveredAlerts.map((alert) => (
              <li key={alert.trip.id}>
                <div className="decline-alert-trip">
                  <strong>{tripLabel(alert.trip)}</strong>
                  <span className="decline-alert-children">
                    {alert.children.map((c) => `${c.first_name} ${c.last_name}`).join(", ")}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

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
              {tentative.length > 0 ? (
                <button className="primary-button" data-testid="confirm-drives" disabled={working} onClick={() => setConfirmAllOpen(true)}>
                  <CheckIcon width="19" height="19" /> Confirm all drives
                </button>
              ) : null}
              {confirmAllOpen ? (
                <div className="confirm-code-block" data-testid="confirm-all-dialog">
                  <p className="confirm-code-warning">You're committing to drive for all {tentative.length} trip{tentative.length !== 1 ? "s" : ""} below. Please verify each one.</p>
                  <ul className="confirm-all-list">
                    {tentative.map((entry) => (
                      <li key={entry.assignment.id}>
                        <strong>{tripLabel(entry.trip)}</strong>
                        <small>{entry.vehicle.label} · {entry.children.length} rider{entry.children.length !== 1 ? "s" : ""}</small>
                      </li>
                    ))}
                  </ul>
                  <div className="confirm-code-actions">
                    <button className="primary-button" disabled={working} onClick={() => { onConfirmAll(); setConfirmAllOpen(false); }}>
                      {working ? "Confirming…" : "Yes, confirm all"}
                    </button>
                    <button className="text-button" disabled={working} onClick={() => setConfirmAllOpen(false)}>Cancel</button>
                  </div>
                </div>
              ) : null}
              {declined.length > 0 && tentative.length === 0 ? (
                <p className="helper-copy">All drives resolved. Use "Review individually" to change a response.</p>
              ) : null}
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

      <button className="coverage-alert" onClick={onDirectory} data-testid="directory-link">
        <span><AvatarIcon width="20" height="20" /></span>
        <span><strong>Parent directory</strong><small>Phone and email for everyone in your carpool</small></span>
        <ChevronRightIcon />
      </button>

      <button className="coverage-alert" onClick={onFaq} data-testid="faq-link">
        <span><QuestionMarkCircledIcon width="20" height="20" /></span>
        <span><strong>FAQ</strong><small>How the carpool works</small></span>
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
  onDeclined,
  timezone,
}: {
  myAssignments: MyDriverAssignment[];
  repository: CarpoolRepository;
  onResponded: () => void;
  onBack: () => void;
  onDeclined: (assignmentId: string) => void;
  timezone: string;
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
      if (response === "declined") onDeclined(assignmentId);
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
        <div><span className="eyebrow">Confirmation</span><h1>Review your drives</h1></div>
      </header>
      <p className="detail-intro">Confirm each assignment only if the date, direction, vehicle, and seat count are correct. You can change your response.</p>
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
                      placeholder="Help your admin find a replacement"
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
                    I can't make this one
                  </button>
                </>
              )
            ) : status === "confirmed" ? (
              <>
                <div className="success-notice"><CheckCircledIcon /><span><strong>Confirmed</strong><small>{dateInfo.full} · {period}</small></span></div>
                <AddToCalendarButton assignments={[entry]} timezone={timezone} />
                {isDeclining ? (
                  <div className="decline-form" data-testid="decline-form">
                    <label className="auth-field">
                      <span>Reason (optional)</span>
                      <KeyboardInput
                        value={declineReason}
                        onChange={(event) => setDeclineReason(event.target.value)}
                        placeholder="Help your admin find a replacement"
                        autoComplete="off"
                      />
                    </label>
                    <button className="decline-button" disabled={working === entry.assignment.id} onClick={() => void respond(entry.assignment.id, "declined", declineReason)}>
                      {working === entry.assignment.id ? "Declining…" : "Confirm decline"}
                    </button>
                    <button className="text-button" onClick={() => { setDecliningId(null); setDeclineReason(""); }}>Cancel</button>
                  </div>
                ) : (
                  <button className="decline-button" disabled={working === entry.assignment.id} onClick={() => setDecliningId(entry.assignment.id)}>
                    I can't make this one
                  </button>
                )}
              </>
            ) : (
              <>
                <div className="declined-notice"><Cross2Icon /><span><strong>Declined</strong><small>This drive has been released.</small></span></div>
                <button className="primary-button" disabled={working === entry.assignment.id} onClick={() => void respond(entry.assignment.id, "confirmed")}>
                  <CheckIcon /> Re-accept this drive
                </button>
              </>
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
  checkinError,
  setup,
  repository,
  driverProfileId,
  groupId,
  onReloadCheckin,
  onReloadWeek,
  isCoordinator,
  onCreateWeek,
  avatarUrl,
  onAccount,
  allWeeks,
  selectedWeekId,
  onSelectWeek,
}: {
  week: WeekWithTrips | null;
  weekLoading: boolean;
  weekError: string | null;
  checkin: Tables<"weekly_checkins"> | null;
  checkinDetails: CheckinDetails | null;
  checkinLoading: boolean;
  checkinError: string | null;
  setup: HouseholdSetup | null;
  repository: CarpoolRepository;
  driverProfileId: string;
  groupId: string;
  onReloadCheckin: () => Promise<void>;
  onReloadWeek: () => void;
  isCoordinator: boolean;
  onCreateWeek: () => void;
  avatarUrl: string | null;
  onAccount: () => void;
  allWeeks: Tables<"weeks">[];
  selectedWeekId: string | null;
  onSelectWeek: (weekId: string | null) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [maxDrives, setMaxDrives] = useState("2");
  const [pendingDrive, setPendingDrive] = useState<Record<string, DrivePreference>>({});
  const [coParentUpdate, setCoParentUpdate] = useState<string | null>(null);

  const submitted = checkin?.status === "submitted";
  const children = setup?.children ?? [];
  const activeVehicle = setup?.vehicles.find((vehicle) => vehicle.active) ?? null;

  const planHeading = (() => {
    if (!week) return "Plan next week";
    const todayStr = new Date().toISOString().slice(0, 10);
    const startsOn = week.week.starts_on;
    const weekStart = new Date(startsOn + "T00:00:00");
    const friday = new Date(weekStart);
    friday.setDate(weekStart.getDate() + 4);
    const fridayStr = friday.toISOString().slice(0, 10);
    if (todayStr >= startsOn && todayStr <= fridayStr) return "Plan this week";
    if (startsOn > todayStr) return "Plan next week";
    return "Plan an earlier week";
  })();

  const currentIdx = allWeeks.findIndex((w) => w.id === (selectedWeekId ?? week?.week.id));
  const hasPrev = currentIdx >= 0 && currentIdx < allWeeks.length - 1;
  const hasNext = currentIdx > 0;
  const showNav = allWeeks.length > 1;
  const showReset = selectedWeekId !== null;

  useEffect(() => {
    if (checkin) setMaxDrives(String(checkin.max_drives || 2));
  }, [checkin?.id]);

  // Realtime: subscribe to checkin changes so co-parents see each other's edits
  useEffect(() => {
    if (!checkin) return;
    const client = getSupabaseClient();
    const channel = client
      .channel(`checkin:${checkin.id}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "weekly_checkins", filter: `id=eq.${checkin.id}` },
        () => {
          void onReloadCheckin();
          setCoParentUpdate("Updated just now");
          setTimeout(() => setCoParentUpdate(null), 3000);
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "ride_requests", filter: `checkin_id=eq.${checkin.id}` },
        () => void onReloadCheckin(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "driver_availability", filter: `checkin_id=eq.${checkin.id}` },
        () => void onReloadCheckin(),
      )
      .subscribe();

    return () => { client.removeChannel(channel); };
  }, [checkin?.id, onReloadCheckin]);

  if (weekLoading) {
    return (
      <div className="screen-content plan-screen" data-testid="plan-screen">
        <AppHeader avatarUrl={avatarUrl} onAccount={onAccount} />
        <header className="page-title">
          <span className="eyebrow">Check-in</span>
          <h1>{planHeading}</h1>
        </header>
        <p className="helper-copy">Loading the upcoming week…</p>
      </div>
    );
  }

  if (weekError) {
    return (
      <div className="screen-content plan-screen" data-testid="plan-screen">
        <AppHeader avatarUrl={avatarUrl} onAccount={onAccount} />
        <header className="page-title">
          <span className="eyebrow">Check-in</span>
          <h1>{planHeading}</h1>
        </header>
        <div className="auth-error" role="alert">{weekError}</div>
        <button className="primary-button" data-testid="retry-load-week" onClick={onReloadWeek}>Try again</button>
      </div>
    );
  }

  if (!week) {
    return (
      <div className="screen-content plan-screen" data-testid="plan-screen">
        <AppHeader avatarUrl={avatarUrl} onAccount={onAccount} />
        <header className="page-title">
          <span className="eyebrow">Check-in</span>
          <h1>{planHeading}</h1>
        </header>
        <div className="empty-state">
          <p>No upcoming week has been created yet.</p>
          {isCoordinator ? (
            <button className="primary-button" data-testid="create-week-plan" onClick={onCreateWeek}>
              Create next week
            </button>
          ) : (
            <p className="helper-copy">An admin needs to create the week first. Check back soon.</p>
          )}
        </div>
      </div>
    );
  }

  if (checkinError) {
    return (
      <div className="screen-content plan-screen" data-testid="plan-screen">
        <AppHeader avatarUrl={avatarUrl} onAccount={onAccount} />
        <header className="page-title">
          <span className="eyebrow">Check-in</span>
          <h1>{planHeading}</h1>
          <p>{weekLabel(week.week.starts_on)}</p>
        </header>
        <div className="auth-error" role="alert">Couldn't load your check-in: {checkinError}</div>
        <button className="primary-button" onClick={() => void onReloadCheckin()}>Try again</button>
      </div>
    );
  }

  if (children.length === 0) {
    return (
      <div className="screen-content plan-screen" data-testid="plan-screen">
        <AppHeader avatarUrl={avatarUrl} onAccount={onAccount} />
        <header className="page-title">
          <span className="eyebrow">Check-in</span>
          <h1>{planHeading}</h1>
          <p>{weekLabel(week.week.starts_on)}</p>
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

  const setDrivePreference = async (tripId: string, pref: DrivePreference) => {
    if (submitted || !checkin) return;
    if (pref !== "cannot" && !activeVehicle) {
      setSubmitError("Add a vehicle in your account before volunteering to drive.");
      return;
    }
    setPendingDrive((prev) => ({ ...prev, [tripId]: pref }));
    try {
      await repository.upsertDriverAvailability(
        checkin.id, tripId, driverProfileId,
        activeVehicle?.id ?? null, pref, groupId,
      );
      await onReloadCheckin();
    } catch (error) {
      setSubmitError(readableError(error));
    } finally {
      setPendingDrive((prev) => {
        const next = { ...prev };
        delete next[tripId];
        return next;
      });
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
      <AppHeader avatarUrl={avatarUrl} onAccount={onAccount} />
      <header className="page-title">
        <span className="eyebrow">Check-in</span>
        <h1>{planHeading}</h1>
        <p>{weekLabel(week.week.starts_on)}</p>
      </header>

      {showNav ? (
        <div className="week-nav" data-testid="plan-week-nav">
          <button className="week-nav-btn" disabled={!hasPrev} onClick={() => { if (hasPrev) onSelectWeek(allWeeks[currentIdx + 1].id); }}>
            <ChevronLeftIcon /> Earlier
          </button>
          {showReset ? (
            <button className="week-nav-btn week-nav-btn--reset" data-testid="plan-week-reset" onClick={() => onSelectWeek(null)}>
              Current
            </button>
          ) : null}
          <button className="week-nav-btn" disabled={!hasNext} onClick={() => { if (hasNext) onSelectWeek(allWeeks[currentIdx - 1].id); }}>
            Later <ChevronRightIcon />
          </button>
        </div>
      ) : null}

      {coParentUpdate ? (
        <div className="coparent-toast" data-testid="coparent-update">{coParentUpdate}</div>
      ) : null}

      {submitted ? (
        <div className="success-banner">
          <CheckCircledIcon width="24" height="24" />
          <span><strong>Week submitted</strong><small>Your check-in is locked. Reopen to make changes.</small></span>
        </div>
      ) : null}

      {submitError ? <div className="auth-error" role="alert">{submitError}</div> : null}

      {!submitted ? (
        <div className="checkin-summary">
          <span><strong>{[...rideMap.values()].filter(Boolean).length}</strong> rides needed</span>
          <span><strong>{[...driveMap.values()].filter((p) => p !== "cannot").length}</strong> trips you can drive</span>
        </div>
      ) : null}

      {!submitted ? (
        children.map((child) => {
          const childRides = week.trips.filter((t) => rideMap.get(`${t.id}:${child.id}`)).length;
          if (childRides > 0) return null;
          return (
            <div className="checkin-empty-prompt" key={`empty-${child.id}`}>
              <span>No rides requested for {child.first_name} this week. Do they need any?</span>
            </div>
          );
        })
      ) : null}

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

              <div className="checkin-section">
                <span className="checkin-section-label">Rides needed</span>
                <p className="checkin-section-caption">Tap each child who needs a ride.</p>
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
                        aria-label={`${child.first_name} ${riding ? "needs a ride" : "does not need a ride"}`}
                      >
                        <span>{child.first_name}</span>
                        <small>{riding ? "Needs ride" : "No ride"}</small>
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="checkin-section">
                <span className="checkin-section-label">Your driving</span>
                <div
                  className="drive-segments"
                  role="group"
                  aria-label={`Your driving for ${direction === "morning" ? "morning" : "afternoon"}`}
                >
                  {(["prefer", "can", "cannot"] as const).map((pref) => {
                    const currentPref = pendingDrive[trip.id] ?? driveMap.get(trip.id) ?? "cannot";
                    const active = currentPref === pref;
                    const busy = pendingDrive[trip.id] !== undefined;
                    return (
                      <button
                        key={pref}
                        className={`drive-segment drive-segment--${pref}${active ? " drive-segment--active" : ""}`}
                        disabled={submitted || busy}
                        onClick={() => void setDrivePreference(trip.id, pref)}
                        aria-pressed={active}
                        aria-label={preferenceLabel(pref)}
                      >
                        {pref === "prefer" ? "Prefer" : pref === "can" ? "Can" : "Can't"}
                      </button>
                    );
                  })}
                </div>
              </div>
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
            <span>Max drives for your household</span>
            <KeyboardInput
              value={maxDrives}
              onChange={(event) => setMaxDrives(event.target.value.replace(/[^0-9]/g, ""))}
              inputMode="numeric"
              placeholder="2"
              autoComplete="off"
            />
            <small>Applies to all drivers in your household this week.</small>
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
  weekStartsOn,
  allWeeks,
  selectedWeekId,
  onSelectWeek,
  avatarUrl,
  onAccount,
  onOpenDrive,
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
  weekStartsOn: string | null;
  allWeeks: Tables<"weeks">[];
  selectedWeekId: string | null;
  onSelectWeek: (weekId: string) => void;
  avatarUrl: string | null;
  onAccount: () => void;
  onOpenDrive: (assignmentId: string) => void;
}) {
  const weekHeading = weekStartsOn ? weekLabel(weekStartsOn) : "This week";
  const currentIdx = allWeeks.findIndex((w) => w.id === (selectedWeekId ?? week?.week.id));
  const hasPrev = currentIdx < allWeeks.length - 1;
  const hasNext = currentIdx > 0;
  if (weekLoading) {
    return (
      <div className="screen-content week-screen" data-testid="week-screen">
        <AppHeader avatarUrl={avatarUrl} onAccount={onAccount} />
        <header className="page-title">
          <span className="eyebrow">Family schedule</span>
          <h1>{weekHeading}</h1>
        </header>
        <p className="helper-copy">Loading…</p>
      </div>
    );
  }

  if (weekError) {
    return (
      <div className="screen-content week-screen" data-testid="week-screen">
        <AppHeader avatarUrl={avatarUrl} onAccount={onAccount} />
        <header className="page-title">
          <span className="eyebrow">Family schedule</span>
          <h1>{weekHeading}</h1>
        </header>
        <div className="auth-error" role="alert">{weekError}</div>
        <button className="primary-button" data-testid="retry-load-week" onClick={onReloadWeek}>Try again</button>
      </div>
    );
  }

  if (!week) {
    return (
      <div className="screen-content week-screen" data-testid="week-screen">
        <AppHeader avatarUrl={avatarUrl} onAccount={onAccount} />
        <header className="page-title">
          <span className="eyebrow">Family schedule</span>
          <h1>{weekHeading}</h1>
        </header>
        <div className="empty-state">
          <p>No upcoming week has been created yet.</p>
          {isCoordinator ? (
            <button className="primary-button" data-testid="generate-schedule-empty" disabled={generating} onClick={onGenerate}>
              {generating ? "Working…" : "Generate schedule"}
            </button>
          ) : (
            <p className="helper-copy">An admin needs to create the week first. Check back soon.</p>
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
        <AppHeader avatarUrl={avatarUrl} onAccount={onAccount} />
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
        <AppHeader avatarUrl={avatarUrl} onAccount={onAccount} />
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
        <AppHeader avatarUrl={avatarUrl} onAccount={onAccount} />
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
            <p className="helper-copy">An admin needs to generate the draft.</p>
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
      const activeRosters = rosters.filter(
        (r) => r.driverAssignment.status !== "declined" && r.driverAssignment.status !== "released",
      );
      if (activeRosters.length > 0) count++;
    }
    return count;
  }, 0);
  const totalTrips = week.trips.length;
  const uncoveredCount = totalTrips - coveredCount;
  const declinedCount = sortedDates.reduce((count, date) => {
    const dateTrips = tripsByDate.get(date) ?? [];
    for (const trip of dateTrips) {
      const rosters = schedule.rostersByTrip.get(trip.id) ?? [];
      count += rosters.filter((r) => r.driverAssignment.status === "declined" || r.driverAssignment.status === "released").length;
    }
    return count;
  }, 0);

  const isPublished = schedule.version.status === "published";

  const uncoveredRiderTotal = schedule.trips.reduce((count, trip) => {
    return count + (schedule.uncoveredRidersByTrip.get(trip.id) ?? []).length;
  }, 0);

  return (
    <div className="screen-content week-screen" data-testid="week-screen">
      <AppHeader avatarUrl={avatarUrl} onAccount={onAccount} />
      <header className="page-title">
        <span className="eyebrow">Family schedule</span>
        <h1>{weekLabel(week.week.starts_on)}</h1>
        <p>
          <span className={`schedule-badge ${isPublished ? "schedule-badge--published" : "schedule-badge--draft"}`}>
            {isPublished ? "Published" : `Draft v${schedule.version.version_number}`}
          </span>
          {isPublished ? null : <span className="schedule-algo">{schedule.version.algorithm_version}</span>}
        </p>
      </header>

      {allWeeks.length > 1 ? (
        <div className="week-nav">
          <button className="week-nav-btn" disabled={!hasPrev} onClick={() => { if (hasPrev) onSelectWeek(allWeeks[currentIdx + 1].id); }}>
            <ChevronLeftIcon /> Earlier
          </button>
          <button className="week-nav-btn" disabled={!hasNext} onClick={() => { if (hasNext) onSelectWeek(allWeeks[currentIdx - 1].id); }}>
            Later <ChevronRightIcon />
          </button>
        </div>
      ) : null}

      {generateError ? <div className="auth-error" role="alert">{generateError}</div> : null}

      <div className="week-status-strip">
        <span><CheckCircledIcon /> {coveredCount} covered</span>
        {uncoveredRiderTotal > 0 ? <span><ExclamationTriangleIcon /> {uncoveredRiderTotal} need{uncoveredRiderTotal !== 1 ? "" : "s"} ride{uncoveredRiderTotal !== 1 ? "s" : ""}</span> : null}
        {declinedCount > 0 ? <span className="week-status-declined"><ExclamationTriangleIcon /> {declinedCount} declined</span> : null}
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
                const activeRosters = rosters.filter(
                  (r) => r.driverAssignment.status !== "declined" && r.driverAssignment.status !== "released",
                );
                const declinedRosters = rosters.filter(
                  (r) => r.driverAssignment.status === "declined" || r.driverAssignment.status === "released",
                );
                const uncovered = activeRosters.length === 0;
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
                      <span className="mini-status mini-status--confirmed">{activeRosters.length} car{activeRosters.length !== 1 ? "s" : ""}</span>
                    )}
                    {!uncovered ? (
                      <div className="trip-rosters">
                        {activeRosters.map((entry) => (
                          <button
                            className="trip-roster"
                            key={entry.driverAssignment.id}
                            data-testid={`drive-card-${entry.driverAssignment.id}`}
                            onClick={() => onOpenDrive(entry.driverAssignment.id)}
                          >
                            <div className="roster-driver">
                              <strong>{entry.driverProfile.full_name}</strong>
                              <small>{entry.vehicle.label} · {entry.vehicle.child_passenger_capacity} seats</small>
                            </div>
                            <div className="roster-children">
                              {entry.children.length ? entry.children.map((child) => (
                                <span key={child.id}>{child.first_name} {child.last_name}</span>
                              )) : <span className="roster-empty">No riders assigned</span>}
                            </div>
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {declinedRosters.length > 0 ? (
                      <div className="trip-rosters trip-rosters--declined">
                        {declinedRosters.map((entry) => (
                          <div className="trip-roster roster--declined" key={entry.driverAssignment.id}>
                            <div className="roster-driver">
                              <strong>{entry.driverProfile.full_name}</strong>
                              <small>{entry.vehicle.label} · {entry.driverAssignment.status === "released" ? "Released" : "Declined"}</small>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {(() => {
                      const uncovered = schedule.uncoveredRidersByTrip.get(trip.id) ?? [];
                      if (uncovered.length === 0) return null;
                      return (
                        <div className="uncovered-riders" data-testid={`uncovered-riders-${trip.id}`}>
                          <small className="uncovered-riders-label">
                            <ExclamationTriangleIcon width="12" height="12" />
                            {uncovered.length} need{uncovered.length !== 1 ? "" : "s"} a ride
                          </small>
                          <div className="uncovered-riders-list">
                            {uncovered.map((child) => (
                              <span key={child.id} className="uncovered-rider-chip">
                                {child.first_name} {child.last_name}
                              </span>
                            ))}
                          </div>
                        </div>
                      );
                    })()}
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
  declinedCount,
  uncoveredCount,
  generateWarning,
  avatarUrl,
  onAccount,
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
  declinedCount: number;
  uncoveredCount: number;
  generateWarning: string | null;
  avatarUrl: string | null;
  onAccount: () => void;
}) {
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);

  if (weekLoading) {
    return (
      <div className="screen-content coordinator-screen" data-testid="coordinator-screen">
        <AppHeader avatarUrl={avatarUrl} onAccount={onAccount} />
        <header className="page-title">
          <span className="eyebrow">{isCoordinator ? "Admin view" : "Status"}</span>
          <h1>Weekly coverage</h1>
        </header>
        <p className="helper-copy">Loading…</p>
      </div>
    );
  }

  if (weekError) {
    return (
      <div className="screen-content coordinator-screen" data-testid="coordinator-screen">
        <AppHeader avatarUrl={avatarUrl} onAccount={onAccount} />
        <header className="page-title">
          <span className="eyebrow">{isCoordinator ? "Admin view" : "Status"}</span>
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
        <AppHeader avatarUrl={avatarUrl} onAccount={onAccount} />
        <header className="page-title">
          <span className="eyebrow">{isCoordinator ? "Admin view" : "Status"}</span>
          <h1>Weekly coverage</h1>
        </header>
        <div className="empty-state">
          <p>No upcoming week has been created yet.</p>
          {createWeekError ? <div className="auth-error" role="alert">{createWeekError}</div> : null}
          {isCoordinator ? (
            <button className="primary-button" data-testid="create-week-coord" disabled={creatingWeek} onClick={onCreateWeek}>
              {creatingWeek ? "Creating…" : "Create next week"}
            </button>
          ) : (
            <p className="helper-copy">Waiting for an admin to create the week.</p>
          )}
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
      <AppHeader avatarUrl={avatarUrl} onAccount={onAccount} />
      <header className="page-title">
        <span className="eyebrow">{isCoordinator ? "Admin view" : "Status"}</span>
        <h1>Weekly coverage</h1>
        <p>{weekLabel(week.week.starts_on)}</p>
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

      {declinedCount > 0 ? (
        <div className="decline-alert decline-alert--admin" data-testid="decline-alert-admin">
          <div className="decline-alert-header">
            <ExclamationTriangleIcon width="20" height="20" />
            <h2>{declinedCount} drive{declinedCount !== 1 ? "s" : ""} declined</h2>
          </div>
          <p className="decline-alert-body">
            Affected parents can volunteer to cover these from their home screen. If no one steps up, regenerate the draft to reassign.
          </p>
        </div>
      ) : null}

      {uncoveredCount > 0 ? (
        <div className="decline-alert decline-alert--admin" data-testid="uncovered-alert-admin">
          <div className="decline-alert-header">
            <ExclamationTriangleIcon width="20" height="20" />
            <h2>{uncoveredCount} trip{uncoveredCount !== 1 ? "s" : ""} with uncovered children</h2>
          </div>
          <p className="decline-alert-body">
            Some children don't have a driver assigned. Check the Week tab for details before publishing.
          </p>
        </div>
      ) : null}

      {generateWarning ? (
        <div className="auth-error" role="alert" data-testid="generate-warning">
          {generateWarning}
        </div>
      ) : null}

      {isCoordinator && week ? (
        <div className="coordinator-generate">
          {generateError ? <div className="auth-error" role="alert">{generateError}</div> : null}
          {scheduleStatus === "draft" ? (
            <>
              <button className="secondary-button" data-testid="generate-schedule-coord" disabled={generating} onClick={onGenerate}>
                {generating ? "Generating…" : "Regenerate draft"}
              </button>
              <button className="primary-button" data-testid="publish-schedule" disabled={publishing || uncoveredCount > 0} onClick={onPublish}>
                {publishing ? "Publishing…" : uncoveredCount > 0 ? "Resolve uncovered first" : "Publish schedule"}
              </button>
              <small className="helper-copy">
                {uncoveredCount > 0
                  ? "Cannot publish — some children don't have a driver. Check the Week tab."
                  : "Publishing locks this schedule for all families."}
              </small>
            </>
            ) : scheduleStatus === "published" ? (
              <>
                <div className="publish-notice">
                  <CheckCircledIcon width="18" height="18" />
                  <span><strong>Schedule published</strong><small>Families can see the final roster.</small></span>
                </div>
                {confirmRegenerate ? (
                  <div className="confirm-code-block" data-testid="confirm-regenerate">
                    <p className="confirm-code-warning">This will replace the published schedule. The new schedule goes live immediately. Continue?</p>
                    <div className="confirm-code-actions">
                      <button className="primary-button" data-testid="regenerate-schedule-coord" disabled={generating} onClick={() => { onGenerate(); setConfirmRegenerate(false); }}>
                        {generating ? "Generating…" : "Yes, replace schedule"}
                      </button>
                      <button className="text-button" disabled={generating} onClick={() => setConfirmRegenerate(false)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <button className="secondary-button" disabled={generating} onClick={() => setConfirmRegenerate(true)}>
                    {generating ? "Generating…" : "Replace published schedule"}
                  </button>
                )}
              </>
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
  groupChildren,
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
  groupChildren: Tables<"children">[];
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

  const [editingPhone, setEditingPhone] = useState(false);
  const [phoneDraft, setPhoneDraft] = useState(profile.phone ?? "");
  const [phoneWorking, setPhoneWorking] = useState(false);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [shareWorking, setShareWorking] = useState(false);

  const [newChildFirst, setNewChildFirst] = useState("");
  const [newChildLast, setNewChildLast] = useState("");
  const [childWorking, setChildWorking] = useState(false);
  const [childError, setChildError] = useState<string | null>(null);
  const [editingChildId, setEditingChildId] = useState<string | null>(null);
  const [editChildFirst, setEditChildFirst] = useState("");
  const [editChildLast, setEditChildLast] = useState("");
  const [editChildWorking, setEditChildWorking] = useState(false);
  const [buddyWorkingId, setBuddyWorkingId] = useState<string | null>(null);
  const [buddyError, setBuddyError] = useState<string | null>(null);
  const [photoWorkingId, setPhotoWorkingId] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);

  const [vehicleLabel, setVehicleLabel] = useState("");
  const [vehicleCapacity, setVehicleCapacity] = useState("4");
  const [vehicleNotes, setVehicleNotes] = useState("");
  const [vehicleWorking, setVehicleWorking] = useState(false);
  const [vehicleError, setVehicleError] = useState<string | null>(null);

  const [joinCode, setJoinCode] = useState<string | null>(null);
  const [codeWorking, setCodeWorking] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [confirmNewCode, setConfirmNewCode] = useState(false);

  const [driveDefaults, setDriveDefaults] = useState<DefaultDrivePref[]>(emptyDriveDefaults());
  const [driveDefaultsLoading, setDriveDefaultsLoading] = useState(true);
  const [driveDefaultsSaving, setDriveDefaultsSaving] = useState(false);
  const [driveDefaultsError, setDriveDefaultsError] = useState<string | null>(null);

  const [rideNeeds, setRideNeeds] = useState<DefaultRideNeed[]>([]);
  const [rideNeedsLoading, setRideNeedsLoading] = useState(true);
  const [standardWeekSaving, setStandardWeekSaving] = useState(false);
  const [standardWeekError, setStandardWeekError] = useState<string | null>(null);

  const activeVehicle = setup?.vehicles.find((vehicle) => vehicle.active) ?? null;

  useEffect(() => {
    if (activeVehicle) {
      setVehicleLabel(activeVehicle.label);
      setVehicleCapacity(String(activeVehicle.child_passenger_capacity));
      setVehicleNotes(activeVehicle.notes ?? "");
    }
  }, [activeVehicle]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [defaults, needs] = await Promise.all([
          repository.getDefaultDrivePreferences(profile.id),
          repository.getDefaultRideNeeds(householdId),
        ]);
        if (mounted) {
          if (defaults.length > 0) setDriveDefaults(defaults);
          const childIds = new Set((setup?.children ?? []).map((c) => c.id));
          setRideNeeds(needs.filter((n) => childIds.has(n.child_id)));
        }
      } catch {
        /* silent — defaults stay empty */
      } finally {
        if (mounted) {
          setDriveDefaultsLoading(false);
          setRideNeedsLoading(false);
        }
      }
    })();
    return () => { mounted = false; };
  }, [repository, profile.id, householdId, setup]);

  const saveStandardWeek = async () => {
    setStandardWeekSaving(true);
    setStandardWeekError(null);
    try {
      await repository.saveDefaultRideNeeds(householdId, rideNeeds);
      await repository.saveDefaultDrivePreferences(driveDefaults);
    } catch (nextError) {
      setStandardWeekError(readableError(nextError));
    } finally {
      setStandardWeekSaving(false);
    }
  };

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

  const savePhone = async () => {
    const digits = phoneDraft.replace(/\D/g, "");
    if (digits.length < 7) {
      setPhoneError("Enter a phone number so other parents can reach you.");
      return;
    }
    setPhoneWorking(true);
    setPhoneError(null);
    try {
      await repository.updateCurrentProfile({ phone: phoneDraft });
      setEditingPhone(false);
      await onReloadHousehold();
    } catch (nextError) {
      setPhoneError(readableError(nextError));
    } finally {
      setPhoneWorking(false);
    }
  };

  const toggleSharePhone = async () => {
    setShareWorking(true);
    try {
      await repository.updateCurrentProfile({ sharePhone: !profile.share_phone });
      await onReloadHousehold();
    } catch (nextError) {
      setNameError(readableError(nextError));
    } finally {
      setShareWorking(false);
    }
  };

  const toggleShareEmail = async () => {
    setShareWorking(true);
    try {
      await repository.updateCurrentProfile({ shareEmail: !profile.share_email });
      await onReloadHousehold();
    } catch (nextError) {
      setNameError(readableError(nextError));
    } finally {
      setShareWorking(false);
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

  const saveEditChild = async (childId: string) => {
    setEditChildWorking(true);
    setChildError(null);
    try {
      await repository.updateChild(childId, {
        firstName: editChildFirst,
        lastName: editChildLast,
      });
      setEditingChildId(null);
      await onReloadHousehold();
    } catch (nextError) {
      setChildError(readableError(nextError));
    } finally {
      setEditChildWorking(false);
    }
  };

  const setBuddy = async (childId: string, buddyChildId: string | null) => {
    setBuddyWorkingId(childId);
    setBuddyError(null);
    try {
      await repository.updateChild(childId, { preferredBuddyChildId: buddyChildId });
      await onReloadHousehold();
    } catch (nextError) {
      setBuddyError(readableError(nextError));
    } finally {
      setBuddyWorkingId(null);
    }
  };

  const uploadChildPhoto = async (childId: string, file: File | null) => {
    if (!file) return;
    setPhotoWorkingId(childId);
    setPhotoError(null);
    try {
      const publicUrl = await repository.uploadChildPhoto(householdId, childId, file);
      await repository.updateChild(childId, { photoUrl: publicUrl });
      await onReloadHousehold();
    } catch (nextError) {
      setPhotoError(readableError(nextError));
    } finally {
      setPhotoWorkingId(null);
    }
  };

  const removeVehicle = async () => {
    const activeVehicle = setup?.vehicles.find((v) => v.active) ?? null;
    if (!activeVehicle) return;
    setVehicleWorking(true);
    setVehicleError(null);
    try {
      await repository.deactivateVehicle(activeVehicle.id, groupId);
      await onReloadHousehold();
    } catch (nextError) {
      setVehicleError(readableError(nextError));
    } finally {
      setVehicleWorking(false);
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

  const regenerateCode = async () => {
    setCodeWorking(true);
    setCodeError(null);
    try {
      const code = await repository.regenerateJoinCode(householdId);
      setJoinCode(code);
    } catch (nextError) {
      setCodeError(readableError(nextError));
    } finally {
      setCodeWorking(false);
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

      <section className="household-section" aria-labelledby="phone-section-heading">
        <div className="section-heading-row">
          <h2 id="phone-section-heading">Your phone</h2>
          {!editingPhone ? <button className="inline-action" onClick={() => { setPhoneDraft(profile.phone ?? ""); setEditingPhone(true); }}>Edit</button> : null}
        </div>
        {editingPhone ? (
          <div className="household-form">
            <label className="auth-field">
              <span>Phone number</span>
              <KeyboardInput
                value={phoneDraft}
                onChange={(event) => setPhoneDraft(event.target.value)}
                autoComplete="tel"
                inputMode="tel"
                placeholder="(415) 555-0100"
              />
            </label>
            {phoneError ? <div className="auth-error" role="alert">{phoneError}</div> : null}
            <button className="primary-button" disabled={phoneWorking} onClick={() => void savePhone()}>
              {phoneWorking ? "Saving…" : "Save phone"}
            </button>
            <button className="text-button" disabled={phoneWorking} onClick={() => { setEditingPhone(false); setPhoneError(null); }}>Cancel</button>
          </div>
        ) : (
          <p className="household-static">{profile.phone ?? "Not set"}</p>
        )}
      </section>

      <section className="household-section" aria-labelledby="sharing-section-heading">
        <h2 id="sharing-section-heading">Parent directory</h2>
        <p className="helper-copy">Control what other parents in your carpool can see.</p>
        <label className="share-toggle-row">
          <span>
            <strong>Show my phone in directory</strong>
            <small>Other parents can see your phone number.</small>
          </span>
          <input
            type="checkbox"
            checked={profile.share_phone}
            disabled={shareWorking}
            onChange={() => void toggleSharePhone()}
          />
        </label>
        <label className="share-toggle-row">
          <span>
            <strong>Show my email in directory</strong>
            <small>Other parents can see your email address.</small>
          </span>
          <input
            type="checkbox"
            checked={profile.share_email}
            disabled={shareWorking}
            onChange={() => void toggleShareEmail()}
          />
        </label>
      </section>

      <section className="household-section" aria-labelledby="children-section-heading">
        <div className="section-heading-row">
          <h2 id="children-section-heading">Children</h2>
        </div>
        {setupLoading && !setup ? <p className="household-static">Loading…</p> : null}
        {setupError ? <div className="auth-error" role="alert">{setupError}</div> : null}
        {buddyError ? <div className="auth-error" role="alert">{buddyError}</div> : null}
        <ul className="household-list" data-testid="child-list">
          {setup?.children.length ? setup.children.map((child) => (
            <li key={child.id} className="household-list-row">
              {editingChildId === child.id ? (
                <div className="household-form" style={{ flex: 1 }}>
                  <div className="household-name-row">
                    <label className="auth-field">
                      <span>First name</span>
                      <KeyboardInput
                        value={editChildFirst}
                        onChange={(event) => setEditChildFirst(event.target.value)}
                        placeholder="First name"
                        autoComplete="off"
                      />
                    </label>
                    <label className="auth-field">
                      <span>Last name</span>
                      <KeyboardInput
                        value={editChildLast}
                        onChange={(event) => setEditChildLast(event.target.value)}
                        placeholder="Last name"
                        autoComplete="off"
                      />
                    </label>
                  </div>
                  <div className="household-row-actions">
                    <button className="primary-button" disabled={editChildWorking} onClick={() => void saveEditChild(child.id)}>
                      {editChildWorking ? "Saving…" : "Save"}
                    </button>
                    <button className="text-button" onClick={() => setEditingChildId(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="child-row-content">
                  <div className="child-row-header">
                    <span className="child-photo-thumb child-photo-thumb--small">
                      {child.photo_url ? <img src={child.photo_url} alt="" /> : <PersonIcon />}
                    </span>
                    <span><strong>{child.first_name} {child.last_name}</strong></span>
                    <div className="household-row-actions">
                      <button
                        className="inline-action"
                        disabled={childWorking || buddyWorkingId === child.id || photoWorkingId === child.id}
                        onClick={() => { setEditingChildId(child.id); setEditChildFirst(child.first_name); setEditChildLast(child.last_name); }}
                      >
                        Edit
                      </button>
                      <button
                        className="text-button household-remove"
                        disabled={childWorking || buddyWorkingId === child.id || photoWorkingId === child.id}
                        onClick={() => void removeChild(child.id)}
                        aria-label={`Remove ${child.first_name} ${child.last_name}`}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                  <div className="child-photo-row">
                    <label className="inline-action child-photo-upload">
                      <span>{photoWorkingId === child.id ? "Uploading…" : "Upload photo"}</span>
                      <input
                        type="file"
                        accept="image/*"
                        disabled={photoWorkingId === child.id}
                        onChange={(event) => void uploadChildPhoto(child.id, event.target.files?.[0] ?? null)}
                        style={{ display: "none" }}
                      />
                    </label>
                  </div>
                  <label className="buddy-picker">
                    <span>Riding buddy</span>
                    <select
                      value={child.preferred_buddy_child_id ?? ""}
                      disabled={buddyWorkingId === child.id || childWorking}
                      onChange={(event) => void setBuddy(child.id, event.target.value || null)}
                      aria-label={`Riding buddy for ${child.first_name} ${child.last_name}`}
                    >
                      <option value="">None</option>
                      {groupChildren
                        .filter((c) => c.household_id !== child.household_id && c.id !== child.id)
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.first_name} {c.last_name}
                          </option>
                        ))}
                    </select>
                  </label>
                </div>
              )}
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
          {activeVehicle ? (
            <button className="text-button household-remove" disabled={vehicleWorking} onClick={() => void removeVehicle()}>
              Remove vehicle
            </button>
          ) : null}
        </div>
      </section>

      <section className="household-section" aria-labelledby="standard-week-heading">
        <div className="section-heading-row">
          <h2 id="standard-week-heading">Standard week</h2>
        </div>
        <p className="household-static">Set your family's defaults for a normal school week. New weeks start with these — you can still adjust any week before submitting. Morning pickup is 8:40 AM from Midtown Terrace. Afternoon pickup is 5:15 PM from Presidio.</p>
        {driveDefaultsLoading || rideNeedsLoading ? (
          <p className="household-static">Loading…</p>
        ) : (
          <>
            {(setup?.children.length ?? 0) > 0 ? (
              <div className="standard-week-subsection">
                <h3 className="standard-week-label">Rides for</h3>
                <p className="standard-week-caption">Which days does your child need a ride? Tap to toggle each trip.</p>
                <RideNeedsGrid
                  children={setup?.children ?? []}
                  needs={rideNeeds}
                  onChange={setRideNeeds}
                  disabled={standardWeekSaving}
                />
              </div>
            ) : null}

            <div className="standard-week-subsection">
              <h3 className="standard-week-label">Your driving</h3>
              <p className="standard-week-caption">Tell us when you're available to drive.</p>
              <DrivePreferenceGrid
                preferences={driveDefaults}
                onChange={setDriveDefaults}
                hasVehicle={!!activeVehicle}
                disabled={standardWeekSaving}
              />
              {!activeVehicle ? (
                <p className="helper-copy">Add a vehicle above to unlock driving preferences.</p>
              ) : null}
            </div>

            {standardWeekError ? <div className="auth-error" role="alert">{standardWeekError}</div> : null}
            <button
              className="primary-button"
              disabled={standardWeekSaving}
              onClick={() => void saveStandardWeek()}
              data-testid="save-standard-week"
            >
              {standardWeekSaving ? "Saving…" : "Save standard week"}
            </button>
          </>
        )}
      </section>

      <section className="household-section" aria-labelledby="invite-section-heading">
        <div className="section-heading-row">
          <h2 id="invite-section-heading">Invite another parent</h2>
        </div>
        <p className="household-static">Share this code with another parent in your household. They&apos;ll sign in with their own Google account, then enter it once during setup.</p>
        {joinCode ? (
          <div className="join-code-card" data-testid="join-code-display">
            <small>Household join code</small>
            <strong>{joinCode}</strong>
          </div>
        ) : null}
        {codeError ? <div className="auth-error" role="alert">{codeError}</div> : null}
        {confirmNewCode ? (
          <div className="confirm-code-block" data-testid="confirm-new-code">
            <p className="confirm-code-warning">This will invalidate the old code. Anyone who hasn&apos;t joined yet will need the new one. Continue?</p>
            <div className="confirm-code-actions">
              <button className="primary-button" disabled={codeWorking} onClick={() => { void regenerateCode(); setConfirmNewCode(false); }}>
                {codeWorking ? "Generating…" : "Yes, get new code"}
              </button>
              <button className="text-button" disabled={codeWorking} onClick={() => setConfirmNewCode(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <button className="secondary-button" disabled={codeWorking} onClick={() => setConfirmNewCode(true)}>
            {joinCode ? "Get a new code" : "Get join code"}
          </button>
        )}
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

type DirectoryEntry = {
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
};

function DirectoryScreen({
  groupId,
  repository,
  onBack,
}: {
  groupId: string;
  repository: CarpoolRepository;
  onBack: () => void;
}) {
  const [entries, setEntries] = useState<DirectoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    repository
      .listGroupDirectory(groupId)
      .then((rows) => {
        if (!mounted) return;
        setEntries(rows as DirectoryEntry[]);
        setError(null);
      })
      .catch((err) => {
        if (!mounted) return;
        setError(readableError(err));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => { mounted = false; };
  }, [groupId, repository]);

  const byHousehold = new Map<string, DirectoryEntry[]>();
  for (const e of entries) {
    const list = byHousehold.get(e.household_id) ?? [];
    list.push(e);
    byHousehold.set(e.household_id, list);
  }
  const householdOrder = entries.map((e) => e.household_id).filter((hid, i, arr) => arr.indexOf(hid) === i);

  return (
    <div className="screen-content directory-screen" data-testid="directory-screen">
      <header className="subpage-header">
        <button className="icon-button" onClick={onBack} aria-label="Back"><Cross2Icon /></button>
        <div><span className="eyebrow">Carpool Crew</span><h1>Parent directory</h1></div>
      </header>

      {loading ? (
        <p className="helper-copy">Loading parents…</p>
      ) : error ? (
        <div className="auth-error" role="alert">{error}</div>
      ) : entries.length === 0 ? (
        <div className="empty-state"><p>No parents found in your carpool.</p></div>
      ) : (
        <div className="directory-list">
          {householdOrder.map((hid) => {
            const members = byHousehold.get(hid) ?? [];
            const householdName = members[0]?.household_name ?? "Household";
            return (
              <section key={hid} className="directory-household">
                <h2 className="directory-household-name">{householdName}</h2>
                {members.map((m) => (
                  <div key={m.id} className="directory-row" data-testid="directory-row">
                    <span className="account-avatar directory-avatar">
                      {m.avatar_url ? <img src={m.avatar_url} alt="" /> : <PersonIcon />}
                    </span>
                    <div className="directory-row-info">
                      <div className="directory-row-name">
                        <strong>{m.full_name}</strong>
                        {m.role === "coordinator" ? <span className="role-badge">Admin</span> : null}
                      </div>
                      <div className="directory-row-contact">
                        {m.share_email && m.email ? (
                          <a href={`mailto:${m.email}`} className="directory-contact-item">{m.email}</a>
                        ) : (
                          <span className="directory-contact-item directory-contact-hidden">Email hidden</span>
                        )}
                        {m.share_phone && m.phone ? (
                          <a href={`tel:${m.phone.replace(/\s/g, "")}`} className="directory-contact-item">{m.phone}</a>
                        ) : (
                          <span className="directory-contact-item directory-contact-hidden">Phone hidden</span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

const FAQ_SECTIONS: { title: string; items: { q: string; a: string }[] }[] = [
  {
    title: "Getting started",
    items: [
      {
        q: "Why do I need a Google account?",
        a: "The carpool uses Google sign-in for secure authentication. Your Google email links to your family's profile. We don't access your Google contacts, calendar, or any other Google data — we only use it to verify who you are.",
      },
      {
        q: "How do I create a household?",
        a: "When you first sign in, the app walks you through onboarding: enter your name and phone, create a household, add your children, add a vehicle (if you'll drive), and set your standard week defaults. The whole process takes about five minutes.",
      },
      {
        q: "How do I join an existing household?",
        a: "If your co-parent already created a household, ask them for the 10-character join code on their Account screen. On the sign-in screen, choose \"Join a household\" and enter the code. Each parent uses their own Google account.",
      },
      {
        q: "How do I invite a co-parent?",
        a: "Open your Account screen and look for the join code. Share that code with your co-parent. They sign in with their own Google account and enter the code to join your household.",
      },
    ],
  },
  {
    title: "Your household profile",
    items: [
      {
        q: "How do I add or edit my children?",
        a: "Open the Account screen (tap your avatar in the top-right). You can add children, edit their names, upload a photo, and remove a child if they leave the carpool.",
      },
      {
        q: "What is a riding buddy?",
        a: "A riding buddy is a child from another family who your child prefers to ride with. When the scheduler assigns your child to a car, it tries to place them in the same car as their buddy. For best results, set the buddy preference in both directions — your child picks their buddy, and the buddy's parent picks your child back.",
      },
      {
        q: "How do I add a vehicle?",
        a: "On the Account screen, add a vehicle with a label (e.g., \"Honda Odyssey\") and the number of child passenger seats (1–12). A vehicle is required if you want to be considered as a driver.",
      },
      {
        q: "What are standard week defaults?",
        a: "During onboarding (and editable on the Account screen), you set which days your child typically needs rides and which days you're typically available to drive. When a new week is created, these defaults pre-fill your check-in so you don't start from scratch.",
      },
    ],
  },
  {
    title: "Weekly check-in",
    items: [
      {
        q: "When should I check in?",
        a: "Check in each week by Saturday. The coordinator generates the schedule on Sunday, so your check-in needs to be submitted before then. You'll see a reminder on the Plan tab if you haven't checked in yet.",
      },
      {
        q: "How do I request rides for my child?",
        a: "On the Plan tab, tap each AM or PM slot for each day your child needs a ride. The highlighted slots show which trips you're requesting. Tap again to toggle off.",
      },
      {
        q: "What does Prefer, Can, and Can't mean for driving?",
        a: "Prefer means you'd like to drive that trip. Can means you're available if needed. Can't means you cannot drive that trip. The scheduler prioritizes Prefer drivers first, then Can drivers if needed. You must have a vehicle on file to mark Prefer or Can.",
      },
      {
        q: "What is max drives per week?",
        a: "This caps how many trips you'll be assigned to drive in a single week. Set it based on your availability. If you set it to 0, you won't drive at all — your child can still ride.",
      },
      {
        q: "Can I change my check-in after submitting?",
        a: "Yes. Tap \"Reopen\" on the Plan tab to un-submit your check-in, make changes, and submit again. The coordinator sees your latest submission when they generate the schedule.",
      },
    ],
  },
  {
    title: "The schedule",
    items: [
      {
        q: "How does the scheduling algorithm work?",
        a: "The scheduler (greedy-v1) assigns children to available drivers for each trip. For each car, it places the driver's own children first, then fills remaining seats with other children — prioritizing riding buddies and then alphabetical order. Drivers are selected based on: own children riding, preference (Prefer over Can), fewest drives so far this week, and then a deterministic tiebreak.",
      },
      {
        q: "What's the difference between a draft and a published schedule?",
        a: "A draft is a working version the coordinator can review and regenerate. Publishing locks the schedule for all families — everyone sees the final rosters and drivers get confirmation requests. Once published, the coordinator can regenerate if needed, which replaces the published version immediately.",
      },
      {
        q: "Who can generate and publish schedules?",
        a: "Only coordinators. The coordinator creates the week, generates the draft schedule, reviews it, and publishes it. If you're not a coordinator, you'll see the schedule on the Week tab but can't generate or publish.",
      },
    ],
  },
  {
    title: "Driver confirmation",
    items: [
      {
        q: "What does tentative mean?",
        a: "A tentative assignment means the scheduler has proposed you as the driver for that trip, but you haven't confirmed yet. You need to confirm or decline by the deadline (typically 3:00 PM Sunday).",
      },
      {
        q: "How do I confirm my drives?",
        a: "On the Home tab, tap \"Confirm all drives\" to confirm every tentative assignment at once, or tap \"Review\" to confirm or decline each trip individually. You'll see a confirmation dialog listing all trips before you commit.",
      },
      {
        q: "What happens if I decline a drive?",
        a: "If you decline, the children who were assigned to your car become uncovered. Their parents get a notification and can volunteer to cover the drive. The coordinator can also regenerate the schedule to reassign.",
      },
      {
        q: "What is the confirmation deadline?",
        a: "The deadline is shown on the Home screen (typically 3:00 PM Sunday). If you don't confirm or decline by the deadline, your assignment expires and the children become uncovered.",
      },
    ],
  },
  {
    title: "Coverage problems",
    items: [
      {
        q: "What happens when my child's driver cancels?",
        a: "You'll see a decline alert on the Home screen showing which trip is affected. If you can drive, tap \"I can drive\" to volunteer. If you can't, contact the coordinator or wait for the schedule to be regenerated.",
      },
      {
        q: "What are uncovered riders?",
        a: "Uncovered riders are children who need a ride for a trip but don't have a driver assigned. They're shown on the Week tab with amber chips listing each child's name. The coordinator should review these before publishing.",
      },
      {
        q: "How do I volunteer to cover a drive?",
        a: "When a drive is declined, affected families see an \"I can drive\" button on the Home screen. Tap it to volunteer — the app checks that your vehicle has enough seats for the assigned children.",
      },
    ],
  },
  {
    title: "Week tab",
    items: [
      {
        q: "How do I view different weeks?",
        a: "On the Week tab, use the Earlier and Later buttons to navigate between weeks. The current week is shown by default.",
      },
      {
        q: "What do the coverage indicators mean?",
        a: "The status strip at the top shows: covered trips, children who need rides (amber), and declined drives. Each trip shows the number of cars and, if there are uncovered children, their names in amber chips.",
      },
      {
        q: "Can I see who's in each car?",
        a: "Yes. On the Week tab, tap any drive card to see the driver, vehicle, route, and all children assigned to that car. Child photos appear if they've been uploaded.",
      },
    ],
  },
  {
    title: "Notifications",
    items: [
      {
        q: "What do push notifications alert me about?",
        a: "You'll be notified when: a new schedule is published, your child's driver declines a drive, your child is uncovered (no driver assigned), or a drive you declined needs coverage.",
      },
      {
        q: "How do I enable push notifications?",
        a: "Tap \"Allow\" on the banner at the top of the Home screen. You'll be asked to grant notification permission. On iOS, you also need to add the app to your home screen for push to work.",
      },
      {
        q: "Why does iOS need Add to Home Screen?",
        a: "iOS Safari doesn't support web push notifications directly. You need to add the app to your home screen (Share → Add to Home Screen) and launch it from there to receive push notifications.",
      },
    ],
  },
  {
    title: "Parent directory",
    items: [
      {
        q: "Who appears in the parent directory?",
        a: "All active parents in your carpool group, grouped by household. Coordinators are marked with an Admin badge.",
      },
      {
        q: "Why is someone's phone or email hidden?",
        a: "Each parent controls whether their phone and email are visible to other families. If they've turned off sharing in their Account settings, you'll see \"Phone hidden\" or \"Email hidden\" instead of their contact info.",
      },
      {
        q: "How do I show my contact info to other families?",
        a: "Open the Account screen and toggle the sharing switches next to your phone number and email. Sharing is on by default — you can turn it off if you prefer not to share.",
      },
    ],
  },
  {
    title: "Account",
    items: [
      {
        q: "How do I sign out?",
        a: "Tap your avatar in the top-right, then scroll to the bottom of the Account screen and tap \"Sign out.\" This returns you to the sign-in screen.",
      },
      {
        q: "Do both parents need separate accounts?",
        a: "Yes. Each parent signs in with their own Google account and joins the same household using the join code. This way each parent has their own profile, can check in independently, and receives their own notifications.",
      },
    ],
  },
];

function FaqScreen({ onBack }: { onBack: () => void }) {
  return (
    <div className="screen-content faq-screen" data-testid="faq-screen">
      <header className="subpage-header">
        <button className="icon-button" onClick={onBack} aria-label="Back"><Cross2Icon /></button>
        <div><span className="eyebrow">Carpool Crew</span><h1>FAQ</h1></div>
      </header>
      <div className="faq-list">
        {FAQ_SECTIONS.map((section) => (
          <section className="faq-section" key={section.title}>
            <h2 className="faq-section-title">{section.title}</h2>
            {section.items.map((item, idx) => (
              <div className="faq-item" key={idx}>
                <p className="faq-question">{item.q}</p>
                <p className="faq-answer">{item.a}</p>
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

function AddToCalendarButton({
  assignments,
  timezone,
  label = "Add to calendar",
}: {
  assignments: MyDriverAssignment[];
  timezone: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const isBulk = assignments.length > 1;

  const handleGoogle = () => {
    if (assignments.length === 0) return;
    window.open(buildGoogleCalendarUrl(assignments[0], timezone), "_blank", "noopener");
    setOpen(false);
  };

  const handleOutlook = () => {
    if (assignments.length === 0) return;
    window.open(buildOutlookUrl(assignments[0], timezone), "_blank", "noopener");
    setOpen(false);
  };

  const handleApple = () => {
    const ics = buildIcsCalendar(assignments, timezone);
    const filename = isBulk ? "carpool-crew-drives.ics" : "carpool-crew-drive.ics";
    downloadIcs(filename, ics);
    setOpen(false);
  };

  return (
    <>
      <button
        className="secondary-button calendar-button"
        data-testid="add-to-calendar"
        onClick={() => setOpen(true)}
      >
        <CalendarIcon width="16" height="16" /> {label}
      </button>
      <BottomSheet open={open} onOpenChange={setOpen} title="Add to calendar">
        <div className="calendar-sheet" data-testid="calendar-sheet">
          {!isBulk ? (
            <>
              <button className="calendar-sheet-option" data-testid="calendar-google" onClick={handleGoogle}>
                <span className="calendar-sheet-icon">G</span>
                <span className="calendar-sheet-label">Google Calendar</span>
                <ChevronRightIcon />
              </button>
              <button className="calendar-sheet-option" data-testid="calendar-outlook" onClick={handleOutlook}>
                <span className="calendar-sheet-icon">O</span>
                <span className="calendar-sheet-label">Outlook</span>
                <ChevronRightIcon />
              </button>
            </>
          ) : (
            <p className="calendar-sheet-note">
              Adding {assignments.length} drives at once. Google Calendar and Outlook support one event at a time — use Apple Calendar (.ics) to import all drives together.
            </p>
          )}
          <button className="calendar-sheet-option" data-testid="calendar-apple" onClick={handleApple}>
            <span className="calendar-sheet-icon"><CalendarIcon width="18" height="18" /></span>
            <span className="calendar-sheet-label">
              {isBulk ? "Apple Calendar (.ics — all drives)" : "Apple Calendar (.ics)"}
            </span>
            <ChevronRightIcon />
          </button>
        </div>
      </BottomSheet>
    </>
  );
}

function DriveDetailScreen({
  entry,
  trip,
  serviceDate,
  onBack,
}: {
  entry: ScheduleRosterEntry;
  trip: Tables<"trips">;
  serviceDate: string;
  onBack: () => void;
}) {
  const dateLabel = new Date(serviceDate + "T00:00:00").toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
  const directionLabel = trip.direction === "morning" ? "Morning" : "Afternoon";
  const driverName = entry.driverProfile.full_name;
  const vehicleLabel = entry.vehicle.label;
  const seats = entry.vehicle.child_passenger_capacity;
  const children = entry.children;

  return (
    <div className="screen-content drive-detail-screen" data-testid="drive-detail-screen">
      <header className="subpage-header">
        <button className="icon-button" onClick={onBack} aria-label="Back"><Cross2Icon /></button>
        <div><span className="eyebrow">{dateLabel}</span><h1>{directionLabel} drive</h1></div>
      </header>

      <section className="drive-detail-meta">
        <div className="drive-detail-row">
          <span className="drive-detail-label">Time</span>
          <strong>{trip.meeting_time}</strong>
        </div>
        <div className="drive-detail-row">
          <span className="drive-detail-label">Route</span>
          <strong>{trip.origin} → {trip.destination}</strong>
        </div>
        <div className="drive-detail-row">
          <span className="drive-detail-label">Driver</span>
          <strong>{driverName}</strong>
        </div>
        <div className="drive-detail-row">
          <span className="drive-detail-label">Vehicle</span>
          <strong>{vehicleLabel} · {seats} seats</strong>
        </div>
      </section>

      <section className="drive-detail-children">
        <h2>Children on this drive ({children.length})</h2>
        {children.length === 0 ? (
          <p className="helper-copy">No children assigned to this drive.</p>
        ) : (
          <div className="child-photo-grid">
            {children.map((child) => (
              <div key={child.id} className="child-photo-card" data-testid="child-photo-card">
                <span className="child-photo-thumb">
                  {child.photo_url ? <img src={child.photo_url} alt="" /> : <PersonIcon />}
                </span>
                <strong>{child.first_name} {child.last_name}</strong>
              </div>
            ))}
          </div>
        )}
      </section>
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
  const [groupChildren, setGroupChildren] = useState<Tables<"children">[]>([]);
  const [weekData, setWeekData] = useState<WeekWithTrips | null>(null);
  const [weekLoading, setWeekLoading] = useState(false);
  const [weekError, setWeekError] = useState<string | null>(null);
  const [planWeekData, setPlanWeekData] = useState<WeekWithTrips | null>(null);
  const [planWeekLoading, setPlanWeekLoading] = useState(false);
  const [planWeekError, setPlanWeekError] = useState<string | null>(null);
  const [allWeeks, setAllWeeks] = useState<Tables<"weeks">[]>([]);
  const [selectedWeekId, setSelectedWeekId] = useState<string | null>(null);
  const [viewWeekData, setViewWeekData] = useState<WeekWithTrips | null>(null);
  const [selectedPlanWeekId, setSelectedPlanWeekId] = useState<string | null>(null);
  const [planViewWeekData, setPlanViewWeekData] = useState<WeekWithTrips | null>(null);
  const [planViewWeekLoading, setPlanViewWeekLoading] = useState(false);
  const [checkin, setCheckin] = useState<Tables<"weekly_checkins"> | null>(null);
  const [checkinDetails, setCheckinDetails] = useState<CheckinDetails | null>(null);
  const [checkinLoading, setCheckinLoading] = useState(false);
  const [checkinError, setCheckinError] = useState<string | null>(null);
  const [overview, setOverview] = useState<WeekOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<ScheduleVersionWithRosters | null>(null);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [generateWarning, setGenerateWarning] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [confirmAllOpen, setConfirmAllOpen] = useState(false);
  const [myAssignments, setMyAssignments] = useState<MyDriverAssignment[]>([]);
  const [assignmentsLoading, setAssignmentsLoading] = useState(false);
  const [assignmentsError, setAssignmentsError] = useState<string | null>(null);
  const [declinedAlerts, setDeclinedAlerts] = useState<DeclinedDriveAlert[]>([]);
  const [uncoveredAlerts, setUncoveredAlerts] = useState<UncoveredChildAlert[]>([]);
  const [volunteerWorking, setVolunteerWorking] = useState(false);
  const [volunteerError, setVolunteerError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [confirmWorking, setConfirmWorking] = useState(false);
  const [pushSubscribing, setPushSubscribing] = useState(false);
  const [iosInstallDismissed, setIOSInstallDismissed] = useState(false);
  const [creatingWeek, setCreatingWeek] = useState(false);
  const [createWeekError, setCreateWeekError] = useState<string | null>(null);
  const [authWorking, setAuthWorking] = useState(false);
  const [authError, setAuthError] = useState<string | null>(() => oauthErrorFromLocation());
  const [activeTab, setActiveTab] = useState<AppTab>("home");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [driveDetailId, setDriveDetailId] = useState<string | null>(null);
  const [faqOpen, setFaqOpen] = useState(false);
  const [pushPermissionShown, setPushPermissionShown] = useState(false);

  // Register service worker for PWA push notifications
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch((err) => {
        console.error("[carpool] Service worker registration failed:", err);
      });
    }
  }, []);

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
      if (!group) throw new Error("The Carpool Crew group has not been configured.");
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
      const [setup, groupKids] = await Promise.all([
        repository.getHouseholdSetup(identity.membership.household_id),
        repository.listGroupChildren(identity.group.id),
      ]);
      setHouseholdSetup(setup);
      setGroupChildren(groupKids);
    } catch (error) {
      setHouseholdError(readableError(error));
    } finally {
      setHouseholdLoading(false);
    }
  }, [identity?.membership, identity?.group?.id, repository]);

  useEffect(() => {
    if (identity?.membership) void loadHousehold();
  }, [identity?.membership, loadHousehold]);

  const loadWeek = useCallback(async () => {
    if (!identity?.group) return;
    setWeekLoading(true);
    setWeekError(null);
    setPlanWeekLoading(true);
    setPlanWeekError(null);
    try {
      const data = await repository.getCurrentWeek(identity.group.id);
      setWeekData(data);
      const weeks = await repository.listWeeks(identity.group.id);
      setAllWeeks(weeks);
    } catch (error) {
      setWeekError(readableError(error));
    } finally {
      setWeekLoading(false);
    }
    try {
      const planData = await repository.getPlanWeek(identity.group.id);
      setPlanWeekData(planData);
    } catch (error) {
      setPlanWeekError(readableError(error));
    } finally {
      setPlanWeekLoading(false);
    }
  }, [identity?.group, repository]);

  const loadPlanViewWeek = useCallback(async () => {
    if (!selectedPlanWeekId) { setPlanViewWeekData(null); return; }
    setPlanViewWeekLoading(true);
    try {
      const data = await repository.getWeekById(selectedPlanWeekId);
      setPlanViewWeekData(data);
    } catch {
      setPlanViewWeekData(null);
    } finally {
      setPlanViewWeekLoading(false);
    }
  }, [selectedPlanWeekId, repository]);

  const activePlanWeek = useMemo(
    () => (selectedPlanWeekId ? planViewWeekData : planWeekData),
    [selectedPlanWeekId, planViewWeekData, planWeekData],
  );

  const loadCheckin = useCallback(async () => {
    if (!identity?.membership || !activePlanWeek) return;
    setCheckinLoading(true);
    setCheckinError(null);
    try {
      const checkinRow = await repository.getOrCreateCheckin(
        activePlanWeek.week.id, identity.membership.household_id, identity.group.id,
      );
      setCheckin(checkinRow);
      let details = await repository.getCheckinDetails(checkinRow.id);
      let needsReload = false;

      if (details.rideRequests.length === 0 && (householdSetup?.children.length ?? 0) > 0) {
        await repository.applyDefaultRideNeeds(
          checkinRow.id, identity.membership.household_id,
          activePlanWeek.trips, householdSetup!.children,
          identity.group.id, identity.profile.id,
        );
        needsReload = true;
      }

      const myDriveAvail = details.driverAvailability.filter(
        (a) => a.driver_profile_id === identity.profile.id,
      );
      if (myDriveAvail.length === 0) {
        const activeVehicle = householdSetup?.vehicles.find((v) => v.active) ?? null;
        await repository.applyDefaultDrivePreferences(
          checkinRow.id, identity.profile.id, activePlanWeek.trips,
          activeVehicle?.id ?? null, identity.group.id,
        );
        needsReload = true;
      }

      if (needsReload) {
        details = await repository.getCheckinDetails(checkinRow.id);
      }

      setCheckinDetails(details);
    } catch (error) {
      setCheckin(null);
      setCheckinDetails(null);
      setCheckinError(readableError(error));
    } finally {
      setCheckinLoading(false);
    }
  }, [identity?.membership, identity?.group, identity?.profile, activePlanWeek, householdSetup, repository]);

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
    void loadPlanViewWeek();
  }, [loadPlanViewWeek]);

  useEffect(() => {
    if (activePlanWeek) void loadCheckin();
  }, [activePlanWeek, loadCheckin]);

  useEffect(() => {
    if (activeTab === "coordinate" && weekData) void loadOverview();
  }, [activeTab, weekData, loadOverview]);

  const loadSchedule = useCallback(async () => {
    if (!identity?.group || !weekData) return;
    setScheduleLoading(true);
    setScheduleError(null);
    try {
      // Use selectedWeekId if set (week navigation), otherwise the current week.
      const viewWeek = selectedWeekId
        ? await repository.getWeekById(selectedWeekId)
        : weekData;
      setViewWeekData(viewWeek);
      if (!viewWeek) { setSchedule(null); return; }
      const roster = await repository.getGroupRoster(identity.group.id);
      const version = await repository.getLatestScheduleVersion(
        viewWeek.week.id, identity.group.id, viewWeek.trips,
        roster.children, roster.vehicles, roster.profiles,
      );
      setSchedule(version);
    } catch (error) {
      setSchedule(null);
      setScheduleError(readableError(error));
    } finally {
      setScheduleLoading(false);
    }
  }, [identity?.group, weekData, selectedWeekId, repository]);

  useEffect(() => {
    if (weekData) void loadSchedule();
  }, [weekData, selectedWeekId, loadSchedule]);

  useEffect(() => {
    if (activeTab === "week" && weekData) void loadSchedule();
  }, [activeTab, weekData, loadSchedule]);

  const generateSchedule = useCallback(async () => {
    if (!weekData) return;
    setGenerating(true);
    setGenerateError(null);
    setGenerateWarning(null);
    try {
      const result = await repository.generateDraftSchedule(weekData.week.id);
      if (!result.success) {
        setGenerateError(result.error ?? "Failed to generate schedule.");
      } else {
        await loadSchedule();
        await loadOverview();
        if (result.warning) {
          setGenerateWarning(result.warning);
        }
        // Notify parents of uncovered children
        if (result.version?.id) {
          void repository.sendPushNotification(null, result.version.id, "uncovered");
        }
      }
    } catch (error) {
      setGenerateError(readableError(error));
    } finally {
      setGenerating(false);
    }
  }, [weekData, repository, loadSchedule, loadOverview]);

  const subscribeToPush = useCallback(async () => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    setPushSubscribing(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") return;

      const reg = await navigator.serviceWorker.ready;
      const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;
      if (!vapidKey) return;

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKey,
      });

      const json = sub.toJSON();
      if (json.keys?.p256dh && json.keys?.auth) {
        await repository.savePushSubscription(
          sub.endpoint,
          json.keys.p256dh,
          json.keys.auth,
        );
      }
    } catch (err) {
      console.error("[carpool] Push subscription failed:", err);
    } finally {
      setPushSubscribing(false);
    }
  }, [repository]);

  // iOS Safari doesn't support PushManager until the app is installed as a PWA.
  // Show install instructions instead of the standard push permission banner.
  const shouldShowIOSInstallBanner = (() => {
    if (!identity) return false;
    if (iosInstallDismissed) return false;
    if (localStorage.getItem("ios_install_dismissed") === "true") return false;
    const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
    const isStandalone = window.matchMedia("(display-mode: standalone)").matches;
    const hasPushSupport = "serviceWorker" in navigator && "PushManager" in window;
    return isIOS && !isStandalone && !hasPushSupport;
  })();

  const shouldShowPushBanner = (() => {
    if (!identity) return false;
    if (pushPermissionShown) return false;
    if (typeof Notification === "undefined") return false;
    if (Notification.permission !== "default") return false;
    if (localStorage.getItem("push_dismissed") === "true") return false;
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return false;
    return true;
  })();

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

      // Load declined drive alerts and uncovered children for affected parents
      const [alerts, uncovered] = await Promise.all([
        repository.getAffectedDeclinedDrives(
          schedule.version.id,
          identity.profile.id,
          identity.group.id,
        ),
        repository.getUncoveredChildren(
          schedule.version.id,
          identity.profile.id,
          identity.group.id,
        ),
      ]);
      setDeclinedAlerts(alerts);
      setUncoveredAlerts(uncovered);
    } catch (error) {
      setMyAssignments([]);
      setDeclinedAlerts([]);
      setUncoveredAlerts([]);
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
    setConfirmError(null);
    try {
      for (const entry of tentative) {
        await repository.respondToDriverAssignment(entry.assignment.id, "confirmed");
      }
      await loadMyAssignments();
    } catch (error) {
      setConfirmError(readableError(error));
      await loadMyAssignments();
    } finally {
      setConfirmWorking(false);
    }
  }, [myAssignments, repository, loadMyAssignments]);

  const volunteerForDrive = useCallback(async (assignmentId: string) => {
    setVolunteerWorking(true);
    setVolunteerError(null);
    try {
      await repository.volunteerForDrive(assignmentId);
      await loadMyAssignments();
      await loadSchedule();
    } catch (error) {
      setVolunteerError(readableError(error));
    } finally {
      setVolunteerWorking(false);
    }
  }, [repository, loadMyAssignments, loadSchedule]);

  const publishSchedule = useCallback(async () => {
    if (!schedule) return;
    setPublishing(true);
    try {
      await repository.publishSchedule(schedule.version.id);
      await repository.sendPushNotification(null, schedule.version.id, "published");
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

    void supabase.auth.getSession().then(async ({ data, error }) => {
      if (!mounted) return;
      if (error) setAuthError(readableError(error));
      setAuthInitialized(true);

      // Dev/staging test auth bypass: auto sign in with ?testAuth=email|password
      // Checked BEFORE the session check so switching demo accounts works even
      // when a session already exists (signs out the old user first).
      if (import.meta.env.DEV || isStaging) {
        const params = new URLSearchParams(window.location.search);
        const testAuth = params.get("testAuth");
        if (testAuth) {
          const [email, password] = testAuth.split("|");
          if (email && password) {
            // If existing session is for a different user, sign out first
            if (data.session && data.session.user?.email !== email) {
              await supabase.auth.signOut({ scope: "local" });
            }
            const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
            if (signInError) setAuthError(readableError(signInError));
            // Clean the URL so testAuth doesn't persist across reloads/navigation
            window.history.replaceState({}, document.title, window.location.pathname);
            // onAuthStateChange will handle setting session + loadIdentity
            return;
          }
        }
      }

      // Normal flow: no testAuth param
      setSession(data.session);
      if (data.session) {
        void loadIdentity();
      }
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
    // Strip testAuth from URL so reload doesn't re-sign-in
    if (window.location.search.includes("testAuth=")) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }
    try {
      const { error } = await supabase.auth.signOut({ scope: "local" });
      if (error) console.error("[signOut]", error);
    } catch (err) {
      console.error("[signOut]", err);
    }
    // Clear all state after signOut completes (not optimistically)
    setSession(null);
    setIdentity(null);
    setAccountOpen(false);
    setReviewOpen(false);
    setDirectoryOpen(false);
    setDriveDetailId(null);
    setFaqOpen(false);
    setActiveTab("home");
    setAuthWorking(false);
  };

  const navItems = useMemo(() => [
    { id: "home" as const, label: "Home", icon: HomeIcon },
    { id: "plan" as const, label: "Check-in", icon: BackpackIcon },
    { id: "week" as const, label: "Week", icon: CalendarIcon },
    { id: "coordinate" as const, label: "Status", icon: GroupIcon },
  ], []);

  const navigate = (tab: AppTab) => {
    setReviewOpen(false);
    setAccountOpen(false);
    setDirectoryOpen(false);
    setDriveDetailId(null);
    setFaqOpen(false);
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
          groupChildren={groupChildren}
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
          onDeclined={(assignmentId) => void repository.sendPushNotification(assignmentId, null, "declined")}
          timezone={identity.group.timezone}
        />
      );
    }

    if (directoryOpen && identity) {
      return (
        <DirectoryScreen
          groupId={identity.group.id}
          repository={repository}
          onBack={() => setDirectoryOpen(false)}
        />
      );
    }

    if (driveDetailId && identity && schedule) {
      const found = findDriveDetail(schedule, driveDetailId);
      if (found) {
        return (
          <DriveDetailScreen
            entry={found.entry}
            trip={found.trip}
            serviceDate={found.serviceDate}
            onBack={() => setDriveDetailId(null)}
          />
        );
      }
    }

    if (faqOpen && identity) {
      return <FaqScreen onBack={() => setFaqOpen(false)} />;
    }

    if (activeTab === "plan") {
      return (
        <PlanScreen
          week={activePlanWeek}
          weekLoading={selectedPlanWeekId ? planViewWeekLoading : planWeekLoading}
          weekError={selectedPlanWeekId ? null : planWeekError}
          checkin={checkin}
          checkinDetails={checkinDetails}
          checkinLoading={checkinLoading}
          checkinError={checkinError}
          setup={householdSetup}
          repository={repository}
          driverProfileId={identity.profile.id}
          groupId={identity.group.id}
          onReloadCheckin={loadCheckin}
          onReloadWeek={() => void loadWeek()}
          isCoordinator={identity.membership?.role === "coordinator"}
          onCreateWeek={() => void createWeek()}
          avatarUrl={identity.profile.avatar_url}
          onAccount={() => setAccountOpen(true)}
          allWeeks={allWeeks}
          selectedWeekId={selectedPlanWeekId}
          onSelectWeek={setSelectedPlanWeekId}
        />
      );
    }

    if (activeTab === "week") {
      return (
        <WeekScreen
          week={viewWeekData ?? weekData}
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
          weekStartsOn={weekData?.week.starts_on ?? null}
          allWeeks={allWeeks}
          selectedWeekId={selectedWeekId}
          onSelectWeek={(id) => { setSelectedWeekId(id); }}
          avatarUrl={identity.profile.avatar_url}
          onAccount={() => setAccountOpen(true)}
          onOpenDrive={(id) => setDriveDetailId(id)}
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
          declinedCount={schedule ? countDeclinedRosters(schedule) : 0}
          uncoveredCount={schedule ? countUncoveredTrips(schedule) : 0}
          generateWarning={generateWarning}
          avatarUrl={identity.profile.avatar_url}
          onAccount={() => setAccountOpen(true)}
        />
      );
    }

    return (
      <HomeScreen
        myAssignments={myAssignments}
        assignmentsLoading={assignmentsLoading}
        assignmentsError={assignmentsError}
        confirmError={confirmError}
        schedulePublished={schedule?.version.status === "published"}
        onConfirmAll={() => void confirmAll()}
        onReview={() => setReviewOpen(true)}
        onCoverage={() => navigate("week")}
        onDirectory={() => setDirectoryOpen(true)}
        onAccount={() => setAccountOpen(true)}
        onFaq={() => setFaqOpen(true)}
        onRetryAssignments={() => void loadMyAssignments()}
        onVolunteer={(assignmentId) => void volunteerForDrive(assignmentId)}
        working={confirmWorking}
        volunteerWorking={volunteerWorking}
        volunteerError={volunteerError}
        avatarUrl={identity.profile.avatar_url}
        weekStartsOn={weekData?.week.starts_on ?? null}
        confirmationDeadline={weekData?.week.confirmation_deadline ?? null}
        declinedAlerts={declinedAlerts}
        uncoveredAlerts={uncoveredAlerts}
        showPushBanner={shouldShowPushBanner}
        onAllowPush={() => { setPushPermissionShown(true); void subscribeToPush(); }}
        onDismissPush={() => { setPushPermissionShown(true); localStorage.setItem("push_dismissed", "true"); }}
        pushSubscribing={pushSubscribing}
        showIOSInstallBanner={shouldShowIOSInstallBanner}
        onDismissIOSInstall={() => { setIOSInstallDismissed(true); localStorage.setItem("ios_install_dismissed", "true"); }}
        timezone={identity.group.timezone}
      />
    );
  };

  if (!authInitialized || (session && identityLoading && !identity)) {
    return (
      <div className="prototype-shell">
        <MobileScroll className="app-screen">
          <main className="app-main" aria-label="Carpool Crew app">
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
          <main className="app-main" aria-label="Carpool Crew sign in">
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
          <main className="app-main" aria-label="Carpool Crew connection error">
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
          <main className="app-main" aria-label="Carpool Crew onboarding">
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
          <main className="app-main" aria-label="Carpool Crew app">
            <AuthLoadingScreen />
          </main>
        </MobileScroll>
      </div>
    );
  }

  return (
    <div className="prototype-shell">
      <AppErrorBoundary>
        <MobileScroll className="app-screen" key={activeTab}>
          <main className="app-main" aria-label="Carpool Crew app">
            {renderContent()}
          </main>
        </MobileScroll>
      </AppErrorBoundary>
      {!reviewOpen && !accountOpen && !directoryOpen && !driveDetailId && !faqOpen ? (
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
