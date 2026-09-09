# Mobile runtime components

## Carousel

`Carousel` is the standard component for horizontal collections: cards, images, media, swipeable items, and chip or filter rails. Place it directly inside `MobileScroll`; consumers should not add gesture wrappers or pointer handlers.

```tsx
<MobileScroll>
  <section>
    <Carousel
      ariaLabel="Event details"
      className="event-carousel"
      contentClassName="event-carousel-track"
    >
      {cards}
    </Carousel>
  </section>
</MobileScroll>
```

The runtime resolves nested gestures by axis. Horizontal intent stays with `Carousel`; vertical intent is handed to the parent `MobileScroll`. Slight vertical drift after a horizontal gesture is claimed does not move, rubber-band, or add momentum to the parent. Taps remain clickable, while a completed drag suppresses the item click.

Do not use `data-scroll-drag="ignore"` for carousels or ordinary rails. It is a hard opt-out that prevents parent scrolling in every direction. Do not layer CSS scroll snapping over the runtime's JavaScript momentum. If snapping is added later, it should be a component option so one system owns release motion.

## Keyboard-linked surfaces

Use `KeyboardInput`, `KeyboardTextarea`, or `MobileTextField` for all text entry. Position a composer, search surface, or other keyboard-linked UI from `useKeyboardInsets().bottomInset`. The inset is relative to the app viewport: Android's closed-keyboard viewport already ends above its navigation bar, while iOS still needs its overlaid home-indicator inset; both platforms return the keyboard height while the keyboard is open. Never pin those surfaces to only `keyboardHeight`. When that surface closes, call `keyboard.hide()` in the same event before updating its own open state.

## BottomSheet

`BottomSheet` dismisses the keyboard before opening and animates both in and out by default. Keep its `open` state controlled through `onOpenChange`; no consumer exit-animation wrapper is needed.

`BottomSheet` uses `useScreenPortal()` to portal into the device screen. In dev, `PhoneFrame` provides this context. In production (frameless `MobileRuntime`), `ScreenPortalContext` is provided with a ref on the `mobile-runtime-frameless` container, so `BottomSheet` works in both runtimes.

The sheet sizes itself from the **measured portal box** (`snap` of the portal height, default 0.72), never from `device.geometry` — geometry is all zeros in the frameless production runtime, and sizing from it collapsed every production sheet to the 260px minimum. A `ResizeObserver` tracks URL-bar collapse and rotation. The sheet is content-sized up to that cap; overflowing content scrolls inside `.sheet-content`.

The handle has two-tier snap semantics: it opens at `snap`, a drag up on the handle expands it to 94% of the portal (the sheet stretches so the gesture is always visible), a drag down from the expanded snap collapses back to `snap`, and a drag down from `snap` dismisses. On iOS the sheet clears `env(safe-area-inset-bottom)` (the portal's `--device-safe-area-bottom`) while the keyboard is closed and rides directly above the keyboard while open.

`MobileRuntime` accepts a test-only `frameless` prop to mount the production runtime inside a dev build — the geometry/sizing paths that only run when `import.meta.env.PROD` is true have no other automated coverage (`tests/runtime-fixture-frameless.html`).
