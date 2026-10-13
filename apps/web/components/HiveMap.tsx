"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HEALTH_COLORS, HOST_RING_COLOR, ROLE_COLORS, STEMS, healthLevel, speakerLayout, type ClientRecord, type HealthSnapshot, type RoomState, type StemRole } from "@hive/protocol";
import type { HiveClock, HiveHostControls } from "@hive/sync-client";
import { patternGain, stableGains } from "@/lib/hive/derive";
import { MAP_SIZE, dotMetrics, drawnCentre, fitLabel } from "@/lib/hive/map-layout";

const SIZE = MAP_SIZE;
const LONG_PRESS_MS = 500;
const DRAG_THRESHOLD_PX = 6;
/** A fingertip wobbles more than a mouse: below this a touch is still a tap, not the start of a drag. */
const TOUCH_DRAG_THRESHOLD_PX = 12;

function cyclableRoles(room: RoomState): StemRole[] {
  const trackStems = (room.track?.stems ?? []).filter((s): s is StemRole => (STEMS as readonly string[]).includes(s));
  return trackStems.length > 0 ? trackStems : [...STEMS];
}

/**
 * Whether a phone's part is something the host can change right now: only ORCHESTRA hands out
 * parts, and only on a song that has them (an uploaded song is one stem, "mix"). Everywhere else a
 * pin changes nothing anyone can see or hear, so a tap must not silently set one.
 */
export function partsApply(room: RoomState): boolean {
  const stems = (room.track?.stems ?? []).filter((s) => (STEMS as readonly string[]).includes(s));
  return room.mode.kind === "ORCHESTRA" && stems.length > 1;
}

function nextPinnedRole(current: StemRole | null, roles: StemRole[]): StemRole | null {
  const sequence: Array<StemRole | null> = [...roles, null];
  const idx = sequence.findIndex((r) => r === current);
  return sequence[(idx + 1) % sequence.length] ?? null;
}

interface Dot {
  client: ClientRecord;
  x: number; // 0..1
  y: number;
  isHost: boolean;
}

export function HiveMap({
  room,
  health,
  healthServerTime,
  clock,
  host,
  onOpenSheet,
  size = SIZE,
  excludeClientId,
}: {
  room: RoomState;
  health: Record<string, HealthSnapshot>;
  healthServerTime: number | null;
  clock: HiveClock;
  /** Omit both host and onOpenSheet for a read-only map (no drag/tap/long-press) -- /screen. */
  host?: HiveHostControls;
  onOpenSheet?: (clientId: string) => void;
  /** Rendered width/height in px; the internal SIZE x SIZE viewBox (and drag math, which reads the rendered box) is unaffected. */
  size?: number;
  /**
   * Never draw this client id as a dot. /screen has no credential-free way to join without also
   * being forced into `plays: true` server-side (docs/PROTOCOL-REQUESTS.md R-8) -- until that
   * lands, this hides the viewer's own phantom "speaker" locally.
   */
  excludeClientId?: string;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [livePositions, setLivePositions] = useState<Record<string, { x: number; y: number }>>({});
  // WAVE sweeps and STROBE blinks: evaluatePattern on the shared clock, no per-tick messages.
  const [gains, setGains] = useState<Record<string, number>>({});
  const gesture = useRef<{
    id: string;
    startX: number;
    startY: number;
    moved: boolean;
    longPressTimer: ReturnType<typeof setTimeout> | null;
    longPressed: boolean;
  } | null>(null);

  const roomRef = useRef(room);
  useEffect(() => {
    roomRef.current = room;
  }, [room]);

  useEffect(() => {
    let raf: number;
    const tick = () => {
      const t = clock.trackTimeSec();
      const next: Record<string, number> = {};
      for (const c of Object.values(roomRef.current.clients)) {
        if (c.assignment?.pattern) next[c.id] = patternGain(c.assignment.pattern, t);
      }
      // Keep the previous object when nothing visibly changed, so React skips the render: with no
      // pattern on screen (Unison, Orchestra, Stereo, Choir — or a stopped Wave/Strobe) this used to
      // re-render every dot of the map sixty times a second for as long as the stage was open.
      setGains((prev) => stableGains(prev, next));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [clock]);

  // A finger that lands on a dot must drag the dot, never scroll the page. `touch-action: none` on
  // the dot says so declaratively; this says it again for engines that ignore touch-action on SVG
  // children. It has to be a native, non-passive listener — React's onTouchStart is passive.
  const interactive = !!host;
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !interactive) return;
    const onTouchStart = (e: TouchEvent) => {
      if ((e.target as Element | null)?.closest?.("g[data-client-id]")) e.preventDefault();
    };
    svg.addEventListener("touchstart", onTouchStart, { passive: false });
    return () => svg.removeEventListener("touchstart", onTouchStart);
  }, [interactive]);

  const roles = cyclableRoles(room);

  /**
   * Where every speaker is: `speakerLayout(room)` from @hive/protocol — the hand-placed position if
   * the host dragged the phone, its auto slot otherwise. It is the function the planner computes
   * WAVE's sweep and STEREO's sides from, so the dots sit exactly where the room hears them. It is
   * laid out over EVERY `plays` record, connected or not (the set the planner assigns): a phone that
   * drops for a minute keeps its slot and nobody else moves. Dragging still writes a real position.
   */
  // Keyed on what the layout depends on, so it is recomputed when the room changes and not on every
  // animation frame.
  const layoutKey = JSON.stringify(
    Object.values(room.clients)
      .filter((c) => c.plays)
      .map((c) => [c.id, c.joinIndex, c.position?.x ?? null, c.position?.y ?? null]),
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `room` changes identity with every snapshot; layoutKey is the part that matters
  const layout = useMemo(() => speakerLayout(room), [layoutKey]);
  const metrics = dotMetrics(layout.spacing);

  // Drawn: only what is actually in the room right now — connected speakers plus the connected host.
  // Disconnected records linger server-side for the retention window, but drawing them made the map
  // show phones that had left the party.
  const speakers = Object.values(room.clients).filter((c) => c.plays && c.connected && c.id !== excludeClientId);
  const hostRecord = Object.values(room.clients).find((c) => c.kind === "host" && !c.plays && c.connected);
  const hostXY = hostRecord ? { x: hostRecord.position?.x ?? 0.1, y: hostRecord.position?.y ?? 0.9 } : null;

  const dots: Dot[] = speakers.map((c) => {
    // A drag in progress leads the server by a snapshot; everything else is the shared layout.
    const p = livePositions[c.id] ?? layout.positions[c.id] ?? { x: 0.5, y: 0.5 };
    return { client: c, x: p.x, y: p.y, isHost: c.kind === "host" };
  });

  function normFromEvent(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = svgRef.current!.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    return { x, y };
  }

  const endGesture = useCallback(() => {
    const g = gesture.current;
    if (!g) return;
    if (g.longPressTimer) clearTimeout(g.longPressTimer);
    gesture.current = null;
  }, []);

  function onPointerDown(e: React.PointerEvent, clientId: string) {
    if (!host) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    const timer = setTimeout(() => {
      if (gesture.current && gesture.current.id === clientId && !gesture.current.moved) {
        gesture.current.longPressed = true;
        onOpenSheet?.(clientId);
      }
    }, LONG_PRESS_MS);
    gesture.current = { id: clientId, startX: e.clientX, startY: e.clientY, moved: false, longPressTimer: timer, longPressed: false };
  }

  function onPointerMove(e: React.PointerEvent, clientId: string) {
    if (!host) return;
    const g = gesture.current;
    if (!g || g.id !== clientId || g.longPressed) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (!g.moved && Math.hypot(dx, dy) > (e.pointerType === "mouse" ? DRAG_THRESHOLD_PX : TOUCH_DRAG_THRESHOLD_PX)) {
      g.moved = true;
      if (g.longPressTimer) clearTimeout(g.longPressTimer);
      setDragging(clientId);
    }
    if (g.moved) {
      const { x, y } = normFromEvent(e);
      setLivePositions((p) => ({ ...p, [clientId]: { x, y } }));
      host.setPosition(clientId, x, y);
    }
  }

  function onPointerUp(e: React.PointerEvent, clientId: string) {
    if (!host) return;
    const g = gesture.current;
    if (g && g.id === clientId) {
      if (g.moved) {
        const { x, y } = normFromEvent(e);
        host.setPosition(clientId, x, y);
        setLivePositions((p) => ({ ...p, [clientId]: { x, y } }));
      } else if (!g.longPressed) {
        // A plain tap: cycle this client's pinned part where parts exist; otherwise open its sheet
        // (the same thing a long-press does) rather than pin a part nobody can see or hear.
        const rec = room.clients[clientId];
        if (rec && partsApply(room)) host.assign(clientId, nextPinnedRole(rec.pinnedRole, roles));
        else if (rec) onOpenSheet?.(clientId);
      }
    }
    setDragging(null);
    endGesture();
  }

  return (
    <svg
      ref={svgRef}
      width={size}
      height={size}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      role="img"
      aria-label={`Hive map: ${speakers.length} player phones`}
      className="no-callout"
      // Square at every width: the flex parent may squeeze the width (a 320-375 px phone), and with a
      // fixed height the drawing was letterboxed inside a taller box — a dragged dot then landed up
      // to 15 px away from the finger, because the drag maths divides by the box, not the drawing.
      // touch-action: the map is a screen-wide square in the middle of a page that scrolls, so its
      // background lets a vertical swipe through (pan-y) and only the dots — the things one drags —
      // claim the gesture (touch-action: none on each <g>, plus the touchstart guard above for
      // engines that do not apply touch-action to SVG children).
      style={{ touchAction: host ? "pan-y" : "auto", maxWidth: "100%", height: "auto", aspectRatio: "1 / 1" }}
    >
      <defs>
        <pattern id="hive-map-dots" width="20" height="20" patternUnits="userSpaceOnUse">
          <circle cx="10" cy="10" r="1" fill="var(--border)" />
        </pattern>
      </defs>
      <rect x="0" y="0" width={SIZE} height={SIZE} rx="24" fill="var(--surface)" stroke="var(--border)" />
      <rect x="12" y="12" width={SIZE - 24} height={SIZE - 24} rx="16" fill="url(#hive-map-dots)" />

      {hostXY ? (
        <g>
          <circle cx={hostXY.x * SIZE} cy={hostXY.y * SIZE} r={14 * metrics.scale} fill="none" stroke={HOST_RING_COLOR} strokeWidth="2" strokeDasharray="4 3" />
          <text x={hostXY.x * SIZE} y={hostXY.y * SIZE - 14 * metrics.scale - 4} textAnchor="middle" fontSize="10" fill={HOST_RING_COLOR} fontFamily="IBM Plex Sans, sans-serif">
            Host
          </text>
        </g>
      ) : null}

      {dots.map(({ client, x, y, isHost }) => {
        const level = healthLevel(health[client.id] ?? null, healthServerTime ?? 0);
        const fill = client.assignment ? ROLE_COLORS[client.assignment.role] : ROLE_COLORS.unison;
        // In unison (and before a track is assigned) the health ring stays a calm black: a red ring
        // on a phone that sounds fine read as "something is wrong". Stem modes keep the traffic
        // lights — there the host is actively managing parts and wants the signal.
        const ringColor = !client.assignment || client.assignment.role === "unison" ? "#0B0F14" : HEALTH_COLORS[level];
        const gain = client.assignment?.pattern ? (gains[client.id] ?? 1) : 1;
        // Drawn inside the map even when the stored position is on the very edge (ring and name stay whole).
        const { x: cx, y: cy } = drawnCentre({ x, y }, metrics);
        return (
          <g
            key={client.id}
            data-client-id={client.id}
            data-dragging={dragging === client.id ? "true" : "false"}
            onPointerDown={(e) => onPointerDown(e, client.id)}
            onPointerMove={(e) => onPointerMove(e, client.id)}
            onPointerUp={(e) => onPointerUp(e, client.id)}
            onPointerCancel={endGesture}
            style={{ cursor: host ? "pointer" : "default", touchAction: host ? "none" : "auto" }}
          >
            <circle cx={cx} cy={cy} r={metrics.ring} fill="none" stroke={ringColor} strokeWidth={metrics.ringWidth} />
            <circle
              cx={cx}
              cy={cy}
              r={metrics.fill}
              fill={fill}
              fillOpacity={0.3 + 0.7 * gain}
              stroke={isHost ? HOST_RING_COLOR : "none"}
              strokeDasharray={isHost ? "3 2" : undefined}
              strokeWidth={isHost ? 2 : 0}
            />
            {/* Names only while they fit between neighbours; a big party is dots, and a tap or the Players list has the name. */}
            {metrics.showLabels ? (
              <text x={cx} y={cy + metrics.labelDy} textAnchor="middle" fontSize={metrics.font} fill="var(--muted)" fontFamily="IBM Plex Sans, sans-serif">
                {/* The label is cut to fit; the whole name stays on the element (tooltip, assistive tech). */}
                <title>{client.name}</title>
                {fitLabel(client.name, metrics.labelChars)}
              </text>
            ) : null}
            {/* Invisible, finger-sized, on top: the visible dot shrinks at a big party, the thing you can grab does not. */}
            <circle cx={cx} cy={cy} r={metrics.hit} fill="transparent" />
          </g>
        );
      })}
    </svg>
  );
}
