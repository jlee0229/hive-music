/** CSS shorthand `padding` with each side's design value plus the device's safe-area inset on top of it. */
export function safeAreaPadding(top: number, x: number, bottom: number): string {
  return [
    `calc(${top}px + env(safe-area-inset-top, 0px))`,
    `calc(${x}px + env(safe-area-inset-right, 0px))`,
    `calc(${bottom}px + env(safe-area-inset-bottom, 0px))`,
    `calc(${x}px + env(safe-area-inset-left, 0px))`,
  ].join(" ");
}

/** For a bottom sheet: only the bottom inset (home indicator) matters. */
export function safeAreaPaddingBottom(bottom: number): string {
  return `calc(${bottom}px + env(safe-area-inset-bottom, 0px))`;
}
