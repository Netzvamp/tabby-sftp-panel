export type DockPosition = 'left' | 'right'

/** Clamp a docked size (px) to [min, 60% of the container along that axis]. */
export function clampSize (px: number, container: number, min: number): number {
  const max = Math.max(min, Math.floor(container * 0.6))
  return Math.min(max, Math.max(min, Math.round(px)))
}

/** New docked size from a pointer position, given the tab's bounding rect. */
export function dockSize (
  pos: DockPosition,
  rect: { left: number, right: number, width: number },
  x: number,
): number {
  // Left/right docks resize by width (min 200).
  return pos === 'left'
    ? clampSize(x - rect.left, rect.width, 200)
    : clampSize(rect.right - x, rect.width, 200)
}
