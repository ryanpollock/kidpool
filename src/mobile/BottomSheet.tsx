import {
  type PropsWithChildren,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useDrag } from "@use-gesture/react";
import { AnimatePresence, motion } from "motion/react";
import { useKeyboard, useKeyboardInsets } from "./Keyboard";
import { useScreenPortal } from "./PhoneFrame";
import { useMobileDevice } from "./Device";

type BottomSheetProps = PropsWithChildren<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  snap?: number;
}>;

// Two-tier snap semantics: the sheet opens at `snap` of the portal height and
// can be dragged up to EXPANDED_SNAP. Dragging down from the top snap
// collapses back to `snap`; dragging down from `snap` dismisses (the
// pre-existing behavior).
const EXPANDED_SNAP = 0.94;
const MIN_SHEET_HEIGHT = 260;
const DISMISS_DRAG_DISTANCE = 96;
const DISMISS_VELOCITY = 0.55;
const EXPAND_DRAG_DISTANCE = 48;
const EXPAND_VELOCITY = 0.55;
const KEYBOARD_MAX_DEDUCTION = 180;

export function BottomSheet({
  open,
  onOpenChange,
  title,
  description,
  snap = 0.72,
  children,
}: BottomSheetProps) {
  const { device } = useMobileDevice();
  const { screenRef } = useScreenPortal();
  const keyboard = useKeyboard();
  const { keyboardHeight } = useKeyboardInsets();
  const [dragY, setDragY] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [portal, setPortal] = useState<{ height: number; safeAreaBottom: number } | null>(null);
  const [nativeKeyboard, setNativeKeyboard] = useState(0);
  const lastMeasuredElement = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) keyboard.hide();
  }, [open]);

  // Every open starts collapsed, un-dragged, and keyboard-neutral.
  useEffect(() => {
    if (!open) {
      setExpanded(false);
      setDragY(0);
      setNativeKeyboard(0);
    }
  }, [open]);

  // Measure the real portal container — the phone screen in the dev frame,
  // the full-viewport frameless container in production. Device geometry is
  // deliberately all zeros in the frameless production runtime, so sizing
  // from it collapsed every production sheet to the MIN_SHEET_HEIGHT floor
  // (~260px regardless of `snap`). The portal's own box is correct in both
  // runtimes, and the ResizeObserver tracks URL-bar collapse and rotation.
  useLayoutEffect(() => {
    const element = screenRef.current;
    if (!element) return;
    lastMeasuredElement.current = element;

    const measure = () => {
      const style = getComputedStyle(element);
      const safeAreaRaw = parseFloat(style.getPropertyValue("--device-safe-area-bottom"));
      setPortal({
        height: element.clientHeight,
        safeAreaBottom: Number.isFinite(safeAreaRaw) ? safeAreaRaw : 0,
      });
    };
    measure();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      lastMeasuredElement.current = null;
    };
  }, [screenRef, open]);

  // Track the NATIVE keyboard while the sheet is open. Safari and Chrome
  // overlay the virtual keyboard on the visual viewport without resizing the
  // layout viewport, so a bottom-anchored sheet ends up underneath it —
  // there is no simulated KeyboardDock in production to shrink it. The
  // visual viewport's height (and pan offset) vs the layout viewport gives
  // the covered span; a width change means pinch-zoom, not a keyboard.
  useLayoutEffect(() => {
    if (!open) return;
    const viewport = window.visualViewport;
    if (!viewport) return;

    const update = () => {
      const covered = Math.max(
        0,
        window.innerHeight - viewport.height - viewport.offsetTop,
      );
      const zoomed = Math.abs(window.innerWidth - viewport.width) > 40;
      setNativeKeyboard(!zoomed && covered > 80 ? Math.round(covered) : 0);
    };
    update();

    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, [open]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      keyboard.hide();
    }

    onOpenChange(nextOpen);
  };

  const portalHeight = portal?.height ?? device.geometry.screen.height;
  const expandTravel = Math.round(portalHeight * (Math.max(snap, EXPANDED_SNAP) - snap));

  const bindDrag = useDrag(
    (state) => {
      const [, movementY] = state.movement;
      const [, velocityY] = state.velocity;
      const [, directionY] = state.direction;

      if (!state.last) {
        // Follow the finger: upward toward the expanded snap while collapsed,
        // downward toward collapse/dismiss in either state.
        const maxUpward = expanded ? 0 : -expandTravel;
        setDragY(Math.max(maxUpward, movementY));
        return;
      }

      const downward = Math.max(0, movementY);
      setDragY(0);

      if (expanded) {
        // Top snap: dragging down collapses back to the default snap.
        if (
          downward > EXPAND_DRAG_DISTANCE ||
          (velocityY > EXPAND_VELOCITY && directionY > 0)
        ) {
          setExpanded(false);
        }
        return;
      }

      const shouldExpand =
        movementY < -EXPAND_DRAG_DISTANCE ||
        (velocityY < -EXPAND_VELOCITY && directionY < 0);
      if (shouldExpand) {
        setExpanded(true);
        return;
      }

      const shouldDismiss =
        downward > DISMISS_DRAG_DISTANCE ||
        (velocityY > DISMISS_VELOCITY && directionY > 0);
      if (shouldDismiss) {
        onOpenChange(false);
      }
    },
    {
      axis: "y",
      filterTaps: true,
    },
  );

  const effectiveSnap = expanded ? Math.max(snap, EXPANDED_SNAP) : snap;
  const sheetHeight = Math.round(portalHeight * effectiveSnap);
  // The simulated dev keyboard deducts through the original cap; the native
  // keyboard deducts fully — capping it would leave the sheet's lower edge
  // buried under the real keyboard.
  const keyboardDeduction = Math.min(keyboardHeight, KEYBOARD_MAX_DEDUCTION) + nativeKeyboard;
  const effectiveHeight = Math.max(MIN_SHEET_HEIGHT, sheetHeight - keyboardDeduction);
  // iOS keeps clearing the home-indicator inset while the keyboard is closed
  // and rides directly above the keyboard once open. The portal's
  // --device-safe-area-bottom carries env(safe-area-inset-bottom) in the
  // frameless runtime and the simulated inset in the dev frame.
  const sheetBottom =
    device.platform === "android"
      ? Math.max(device.geometry.safeArea.bottom, keyboardHeight, nativeKeyboard)
      : Math.max(portal?.safeAreaBottom ?? device.geometry.safeArea.bottom, keyboardHeight, nativeKeyboard);
  const portalContainer = screenRef.current ?? undefined;

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      {/* Keep the portal mounted after `open` flips so AnimatePresence can run
          the sheet and overlay exit animations before Radix removes them. */}
      <Dialog.Portal container={portalContainer} forceMount>
        <AnimatePresence>
          {open ? (
            <>
              <Dialog.Overlay asChild forceMount>
                <motion.div
                  className="sheet-overlay"
                  data-testid="sheet-overlay"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.16 }}
                />
              </Dialog.Overlay>
              <Dialog.Content asChild forceMount>
                <motion.div
                  className="bottom-sheet"
                  data-testid="bottom-sheet"
                  style={{
                    bottom: sheetBottom,
                    maxHeight: effectiveHeight,
                    // Stretched to the full snap when expanded so the gesture
                    // is visible even when the content is shorter than the cap.
                    ...(expanded ? { height: sheetHeight } : {}),
                  }}
                  initial={{ y: effectiveHeight + 36 }}
                  animate={{ y: dragY }}
                  exit={{
                    y: effectiveHeight + 36,
                    transition: {
                      type: "spring",
                      stiffness: 250,
                      damping: 30,
                      mass: 1.05,
                    },
                  }}
                  transition={{
                    type: "spring",
                    stiffness: 500,
                    damping: 43,
                    mass: 0.9,
                  }}
                >
                  <div className="sheet-handle-zone" data-testid="sheet-handle" {...bindDrag()}>
                    <div className="sheet-handle" />
                  </div>
                  <div className="sheet-header">
                    <Dialog.Title className="sheet-title">{title}</Dialog.Title>
                    {description ? <Dialog.Description className="sheet-description">{description}</Dialog.Description> : null}
                  </div>
                  <div className="sheet-content">{children}</div>
                </motion.div>
              </Dialog.Content>
            </>
          ) : null}
        </AnimatePresence>
      </Dialog.Portal>
    </Dialog.Root>
  );
}