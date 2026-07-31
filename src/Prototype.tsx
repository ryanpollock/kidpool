import { useMemo, useState } from "react";
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
  SunIcon,
} from "@radix-ui/react-icons";
import { MobileScroll } from "./mobile";

type AppTab = "home" | "plan" | "week" | "coordinate";
type DrivePreference = "prefer" | "available" | "no";

type DayPlan = {
  day: string;
  date: string;
  morningRide: boolean;
  afternoonRide: boolean;
  drive: DrivePreference;
};

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
}: {
  driverConfirmed: boolean;
  onConfirm: () => void;
  onReview: () => void;
  onCoverage: () => void;
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
        <button className="avatar-button" aria-label="Open household profile">
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
}: {
  plans: DayPlan[];
  setPlans: (next: DayPlan[]) => void;
  submitted: boolean;
  onSubmit: () => void;
}) {
  const updatePlan = (index: number, update: Partial<DayPlan>) => {
    setPlans(plans.map((plan, planIndex) => planIndex === index ? { ...plan, ...update } : plan));
  };

  const cycleDrive = (preference: DrivePreference): DrivePreference => {
    if (preference === "prefer") return "available";
    if (preference === "available") return "no";
    return "prefer";
  };

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
        <div className="section-heading-row"><h2>Alex’s rides</h2><span>Tap to change</span></div>
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
        <span><strong>Blue Subaru · 4 passenger seats</strong><small>Includes Alex when riding</small></span>
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

export default function Prototype() {
  const [activeTab, setActiveTab] = useState<AppTab>("home");
  const [reviewOpen, setReviewOpen] = useState(false);
  const [driverConfirmed, setDriverConfirmed] = useState(false);
  const [plans, setPlans] = useState(initialPlans);
  const [planSubmitted, setPlanSubmitted] = useState(false);
  const [backupRequested, setBackupRequested] = useState(false);

  const navItems = useMemo(() => [
    { id: "home" as const, label: "Home", icon: HomeIcon },
    { id: "plan" as const, label: "Plan", icon: BackpackIcon },
    { id: "week" as const, label: "Week", icon: CalendarIcon },
    { id: "coordinate" as const, label: "Cover", icon: GroupIcon },
  ], []);

  const navigate = (tab: AppTab) => {
    setReviewOpen(false);
    setActiveTab(tab);
  };

  const renderContent = () => {
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
      />
    );
  };

  return (
    <div className="prototype-shell">
      <MobileScroll className="app-screen">
        <main className="app-main" aria-label="Midtown Carpool app">
          {renderContent()}
        </main>
      </MobileScroll>
      {!reviewOpen ? (
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
