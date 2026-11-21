// Deterministic schedule logic. Hours are structured data, so code checks them, not a model.
export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const toMin = (t) => {
  const [h, m] = String(t).split(":").map(Number);
  return h * 60 + (m || 0);
};
const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// Intersect a source's weekly hours with the person's availability.
// availability: [{day:"Mon", start:"17:00", end:"20:00"}]; empty/missing = any time.
export function openWindows(source, availability) {
  const anyTime = !availability || availability.length === 0;
  const out = [];
  for (const day of DAYS) {
    const srcSlots = source.hours?.[day] || [];
    const avail = anyTime
      ? [["00:00", "23:59"]]
      : availability.filter((a) => a.day === day).map((a) => [a.start, a.end]);
    for (const [s1, e1] of srcSlots) {
      for (const [s2, e2] of avail) {
        const s = Math.max(toMin(s1), toMin(s2));
        const e = Math.min(toMin(e1), toMin(e2));
        if (e - s >= 15) out.push({ day, start: fmt(s), end: fmt(e) });
      }
    }
  }
  return out;
}

export function isWithin(windows, day, time) {
  if (!day || !time) return false;
  const t = toMin(time);
  return windows.some((w) => w.day === day && t >= toMin(w.start) && t <= toMin(w.end));
}

// Days that fall inside the budget period, starting today. "$30 until Friday" on a Saturday = Sat..Fri.
export function allowedDays(periodDays, today = new Date()) {
  if (!periodDays || periodDays >= 7) return DAYS;
  const start = (today.getDay() + 6) % 7; // JS Sunday=0 -> Mon=0
  return Array.from({ length: Math.ceil(periodDays) }, (_, i) => DAYS[(start + i) % 7]);
}

// Is this day+time already in the past today? (Today's slots that have passed can't be used.)
export function alreadyPassed(day, time, now = new Date()) {
  const today = DAYS[(now.getDay() + 6) % 7];
  return day === today && toMin(time) < now.getHours() * 60 + now.getMinutes();
}
