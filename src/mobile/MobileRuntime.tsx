import { useEffect, useMemo, useRef, type PropsWithChildren } from "react";
import { browserDevice, MobileDeviceProvider, useMobileDevice } from "./Device";
import { KeyboardDock, KeyboardProvider, useKeyboard } from "./Keyboard";
import { PhoneFrame, ScreenPortalContext } from "./PhoneFrame";
import { HomeIndicator, StatusBar } from "./components";

export function MobileRuntime({ children }: PropsWithChildren) {
  const framelessScreenRef = useRef<HTMLDivElement | null>(null);
  const framelessPortalValue = useMemo(
    () => ({ screenRef: framelessScreenRef }),
    [],
  );

  if (import.meta.env.PROD) {
    return (
      <MobileDeviceProvider device={browserDevice}>
        <KeyboardProvider>
          <ScreenPortalContext.Provider value={framelessPortalValue}>
            <div className="mobile-runtime-frameless" ref={framelessScreenRef}>
              <MobileAppViewport>{children}</MobileAppViewport>
            </div>
          </ScreenPortalContext.Provider>
        </KeyboardProvider>
      </MobileDeviceProvider>
    );
  }

  return (
    <MobileDeviceProvider>
      <PhoneFrame>
        <KeyboardProvider>
          <KeyboardPreview />
          <StatusBar />
          <MobileAppViewport>{children}</MobileAppViewport>
          <HomeIndicator />
          <KeyboardDock />
        </KeyboardProvider>
      </PhoneFrame>
    </MobileDeviceProvider>
  );
}

function MobileAppViewport({ children }: PropsWithChildren) {
  const { device } = useMobileDevice();
  const keyboard = useKeyboard();

  return (
    <div
      className="mobile-app-viewport"
      data-keyboard-visible={keyboard.visible ? "true" : "false"}
      data-platform={device.platform}
      data-testid="mobile-app-viewport"
    >
      {children}
    </div>
  );
}

function KeyboardPreview() {
  const keyboard = useKeyboard();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("keyboard") === "1") {
      keyboard.show();
    }
  }, [keyboard]);

  return null;
}