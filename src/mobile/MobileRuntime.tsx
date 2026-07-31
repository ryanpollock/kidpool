import { useEffect, type PropsWithChildren } from "react";
import { browserDevice, MobileDeviceProvider, useMobileDevice } from "./Device";
import { KeyboardDock, KeyboardProvider, useKeyboard } from "./Keyboard";
import { PhoneFrame } from "./PhoneFrame";
import { HomeIndicator, StatusBar } from "./components";

export function MobileRuntime({ children }: PropsWithChildren) {
  if (import.meta.env.PROD) {
    return (
      <MobileDeviceProvider device={browserDevice}>
        <KeyboardProvider>
          <div className="mobile-runtime-frameless">
            <MobileAppViewport>{children}</MobileAppViewport>
          </div>
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