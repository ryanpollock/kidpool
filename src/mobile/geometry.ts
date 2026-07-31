export type MobileDeviceGeometry = {
  device: {
    width: number;
    height: number;
  };
  screen: {
    x: number;
    y: number;
    width: number;
    height: number;
    radius: number;
  };
  safeArea: {
    top: number;
    bottom: number;
  };
  keyboard: {
    height: number;
  };
};

export const iphoneGeometry = {
  // CSS-space coordinates for the 3x iPhone assets. Keep source PNG dimensions
  // divisible by 3 so the rendered phone frame lands on whole CSS pixels.
  device: {
    width: 511,
    height: 968,
  },
  screen: {
    x: 59,
    y: 58,
    width: 393,
    height: 852,
    radius: 42,
  },
  safeArea: {
    top: 54,
    bottom: 34,
  },
  keyboard: {
    height: 338,
  },
} as const satisfies MobileDeviceGeometry;

export const pixelGeometry = {
  // Pixel10.png is a 2x asset. Its 854 x 1904 screen opening renders at
  // exactly 427 x 952 CSS pixels inside the 566 x 1022 asset canvas.
  device: {
    width: 566,
    height: 1022,
  },
  screen: {
    x: 70,
    y: 35,
    width: 427,
    height: 952,
    radius: 58,
  },
  safeArea: {
    top: 64,
    bottom: 48,
  },
  keyboard: {
    height: 316,
  },
} as const satisfies MobileDeviceGeometry;

export const browserGeometry = {
  // Frameless geometry for production: fills the real viewport. Safe areas
  // are handled by CSS env(safe-area-inset-*), and the native keyboard
  // replaces the simulated KeyboardDock, so all values are zero.
  device: {
    width: 0,
    height: 0,
  },
  screen: {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    radius: 0,
  },
  safeArea: {
    top: 0,
    bottom: 0,
  },
  keyboard: {
    height: 0,
  },
} as const satisfies MobileDeviceGeometry;

export type IPhoneGeometry = typeof iphoneGeometry;
