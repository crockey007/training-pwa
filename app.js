const KEY = "home-gym-v1";
const APP_VERSION = 36;

const state = {
  view: "today",
  sheet: null,
  historyDate: null,
  draft: null,
  weeklyPlan: null,
  coachPlan: null,
  syncStatus: "idle",
  restTimer: null,
  showNextPreview: false,
  reviewing: false,
  editDraft: null,
  runDate: null,
  runNotice: "",
  planDate: null,
};

let syncTimer = null;

function todayStr(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseDate(value) {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function weekdayJa(value) {
  return "日月火水木金土"[parseDate(value).getDay()];
}

function weekStart(value = todayStr()) {
  const date = parseDate(value);
  const day = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - day);
  return todayStr(date);
}

function load() {
  try {
    const data = JSON.parse(localStorage.getItem(KEY)) || {};
    if (!data.updatedAt) data.updatedAt = null;
    return data;
  } catch {
    return {};
  }
}

function save(data) {
  localStorage.setItem(KEY, JSON.stringify(data));
}

function canSync() {
  return false;
}

function withTimeout(promise, ms = 5000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

function showBootError(err) {
  const app = document.getElementById("app");
  if (!app) return;
  const msg = err && err.message ? String(err.message) : "不明なエラー";
  app.innerHTML = `<main class="page"><section class="card"><h2>起動エラー</h2><p class="muted">${escapeHtml(msg)}</p><p class="muted">${repairLinkHtml()}</p></section></main>`;
}

function repairUrl() {
  return new URL("./v36.html", location.href).href;
}

function repairLinkHtml(label) {
  const url = repairUrl();
  const text = label || url;
  return `<a href="./v36.html" class="link-url">${escapeHtml(text)}</a>`;
}

function scheduleSync() {
  state.syncStatus = "idle";
}

function mergeByDate(listA = [], listB = [], key = "date") {
  const map = new Map();
  [...listA, ...listB].forEach((row) => {
    const existing = map.get(row[key]);
    if (!existing) map.set(row[key], row);
    else map.set(row[key], { ...existing, ...row });
  });
  return [...map.values()].sort((a, b) => a[key].localeCompare(b[key]));
}

function mergeWorkouts(a = [], b = []) {
  const map = new Map();
  [...a, ...b].forEach((w) => {
    const existing = map.get(w.date);
    if (!existing) map.set(w.date, w);
    else if (w.completed && !existing.completed) map.set(w.date, w);
    else if ((w.exercises?.length || 0) > (existing.exercises?.length || 0)) map.set(w.date, w);
    else if (w.review && (!existing.review || (w.review.generatedAt || "") >= (existing.review.generatedAt || ""))) {
      map.set(w.date, { ...existing, ...w });
    }
  });
  return [...map.values()].sort((x, y) => x.date.localeCompare(y.date));
}

function mergeAll(local, remote) {
  const localOk = local && typeof local === "object" ? local : {};
  const remoteOk = remote && typeof remote === "object" ? remote : {};
  const merged = {
    workouts: mergeWorkouts(localOk.workouts, remoteOk.workouts),
    meals: mergeByDate(localOk.meals, remoteOk.meals),
    sleeps: mergeByDate(localOk.sleeps, remoteOk.sleeps),
    weights: mergeByDate(localOk.weights, remoteOk.weights),
    runs: mergeByDate(localOk.runs, remoteOk.runs),
    scheduleOverrides: { ...(remoteOk.scheduleOverrides || {}), ...(localOk.scheduleOverrides || {}) },
    draft: localOk.draft && localOk.draft.date === todayStr() ? localOk.draft : remoteOk.draft ?? localOk.draft,
    profileStartDate: localOk.profileStartDate || remoteOk.profileStartDate || PROFILE.startDate,
    pendingSync: false,
    updatedAt: new Date().toISOString(),
  };
  try {
    merged.coachPlan = CoachEngine.generate(merged);
  } catch {
    merged.coachPlan = localOk.coachPlan || remoteOk.coachPlan || null;
  }
  return merged;
}

function setsAllWeight(row, kg) {
  return Boolean(row && row.sets && row.sets.length && row.sets.every((s) => Number(s.weight) === kg));
}

function correctAugust17Weights() {
  const data = load();
  const workouts = data.workouts || [];
  const w = workouts.find((row) => row.date === "2026-08-17");
  if (!w) return false;
  const bench = w.exercises.find((ex) => ex.id === "bench-press");
  const incline = w.exercises.find((ex) => ex.id === "incline-press");
  const ohp = w.exercises.find((ex) => ex.id === "ohp");
  if (!setsAllWeight(bench, 40) || !setsAllWeight(incline, 30) || !setsAllWeight(ohp, 20)) return false;
  bench.sets.forEach((s) => {
    s.weight = 30;
  });
  incline.sets.forEach((s) => {
    s.weight = 20;
  });
  ohp.sets.forEach((s) => {
    s.weight = 10;
  });
  w.review = makeReview(
    w,
    workouts.filter((row) => row.date !== w.date)
  );
  save({ ...data, workouts, updatedAt: new Date().toISOString() });
  try {
    refreshCoachPlan();
  } catch {
    /* plan later */
  }
  return true;
}

function cloneWorkout(w) {
  return JSON.parse(JSON.stringify(w));
}

function startEditWorkout(date) {
  const w = completedWorkouts().find((row) => row.date === date);
  if (!w) return;
  state.editDraft = cloneWorkout(w);
  state.historyDate = null;
  state.sheet = null;
  state.view = "edit";
  render();
}

function saveEditedWorkout() {
  const edited = state.editDraft;
  if (!edited) return;
  const workouts = db().workouts.filter((w) => w.date !== edited.date);
  edited.completed = true;
  edited.review = makeReview(edited, workouts);
  workouts.push(edited);
  patch({ workouts });
  refreshCoachPlan();
  state.editDraft = null;
  state.view = "history";
  state.historyDate = edited.date;
  render();
}

function cancelEditWorkout() {
  state.editDraft = null;
  state.view = "history";
  render();
}

function restoreMacBackup() {
  if (typeof MAC_BACKUP === "undefined") return;
  save(mergeAll(load(), MAC_BACKUP));
  correctAugust17Weights();
  ensureReviews();
  refreshCoachPlan();
  render();
}

function needsMacRestore() {
  if (typeof MAC_BACKUP === "undefined") return false;
  const dates = new Set(completedWorkouts().map((w) => w.date));
  return !dates.has("2026-08-17") || !dates.has("2026-08-20") || !dates.has("2026-08-23");
}

function exportBackup() {
  const blob = new Blob([JSON.stringify(load(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `training-${todayStr()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function importBackupFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const incoming = JSON.parse(String(reader.result || "{}"));
      if (!incoming || typeof incoming !== "object") throw new Error("invalid");
      save(mergeAll(load(), incoming));
      ensureReviews();
      ensureCoachPlan();
      render();
    } catch {
      alert("読み込めませんでした。");
    }
  };
  reader.readAsText(file);
}

function applyCoachPlan(plan) {
  state.coachPlan = plan;
  patch({ coachPlan: plan });
}

function refreshCoachPlan(completedWorkout) {
  const data = load();
  if (!data.profileStartDate) data.profileStartDate = PROFILE.startDate;
  if (completedWorkout) {
    data.workouts = mergeWorkouts(data.workouts || [], [completedWorkout]);
  }
  try {
    const plan = CoachEngine.generate(data);
    applyCoachPlan(plan);
    return plan;
  } catch (err) {
    console.error(err);
    return data.coachPlan || null;
  }
}

function ensureCoachPlan() {
  try {
    return refreshCoachPlan();
  } catch (err) {
    console.error(err);
    return state.coachPlan || load().coachPlan || null;
  }
}

function db() {
  const data = load();
  return {
    workouts: data.workouts || [],
    meals: data.meals || [],
    sleeps: data.sleeps || [],
    weights: data.weights || [],
    draft: data.draft || null,
    coachPlan: data.coachPlan || null,
    runs: data.runs || [],
  };
}

function patch(partial) {
  const next = { ...load(), ...partial, updatedAt: new Date().toISOString(), pendingSync: false };
  save(next);
  scheduleSync();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function completedWorkouts() {
  return db().workouts.filter((w) => w.completed).sort((a, b) => a.date.localeCompare(b.date));
}

function lastWorkout() {
  const all = completedWorkouts();
  return all[all.length - 1] || null;
}

function reviewContext(date) {
  const meal = (db().meals || []).find((row) => row.date === date) || null;
  const sleep = (db().sleeps || []).find((row) => row.date === date) || null;
  const run = (db().runs || []).find((row) => row.date === date && row.done) || null;
  return { meal, sleep, run };
}

function makeReview(workout, allWorkouts) {
  return CoachEngine.reviewSession(workout, allWorkouts, reviewContext(workout.date));
}

function ensureReviews() {
  const workouts = db().workouts || [];
  let changed = false;
  const next = workouts.map((w) => {
    if (!w.completed || w.review) return w;
    changed = true;
    return { ...w, review: makeReview(w, workouts) };
  });
  if (changed) patch({ workouts: next });
}

function workoutsThisWeek() {
  const start = weekStart();
  return completedWorkouts().filter((w) => w.date >= start);
}

function lastLogs(exerciseId) {
  for (const workout of completedWorkouts().slice().reverse()) {
    const found = workout.exercises.find((ex) => ex.id === exerciseId);
    if (found && found.sets.some((set) => set.reps > 0)) return found;
  }
  return null;
}

function phaseLabel() {
  return state.coachPlan?.phase || (completedWorkouts().length < 6 ? "導入期" : "漸進期");
}

function weakerBetween(a, b) {
  const logA = lastLogs(a);
  const logB = lastLogs(b);
  if (!logA) return a;
  if (!logB) return b;
  const avg = (log) => log.sets.reduce((sum, set) => sum + set.reps, 0) / log.sets.length;
  return avg(logA) <= avg(logB) ? a : b;
}

function pickBack() {
  const pull = lastLogs("pull-up");
  if (pull && pull.sets.some((set) => set.reps >= 6)) return "pull-up";
  return "lat-pulldown";
}

function nextSessionType() {
  return (
    state.coachPlan?.weekSchedule?.nextSessionType ||
    state.coachPlan?.nextSessionType ||
    (() => {
      const last = lastWorkout();
      if (!last) return "A";
      return { A: "B", B: "C", C: "A" }[last.sessionType] || "A";
    })()
  );
}

function sessionExercises(type) {
  const plan = state.coachPlan;
  if (plan && plan.nextSessionType === type && plan.exercises?.length) return plan.exercises;
  if (type === "A") return ["bench-press", "incline-press", "ohp", "pushdown", "bench-dip"];
  if (type === "B") return ["lat-pulldown", "seated-row", "barbell-row", "barbell-curl", "face-pull"];
  return [weakerBetween("bench-press", "incline-press"), pickBack(), "side-raise", "oh-tricep", "hammer-curl", "core"];
}

function sessionFocus(type) {
  return state.coachPlan?.focus && state.coachPlan.nextSessionType === type
    ? state.coachPlan.focus
    : SESSION_META[type].focus;
}

function recommend(exercise) {
  const planned = state.coachPlan?.targets?.[exercise.id];
  if (planned && state.coachPlan.nextSessionType === (state.draft?.sessionType || nextSessionType())) {
    return planned;
  }
  const last = lastLogs(exercise.id);
  if (exercise.bodyweight) {
    if (!last) {
      return { weight: 0, reps: exercise.repMin, reason: "自重から開始。回数を伸ばすことが進歩です。" };
    }
    const hit = last.sets.every((set) => set.reps >= exercise.repMax);
    return {
      weight: 0,
      reps: hit ? exercise.repMax : Math.min(exercise.repMax, Math.max(...last.sets.map((s) => s.reps)) + 1),
      reason: hit ? "前回は上限回数に到達。今日はさらに1〜2回、または動作を丁寧に。" : "前回の回数をベースに、上限まで伸ばす。",
    };
  }
  if (!last) {
    return {
      weight: exercise.startWeight,
      reps: exercise.repMin,
      reason: `開始重量の目安です（バー${PROFILE.barKg}kgを含む総重量）。最初は${exercise.repMin}回を綺麗に。`,
    };
  }
  const weight = last.sets[0].weight;
  const hitMax = last.sets.every((set) => set.reps >= exercise.repMax);
  const missMin = last.sets.some((set) => set.reps < exercise.repMin);
  if (hitMax) {
    return {
      weight: roundStep(weight + exercise.incrementKg, exercise.incrementKg || 2.5),
      reps: exercise.repMin,
      reason: `前回すべて${exercise.repMax}回できたので、${exercise.incrementKg}kg上げます。`,
    };
  }
  if (missMin) {
    return {
      weight,
      reps: exercise.repMin,
      reason: `前回${exercise.repMin}回未満のセットがあったので、同じ重量で回数を伸ばします。`,
    };
  }
  return {
    weight,
    reps: Math.min(exercise.repMax, Math.max(...last.sets.map((s) => s.reps))),
    reason: "前回の重量を維持。回数を上限に近づけましょう。",
  };
}

function roundStep(value, step) {
  const s = step || 2.5;
  const rounded = Math.round(value / s) * s;
  return Number(rounded.toFixed(s < 1 ? 2 : 1));
}

function emptySets(exercise, rec) {
  return Array.from({ length: exercise.sets }, () => ({
    weight: rec.weight,
    reps: rec.reps,
  }));
}

function ensureDraft(sessionType) {
  const data = db();
  const today = todayStr();
  if (data.draft && data.draft.date === today && data.draft.sessionType === sessionType) {
    state.draft = data.draft;
    return data.draft;
  }
  const exercises = sessionExercises(sessionType).map((id) => {
    const exercise = EXERCISE_MAP[id];
    const rec = recommend(exercise);
    return { id, sets: emptySets(exercise, rec) };
  });
  const draft = { date: today, sessionType, exercises };
  state.draft = draft;
  patch({ draft });
  return draft;
}

function todayMeal() {
  return db().meals.find((m) => m.date === todayStr()) || { date: todayStr(), protein: 0, quality: "", note: "" };
}

function todayRun(date = todayStr()) {
  return (
    db().runs.find((r) => r.date === date) || {
      date,
      done: false,
      km: 0,
      kcal: 0,
    }
  );
}

function proteinOptions() {
  const max = 250;
  const opts = [];
  for (let n = 0; n <= max; n += 10) opts.push(n);
  return opts;
}

function todaySleep() {
  return db().sleeps.find((s) => s.date === todayStr()) || { date: todayStr(), hours: 7, quality: "", note: "" };
}

function sortedBodyLogs() {
  return db().weights.slice().sort((a, b) => a.date.localeCompare(b.date));
}

function latestBodyLog() {
  const logs = sortedBodyLogs();
  return logs[logs.length - 1] || null;
}

function todayBody() {
  const today = todayStr();
  const found = db().weights.find((w) => w.date === today);
  const latest = latestBodyLog();
  return {
    date: today,
    kg: found?.kg ?? latest?.kg ?? PROFILE.startWeightKg,
    bodyFat: found?.bodyFat ?? latest?.bodyFat ?? PROFILE.startBodyFat,
    saved: Boolean(found),
  };
}

function chartSeries(key) {
  return sortedBodyLogs().filter((row) => row[key] != null);
}

function lineChartSvg(series, key, color, unit) {
  const points = series.filter((row) => row[key] != null);
  if (points.length < 2) {
    return `<div class="chart-empty">記録が2件以上でグラフが表示されます</div>`;
  }
  const W = 320;
  const H = 132;
  const pad = { t: 12, r: 10, b: 24, l: 34 };
  const values = points.map((p) => p[key]);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const span = rawMax - rawMin || 1;
  const min = rawMin - span * 0.12;
  const max = rawMax + span * 0.12;
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const coords = points.map((p, i) => {
    const x = pad.l + (i / (points.length - 1)) * innerW;
    const y = pad.t + innerH - ((p[key] - min) / (max - min)) * innerH;
    return { x, y, p };
  });
  const poly = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const area = `${coords[0].x.toFixed(1)},${(pad.t + innerH).toFixed(1)} ${poly} ${coords[coords.length - 1].x.toFixed(1)},${(pad.t + innerH).toFixed(1)}`;
  const yTicks = [min, (min + max) / 2, max];
  const last = points[points.length - 1];
  const delta = points.length >= 2 ? last[key] - points[points.length - 2][key] : 0;
  const deltaLabel = delta === 0 ? "±0" : `${delta > 0 ? "+" : ""}${key === "kg" ? delta.toFixed(1) : delta.toFixed(1)}${unit}`;
  const deltaClass = delta > 0 ? "up" : delta < 0 ? "down" : "";
  return `<div class="chart-head">
      <div><span class="chart-value">${last[key]}${unit}</span><span class="chart-delta ${deltaClass}">${deltaLabel}</span></div>
      <span class="muted">${points.length}件の記録</span>
    </div>
    <svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${key === "kg" ? "体重" : "体脂肪率"}の推移">
      ${yTicks
        .map((v) => {
          const y = pad.t + innerH - ((v - min) / (max - min)) * innerH;
          return `<line class="chart-grid" x1="${pad.l}" y1="${y.toFixed(1)}" x2="${W - pad.r}" y2="${y.toFixed(1)}" />
            <text class="chart-axis" x="${pad.l - 6}" y="${y.toFixed(1)}" text-anchor="end" dominant-baseline="middle">${v.toFixed(key === "kg" ? 1 : 1)}</text>`;
        })
        .join("")}
      <polygon class="chart-area" points="${area}" fill="${color}" />
      <polyline class="chart-line" points="${poly}" stroke="${color}" />
      ${coords
        .map(
          (c, i) => `<circle class="chart-dot" cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="${i === coords.length - 1 ? 4 : 3}" fill="${color}" />
            <text class="chart-label" x="${c.x.toFixed(1)}" y="${H - 4}" text-anchor="middle">${c.p.date.slice(5).replace("-", "/")}</text>`
        )
        .join("")}
    </svg>`;
}

function bodyHistoryHtml() {
  const logs = sortedBodyLogs().slice().reverse();
  if (!logs.length) return `<p class="muted">まだ記録がありません。</p>`;
  return logs
    .slice(0, 8)
    .map(
      (row) => `<div class="body-log-row">
        <span>${row.date.replaceAll("-", ".")}</span>
        <span>${row.kg != null ? row.kg + "kg" : "—"}</span>
        <span>${row.bodyFat != null ? row.bodyFat + "%" : "—"}</span>
      </div>`
    )
    .join("");
}

function upsertByDate(listName, item) {
  const data = db();
  const list = data[listName].filter((row) => row.date !== item.date);
  list.push(item);
  patch({ [listName]: list });
}

function suggestion() {
  const today = todayStr();
  const plan = state.coachPlan || ensureCoachPlan() || {};
  const doneToday = completedWorkouts().find((w) => w.date === today);
  if (doneToday) {
    const next = plan.weekSchedule?.nextSessionType || plan.nextSessionType || "A";
    const meta = SESSION_META[next] || SESSION_META.A;
    const when = plan.weekSchedule?.nextDate
      ? `${plan.weekSchedule.nextDate.replaceAll("-", "/").slice(5)}（${weekdayJa(plan.weekSchedule.nextDate)}）`
      : "次の空き日";
    return {
      type: next,
      title: `今日の${doneToday.sessionType}は完了`,
      detail: `${plan.coachNote || ""}\n\n次回予定: ${when} ${next} ${meta.name}（${meta.subtitle}）`.trim(),
      action: "次回メニューを見る",
      done: true,
      showNext: true,
    };
  }
  if (db().draft && db().draft.date === today) {
    const type = db().draft.sessionType;
    const meta = SESSION_META[type];
    return {
      type,
      title: `${type} ${meta.name} を再開`,
      detail: "途中の記録が残っています。",
      action: "トレーニングを再開",
      resume: true,
    };
  }
  const todayCal = (plan.weekSchedule?.days || []).find((d) => d.date === today);
  if (todayCal && todayCal.kind !== "train" && todayCal.kind !== "done") {
    const type = plan.weekSchedule?.nextSessionType || nextSessionType();
    const meta = SESSION_META[type] || SESSION_META.A;
    const when = plan.weekSchedule?.nextDate
      ? `${plan.weekSchedule.nextDate.replaceAll("-", "/").slice(5)}（${weekdayJa(plan.weekSchedule.nextDate)}）`
      : "次の空き日";
    const kindLabel = todayCal.kind === "run" ? "ラン日" : "休養日";
    return {
      type,
      title: `今日は${kindLabel}`,
      detail: `次のトレーニングは ${when} ${type} ${meta.name}。カレンダーの日付をタップすると、休養とトレを入れ替えできます。`,
      action: `それでも${type}を始める`,
      rest: true,
    };
  }
  const weekly = workoutsThisWeek();
  if (weekly.length >= PROFILE.weeklyTrainingMax) {
    const type = nextSessionType();
    return {
      type,
      title: "今週の目標回数に到達",
      detail: `上半身は週${PROFILE.weeklyTrainingMin}–${PROFILE.weeklyTrainingMax}回が目安です（${weekly.length}回済）。休養かランを優先してOK。`,
      action: `${type}を始める`,
      rest: true,
    };
  }
  const last = lastWorkout();
  if (last && last.date === yesterdayStr()) {
    const type = nextSessionType();
    const meta = SESSION_META[type];
    return {
      type,
      title: `回復日推奨 / 次は${type} ${meta.name}`,
      detail: "昨日トレーニングしています。可能ならランか休養。やるなら次のセッションです。",
      action: `${type} ${meta.name} を開始`,
    };
  }
  const type = nextSessionType();
  const meta = SESSION_META[type] || SESSION_META.A;
  const detail = [plan.coachNote, plan.recoveryNote].filter(Boolean).join("\n\n") || "記録に合わせて次回メニューを組んでいます。";
  return {
    type,
    title: `次回: ${type} ${meta.name}`,
    detail,
    action: `${type} ${meta.name} を開始`,
  };
}

function yesterdayStr() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return todayStr(date);
}

function render() {
  const app = document.getElementById("app");
  if (!app) return;
  try {
    const titles = {
    today: ["Training", "週間カレンダー / 上半身メイン"],
    workout: ["トレーニング", SESSION_META[state.draft?.sessionType || "A"].subtitle],
    history: ["履歴", "重量と回数の積み上げ"],
    review: ["振り返り", "完了したセッションの評価"],
    life: ["生活", "食事と睡眠は短く、続ける"],
    library: ["種目", "器具の使い方とフォーム"],
    edit: ["記録の修正", "重量と回数をあとから直す"],
  };
  const [title, sub] = titles[state.view] || titles.today;
  const syncLabel = {
    synced: load().pendingSync ? "同期待ち" : "Mac同期済",
    pending: "同期中…",
    offline: load().pendingSync ? "同期待ち（オフライン）" : "オフライン",
    idle: "—",
  }[state.syncStatus];
  app.innerHTML = `
    <header class="topbar">
      <h1>${title}</h1>
      <div class="sub">${sub} · <a href="./v36.html" class="link-url">v${APP_VERSION}</a></div>
      ${canSync() ? `<div class="sync-pill ${state.syncStatus}">${syncLabel}</div>` : ""}
    </header>
    <main class="page">${viewHtml()}</main>
    ${tabbar()}
    ${state.sheet ? sheetHtml() : ""}${state.historyDate ? historySheetHtml() : ""}${state.runDate ? runSheetHtml() : ""}${state.planDate ? planSheetHtml() : ""}${nextPreviewHtml()}
    ${restTimerBar()}
  `;
    bind();
  } catch (err) {
    console.error(err);
    showBootError(err);
  }
}

function tabbar() {
  const tabs = [
    ["today", "今日"],
    ["workout", "記録"],
    ["review", "振り返り"],
    ["library", "種目"],
    ["life", "生活"],
  ];
  return `<nav class="tabbar">${tabs
    .map(
      ([id, label]) =>
        `<button data-nav="${id}" class="${state.view === id || (id === "workout" && (state.view === "history" || state.view === "edit")) ? "active" : ""}"><span class="ico">${icon(id)}</span>${label}</button>`
    )
    .join("")}</nav>`;
}

function icon(id) {
  return { today: "●", workout: "≡", review: "◎", library: "＋", life: "☾" }[id];
}

function viewHtml() {
  if (state.view === "workout") return workoutHtml();
  if (state.view === "history") return historyHtml();
  if (state.view === "review") return reviewPageHtml();
  if (state.view === "library") return libraryHtml();
  if (state.view === "life") return lifeHtml();
  if (state.view === "edit") return editWorkoutHtml();
  return todayHtml();
}

function todayHtml() {
  const sug = suggestion();
  const weekly = workoutsThisWeek().length;
  const meal = todayMeal();
  const sleep = todaySleep();
  const last = lastWorkout();
  return `
    <section class="stats">
      <div class="stat"><span>今週</span><b>${weekly}/${PROFILE.weeklyTrainingMin}–${PROFILE.weeklyTrainingMax}</b></div>
      <div class="stat"><span>タンパク質</span><b>${meal.protein || "—"}</b></div>
      <div class="stat"><span>睡眠</span><b>${sleep.quality ? sleep.hours + "h" : "—"}</b></div>
    </section>
    ${needsMacRestore()
      ? `<section class="card accent">
      <div class="kicker">記録の同期</div>
      <h2 style="margin-top:8px">8/17〜23の記録を入れる</h2>
      <p class="muted">A・B・Cとラン3回を書き込み、今日からのメニューに反映します。ホーム画面のアプリで押してください。</p>
      <button class="btn" type="button" data-restore-mac="1">記録を入れてメニュー更新</button>
    </section>`
      : ""}
    ${weekCalendarHtml()}
    ${runCardHtml(todayStr())}
    ${weekRunsHtml()}
    <section class="card accent">
      <div class="kicker">自動コーチ · ${phaseLabel()} · ${todayStr().replaceAll("-", ".")} ${weekdayJa(todayStr())}</div>
      <h2 style="margin-top:8px">${escapeHtml(sug.title)}</h2>
      <p class="muted coach-note">${escapeHtml(sug.detail)}</p>
      ${sug.done ? "" : `<button class="btn" data-start="${sug.type}">${escapeHtml(sug.action)}</button>`}
      <button class="btn ghost" data-nav="review" style="margin-top:8px">振り返りを見る</button>
      <button class="btn ghost" data-nav="history" style="margin-top:8px">履歴を見る</button>
    </section>
    ${sessionPreview(sug.done ? nextSessionType() : sug.type)}
    ${weeklySummaryCard()}
    <section class="card">
      <div class="row">
        <h3>直近の記録</h3>
        <span class="muted">${last ? last.date : "まだなし"}</span>
      </div>
      <p class="muted" style="margin:8px 0 0">
        ${last ? `${last.sessionType} ${SESSION_META[last.sessionType].name} · ${last.exercises.length}種目` : "初回は重量よりフォーム。セーフティバーを必ずセット。"}
      </p>
      ${last?.review ? `<p class="muted" style="margin-top:8px">${escapeHtml(last.review.aiText ? last.review.aiText.split("\n")[0] : last.review.summary)}</p>` : ""}
    </section>
  `;
}

function weekCalendarHtml() {
  let cal = state.coachPlan?.weekSchedule;
  if (!cal || !cal.days) {
    try {
      if (typeof CoachEngine.buildWeekSchedule !== "function") {
        return `<section class="card"><div class="kicker">週間カレンダー</div><h3>更新が必要です</h3><p class="muted">${repairLinkHtml()}</p></section>`;
      }
      cal = CoachEngine.buildWeekSchedule(load(), nextSessionType());
    } catch (err) {
      console.error(err);
      return `<section class="card"><div class="kicker">週間カレンダー</div><h3>予定を表示できません</h3><p class="muted">アプリを開き直してください。</p></section>`;
    }
  }
  const nextDate = cal.nextDate;
  const nextType = cal.nextSessionType;
  const meta = SESSION_META[nextType] || { name: "" };
  const nextLabel = nextDate
    ? `${nextDate.replaceAll("-", "/").slice(5)}（${weekdayJa(nextDate)}） ${nextType} ${meta.name}`
    : "今週の予定は完了";
  const hint =
    cal.nextWeekHint && cal.nextWeekHint.date !== nextDate
      ? `<p class="muted" style="margin-top:8px">来週: ${cal.nextWeekHint.date.replaceAll("-", "/").slice(5)}（${cal.nextWeekHint.weekday}） ${cal.nextWeekHint.sessionType} ${SESSION_META[cal.nextWeekHint.sessionType].name}</p>`
      : cal.nextWeekHint
        ? `<p class="muted" style="margin-top:8px">来週 ${cal.nextWeekHint.date.replaceAll("-", "/").slice(5)}（${cal.nextWeekHint.weekday}）が次の予定です。</p>`
        : "";
  return `<section class="card">
    <div class="row">
      <div>
        <div class="kicker">週間カレンダー</div>
        <h3 style="margin-top:6px">次は ${escapeHtml(nextLabel)}</h3>
      </div>
      <span class="muted">${cal.doneCount}/${cal.target}回</span>
    </div>
    <div class="week-cal">
      ${cal.days
        .map((day) => {
          const cls = ["week-cell", day.kind, day.isToday ? "today" : "", day.isNext ? "next" : "", day.overridden ? "changed" : ""]
            .filter(Boolean)
            .join(" ");
          const action =
            day.kind === "done"
              ? `data-hist="${day.date}"`
              : !day.isPast
                ? `data-plan-day="${day.date}"`
                : day.kind === "run" || day.kind === "rest"
                  ? `data-log-run="${day.date}"`
                  : "";
          const tag = action ? "button" : "div";
          const typeAttr = tag === "button" ? ' type="button"' : "";
          return `<${tag} class="${cls}" ${action}${typeAttr}>
            <span class="wday">${day.weekday}</span>
            <span class="wnum">${day.dayNum}</span>
            <span class="wtag">${escapeHtml(day.label)}</span>
          </${tag}>`;
        })
        .join("")}
    </div>
    ${hint}
    <p class="muted" style="margin-top:8px">日付をタップすると、休養とトレーニングを入れ替えできます。連続は避けます。</p>
  </section>`;
}

function imgSrc(id) {
  return `./images/${id}.jpg`;
}

function motionThumb(id) {
  return `<img class="motion-thumb" src="${imgSrc(id)}" alt="" />`;
}

function exerciseCard(id, extra = "") {
  const ex = EXERCISE_MAP[id];
  const rec = recommend(ex);
  const weight = ex.bodyweight ? "自重" : `${rec.weight}kg`;
  return `<button class="ex-item" data-open="${id}">
    ${motionThumb(id)}
    <div class="ex-copy">
      <div class="row"><h3>${ex.name}</h3><span class="badge">${weight}</span></div>
      <div class="meta"><span>${ex.muscle} · ${ex.sets}×${ex.repMin}–${ex.repMax}</span><span>やり方</span></div>
      ${extra}
    </div>
  </button>`;
}

function weeklySummaryCard() {
  const s = state.coachPlan?.weeklySummary;
  if (!s) return "";
  return `<section class="card">
    <h3>今週のサマリー</h3>
    <div class="stats" style="margin-top:8px">
      <div class="stat"><span>セッション</span><b>${s.sessions}</b></div>
      <div class="stat"><span>総セット</span><b>${s.totalSets}</b></div>
      <div class="stat"><span>ボリューム</span><b>${s.totalVolumeKg || "—"}kg</b></div>
    </div>
    <p class="muted" style="margin-top:8px">重点部位: ${escapeHtml(s.topMuscle)} · 総レップ ${s.totalReps}回</p>
  </section>`;
}

function reviewBlockHtml(review, date) {
  if (!review && !state.reviewing) return "";
  const isAi = review?.source === "ollama" && review?.aiText;
  const source = isAi ? "AI振り返り" : "コーチ振り返り";
  const body = isAi
    ? `<p class="coach-note review-ai">${escapeHtml(review.aiText)}</p>`
    : review
      ? `<p class="muted">${escapeHtml(review.summary)}</p>
         <p class="coach-note"><b>よかった点</b>\n${escapeHtml(review.goods)}\n\n<b>改善点</b>\n${escapeHtml(review.improves)}\n\n<b>前回比</b>\n${escapeHtml(review.vsPrev)}</p>
         ${review.detail ? `<p class="muted" style="white-space:pre-line">${escapeHtml(review.detail)}</p>` : ""}
         ${review.lifeNotes?.length ? `<p class="muted">${escapeHtml(review.lifeNotes.join(" "))}</p>` : ""}
         <p class="muted">${escapeHtml(review.next)}</p>`
      : "";
  const wait = "";
  const ask = review?.shareText
    ? `<button class="btn ghost" type="button" data-share-review="${date}" style="margin-top:10px">Siri / ChatGPT に渡す文を共有</button>`
    : "";
  return `<section class="review-card">
    <div class="kicker">${source}</div>
    ${wait}
    ${body}
    ${ask}
  </section>`;
}

function nextPreviewHtml() {
  if (!state.showNextPreview) return "";
  const last = completedWorkouts().slice(-1)[0];
  const plan = state.coachPlan;
  const type = plan?.nextSessionType;
  const meta = type ? SESSION_META[type] : null;
  const nextBlock = plan && meta
    ? `<div class="kicker" style="margin-top:16px">次回プレビュー</div>
    <h2>${type} ${meta.name}</h2>
    <p class="muted coach-note">${escapeHtml(plan.coachNote)}</p>
    <div class="stack" style="margin-top:12px">
      ${plan.exercises.slice(0, 4).map((id) => {
        const ex = EXERCISE_MAP[id];
        const t = plan.targets[id];
        const w = ex.bodyweight ? "自重" : `${t.weight}kg`;
        return `<div class="ex-item" style="pointer-events:none">
          ${motionThumb(id)}
          <div class="ex-copy"><h3>${ex.name}</h3><span class="muted">${w} × ${t.reps}回</span></div>
        </div>`;
      }).join("")}
    </div>`
    : "";
  return `<div class="sheet-bg" data-close-preview="1"><div class="sheet" data-stop="1">
    <div class="kicker">セッション完了</div>
    <h2>今日の振り返り</h2>
    ${last ? reviewBlockHtml(last.review, last.date) : ""}
    ${nextBlock}
    <button class="btn" type="button" data-close-preview-btn="1" style="margin-top:16px">OK</button>
  </div></div>`;
}

async function shareReviewPrompt(date) {
  const workout = completedWorkouts().find((w) => w.date === date);
  const text = workout?.review?.shareText;
  if (!text) return;
  try {
    if (navigator.share) {
      await navigator.share({ title: `Training ${date} 振り返り`, text });
      return;
    }
  } catch {
    /* fall through */
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      alert("振り返り文をコピーしました。SiriやChatGPTに貼り付けてください。");
      return;
    }
  } catch {
    /* ignore */
  }
  prompt("この文をコピーしてSiriやChatGPTに貼り付けてください。", text);
}

function runCardHtml(date) {
  const run = todayRun(date);
  const isToday = date === todayStr();
  return `<section class="card">
    <div class="row">
      <div>
        <div class="kicker">ラン · Garmin</div>
        <h3>${isToday ? "今日のラン" : date.replaceAll("-", ".") + " のラン"}</h3>
      </div>
      <span class="muted">${run.done && (run.km || run.kcal) ? `${run.km || 0}km · ${run.kcal || 0}kcal` : run.done ? "数字を入れて保存" : "未記録"}</span>
    </div>
    <p class="muted">走った日は「ランした」を選んで、Garminの距離と消費カロリーを入れてください。</p>
    <div class="pills" style="margin-top:10px">
      <button class="pill ${!run.done ? "active" : ""}" type="button" data-run-done="${date}:0">やっていない</button>
      <button class="pill good ${run.done ? "active" : ""}" type="button" data-run-done="${date}:1">ランした</button>
    </div>
    ${
      run.done
        ? `<div class="metric-grid" style="margin-top:12px">
        <div>
          <div class="metric-label">距離 km</div>
          ${stepperHtml(`run-km:${date}`, Number(run.km) || 0, "km")}
          <input class="num-input" type="text" inputmode="decimal" enterkeyhint="done" autocomplete="off" autocorrect="off" spellcheck="false" value="${run.km || ""}" data-run-km="${date}" placeholder="例 5.20" />
        </div>
        <div>
          <div class="metric-label">消費カロリー</div>
          ${stepperHtml(`run-kcal:${date}`, Number(run.kcal) || 0, "")}
          <input class="num-input" type="text" inputmode="numeric" enterkeyhint="done" autocomplete="off" autocorrect="off" spellcheck="false" value="${run.kcal || ""}" data-run-kcal="${date}" placeholder="例 320" />
        </div>
      </div>
      <p class="muted" style="margin-top:8px">±でも、Garminの数字を直接入力しても大丈夫です。</p>
      ${state.runNotice ? `<p class="coach-note" style="margin-top:10px">${escapeHtml(state.runNotice)}</p>` : ""}
      <button class="btn" type="button" data-save-run="${date}" style="margin-top:12px">ランを保存</button>`
        : ""
    }
  </section>`;
}

function runSheetHtml() {
  if (!state.runDate) return "";
  return `<div class="sheet-bg" data-close-run="1"><div class="sheet" data-stop="1">
    <button class="sheet-back dark" type="button" data-close-btn="1">‹ 戻る</button>
    <div class="handle"></div>
    <div style="margin-top:36px">${runCardHtml(state.runDate)}</div>
  </div></div>`;
}

function weekRunsHtml() {
  const start = weekStart();
  const runs = (db().runs || [])
    .filter((r) => r.done && r.date >= start && (r.km || r.kcal))
    .sort((a, b) => b.date.localeCompare(a.date));
  if (!runs.length) return "";
  return `<section class="card">
    <h3>今週のラン</h3>
    ${runs
      .map(
        (r) => `<div class="body-log-row">
        <span>${r.date.replaceAll("-", ".")} ${weekdayJa(r.date)}</span>
        <span>${r.km || 0}km</span>
        <span>${r.kcal || 0}kcal</span>
      </div>`
      )
      .join("")}
  </section>`;
}

function setDayPlan(date, kind) {
  const overrides = { ...(load().scheduleOverrides || {}) };
  if (!kind) delete overrides[date];
  else overrides[date] = kind;
  patch({ scheduleOverrides: overrides });
  refreshCoachPlan();
}

function planSheetHtml() {
  const date = state.planDate;
  if (!date) return "";
  const cal = (state.coachPlan?.weekSchedule?.days || []).find((d) => d.date === date);
  const kind = cal?.kind || "rest";
  const ov = (load().scheduleOverrides || {})[date];
  const meta = cal?.sessionType ? SESSION_META[cal.sessionType] : null;
  const nowLabel =
    kind === "train"
      ? `${cal.sessionType} ${meta?.name || ""}`
      : kind === "run"
        ? "ラン"
        : "休養";
  return `<div class="sheet-bg" data-close-plan="1"><div class="sheet" data-stop="1">
    <button class="sheet-back dark" type="button" data-close-btn="1">‹ 戻る</button>
    <div class="handle"></div>
    <div class="kicker" style="margin-top:36px">予定の変更</div>
    <h2 style="margin-top:6px">${date.replaceAll("-", ".")}（${weekdayJa(date)}）</h2>
    <p class="muted">いまの予定: ${escapeHtml(nowLabel)}${ov ? "（手動）" : ""}</p>
    <button class="btn" type="button" data-set-plan="${date}:train" style="margin-top:16px">トレーニングにする</button>
    <button class="btn ghost" type="button" data-set-plan="${date}:rest" style="margin-top:8px">休養にする</button>
    <button class="btn ghost" type="button" data-set-plan="${date}:run" style="margin-top:8px">ランにする</button>
    ${ov ? `<button class="btn ghost" type="button" data-set-plan="${date}:" style="margin-top:8px">自動の予定に戻す</button>` : ""}
    <button class="btn ghost" type="button" data-log-run="${date}" style="margin-top:8px">Garminの記録を入れる</button>
  </div></div>`;
}

function restTimerBar() {
  if (!state.restTimer) return "";
  const t = state.restTimer;
  return `<div class="rest-bar">
    <span>休憩 ${t.left}s</span>
    <button type="button" data-rest-skip="1">スキップ</button>
  </div>`;
}

function sessionPreview(type) {
  const ids = sessionExercises(type);
  return `
    <section class="stack">
      ${ids
        .map((id) => {
          const rec = recommend(EXERCISE_MAP[id]);
          return exerciseCard(id, `<div class="muted">${escapeHtml(rec.reason)}</div>`);
        })
        .join("")}
    </section>
  `;
}

function workoutHtml() {
  const draft = state.draft || db().draft;
  if (!draft) {
    return `<div class="empty">まだ開始していません。<br>「今日」からセッションを始めてください。</div>
      <button class="btn" data-nav="today">今日の提案へ</button>
      <button class="btn ghost" data-nav="history">過去の履歴</button>`;
  }
  return `
    <section class="card">
      <div class="row">
        <div>
          <div class="kicker">${draft.sessionType} ${SESSION_META[draft.sessionType].name}</div>
          <h2>${draft.date.replaceAll("-", ".")}</h2>
        </div>
        <button class="btn small ghost" data-nav="history">履歴</button>
      </div>
      <p class="muted">${sessionFocus(draft.sessionType)}。重量はバー（${PROFILE.barKg}kg）込みの総重量。休憩はコンパウンド90–120秒、腕は60–90秒。</p>
    </section>
    ${draft.exercises
      .map((row) => {
        const ex = EXERCISE_MAP[row.id];
        const rec = recommend(ex);
        return `<section class="card">
          <div class="row">
            ${motionThumb(row.id)}
            <div style="flex:1">
              <h3>${ex.name}</h3>
              <div class="muted">${ex.sets}×${ex.repMin}–${ex.repMax} · 目安 ${ex.bodyweight ? "自重" : rec.weight + "kg"}</div>
            </div>
            <button class="btn small ghost" data-open="${ex.id}">やり方</button>
          </div>
          <p class="reason">${escapeHtml(rec.reason)}</p>
          ${row.sets
            .map(
              (set, i) => `<div class="set-row">
              <div class="muted">#${i + 1}</div>
              ${
                ex.bodyweight
                  ? `<div class="muted" style="text-align:center">自重</div>`
                  : stepperHtml(`w:${row.id}:${i}`, set.weight, "kg")
              }
              ${stepperHtml(`r:${row.id}:${i}`, set.reps, "回")}
              <button class="btn small ghost" type="button" data-rest="${row.id}:${i}" style="margin-top:6px;width:100%">休憩タイマー</button>
            </div>`
            )
            .join("")}
        </section>`;
      })
      .join("")}
    <button class="btn" data-finish="1">このセッションを完了</button>
    <button class="btn ghost" data-clear-draft="1">下書きを破棄</button>
  `;
}

function editWorkoutHtml() {
  const draft = state.editDraft;
  if (!draft) {
    return `<div class="empty">修正する記録がありません。</div>
      <button class="btn" data-nav="history">履歴へ</button>`;
  }
  const meta = SESSION_META[draft.sessionType] || { name: draft.sessionType };
  return `
    <section class="card">
      <div class="row">
        <div>
          <div class="kicker">${draft.sessionType} ${meta.name}</div>
          <h2>${draft.date.replaceAll("-", ".")} ${weekdayJa(draft.date)}</h2>
        </div>
      </div>
      <p class="muted">重量はバー（${PROFILE.barKg}kg）込みの総重量です。直したら「修正を保存」を押してください。振り返りと次回の提案も更新されます。</p>
    </section>
    ${draft.exercises
      .map((row) => {
        const ex = EXERCISE_MAP[row.id];
        return `<section class="card">
          <div class="row">
            ${motionThumb(row.id)}
            <div style="flex:1">
              <h3>${ex.name}</h3>
              <div class="muted">${ex.bodyweight ? "自重" : "バー込み総重量"}</div>
            </div>
          </div>
          ${row.sets
            .map(
              (set, i) => `<div class="set-row">
              <div class="muted">#${i + 1}</div>
              ${
                ex.bodyweight
                  ? `<div class="muted" style="text-align:center">自重</div>`
                  : stepperHtml(`w:${row.id}:${i}`, set.weight, "kg")
              }
              ${stepperHtml(`r:${row.id}:${i}`, set.reps, "回")}
            </div>`
            )
            .join("")}
        </section>`;
      })
      .join("")}
    <button class="btn" data-save-edit="1">修正を保存</button>
    <button class="btn ghost" data-cancel-edit="1">やめる</button>
  `;
}

function stepperHtml(key, value, unit) {
  return `<div class="stepper" data-step="${key}">
    <button data-delta="-1">−</button>
    <div class="val">${value}${unit}</div>
    <button data-delta="1">+</button>
  </div>`;
}

function historyHtml() {
  const workouts = completedWorkouts().slice().reverse();
  if (!workouts.length) return `<div class="empty">完了したセッションはまだありません。</div>`;
  const lifts = ["bench-press", "ohp", "barbell-row", "lat-pulldown"];
  const liftCards = lifts
    .map((id) => {
      const ex = EXERCISE_MAP[id];
      const log = lastLogs(id);
      return `<div class="stat"><span>${ex.name}</span><b>${log && !ex.bodyweight ? log.sets[0].weight + "kg" : log ? log.sets.map((s) => s.reps).join("/") : "—"}</b></div>`;
    })
    .join("");
  return `
    <section class="stats">${liftCards}</section>
    <section class="card">
      ${workouts
        .map(
          (w) => `<button class="history-item" data-hist="${w.date}">
            <div class="row"><b>${w.date.replaceAll("-", ".")} ${weekdayJa(w.date)}</b><span class="badge">${w.sessionType} ${SESSION_META[w.sessionType].name}</span></div>
            <div class="muted">${w.exercises.map((ex) => EXERCISE_MAP[ex.id].name).join(" / ")}${w.review ? " · 振り返りあり" : ""}</div>
          </button>`
        )
        .join("")}
    </section>
    <button class="btn ghost" data-nav="workout">今日の記録へ</button>
  `;
}

function reviewPageHtml() {
  const workouts = completedWorkouts().slice().reverse();
  if (!workouts.length) {
    return `<section class="card">
      <div class="kicker">振り返り</div>
      <h2>まだありません</h2>
      <p class="muted">「記録」でセッションを完了すると、ここに今日の振り返りが出ます。記録はiPhone内のログから自動で作ります。</p>
    </section>`;
  }
  return workouts
    .map((w) => {
      const meta = SESSION_META[w.sessionType] || { name: w.sessionType };
      return `<section class="card">
        <div class="kicker">${w.date.replaceAll("-", ".")} ${weekdayJa(w.date)} · ${w.sessionType} ${meta.name}</div>
        ${reviewBlockHtml(w.review, w.date) || `<p class="muted">記録から振り返りを作成しています。</p>`}
        <button class="btn ghost" type="button" data-edit-workout="${w.date}" style="margin-top:10px">この記録を修正</button>
      </section>`;
    })
    .join("");
}

function libraryHtml() {
  return `<section class="stack">
    ${EXERCISES.map((ex) => exerciseCard(ex.id, `<div class="muted">${escapeHtml(ex.equipment)}</div>`)).join("")}
  </section>`;
}

function lifeHtml() {
  const meal = todayMeal();
  const sleep = todaySleep();
  const body = todayBody();
  const weightSeries = chartSeries("kg");
  const fatSeries = chartSeries("bodyFat");
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = parseDate(weekStart());
    date.setDate(date.getDate() + i);
    return todayStr(date);
  });
  const meals = db().meals;
  return `
    <section class="card">
      <div class="row"><h3>今日の体重・体脂肪</h3><span class="muted">${body.saved ? "今日記録済" : "未記録"}</span></div>
      <p class="muted">±で直す数値は<strong>今日</strong>の記録です。開始時（${PROFILE.startWeightKg}kg / ${PROFILE.startBodyFat}%）は変わりません。</p>
      <div class="metric-grid">
        <div>
          <div class="metric-label">今日の体重</div>
          ${stepperHtml("body-weight", body.kg, "kg")}
        </div>
        <div>
          <div class="metric-label">今日の体脂肪率</div>
          ${stepperHtml("body-fat", body.bodyFat, "%")}
        </div>
      </div>
      <button class="btn" type="button" data-save-body="1" style="margin-top:12px">今日の数値を記録</button>
      <p class="muted" style="margin-top:8px">目標は体脂肪10–12%前後</p>
    </section>
    <section class="card">
      <h3>体重の推移</h3>
      ${lineChartSvg(weightSeries, "kg", "#6aa6ff", "kg")}
    </section>
    <section class="card">
      <h3>体脂肪率の推移</h3>
      ${lineChartSvg(fatSeries, "bodyFat", "#3ddc97", "%")}
    </section>
    <section class="card">
      <h3>記録一覧</h3>
      <div class="body-log-head"><span>日付</span><span>体重</span><span>体脂肪</span></div>
      ${bodyHistoryHtml()}
    </section>
    <section class="card">
      <h3>今週の食事ログ</h3>
      <p class="muted">カロリー計算はしません。タンパク質の目安 ${PROFILE.proteinTargetG}g と、食べ具合だけ。</p>
      <div class="week" style="margin-top:10px">
        ${days
          .map((d) => {
            const hit = meals.some((m) => m.date === d && m.protein);
            return `<div class="daydot ${hit ? "done" : ""} ${d === todayStr() ? "today" : ""}"><i></i>${weekdayJa(d)}</div>`;
          })
          .join("")}
      </div>
    </section>
    <section class="card">
      <div class="row"><h3>今日のタンパク質</h3><b>${meal.protein || 0}g</b></div>
      <div class="progress-bar" style="margin:10px 0 12px"><span style="width:${Math.min(100, ((meal.protein || 0) / PROFILE.proteinTargetG) * 100)}%"></span></div>
      <p class="muted">10g刻み。指でスクロールして選んでください。目安は ${PROFILE.proteinTargetG}g です。</p>
      <div class="pick-scroll" data-protein-scroll="1">
        ${proteinOptions()
          .map((n) => `<button class="pick-opt ${Number(meal.protein) === n ? "active" : ""}" type="button" data-protein="${n}">${n}g</button>`)
          .join("")}
      </div>
      <h3 style="margin-top:16px">食べ具合</h3>
      <div class="pills" style="margin-top:8px">
        <button class="pill poor ${meal.quality === "poor" ? "active" : ""}" data-quality="poor">不足</button>
        <button class="pill ok ${meal.quality === "ok" ? "active" : ""}" data-quality="ok">普通</button>
        <button class="pill good ${meal.quality === "good" ? "active" : ""}" data-quality="good">十分</button>
      </div>
      <textarea class="note" data-meal-note="1" placeholder="任意メモ（外食、間食など）">${escapeHtml(meal.note || "")}</textarea>
    </section>
    <section class="card">
      <div class="row"><h3>睡眠</h3><span class="muted">7時間以上が目安</span></div>
      ${stepperHtml("sleep-hours", sleep.hours, "h")}
      <div class="pills" style="margin-top:12px">
        <button class="pill poor ${sleep.quality === "poor" ? "active" : ""}" data-sleepq="poor">浅い</button>
        <button class="pill ok ${sleep.quality === "ok" ? "active" : ""}" data-sleepq="ok">普通</button>
        <button class="pill good ${sleep.quality === "good" ? "active" : ""}" data-sleepq="good">良い</button>
      </div>
    </section>
    <section class="card">
      <h3>データのバックアップ</h3>
      <p class="muted">記録はiPhoneのこのアプリ内に保存されます。Mac同期はありません。機種変更や再インストールのときだけ、下で書き出し／読み込みできます。</p>
      <button class="btn" type="button" data-restore-mac="1" style="margin-top:12px">8/17〜23の記録を入れてメニュー更新</button>
      <button class="btn ghost" type="button" data-export="1" style="margin-top:8px">記録を書き出す</button>
      <button class="btn ghost" type="button" data-import-btn="1" style="margin-top:8px">記録を読み込む</button>
      <input type="file" accept="application/json,.json" data-import-file="1" hidden />
    </section>
    <section class="card">
      <h3>アプリの修復</h3>
      <p class="muted">画面の版が古いまま、白い画面、更新されないときはこちら。ホーム画面のアプリからだと古い更新ページが残ることがあります。うまくいかないときはSafariで開いてください。</p>
      <a class="btn" href="./v36.html" style="display:block;text-align:center;margin-top:12px;text-decoration:none">最新版に更新する</a>
    </section>
  `;
}

function sheetHtml() {
  const ex = EXERCISE_MAP[state.sheet];
  if (!ex) return "";
  const rec = recommend(ex);
  const cues = CUES[ex.id] || [];
  return `<div class="sheet-bg" data-close-sheet="1"><div class="sheet sheet-guide" data-stop="1">
    <div class="hero-bar">
      <button class="sheet-back" type="button" data-close-btn="1">‹ 戻る</button>
      <span class="hero-tag">${escapeHtml(ex.muscle)}</span>
    </div>
    <div class="hero-still">
      <img src="${imgSrc(ex.id)}" alt="${escapeHtml(ex.name)}の動作（開始・中間・終了）" />
      <div class="motion-phases still"><span>開始</span><span>中間</span><span>終了</span></div>
    </div>
    <div class="sheet-body">
      <h2>${ex.name}</h2>
      <p class="hero-eq">${escapeHtml(ex.equipment)}</p>
      <div class="cue-chips">${cues.map((cue) => `<span>${escapeHtml(cue)}</span>`).join("")}</div>
      <div class="guide-meta">
        <span>${ex.sets}セット × ${ex.repMin}–${ex.repMax}回</span>
        <span>休憩 ${ex.restSec}秒</span>
        <span>${ex.bodyweight ? "自重" : "目安 " + rec.weight + "kg"}</span>
      </div>
      <p class="scroll-hint">下にスクロールしてやり方</p>
      ${guideBlock("01", "器具のセット", ex.setup)}
      ${guideBlock("02", "フォーム", ex.form)}
      ${guideBlock("03", "やりがちなミス", ex.mistakes, true)}
      <button class="btn" type="button" data-close-btn="1" style="margin-top:20px">閉じる</button>
    </div>
  </div></div>`;
}

function guideBlock(num, title, lines, warn = false) {
  return `<section class="guide-block ${warn ? "warn" : ""}">
    <div class="sec-label"><i>${num}</i>${title}</div>
    <ol class="steps">${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ol>
  </section>`;
}

function bind() {
  document.querySelectorAll("[data-nav]").forEach((el) =>
    el.addEventListener("click", () => {
      if (el.dataset.nav !== "edit") state.editDraft = null;
      state.view = el.dataset.nav;
      if (state.view === "workout") state.draft = db().draft;
      render();
    })
  );
  document.querySelectorAll("[data-start]").forEach((el) =>
    el.addEventListener("click", () => {
      ensureDraft(el.dataset.start);
      state.view = "workout";
      render();
    })
  );
  document.querySelectorAll("[data-open]").forEach((el) =>
    el.addEventListener("click", () => {
      openOverlay("sheet", el.dataset.open);
    })
  );
  document.querySelectorAll("[data-close-sheet]").forEach((el) =>
    el.addEventListener("click", (ev) => {
      if (ev.target === el) closeOverlay();
    })
  );
  document.querySelectorAll("[data-close-btn]").forEach((el) =>
    el.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      closeOverlay();
    })
  );
  document.querySelectorAll("[data-stop]").forEach((el) =>
    el.addEventListener("click", (ev) => ev.stopPropagation())
  );
  document.querySelectorAll("[data-step]").forEach((el) => {
    el.querySelectorAll("[data-delta]").forEach((btn) =>
      btn.addEventListener("click", () => applyStep(el.dataset.step, Number(btn.dataset.delta)))
    );
  });
  document.querySelectorAll("[data-finish]").forEach((el) => el.addEventListener("click", finishWorkout));
  document.querySelectorAll("[data-clear-draft]").forEach((el) =>
    el.addEventListener("click", () => {
      patch({ draft: null });
      state.draft = null;
      state.view = "today";
      render();
    })
  );
  document.querySelectorAll("[data-protein]").forEach((el) =>
    el.addEventListener("click", () => {
      upsertByDate("meals", { ...todayMeal(), protein: Number(el.dataset.protein) });
      render();
    })
  );
  document.querySelectorAll("[data-quality]").forEach((el) =>
    el.addEventListener("click", () => {
      upsertByDate("meals", { ...todayMeal(), quality: el.dataset.quality });
      render();
    })
  );
  document.querySelectorAll("[data-sleepq]").forEach((el) =>
    el.addEventListener("click", () => {
      upsertByDate("sleeps", { ...todaySleep(), quality: el.dataset.sleepq });
      render();
    })
  );
  document.querySelectorAll("[data-save-body]").forEach((el) =>
    el.addEventListener("click", () => {
      saveTodayBody();
      render();
    })
  );
  document.querySelectorAll("[data-force-update]").forEach((el) =>
    el.addEventListener("click", () => {
      el.disabled = true;
      el.textContent = "更新しています…";
      forceAppRefresh();
    })
  );
  document.querySelectorAll("[data-restore-mac]").forEach((el) => el.addEventListener("click", restoreMacBackup));
  document.querySelectorAll("[data-edit-workout]").forEach((el) =>
    el.addEventListener("click", () => startEditWorkout(el.dataset.editWorkout))
  );
  document.querySelectorAll("[data-share-review]").forEach((el) =>
    el.addEventListener("click", () => {
      shareReviewPrompt(el.dataset.shareReview);
    })
  );
  document.querySelectorAll("[data-save-edit]").forEach((el) => el.addEventListener("click", saveEditedWorkout));
  document.querySelectorAll("[data-cancel-edit]").forEach((el) => el.addEventListener("click", cancelEditWorkout));
  document.querySelectorAll("[data-import-btn]").forEach((el) =>
    el.addEventListener("click", () => document.querySelector("[data-import-file]")?.click())
  );
  document.querySelectorAll("[data-import-file]").forEach((el) =>
    el.addEventListener("change", () => {
      const file = el.files && el.files[0];
      if (file) importBackupFile(file);
    })
  );
  document.querySelectorAll("[data-meal-note]").forEach((el) =>
    el.addEventListener("change", () => {
      upsertByDate("meals", { ...todayMeal(), note: el.value });
    })
  );
  document.querySelectorAll("[data-hist]").forEach((el) =>
    el.addEventListener("click", () => {
      openOverlay("hist", el.dataset.hist);
    })
  );
  document.querySelectorAll("[data-plan-day]").forEach((el) =>
    el.addEventListener("click", () => {
      openOverlay("plan", el.dataset.planDay);
    })
  );
  document.querySelectorAll("[data-set-plan]").forEach((el) =>
    el.addEventListener("click", () => {
      const raw = el.dataset.setPlan || "";
      const date = raw.slice(0, 10);
      const kind = raw.slice(11);
      setDayPlan(date, kind || null);
      closeOverlay();
    })
  );
  document.querySelectorAll("[data-close-plan]").forEach((el) =>
    el.addEventListener("click", (ev) => {
      if (ev.target === el) closeOverlay();
    })
  );
  document.querySelectorAll("[data-log-run]").forEach((el) =>
    el.addEventListener("click", () => {
      openOverlay("run", el.dataset.logRun);
    })
  );
  document.querySelectorAll("[data-run-done]").forEach((el) =>
    el.addEventListener("click", () => {
      const [date, flag] = el.dataset.runDone.split(":");
      const done = flag === "1";
      const current = todayRun(date);
      upsertByDate("runs", { ...current, date, done, km: done ? current.km : 0, kcal: done ? current.kcal : 0 });
      refreshCoachPlan();
      render();
    })
  );
  document.querySelectorAll("[data-run-km], [data-run-kcal]").forEach((el) => {
    el.addEventListener("click", (ev) => ev.stopPropagation());
    el.addEventListener("touchstart", (ev) => ev.stopPropagation(), { passive: true });
    el.addEventListener("focus", () => {
      setTimeout(() => {
        try {
          el.scrollIntoView({ block: "center", behavior: "smooth" });
        } catch {
          /* ignore */
        }
      }, 300);
    });
    el.addEventListener("change", () => {
      const date = el.dataset.runKm || el.dataset.runKcal;
      const run = todayRun(date);
      const kmEl = document.querySelector(`[data-run-km="${date}"]`);
      const kcalEl = document.querySelector(`[data-run-kcal="${date}"]`);
      const km = kmEl ? Math.max(0, Number(String(kmEl.value).replace(",", ".")) || 0) : run.km || 0;
      const kcal = kcalEl ? Math.max(0, Math.round(Number(kcalEl.value) || 0)) : run.kcal || 0;
      upsertByDate("runs", { ...run, date, done: true, km: roundStep(km, 0.01), kcal });
    });
  });
  document.querySelectorAll("[data-save-run]").forEach((el) =>
    el.addEventListener("click", () => {
      const date = el.dataset.saveRun;
      const root = el.closest("section") || document;
      const kmEl = root.querySelector("[data-run-km]");
      const kcalEl = root.querySelector("[data-run-kcal]");
      const km = kmEl ? Math.max(0, Number(String(kmEl.value).replace(",", ".")) || 0) : 0;
      const kcal = kcalEl ? Math.max(0, Math.round(Number(kcalEl.value) || 0)) : 0;
      upsertByDate("runs", { date, done: true, km: roundStep(km, 0.01), kcal });
      refreshCoachPlan();
      state.runNotice = km || kcal ? `保存しました ${km || 0}km · ${kcal || 0}kcal` : "距離かカロリーを入れてから保存してください";
      if (state.runDate) {
        closeOverlay();
        return;
      }
      render();
    })
  );
  document.querySelectorAll("[data-close-run]").forEach((el) =>
    el.addEventListener("click", (ev) => {
      if (ev.target === el) closeOverlay();
    })
  );
  const proteinScroll = document.querySelector("[data-protein-scroll]");
  const proteinActive = proteinScroll && proteinScroll.querySelector(".pick-opt.active");
  if (proteinScroll && proteinActive) {
    proteinScroll.scrollTop = proteinActive.offsetTop - proteinScroll.clientHeight / 2 + proteinActive.clientHeight / 2;
  }
  document.querySelectorAll("[data-rest]").forEach((el) =>
    el.addEventListener("click", () => startRestTimer(el.dataset.rest.split(":")[0]))
  );
  document.querySelectorAll("[data-rest-skip]").forEach((el) =>
    el.addEventListener("click", () => {
      clearRestTimer();
      render();
    })
  );
  document.querySelectorAll("[data-close-preview]").forEach((el) =>
    el.addEventListener("click", (ev) => {
      if (ev.target.dataset.closePreview) {
        state.showNextPreview = false;
        render();
      }
    })
  );
  document.querySelectorAll("[data-close-preview-btn]").forEach((el) =>
    el.addEventListener("click", () => {
      state.showNextPreview = false;
      render();
    })
  );
  document.querySelectorAll("[data-close-hist]").forEach((el) =>
    el.addEventListener("click", (ev) => {
      if (ev.target === el) closeOverlay();
    })
  );
}

function openOverlay(kind, id) {
  state.sheet = null;
  state.historyDate = null;
  state.runDate = null;
  state.planDate = null;
  if (kind === "sheet") state.sheet = id;
  if (kind === "hist") state.historyDate = id;
  if (kind === "run") state.runDate = id;
  if (kind === "plan") state.planDate = id;
  history.pushState({ overlay: kind, id }, "");
  render();
}

function closeOverlay(fromPop = false) {
  const shouldGoBack = !fromPop && Boolean(history.state && history.state.overlay);
  state.sheet = null;
  state.historyDate = null;
  state.runDate = null;
  state.planDate = null;
  render();
  if (shouldGoBack) history.back();
}

window.addEventListener("popstate", () => {
  if (state.sheet || state.historyDate || state.runDate || state.planDate) closeOverlay(true);
});

function historySheetHtml() {
  const w = completedWorkouts().find((row) => row.date === state.historyDate);
  if (!w) return "";
  if (w.completed && !w.review) {
    const review = CoachEngine.reviewSession(w, db().workouts);
    const workouts = db().workouts.map((row) => (row.date === w.date ? { ...row, review } : row));
    patch({ workouts });
    w.review = review;
  }
  return `<div class="sheet-bg" data-close-hist="1"><div class="sheet" data-stop="1">
    <button class="sheet-back dark" type="button" data-close-btn="1">‹ 戻る</button>
    <div class="handle"></div>
    <div class="kicker" style="margin-top:36px">${w.sessionType} ${SESSION_META[w.sessionType].name}</div>
    <h2 style="margin-top:6px">${w.date.replaceAll("-", ".")} ${weekdayJa(w.date)}</h2>
    ${w.exercises
      .map((ex) => {
        const name = EXERCISE_MAP[ex.id].name;
        const sets = ex.sets
          .map((s, i) => `#${i + 1} ` + (EXERCISE_MAP[ex.id].bodyweight ? `${s.reps}回` : `${s.weight}kg × ${s.reps}回`))
          .join("<br>");
        return `<div class="howto"><h4>${name}</h4><p class="muted">${sets}</p></div>`;
      })
      .join("")}
    ${reviewBlockHtml(w.review, w.date)}
    <button class="btn" type="button" data-edit-workout="${w.date}" style="margin-top:16px">記録を修正</button>
    <button class="btn ghost" type="button" data-close-btn="1" style="margin-top:8px">閉じる</button>
  </div></div>`;
}

function saveTodayBody() {
  const body = todayBody();
  const weights = db().weights.filter((w) => w.date !== todayStr());
  weights.push({ date: todayStr(), kg: body.kg, bodyFat: body.bodyFat });
  patch({ weights });
}

function applyStep(key, delta) {
  if (key === "sleep-hours") {
    const sleep = todaySleep();
    const hours = Math.max(4, Math.min(12, roundStep((sleep.hours || 7) + delta * 0.5, 0.5)));
    upsertByDate("sleeps", { ...sleep, hours });
    render();
    return;
  }
  if (key.startsWith("run-km:") || key.startsWith("run-kcal:")) {
    const isKm = key.startsWith("run-km:");
    const date = key.slice(isKm ? 7 : 9);
    const run = todayRun(date);
    if (isKm) {
      const km = Math.max(0, roundStep((Number(run.km) || 0) + delta * 0.1, 0.1));
      upsertByDate("runs", { ...run, date, done: true, km });
    } else {
      const kcal = Math.max(0, (Number(run.kcal) || 0) + delta * 10);
      upsertByDate("runs", { ...run, date, done: true, kcal });
    }
    refreshCoachPlan();
    render();
    return;
  }
  if (key === "body-weight" || key === "body-fat") {
    const body = todayBody();
    const next =
      key === "body-weight"
        ? { ...body, kg: Math.max(40, Math.min(120, roundStep(body.kg + delta * 0.1, 0.1))) }
        : { ...body, bodyFat: Math.max(5, Math.min(40, roundStep(body.bodyFat + delta * 0.1, 0.1))) };
    const weights = db().weights.filter((w) => w.date !== todayStr());
    weights.push({ date: todayStr(), kg: next.kg, bodyFat: next.bodyFat });
    patch({ weights });
    render();
    return;
  }
  const [kind, id, index] = key.split(":");
  const draft = state.editDraft || state.draft || db().draft;
  if (!draft) return;
  const row = draft.exercises.find((ex) => ex.id === id);
  const exercise = EXERCISE_MAP[id];
  const set = row.sets[Number(index)];
  if (kind === "w") {
    const step = exercise.incrementKg || 2.5;
    set.weight = Math.max(0, roundStep(set.weight + delta * step, step));
  } else {
    set.reps = Math.max(0, set.reps + delta);
  }
  if (state.editDraft) {
    state.editDraft = draft;
    render();
    return;
  }
  state.draft = draft;
  patch({ draft });
  render();
}

function startRestTimer(exerciseId) {
  const sec = CoachEngine.restSecondsFor(exerciseId);
  clearRestTimer();
  state.restTimer = { left: sec, total: sec };
  restInterval = setInterval(() => {
    state.restTimer.left -= 1;
    if (state.restTimer.left <= 0) {
      clearRestTimer();
    }
    render();
  }, 1000);
  render();
}

let restInterval = null;
function clearRestTimer() {
  if (restInterval) clearInterval(restInterval);
  restInterval = null;
  state.restTimer = null;
}

function finishWorkout() {
  const draft = state.draft || db().draft;
  if (!draft) return;
  const completed = { ...draft, completed: true };
  const workouts = db().workouts.filter((w) => w.date !== draft.date);
  completed.review = makeReview(completed, workouts);
  workouts.push(completed);
  patch({ workouts, draft: null });
  refreshCoachPlan();
  state.draft = null;
  state.view = "today";
  state.showNextPreview = true;
  state.reviewing = false;
  clearRestTimer();
  render();
}

async function forceAppRefresh() {
  try {
    if (navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (window.caches) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    /* ignore */
  }
  const dest = new URL("./index.html", location.href);
  dest.search = "";
  dest.searchParams.set("t", String(Date.now()));
  location.href = dest.href;
}

async function checkAppUpdate() {
  try {
    const res = await withTimeout(fetch(`./app.js?t=${Date.now()}`, { cache: "no-store" }), 4000);
    const text = await res.text();
    const match = text.match(/const APP_VERSION = (\d+)/);
    if (match && Number(match[1]) > APP_VERSION) {
      await forceAppRefresh();
      return;
    }
  } catch {
    /* ignore */
  }
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) await withTimeout(reg.update(), 3000);
  } catch {
    /* ignore */
  }
}

async function refreshFromServer() {
  try {
    await checkAppUpdate();
  } catch {
    /* ignore */
  }
  try {
    ensureReviews();
  } catch (err) {
    console.error(err);
  }
  try {
    ensureCoachPlan();
  } catch (err) {
    console.error(err);
  }
  render();
}

async function onAppVisible() {
  await refreshFromServer();
}

function bootstrap() {
  state.coachPlan = load().coachPlan || null;
  try {
    correctAugust17Weights();
  } catch (err) {
    console.error(err);
  }
  try {
    ensureCoachPlan();
  } catch (err) {
    console.error(err);
  }
  try {
    render();
  } catch (err) {
    console.error(err);
    showBootError(err);
  }
  refreshFromServer();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") onAppVisible();
  });
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw-36.js").catch(() => {});
  });
}

bootstrap();
