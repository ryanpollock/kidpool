import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { BottomSheet, MobileRuntime } from "../src/mobile";
import "../src/styles.css";
import "./runtime-fixture.css";

// Frameless production runtime fixture. MobileRuntime runs its frameless
// branch via the `frameless` prop so the geometry/sizing paths that only
// execute when import.meta.env.PROD is true can be tested in a dev build —
// the exact paths that let production sheets collapse to the 260px floor
// (device geometry is all zeros in the frameless runtime).
function FramelessSheetFixture() {
  const [sheetOpen, setSheetOpen] = useState(false);

  return (
    <MobileRuntime frameless>
      <div className="fixture-screen" data-testid="frameless-screen">
        <main className="fixture-content">
          <h1>Frameless runtime fixture</h1>
          <button className="sheet-trigger" type="button" onClick={() => setSheetOpen(true)}>
            Open sheet
          </button>
        </main>
      </div>
      <BottomSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        title="Frameless sheet"
        description="Sized from the real viewport, not device geometry."
        snap={0.72}
      >
        <div data-testid="frameless-sheet-content" style={{ height: 1600 }}>
          <p>Tall form content</p>
        </div>
      </BottomSheet>
    </MobileRuntime>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <FramelessSheetFixture />
  </StrictMode>,
);