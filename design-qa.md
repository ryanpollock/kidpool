# Design QA

> Note: Reference images referenced below are kept locally (gitignored) and are not in the repository.

## Evidence

- Source visual truth: `/Users/ryanpollock/Code/clarendon-presidio carpool/carpool-app/design-reference.png`
- Normalized source: `/Users/ryanpollock/Code/clarendon-presidio carpool/carpool-app/design-reference-normalized.png`
- Final implementation capture: `/Users/ryanpollock/Code/clarendon-presidio carpool/carpool-app/implementation-mobile-screen-final.png`
- Final side-by-side comparison: `/Users/ryanpollock/Code/clarendon-presidio carpool/carpool-app/design-comparison-final.png`
- Browser-rendered stage capture: `/Users/ryanpollock/Code/clarendon-presidio carpool/carpool-app/implementation-stage-final.png`
- Source pixels: 853 × 1844, normalized to 393 × 852.
- Implementation pixels: 393 × 852.
- CSS app viewport: 393 × 852.
- Browser viewport: 1400 × 1200.
- Device scale factor: 1.
- State: iPhone, Sunday morning, two tentative driving assignments awaiting confirmation.

The source omits operating-system and device chrome. The implementation capture includes the mobile template's protected live status bar and iOS home indicator. Fidelity was judged on app-owned content; the template-owned chrome was preserved as required.

## Full-view comparison

The selected visual and implementation were placed together in `design-comparison-final.png` before judgment.

The implementation preserves the source's primary hierarchy:

1. Identity and carpool context.
2. Dominant "Confirm your drives" headline.
3. Explicit number of assignments and deadline.
4. Two individually legible tentative drive assignments.
5. One unmistakable confirmation action.
6. Secondary individual-review action.
7. Visible coverage warning.

The interactive implementation adds persistent bottom navigation so the Saturday planning, weekly schedule, and coordinator-recovery flows can be tested. This is an intentional product addition that does not compete with or obscure the primary confirmation action.

## Focused comparison

The normalized 393 × 852 comparison keeps the hero, both assignment rows, confirmation button, and coverage warning readable at once, so an additional crop was not required. These are the fidelity-critical regions for the selected source.

## Required fidelity surfaces

### Fonts and typography

- The implementation uses Georgia for the high-contrast display headline and the system sans stack for utility text, closely matching the reference's serif/sans relationship.
- Hierarchy, weight, wrapping, and deadline emphasis match the source.
- Small operational copy remains readable without truncating dates, routes, or statuses.

### Spacing and layout rhythm

- The source's broad sequence and grouping are preserved.
- Assignment rows use simple separators rather than nested cards.
- The confirmation button remains above the fold.
- Protected device chrome and persistent navigation reduce available app-content height; less of the week-at-a-glance list is visible without scrolling. This is an accepted product/runtime constraint.

### Colors and visual tokens

- Deep navy, warm paper, restrained teal, amber, green, and red tokens match the source's calm utility palette.
- Tentative, confirmed, and uncovered states have distinct color and text labels; meaning does not depend on color alone.
- Contrast is appropriate for primary text, controls, and status messaging.

### Image quality and asset fidelity

- The reference contains no photography or custom raster illustration.
- App icons use the installed Radix icon library.
- No inline SVG, handcrafted SVG, emoji, CSS drawing, or placeholder raster asset was substituted for visible app imagery.
- Device bezel and status assets remain owned by the protected mobile runtime.

### Copy and content

- The primary headline, assignment count, deadline, dates, directions, vehicle, status, confirmation CTA, and review action match the selected source.
- The implementation adds a safety clarification that opening the schedule is not confirmation.
- The visible coverage warning reflects the product requirements and pressure-test data.

## Comparison history

### Iteration 1

- [P2] The coverage warning appeared below the initial visible app viewport after adding the persistent navigation and protected device chrome.
  - Impact: A safety-relevant shortfall could be missed without scrolling.
  - Fix: Moved the coverage warning directly below the confirmation actions and ahead of the week-at-a-glance section.
- [P2] The initial header used an icon whose grouping-box shape did not communicate a parent or household.
  - Impact: The app identity looked like a layout control.
  - Fix: Replaced it with the closest appropriate person icon from the installed icon library.

Post-fix evidence: `design-comparison-final.png` shows the coverage warning above the fixed navigation and the revised parent-oriented identity mark.

No actionable P0, P1, or P2 differences remain.

## Primary interactions tested

- Confirm both tentative drives; confirmed state and labels updated.
- Open the Saturday planning screen.
- Toggle a child's ride requirement.
- Submit the upcoming week's household plan.
- Open the full weekly schedule.
- Open coordinator coverage.
- Send a backup-driver request for an uncovered trip.
- Verified the visible success state after each core action.
- Checked captured browser console logs after the final render: no errors or warnings.

## Follow-up polish

- [P3] The source shows the entire five-day glance at once; the functional prototype scrolls to reveal the lower rows because it includes persistent navigation and live device chrome.
- [P3] A future brand pass can replace the generic parent icon after the carpool chooses a name and identity.

## Final result

final result: passed
