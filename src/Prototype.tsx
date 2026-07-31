import { useCallback, useEffect, useMemo, useState } from "react";
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
  type HouseholdSetup,
  type Tables,
} from "./lib/supabase";

type AppTab = "home" | "plan" | "week" | "coordinate";
type DrivePreference = "prefer" | "available" | "no";

type DayPlan = {
  day: string;
  date: string;
  morningRide: boolean;
  afternoonRide: boolean;
  drive: DrivePreference;
};

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

const initialPlans: DayPlan[] = [
  { day: "Mon", date: "Aug 3", morningRide: true, afternoonRide: true, drive: "prefer" },
  { day: "Tue", date: "Aug 4", morningRide: true, afternoonRide: true, drive: "no" },
  { day: "Wed", date: "Aug 5", morningRide: true, afternoonRide: false, drive: "available" },
  { day: "Thu", date: "Aug 6", morningRide: true, afternoonRide: true, drive: "available" },
  { day: "Fri", date: "Aug 7", morningRide: true, afternoonRide: true, drive: "no" },
];

const weeklyTrips = [
  { day: "Mon", date: "Aug 3", am: "You drive", pm: "Priya drives", status: "covered" },
  { day: "Tue", date: "Aug 4", am: "Miguel drives", pm: "Needs driver", status: "uncovered" },
  { day: "Wed", date: "Aug 5", am: "Jordan drives", pm: "Not riding", status: "covered" },
  { day: "Thu", date: "Aug 6", am: "Lee drives", pm: "You drive", status: "covered" },
  { day: "Fri", date: "Aug 7", am: "Priya drives", pm: "Sam drives", status: "covered" },
];

function AssignmentRow({
  period,
  date,
  route,
  riders,
  confirmed,
}: {
  period: "Morning" | "Afternoon";
  date: string;
  route: string;
  riders: number;
  confirmed: boolean;
}) {
  const PeriodIcon = period === "Morning" ? SunIcon : MoonIcon;

  return (
    <article className="assignment-row">
      <span className={`period-icon ${period === "Morning" ? "period-icon--morning" : "period-icon--afternoon"}`}>
        <PeriodIcon width="22" height="22" />
      </span>
      <div className="assignment-copy">
        <div className="assignment-title">{date} · {period}</div>
        <div className="assignment-route">{route}</div>
        <div className="assignment-meta">
          <span>Blue Subaru</span>
          <span>{riders} riders</span>
        </div>
      </div>
      <span className={`status-label ${confirmed ? "status-label--confirmed" : "status-label--tentative"}`}>
        {confirmed ? <CheckIcon width="13" height="13" /> : null}
        {confirmed ? "Confirmed" : "Tentative"}
      </span>
    </article>
  );
}

function HomeScreen({
  driverConfirmed,
  onConfirm,
  onReview,
  onCoverage,
  onAccount,
}: {
  driverConfirmed: boolean;
  onConfirm: () => void;
  onReview: () => void;
  onCoverage: () => void;
  onAccount: () => void;
}) {
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

      <section className={`confirmation-hero ${driverConfirmed ? "confirmation-hero--done" : ""}`}>
        <span className="eyebrow">{driverConfirmed ? "Sunday schedule" : "Action needed today"}</span>
        <h1>{driverConfirmed ? "You’re all set" : "Confirm your drives"}</h1>
        <p className="hero-deadline">
          {driverConfirmed ? (
            <><CheckCircledIcon width="18" height="18" /> 2 assignments confirmed</>
          ) : (
            <>2 assignments <span aria-hidden="true">·</span> <strong>Confirm by 3:00 PM</strong></>
          )}
        </p>
        <p className="hero-support">
          {driverConfirmed
            ? "We’ll remind you the evening before each drive."
            : "These are tentative until you accept them. Opening this schedule does not count as confirmation."}
        </p>
      </section>

      <section className="assignment-section" aria-labelledby="assignment-heading">
        <div className="section-heading-row">
          <h2 id="assignment-heading">{driverConfirmed ? "Your confirmed drives" : "Your tentative drives"}</h2>
          <span>Aug 3–7</span>
        </div>
        <div className="assignment-list">
          <AssignmentRow
            period="Morning"
            date="Mon, Aug 3"
            route="Midtown Terrace → Presidio"
            riders={3}
            confirmed={driverConfirmed}
          />
          <AssignmentRow
            period="Afternoon"
            date="Thu, Aug 6"
            route="Presidio → Midtown Terrace"
            riders={3}
            confirmed={driverConfirmed}
          />
        </div>
        {!driverConfirmed ? (
          <>
            <button className="primary-button" data-testid="confirm-drives" onClick={onConfirm}>
              <CheckIcon width="19" height="19" /> Confirm both drives
            </button>
            <button className="text-button" onClick={onReview}>Review individually</button>
          </>
        ) : (
          <button className="secondary-button" onClick={onReview}>View passenger rosters <ChevronRightIcon /></button>
        )}
      </section>

      <button className="coverage-alert" onClick={onCoverage} data-testid="coverage-alert">
        <span><ExclamationTriangleIcon width="20" height="20" /></span>
        <span><strong>Coverage needed</strong><small>Tue, Aug 4 · Afternoon return</small></span>
        <ChevronRightIcon />
      </button>

      <section className="week-glance" aria-labelledby="week-heading">
        <div className="section-heading-row">
          <h2 id="week-heading">Your week at a glance</h2>
          <button className="inline-action" onClick={onCoverage}>Full week</button>
        </div>
        <div className="glance-rows">
          <div><strong>Mon, Aug 3</strong><span>Morning drive</span><span className={driverConfirmed ? "positive" : "tentative"}>{driverConfirmed ? "Confirmed" : "Tentative"}</span></div>
          <div><strong>Tue, Aug 4</strong><span>No drive scheduled</span><span>—</span></div>
          <div><strong>Thu, Aug 6</strong><span>Afternoon drive</span><span className={driverConfirmed ? "positive" : "tentative"}>{driverConfirmed ? "Confirmed" : "Tentative"}</span></div>
        </div>
      </section>

    </div>
  );
}

function ReviewScreen({
  driverConfirmed,
  onConfirm,
  onBack,
}: {
  driverConfirmed: boolean;
  onConfirm: () => void;
  onBack: () => void;
}) {
  return (
    <div className="screen-content detail-screen" data-testid="review-screen">
      <header className="subpage-header">
        <button onClick={onBack} aria-label="Back to home"><Cross2Icon /></button>
        <div><span className="eyebrow">Sunday confirmation</span><h1>Review your drives</h1></div>
      </header>
      <p className="detail-intro">Confirm each assignment only if the date, direction, vehicle, and seat count are correct.</p>
      <div className="detail-card">
        <AssignmentRow period="Morning" date="Mon, Aug 3" route="Midtown Terrace → Presidio" riders={3} confirmed={driverConfirmed} />
        <div className="roster">
          <span>Passenger roster</span>
          <strong>Alex M. · Jordan K. · Sam R.</strong>
          <small>Meet at 7:35 AM · Depart at 7:40 AM</small>
        </div>
      </div>
      <div className="detail-card">
        <AssignmentRow period="Afternoon" date="Thu, Aug 6" route="Presidio → Midtown Terrace" riders={3} confirmed={driverConfirmed} />
        <div className="roster">
          <span>Passenger roster</span>
          <strong>Alex M. · Priya S. · Lee A.</strong>
          <small>Meet at 3:20 PM · Blue Subaru</small>
        </div>
      </div>
      {!driverConfirmed ? (
        <>
          <button className="primary-button" onClick={onConfirm}><CheckIcon /> Confirm both drives</button>
          <button className="decline-button">I can’t make one of these</button>
        </>
      ) : (
        <div className="success-notice"><CheckCircledIcon /><span><strong>Both drives confirmed</strong><small>Your family schedule is ready.</small></span></div>
      )}
    </div>
  );
}

function PlanScreen({
  plans,
  setPlans,
  submitted,
  onSubmit,
  setup,
}: {
  plans: DayPlan[];
  setPlans: (next: DayPlan[]) => void;
  submitted: boolean;
  onSubmit: () => void;
  setup: HouseholdSetup | null;
}) {
  const updatePlan = (index: number, update: Partial<DayPlan>) => {
    setPlans(plans.map((plan, planIndex) => planIndex === index ? { ...plan, ...update } : plan));
  };

  const cycleDrive = (preference: DrivePreference): DrivePreference => {
    if (preference === "prefer") return "available";
    if (preference === "available") return "no";
    return "prefer";
  };

  const firstChild = setup?.children.find((child) => child.active) ?? null;
  const activeVehicle = setup?.vehicles.find((vehicle) => vehicle.active) ?? null;
  const ridesLabel = firstChild ? `${firstChild.first_name}’s rides` : "Your rides";
  const vehicleLabel = activeVehicle ? activeVehicle.label : "No vehicle set up";
  const vehicleSeats = activeVehicle ? `${activeVehicle.child_passenger_capacity} passenger seats` : "Add a vehicle in your account";
  const vehicleNote = activeVehicle ? "Includes your children when riding" : "Open your account to add one";

  return (
    <div className="screen-content plan-screen" data-testid="plan-screen">
      <header className="page-title">
        <span className="eyebrow">Saturday check-in</span>
        <h1>Plan next week</h1>
        <p>Aug 3–7 · Prefilled from your normal routine</p>
      </header>

      {submitted ? (
        <div className="success-banner">
          <CheckCircledIcon width="24" height="24" />
          <span><strong>Week submitted</strong><small>We’ll send proposed drives Sunday morning.</small></span>
        </div>
      ) : null}

      <section className="planning-section">
        <div className="section-heading-row"><h2>{ridesLabel}</h2><span>Tap to change</span></div>
        <div className="day-plan-list">
          {plans.map((plan, index) => (
            <div className="day-plan-row" key={plan.day}>
              <div className="day-label"><strong>{plan.day}</strong><span>{plan.date}</span></div>
              <button
                className={plan.morningRide ? "ride-toggle ride-toggle--on" : "ride-toggle"}
                onClick={() => updatePlan(index, { morningRide: !plan.morningRide })}
                aria-pressed={plan.morningRide}
                aria-label={`${plan.day} morning ride`}
              >
                <SunIcon /> AM
              </button>
              <button
                className={plan.afternoonRide ? "ride-toggle ride-toggle--on" : "ride-toggle"}
                onClick={() => updatePlan(index, { afternoonRide: !plan.afternoonRide })}
                aria-pressed={plan.afternoonRide}
                aria-label={`${plan.day} afternoon ride`}
              >
                <MoonIcon /> PM
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="planning-section">
        <div className="section-heading-row"><h2>Your driving availability</h2><span>Max 2 drives</span></div>
        <p className="helper-copy">Tap each day to cycle through prefer, can if needed, and unavailable.</p>
        <div className="drive-preference-list">
          {plans.map((plan, index) => (
            <button
              key={plan.day}
              className={`preference-row preference-row--${plan.drive}`}
              onClick={() => updatePlan(index, { drive: cycleDrive(plan.drive) })}
            >
              <span><strong>{plan.day}, {plan.date}</strong><small>Any direction</small></span>
              <span>{plan.drive === "prefer" ? "Prefer to drive" : plan.drive === "available" ? "Can if needed" : "Unavailable"}</span>
            </button>
          ))}
        </div>
      </section>

      <div className="vehicle-summary">
        <span><DashboardIcon /></span>
        <span><strong>{vehicleLabel} · {vehicleSeats}</strong><small>{vehicleNote}</small></span>
        <ChevronRightIcon />
      </div>

      <button className="primary-button" data-testid="submit-plan" onClick={onSubmit}>
        {submitted ? "Update my week" : "Submit my week"}
      </button>
    </div>
  );
}

function WeekScreen({ driverConfirmed }: { driverConfirmed: boolean }) {
  return (
    <div className="screen-content week-screen" data-testid="week-screen">
      <header className="page-title">
        <span className="eyebrow">Family schedule</span>
        <h1>Aug 3–7</h1>
        <p>{driverConfirmed ? "Your drives are confirmed" : "2 drives still need your confirmation"}</p>
      </header>
      <div className="week-status-strip">
        <span><CheckCircledIcon /> 9 covered</span>
        <span><ExclamationTriangleIcon /> 1 uncovered</span>
      </div>
      <div className="week-list">
        {weeklyTrips.map((trip) => (
          <article className="week-day" key={trip.day}>
            <div className="week-date"><strong>{trip.day}</strong><span>{trip.date}</span></div>
            <div className="leg">
              <SunIcon /><span><small>Morning</small><strong>{trip.am}</strong></span>
              {trip.am === "You drive" ? <span className={driverConfirmed ? "mini-status mini-status--confirmed" : "mini-status"}>{driverConfirmed ? "Confirmed" : "Tentative"}</span> : null}
            </div>
            <div className={`leg ${trip.status === "uncovered" ? "leg--alert" : ""}`}>
              <MoonIcon /><span><small>Afternoon</small><strong>{trip.pm}</strong></span>
              {trip.pm === "You drive" ? <span className={driverConfirmed ? "mini-status mini-status--confirmed" : "mini-status"}>{driverConfirmed ? "Confirmed" : "Tentative"}</span> : null}
              {trip.status === "uncovered" ? <span className="mini-status mini-status--alert">3 seats short</span> : null}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function CoordinatorScreen({
  backupRequested,
  onRequestBackup,
}: {
  backupRequested: boolean;
  onRequestBackup: () => void;
}) {
  return (
    <div className="screen-content coordinator-screen" data-testid="coordinator-screen">
      <header className="page-title">
        <span className="eyebrow">Coordinator view</span>
        <h1>Weekly coverage</h1>
        <p>Aug 3–7 · Confirmed seats only</p>
      </header>

      <section className="coverage-summary">
        <div><strong>9</strong><span>Covered trips</span></div>
        <div className="coverage-summary--alert"><strong>1</strong><span>Needs action</span></div>
      </section>

      <section className="shortfall-panel">
        <div className="shortfall-heading">
          <span><ExclamationTriangleIcon /></span>
          <div><strong>Tuesday afternoon</strong><small>Presidio → Midtown Terrace</small></div>
          <span className="shortfall-count">3 seats short</span>
        </div>
        <div className="capacity-line">
          <span><i style={{ width: "62%" }} /></span>
          <small>8 of 11 seats confirmed</small>
        </div>
        <div className="unassigned-list">
          <span>Unassigned riders</span>
          <strong>Alex M. · Jordan K. · Sam R.</strong>
        </div>
        <button className="primary-button" onClick={onRequestBackup}>
          {backupRequested ? <CheckIcon /> : <GroupIcon />}
          {backupRequested ? "Backup request sent" : "Request backup drivers"}
        </button>
        <small className="deadline-note"><ClockIcon /> Recovery deadline: Monday at 8:00 PM</small>
      </section>

      <section className="coverage-table">
        <div className="section-heading-row"><h2>All trips</h2><span>Confirmed seats</span></div>
        {[
          ["Mon · AM", "12 / 12", "Covered"],
          ["Mon · PM", "10 / 10", "Covered"],
          ["Tue · AM", "12 / 12", "Covered"],
          ["Tue · PM", "8 / 11", "Uncovered"],
          ["Wed · AM", "11 / 11", "Covered"],
        ].map(([trip, seats, status]) => (
          <div className="coverage-row" key={trip}>
            <strong>{trip}</strong><span>{seats}</span><span className={status === "Covered" ? "positive" : "negative"}>{status}</span>
          </div>
        ))}
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
  const [authWorking, setAuthWorking] = useState(false);
  const [authError, setAuthError] = useState<string | null>(() => oauthErrorFromLocation());
  const [activeTab, setActiveTab] = useState<AppTab>("home");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [driverConfirmed, setDriverConfirmed] = useState(false);
  const [plans, setPlans] = useState(initialPlans);
  const [planSubmitted, setPlanSubmitted] = useState(false);
  const [backupRequested, setBackupRequested] = useState(false);

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
          driverConfirmed={driverConfirmed}
          onConfirm={() => setDriverConfirmed(true)}
          onBack={() => setReviewOpen(false)}
        />
      );
    }

    if (activeTab === "plan") {
      return (
        <PlanScreen
          plans={plans}
          setPlans={setPlans}
          submitted={planSubmitted}
          onSubmit={() => setPlanSubmitted(true)}
          setup={householdSetup}
        />
      );
    }

    if (activeTab === "week") {
      return <WeekScreen driverConfirmed={driverConfirmed} />;
    }

    if (activeTab === "coordinate") {
      return <CoordinatorScreen backupRequested={backupRequested} onRequestBackup={() => setBackupRequested(true)} />;
    }

    return (
      <HomeScreen
        driverConfirmed={driverConfirmed}
        onConfirm={() => setDriverConfirmed(true)}
        onReview={() => setReviewOpen(true)}
        onCoverage={() => navigate("week")}
        onAccount={() => setAccountOpen(true)}
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
      <MobileScroll className="app-screen">
        <main className="app-main" aria-label="Midtown Carpool app">
          {renderContent()}
        </main>
      </MobileScroll>
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
              {id === "home" && !driverConfirmed ? <i aria-label="Action needed" /> : null}
            </button>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
