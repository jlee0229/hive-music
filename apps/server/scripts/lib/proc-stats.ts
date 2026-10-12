// Cross-platform "how big and how busy is that other process" probe for the load scripts.
// Linux reads /proc; Windows asks PowerShell (Get-Process); macOS falls back to `ps`.
// Every call is async on purpose: a spawnSync here would stall the load generator's own event loop
// and show up as fake latency in the numbers the scripts report.

export interface ProcStats {
  /** Resident set (Linux VmRSS / Windows WorkingSet64), kB. */
  rssKb: number;
  /** Private/committed bytes where the OS reports them (Windows PrivateMemorySize64), kB; null elsewhere. */
  privateKb: number | null;
  /** User + kernel CPU time consumed since the process started, ms. */
  cpuMs: number;
  /** performance.now() in the *calling* process when the sample was taken. */
  atMs: number;
}

async function run(cmd: string[]): Promise<string> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(p.stdout).text();
  await p.exited;
  return text;
}

export async function readProcStats(pid: number): Promise<ProcStats | null> {
  const atMs = performance.now();
  try {
    if (process.platform === "linux") {
      const status = await Bun.file(`/proc/${pid}/status`).text();
      const stat = await Bun.file(`/proc/${pid}/stat`).text();
      const rss = status.match(/VmRSS:\s+(\d+)\s+kB/);
      // Fields after the ")" that closes comm: state is index 0, utime index 11, stime index 12 (clock ticks, 100 Hz).
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ticks = Number(rest[11]) + Number(rest[12]);
      if (!rss || Number.isNaN(ticks)) return null;
      return { rssKb: Number(rss[1]), privateKb: null, cpuMs: ticks * 10, atMs };
    }
    if (process.platform === "win32") {
      const text = await run([
        "powershell",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p = Get-Process -Id ${pid} -ErrorAction Stop; "$($p.WorkingSet64) $($p.PrivateMemorySize64) $([math]::Round($p.TotalProcessorTime.TotalMilliseconds))"`,
      ]);
      const m = text.trim().match(/^(\d+) (\d+) (\d+)$/);
      if (!m) return null;
      return { rssKb: Math.round(Number(m[1]) / 1024), privateKb: Math.round(Number(m[2]) / 1024), cpuMs: Number(m[3]), atMs };
    }
    // macOS / BSD: rss in kB, cputime as [[dd-]hh:]mm:ss.cc
    const text = (await run(["ps", "-o", "rss=,cputime=", "-p", String(pid)])).trim();
    const m = text.match(/^(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
    if (!m) return null;
    const cpuSec = Number(m[2] ?? 0) * 86400 + Number(m[3] ?? 0) * 3600 + Number(m[4]) * 60 + Number(m[5]);
    return { rssKb: Number(m[1]), privateKb: null, cpuMs: cpuSec * 1000, atMs };
  } catch {
    return null;
  }
}

/** Samples a process on an interval; `stop()` returns every sample taken (always >= 1 if the pid was alive). */
export function sampleProc(pid: number, intervalMs: number): { samples: ProcStats[]; stop(): Promise<ProcStats[]> } {
  const samples: ProcStats[] = [];
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    const s = await readProcStats(pid);
    if (s) samples.push(s);
    busy = false;
  };
  void tick();
  const timer = setInterval(tick, intervalMs);
  return {
    samples,
    async stop() {
      clearInterval(timer);
      while (busy) await new Promise((r) => setTimeout(r, 20));
      const last = await readProcStats(pid);
      if (last) samples.push(last);
      return samples;
    },
  };
}

/** CPU share of one core between two samples, 0..n (1 = one core fully busy). */
export function cpuShare(a: ProcStats, b: ProcStats): number {
  const wall = b.atMs - a.atMs;
  return wall > 0 ? (b.cpuMs - a.cpuMs) / wall : NaN;
}

/** Least-squares slope of RSS over time, kB per minute — the leak detector for soak runs. */
export function rssSlopeKbPerMin(samples: ProcStats[]): number {
  if (samples.length < 3) return NaN;
  const n = samples.length;
  const xs = samples.map((s) => s.atMs / 60_000);
  const ys = samples.map((s) => s.rssKb);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  return den > 0 ? num / den : NaN;
}
