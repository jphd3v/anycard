export const isTouchOnlyDevice = () => {
  if (typeof window === "undefined") return false;

  // A device is considered "hover-capable" if it has a fine-grained pointer
  // (mouse/trackpad) AND supports hover states.
  const isHoverableDevice = window.matchMedia(
    "(hover: hover) and (pointer: fine)"
  );

  // If the device is not hover-capable, we treat it as a touch-only device.
  return !isHoverableDevice.matches;
};
