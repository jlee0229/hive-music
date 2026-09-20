"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { HEALTH_COLORS, HOST_RING_COLOR, ROLE_COLORS, STEMS, healthLevel, type ClientRecord, type HealthSnapshot, type RoomState, type StemRole } from "@hive/protocol";
import type { HiveClock, HiveHostControls } from "@hive/sync-client";
import { patternGain } from "@/lib/hive/derive";

const SIZE = 350;
const LONG_PRESS_MS = 500;
const DRAG_THRESHOLD_PX = 6;

function cyclableRoles(room: RoomState): StemRole[] {
  const trackStems = (room.track?.stems ?? []).filter((s): s is StemRole => (STEMS as readonly string[]).includes(s));
  return trackStems.length > 0 ? trackStems : [...STEMS];
}

function nextPinnedRole(current: StemRole | null, roles: StemRole[]): StemRole | null {
  const sequence: Array<StemRole | null> = [...roles, null];
  const idx = sequence.findIndex((r) => r === current);
  return sequence[(idx + 1) % sequence.length] ?? null;
}

interface Dot {
  client: ClientRecord;
  x: number; // 0..1, null → laid out along the bottom edge by caller
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
}: {
  room: RoomState;
  health: Record<string, HealthSnapshot>;
  healthServerTime: number | null;
  clock: HiveClock;
  host: HiveHostControls;
  onOpenSheet: (clientId: string) => void;
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
      setGains(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [clock]);

  const roles = cyclableRoles(room);

  // Disconnected speakers stay on the map (their ring goes bad/unknown) until the retention window drops them.
  const speakers = Object.values(room.clients).filter((c) => c.plays);
  const placed = speakers.filter((c) => c.position !== null);
  const unplaced = speakers.filter((c) => c.position === null);
  const hostRecord = Object.values(room.clients).find((c) => c.kind === "host" && !c.plays);

  const dots: Dot[] = [
    ...placed.map((c) => ({ client: c, x: livePositions[c.id]?.x ?? c.position!.x, y: livePositions[c.id]?.y ?? c.position!.y, isHost: c.kind === "host" })),
    ...unplaced.map((c, i) => ({
      client: c,
      x: unplaced.length > 1 ? (i + 0.5) / unplaced.length : 0.5,
      y: 0.94,
      isHost: c.kind === "host",
    })),
  ];

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
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    const timer = setTimeout(() => {
      if (gesture.current && gesture.current.id === clientId && !gesture.current.moved) {
        gesture.current.longPressed = true;
        onOpenSheet(clientId);
      }
    }, LONG_PRESS_MS);
    gesture.current = { id: clientId, startX: e.clientX, startY: e.clientY, moved: false, longPressTimer: timer, longPressed: false };
  }

  function onPointerMove(e: React.PointerEvent, clientId: string) {
    const g = gesture.current;
    if (!g || g.id !== clientId || g.longPressed) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (!g.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
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
    const g = gesture.current;
    if (g && g.id === clientId) {
      if (g.moved) {
        const { x, y } = normFromEvent(e);
        host.setPosition(clientId, x, y);
        setLivePositions((p) => ({ ...p, [clientId]: { x, y } }));
      } else if (!g.longPressed) {
        // a plain tap: cycle this client's pinned role
        const rec = room.clients[clientId];
        if (rec) host.assign(clientId, nextPinnedRole(rec.pinnedRole, roles));
      }
    }
    setDragging(null);
    endGesture();
  }

  return (
    <svg
      ref={svgRef}
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      role="img"
      aria-label={`Hive map: ${placed.length + unplaced.length} player phones`}
      className="no-callout"
      style={{ touchAction: "none" }}
    >
      <defs>
        <pattern id="hive-map-dots" width="20" height="20" patternUnits="userSpaceOnUse">
          <circle cx="10" cy="10" r="1" fill="var(--border)" />
        </pattern>
      </defs>
      <rect x="0" y="0" width={SIZE} height={SIZE} rx="24" fill="var(--surface)" stroke="var(--border)" />
      <rect x="12" y="12" width={SIZE - 24} height={SIZE - 24} rx="16" fill="url(#hive-map-dots)" />

      {hostRecord ? (
        <g>
          <circle
            cx={(hostRecord.position?.x ?? 0.1) * SIZE}
            cy={(hostRecord.position?.y ?? 0.9) * SIZE}
            r="14"
            fill="none"
            stroke={HOST_RING_COLOR}
            strokeWidth="2"
            strokeDasharray="4 3"
          />
          <text
            x={(hostRecord.position?.x ?? 0.1) * SIZE}
            y={(hostRecord.position?.y ?? 0.9) * SIZE - 18}
            textAnchor="middle"
            fontSize="10"
            fill={HOST_RING_COLOR}
            fontFamily="IBM Plex Sans, sans-serif"
          >
            you
          </text>
        </g>
      ) : null}

      {dots.map(({ client, x, y, isHost }) => {
        const level = healthLevel(health[client.id] ?? null, healthServerTime ?? 0);
        const fill = client.assignment ? ROLE_COLORS[client.assignment.role] : ROLE_COLORS.unison;
        const gain = client.assignment?.pattern ? (gains[client.id] ?? 1) : 1;
        const cx = x * SIZE;
        const cy = y * SIZE;
        return (
          <g
            key={client.id}
            data-client-id={client.id}
            data-dragging={dragging === client.id ? "true" : "false"}
            onPointerDown={(e) => onPointerDown(e, client.id)}
            onPointerMove={(e) => onPointerMove(e, client.id)}
            onPointerUp={(e) => onPointerUp(e, client.id)}
            onPointerCancel={endGesture}
            style={{ cursor: "pointer" }}
          >
            <circle cx={cx} cy={cy} r="24" fill="none" stroke={HEALTH_COLORS[level]} strokeWidth="3" />
            <circle
              cx={cx}
              cy={cy}
              r="17"
              fill={fill}
              fillOpacity={0.3 + 0.7 * gain}
              stroke={isHost ? HOST_RING_COLOR : "none"}
              strokeDasharray={isHost ? "3 2" : undefined}
              strokeWidth={isHost ? 2 : 0}
            />
            <text x={cx} y={cy + 40} textAnchor="middle" fontSize="11" fill="var(--muted)" fontFamily="IBM Plex Sans, sans-serif">
              {client.name}
            </text>
            {client.position === null ? (
              <text x={cx} y={cy - 32} textAnchor="middle" fontSize="9" fill="var(--faint)" fontFamily="IBM Plex Sans, sans-serif">
                drag me
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
