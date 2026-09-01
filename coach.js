/**
 * Auto coach: weekly base plan + next-session micro-adjustments.
 * Rules auto-evolve after ~3 months of training.
 */
const CoachEngine = {
  generate(data) {
    const weeklyPlan = this.generateWeekly(data);
    const workouts = (data.workouts || []).filter((w) => w.completed).sort((a, b) => a.date.localeCompare(b.date));
    const weights = (data.weights || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    const meals = data.meals || [];
    const rules = this.getRules(data, workouts);
    const last = workouts[workouts.length - 1] || null;
    const lastLog = (id) => {
      for (let i = workouts.length - 1; i >= 0; i--) {
        const row = workouts[i].exercises.find((ex) => ex.id === id);
        if (row && row.sets.some((s) => s.reps > 0)) return row;
      }
      return null;
    };
    const analysis = last ? this.analyzeWorkout(last) : null;
    const body = this.analyzeBody(weights);
    const nutrition = this.analyzeNutrition(meals);
    // 次にやる日と、その日に手動指定があるかを先に決める。
    // 指定があればローテーションより優先する。
    const planDate = this.buildWeekSchedule(data, "A").nextDate || this.fmtDate(new Date());
    const sessionOverride = (data.sessionOverrides || {})[planDate];
    const nextType = this.nextSessionType(last, weeklyPlan, {
      workouts,
      forDate: planDate,
      override: sessionOverride,
    });
    const weeklySession = weeklyPlan.sessions[nextType] || weeklyPlan.sessions.A;
    const exercises = this.microAdjustExercises(nextType, weeklySession.exercises || [], { lastLog, analysis, workouts, rules });
    const targets = {};
    const highlights = [];
    exercises.forEach((id) => {
      const ex = EXERCISE_MAP[id];
      const rec = this.recommend(ex, lastLog(id), rules);
      if (nextType === "C") {
        rec.sets = id === "side-raise" ? 3 : 2;
        rec.reason += " Cはランとの両立を優先する短時間セッション。";
      }
      targets[id] = rec;
      if (rec.highlight) highlights.push(rec.highlight);
    });
    const phase = this.phaseLabel(workouts, body, rules);
    const focus = weeklySession.focus;
    const coachNote = this.buildNote({ last, nextType, analysis, body, nutrition, phase, highlights, rules, weeklyPlan });
    const recoveryNote = this.recoveryNote(last);
    const weeklySummary = this.buildWeeklySummary(workouts, weights);
    const weekSchedule = this.buildWeekSchedule(data, nextType);
    const runPlan = this.buildRunPlan(data);

    return {
      generatedAt: new Date().toISOString(),
      runPlan,
      weekOf: weeklyPlan.weekOf,
      basedOnDate: last?.date || null,
      basedOnSession: last?.sessionType || null,
      nextSessionType: weekSchedule.nextSessionType || nextType,
      weeklyPlan,
      weeklySummary,
      rulesProfile: rules,
      phase,
      focus,
      exercises,
      targets,
      highlights,
      coachNote,
      recoveryNote,
      weekSchedule,
      bodySnapshot: body.latest,
      syncNote: last ? null : "前回ログがまだないので、週次メニューから次回を提案します。記録が増えると提案が細かくなります。",
    };
  },

  generateWeekly(data) {
    const workouts = (data.workouts || []).filter((w) => w.completed);
    const weights = (data.weights || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    const weekOf = this.currentWeekStart();
    const rules = this.getRules(data, workouts);
    const body = this.analyzeBody(weights);
    const lastLog = (id) => {
      for (let i = workouts.length - 1; i >= 0; i--) {
        const row = workouts[i].exercises.find((ex) => ex.id === id);
        if (row && row.sets.some((s) => s.reps > 0)) return row;
      }
      return null;
    };
    const weekWorkouts = workouts.filter((w) => w.date >= weekOf);
    const planDate = this.buildWeekSchedule(data, null).nextDate || this.fmtDate(new Date());
    const exCtx = { lastLog, workouts, rules, forDate: planDate };
    const sessions = {
      A: { focus: SESSION_META.A.focus, exercises: this.baseExercises("A", exCtx) },
      B: { focus: SESSION_META.B.focus, exercises: this.baseExercises("B", exCtx) },
      C: { focus: SESSION_META.C.focus, exercises: this.baseExercises("C", exCtx) },
    };
    const completedTypes = weekWorkouts.map((w) => w.sessionType);
    const coachNote = this.buildWeeklyNote({ rules, body, weekWorkouts, completedTypes });

    return {
      weekOf,
      phase: this.phaseLabel(workouts, body, rules),
      targetDays: "2–3",
      coachNote,
      sessions,
      completedThisWeek: completedTypes,
      suggestedOrder: ["A", "B", "C"],
    };
  },

  currentWeekStart() {
    const d = new Date();
    const day = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - day);
    return this.fmtDate(d);
  },

  fmtDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  },

  parseYmd(value) {
    const [y, m, d] = value.split("-").map(Number);
    return new Date(y, m - 1, d);
  },

  addDays(value, n) {
    const d = this.parseYmd(value);
    d.setDate(d.getDate() + n);
    return this.fmtDate(d);
  },

  buildWeekSchedule(data, nextType) {
    const weekOf = this.currentWeekStart();
    const today = this.fmtDate(new Date());
    const rotation = { A: "B", B: "C", C: "A" };
    const workouts = (data.workouts || []).filter((w) => w.completed).sort((a, b) => a.date.localeCompare(b.date));
    const last = workouts[workouts.length - 1] || null;
    let upcomingType = nextType || this.nextSessionType(last, { suggestedOrder: ["A", "B", "C"] });
    const target = PROFILE.weeklyTrainingMax || 3;
    const weekEnd = this.addDays(weekOf, 7);
    const weekWorkouts = workouts.filter((w) => w.date >= weekOf && w.date < weekEnd);
    const byDate = {};
    weekWorkouts.forEach((w) => {
      byDate[w.date] = w;
    });

    const overrides = data.scheduleOverrides && typeof data.scheduleOverrides === "object" ? data.scheduleOverrides : {};
    const blocked = (date) => ["rest", "run", "duty", "travel"].includes(overrides[date]);

    const days = [];
    for (let i = 0; i < 7; i++) {
      const date = this.addDays(weekOf, i);
      const w = byDate[date];
      days.push({
        date,
        weekday: "月火水木金土日"[i],
        dayNum: Number(date.slice(8)),
        isToday: date === today,
        isPast: date < today,
        kind: w ? "done" : "open",
        sessionType: w ? w.sessionType : null,
        optional: false,
        isNext: false,
        label: "",
        detail: "",
        overridden: Boolean(overrides[date]),
      });
    }

    const doneCount = weekWorkouts.length;
    days.forEach((day) => {
      if (day.kind === "done" || day.date < today) return;
      if (overrides[day.date] === "train") day.kind = "train";
    });
    let remaining = Math.max(
      0,
      target - doneCount - days.filter((day) => day.kind === "train" && day.date >= today).length
    );
    // Marathon block: three runs (quality/easy/long), three upper-body
    // sessions and one full rest day. C stays shorter than A/B.
    const preferred = new Set(["水", "金", "日"]);
    const prevTrainBefore = (date) => {
      const earlier = days.filter((d) => d.date < date && (d.kind === "train" || d.kind === "done"));
      const lastEarlier = earlier[earlier.length - 1];
      return lastEarlier?.date || last?.date || this.addDays(today, -3);
    };
    const canPlace = (day) => {
      if (blocked(day.date) || day.kind !== "open" || day.date < today) return false;
      const prev = prevTrainBefore(day.date);
      const gapPrev = (this.parseYmd(day.date) - this.parseYmd(prev)) / 86400000;
      // 水金日は筋トレ日。ランの質を落とさないよう連日筋トレは避ける。
      const minGap = preferred.has(day.weekday) ? 1 : 2;
      if (gapPrev < minGap) return false;
      const next = days.find((d) => d.date > day.date && d.kind === "train");
      if (next) {
        const gapNext = (this.parseYmd(next.date) - this.parseYmd(day.date)) / 86400000;
        const nextMin = preferred.has(next.weekday) ? 1 : 2;
        if (gapNext < Math.min(minGap, nextMin)) return false;
      }
      return true;
    };
    const place = (day) => {
      if (remaining <= 0 || !canPlace(day)) return false;
      day.kind = "train";
      remaining -= 1;
      return true;
    };

    days.filter((day) => preferred.has(day.weekday)).forEach(place);
    days.forEach(place);

    // 先の予定も固定ローテーションではなく、その日時点で最も間隔が空く種別を選ぶ。
    // 手動指定（sessionOverrides）があればそれを優先する。
    const sessionOverrides =
      data.sessionOverrides && typeof data.sessionOverrides === "object" ? data.sessionOverrides : {};
    const simulated = workouts.map((w) => ({ date: w.date, sessionType: w.sessionType, completed: true }));
    days
      .filter((day) => day.kind === "train")
      .forEach((day, i) => {
        const ov = sessionOverrides[day.date];
        const picked = ov || (i === 0 && upcomingType ? upcomingType : this.chooseSessionType(simulated, day.date));
        day.sessionType = picked;
        day.sessionOverridden = !!ov;
        simulated.push({ date: day.date, sessionType: picked, completed: true });
      });

    const trainDays = days.filter((day) => day.kind === "train" && day.date >= today);
    if (trainDays[0]) trainDays[0].isNext = true;
    // C is a planned short session, not an optional fourth priority.

    let nextDate = trainDays[0]?.date || null;
    let nextSessionType = trainDays[0]?.sessionType || upcomingType;
    let nextWeekHint = null;
    if (!nextDate) {
      const placed = days.filter((d) => d.kind === "train" || d.kind === "done");
      let lastTrain = placed[placed.length - 1]?.date || last?.date || this.addDays(today, -3);
      let cursor = weekEnd;
      for (let i = 0; i < 8; i++) {
        const gap = (this.parseYmd(cursor) - this.parseYmd(lastTrain)) / 86400000;
        if (gap >= 2 && !blocked(cursor)) {
          nextDate = cursor;
          nextSessionType = typeCursor;
          nextWeekHint = {
            date: cursor,
            weekday: "月火水木金土日"[(this.parseYmd(cursor).getDay() + 6) % 7],
            sessionType: typeCursor,
          };
          break;
        }
        cursor = this.addDays(cursor, 1);
      }
    }

    const runMap = {};
    (data.runs || []).forEach((row) => {
      if (row && row.date && (row.done || row.km > 0)) runMap[row.date] = row;
    });
    const runPlan = this.buildRunPlan(data);
    // 曜日テンプレどおりに置けたラン種別を数え、当直・旅行などで押し出された分は
    // 「ラン」指定の別の日へ振り替える（ロングを落とさないよう優先度順）
    const placedRunTypes = new Set();
    days.forEach((day) => {
      if (runMap[day.date] || day.kind === "train" || day.kind === "done") return;
      const ov = overrides[day.date];
      if (ov === "rest" || ov === "duty" || ov === "travel") return;
      const type = RUN_PLAN.weekly?.[day.weekday];
      if (type) placedRunTypes.add(type);
    });
    const spareRunTypes = ["long", "tempo", "easy"].filter((t) => !placedRunTypes.has(t));
    days.forEach((day) => {
      if (day.kind === "done") {
        const meta = SESSION_META[day.sessionType];
        day.label = `${day.sessionType}済`;
        day.detail = `${day.sessionType} ${meta?.name || ""} 完了`;
        return;
      }
      if (day.kind === "train") {
        const meta = SESSION_META[day.sessionType];
        day.label = `${day.sessionType}${meta?.name || ""}`;
        day.detail = day.overridden
          ? "希望日に変更"
          : day.isNext
            ? "次のトレーニング"
            : day.optional
              ? "余裕があれば"
              : "予定";
        return;
      }
      const run = runMap[day.date];
      if (run) {
        const donePace = this.paceOf(run);
        day.kind = "run";
        day.label = run.km ? `ラン${run.km}km` : "ラン済";
        day.detail = donePace
          ? `${run.km}km · ${this.fmtPace(donePace)}/km`
          : `${run.km || "—"}km · ${run.kcal || "—"}kcal`;
        return;
      }
      const plannedRun = runPlan?.byWeekday?.[day.weekday] || null;
      if (plannedRun) day.runTarget = plannedRun;
      const ov = overrides[day.date];
      if (ov === "run") {
        const session = plannedRun || (spareRunTypes.length ? runPlan?.sessions?.[spareRunTypes.shift()] : null);
        if (session) day.runTarget = session;
        day.kind = "run";
        day.label = session?.label || "ラン";
        day.detail = session?.detail || "ラン予定";
        return;
      }
      if (ov === "rest") {
        day.kind = "rest";
        day.label = "休養";
        day.detail = "休養に変更";
        return;
      }
      if (ov === "duty" || ov === "travel") {
        day.kind = "rest";
        day.label = ov === "duty" ? "当直" : "旅行";
        day.detail = ov === "duty" ? "当直・トレーニングなし" : "旅行・完全休養";
        return;
      }
      day.kind = plannedRun ? "run" : "rest";
      day.label = plannedRun?.label || "休養";
      day.detail = plannedRun?.detail || "完全休養";
    });

    return {
      weekOf,
      target,
      doneCount,
      days,
      nextDate,
      nextSessionType,
      nextWeekHint,
    };
  },

  // ---- ラン ----------------------------------------------------------

  fmtPace(sec) {
    const s = Math.max(0, Math.round(sec));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  },

  paceRange(sec, spread) {
    return `${this.fmtPace(sec - spread)}〜${this.fmtPace(sec + spread)}`;
  },

  /** 1kmあたりの秒数。durationSec が無い旧データは note の「6:47/km」から復元する。 */
  paceOf(run) {
    const km = Number(run?.km) || 0;
    if (km <= 0) return 0;
    let sec = Number(run.durationSec) || 0;
    if (!sec) {
      const m = /(\d{1,2}):(\d{2})\s*\/?\s*km/.exec(run.note || "");
      if (m) sec = (Number(m[1]) * 60 + Number(m[2])) * km;
    }
    return sec > 0 ? sec / km : 0;
  },

  runStats(runs) {
    const rows = (runs || [])
      .filter((r) => r && r.date && (r.done || r.km > 0))
      .sort((a, b) => a.date.localeCompare(b.date));
    const paced = rows
      .map((r) => ({ date: r.date, km: Number(r.km) || 0, paceSec: this.paceOf(r), type: r.type || "" }))
      .filter((r) => r.paceSec > 0);
    const recent = paced.slice(-6);
    // 基準ペースは「Eラン」だけから取る。テンポは意図的に速く、ロングは意図的に遅いので、
    // 混ぜると基準が処方に引きずられ、際限なく速く（または遅く）なる自己強化ループになる。
    const shortMax = RUN_PLAN.easyMaxKm + 2;
    let pool = recent.filter((r) => r.type === "easy");
    if (!pool.length) pool = recent.filter((r) => !r.type && r.km > 0 && r.km <= shortMax);
    if (!pool.length) pool = recent.filter((r) => r.type !== "tempo" && r.km > 0 && r.km <= shortMax);
    let easySec = 0;
    if (pool.length) {
      const sorted = pool.map((r) => r.paceSec).sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      easySec = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    } else if (recent.length) {
      // Eランの記録が無い期間は、中央値だと処方側へ引きずられるので最速を採る
      easySec = Math.min.apply(null, recent.map((r) => r.paceSec));
    }
    const longestKm = rows.reduce((m, r) => Math.max(m, Number(r.km) || 0), 0);
    return { rows, paced, recent, easySec, longestKm, count: rows.length };
  },

  /**
   * 実績ペースを起点に、レースまでの残り週数で目標ペースへ寄せていく。
   * 走るたびに easySec が更新されるので、勝手に前倒しにも後ろ倒しにもなる。
   */
  buildRunPlan(data) {
    const goalKey = data.marathonGoal?.target || PROFILE.marathonGoal;
    const raceDate = data.marathonGoal?.date || PROFILE.marathonDate;
    const goal = RUN_PLAN.goals[goalKey];
    if (!goal || !raceDate) return null;

    const dayMs = 86400000;
    const today = this.fmtDate(new Date());
    const stats = this.runStats(data.runs);
    const start = stats.rows[0]?.date || data.profileStartDate || PROFILE.startDate || today;
    const totalDays = Math.max(1, (this.parseYmd(raceDate) - this.parseYmd(start)) / dayMs);
    const elapsedDays = Math.max(0, (this.parseYmd(today) - this.parseYmd(start)) / dayMs);
    const progress = Math.max(0, Math.min(1, elapsedDays / totalDays));
    const weeksToRace = Math.max(0, Math.ceil((this.parseYmd(raceDate) - this.parseYmd(today)) / dayMs / 7));

    const racePaceSec = goal.seconds / RUN_PLAN.marathonKm;
    const tempoFinalSec = racePaceSec - 20; // 閾値ペースの最終形
    const hasData = stats.easySec > 0;
    const easySec = hasData ? stats.easySec : racePaceSec + 70;

    // テンポは「今のEペース −35秒」から始め、レースまでに閾値ペースへ寄せる
    const tempoStart = easySec - 35;
    const tempoRaw = tempoStart + (tempoFinalSec - tempoStart) * progress;
    // 最後の min は、Eペースが既に閾値より速い（目標を大きく上回った）場合に
    // 「テンポの方が遅い」という逆転が起きるのを防ぐガード。
    const tempoSec = Math.round(Math.min(Math.max(tempoFinalSec, Math.min(tempoRaw, easySec - 20)), easySec - 10));
    const longSec = Math.round(easySec + 10);

    const half = (n) => Math.round(n * 2) / 2;
    const buildP = Math.min(1, progress / RUN_PLAN.taperFrom);
    const taperP = progress <= RUN_PLAN.taperFrom ? 0 : (progress - RUN_PLAN.taperFrom) / (1 - RUN_PLAN.taperFrom);

    let longKm = RUN_PLAN.longStartKm + (RUN_PLAN.longPeakKm - RUN_PLAN.longStartKm) * buildP;
    if (taperP > 0) longKm = RUN_PLAN.longPeakKm - (RUN_PLAN.longPeakKm - 12) * taperP;
    // 一度に増やすのは直近最長の約12%まで（最低1km・最大3km）。10%ルールの範囲に収める。
    const longStepKm = stats.longestKm > 0 ? Math.max(1, Math.min(3, stats.longestKm * 0.12)) : 0;
    if (stats.longestKm > 0) longKm = Math.min(longKm, stats.longestKm + longStepKm);
    longKm = half(Math.max(RUN_PLAN.longStartKm - 2, longKm));

    const weekIndex = Math.floor(elapsedDays / 7);
    const cutback = weekIndex > 0 && weekIndex % 4 === 3 && taperP === 0;
    if (cutback) longKm = half(longKm * 0.75);

    const tempoKm = half(RUN_PLAN.tempoStartKm + (RUN_PLAN.tempoPeakKm - RUN_PLAN.tempoStartKm) * buildP);
    const tempoTotalKm = half(tempoKm + 3);
    const easyKm = half(RUN_PLAN.easyMinKm + (RUN_PLAN.easyMaxKm - RUN_PLAN.easyMinKm) * buildP);

    const sessions = {
      tempo: {
        type: "tempo",
        label: RUN_PLAN.types.tempo.label,
        km: tempoTotalKm,
        coreKm: tempoKm,
        paceSec: tempoSec,
        paceText: `${this.paceRange(tempoSec, 5)}/km`,
        detail: `合計${tempoTotalKm}km · うち${tempoKm}kmを ${this.paceRange(tempoSec, 5)}/km`,
        reason: hasData
          ? `直近のEペース${this.fmtPace(easySec)}/kmが基準。残り${weeksToRace}週で${this.fmtPace(tempoFinalSec)}/kmへ寄せる。`
          : `実績が無いので${goal.label}から逆算。走って記録すれば実績ベースに切り替わる。`,
      },
      easy: {
        type: "easy",
        label: RUN_PLAN.types.easy.label,
        km: easyKm,
        paceSec: Math.round(easySec),
        paceText: `${this.paceRange(easySec, 8)}/km`,
        detail: `${easyKm}km · ${this.paceRange(easySec, 8)}/km・会話できる強度`,
        reason: "回復とベース作り。速く走らないことが目的。",
      },
      long: {
        type: "long",
        label: RUN_PLAN.types.long.label,
        km: longKm,
        paceSec: longSec,
        paceText: `${this.paceRange(longSec, 10)}/km`,
        detail: `${longKm}km · ${this.paceRange(longSec, 10)}/km・ゆっくり`,
        reason: cutback
          ? "疲労抜きの週。距離を落として回復を優先。"
          : stats.longestKm > 0
            ? `これまでの最長は${stats.longestKm}km。1回に増やすのは+${half(longStepKm)}kmまで。`
            : "まずは距離に慣れる。",
      },
    };

    const byWeekday = {};
    Object.entries(RUN_PLAN.weekly).forEach(([weekday, type]) => {
      if (sessions[type]) byWeekday[weekday] = { ...sessions[type], weekday };
    });

    return {
      goal: goalKey,
      goalLabel: goal.label,
      raceDate,
      weeksToRace,
      progress: Number(progress.toFixed(3)),
      hasData,
      easyPaceSec: Math.round(easySec),
      easyPaceText: `${this.fmtPace(easySec)}/km`,
      racePaceSec: Math.round(racePaceSec),
      racePaceText: `${this.fmtPace(racePaceSec)}/km`,
      cutbackWeek: cutback,
      sessions,
      byWeekday,
      note: hasData
        ? `${goal.label}は${this.fmtPace(racePaceSec)}/km。今のEペースは${this.fmtPace(easySec)}/km、残り${weeksToRace}週。`
        : `${goal.label}は${this.fmtPace(racePaceSec)}/km。ペース記録が無いため暫定値。`,
    };
  },

  getRules(data, workouts) {
    const start = data.profileStartDate || PROFILE.startDate || workouts[0]?.date || this.currentWeekStart();
    const startDate = new Date(start);
    const now = new Date();
    const monthsElapsed = (now - startDate) / (1000 * 60 * 60 * 24 * 30.44);
    let tier = "intro";
    if (monthsElapsed >= 3) tier = "mature";
    else if (monthsElapsed >= 1 || workouts.length >= 8) tier = "building";

    const weights = (data.weights || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    const latestFat = weights[weights.length - 1]?.bodyFat ?? PROFILE.startBodyFat;

    return {
      tier,
      monthsElapsed: Number(monthsElapsed.toFixed(1)),
      incrementMultiplier: tier === "intro" ? 1 : tier === "building" ? 1 : latestFat > 14 ? 0.5 : 1,
      repFocus: tier === "mature" && latestFat > 13 ? "reps_before_weight" : "standard",
      weeklyTargetMin: 2,
      weeklyTargetMax: 3,
      pullUpThreshold: tier === "intro" ? 5 : 6,
      proteinTargetG: tier === "mature" ? Math.max(PROFILE.proteinTargetG, 140) : PROFILE.proteinTargetG,
      autoAdjustedAt: new Date().toISOString(),
      message:
        tier === "intro"
          ? "導入期ルール（フォーム・回数優先）"
          : tier === "building"
            ? "構築期ルール（漸進過負荷）"
            : "3ヶ月超ルール（体脂肪に応じて負荷調整）",
    };
  },

  phaseLabel(workouts, body, rules) {
    if (rules.tier === "intro") return "導入期";
    if (rules.tier === "mature" && body.fatTrend === "down") return "緩やかカット";
    return rules.tier === "building" ? "構築期" : "漸進期";
  },

  nextSessionType(last, weeklyPlan, ctx) {
    const workouts = ctx?.workouts || (last ? [last] : []);
    const forDate = ctx?.forDate;
    const override = ctx?.override;
    if (!last) return override || weeklyPlan.suggestedOrder[0] || "A";
    return this.chooseSessionType(workouts, forDate, override);
  },

  pickPullExercise(lastLog, rules) {
    const log = lastLog("pull-up");
    if (!log) return "lat-pulldown";
    const best = Math.max(...log.sets.map((s) => s.reps));
    if (best >= rules.pullUpThreshold + 2) return "pull-up";
    if (best >= rules.pullUpThreshold - 1) return "pull-up";
    return "lat-pulldown";
  },

  /** 種目ごとの最終実施日を返す。 */
  lastDoneMap(workouts) {
    const map = {};
    (workouts || []).forEach((w) => {
      (w.exercises || []).forEach((row) => {
        if (row && row.sets && row.sets.some((s) => s.reps > 0)) {
          if (!map[row.id] || w.date > map[row.id]) map[row.id] = w.date;
        }
      });
    });
    return map;
  },

  /**
   * 固定メニューではなく、間隔が空いている種目を優先して組み立てる。
   * core は毎回入れる主要種目、残りは pool から「久しくやっていない順」に選ぶ。
   * 同じ内容が続かず、特定の種目だけ抜け落ちることも無くなる。
   */
  baseExercises(type, ctx) {
    const { lastLog, workouts, rules, forDate } = ctx;
    const plan = SESSION_PLAN[type];
    if (!plan) return [];
    const today = forDate || this.fmtDate(new Date());

    const chosen = [];
    if (type === "B") chosen.push(this.pickPullExercise(lastLog, rules)); // 懸垂かラットプル
    plan.core.forEach((id) => {
      if (!chosen.includes(id)) chosen.push(id);
    });

    const lastDone = this.lastDoneMap(workouts);
    const dayMs = 86400000;
    const candidates = plan.pool
      .filter((id) => !chosen.includes(id))
      .map((id) => {
        const d = lastDone[id];
        return {
          id,
          // 未実施は最優先。それ以外は空いた日数が長いほど優先。
          days: d ? (this.parseYmd(today) - this.parseYmd(d)) / dayMs : 999,
        };
      })
      .sort((a, b) => b.days - a.days || plan.pool.indexOf(a.id) - plan.pool.indexOf(b.id));

    while (chosen.length < plan.size && candidates.length) chosen.push(candidates.shift().id);
    return chosen;
  },

  /**
   * 次にやる種別を決める。A→B→C の固定ローテーションではなく、
   * 「最後にやってから一番空いている種別」を選ぶ。
   * 予定が崩れて特定の部位が飛んでも、次に自動で拾い直せる。
   * 直前と同じ系統（押す/引く/脚）は回復を待つため減点する。
   */
  chooseSessionType(workouts, forDate, override) {
    if (override && SESSION_PLAN[override]) return override;
    const done = (workouts || []).filter((w) => w.completed);
    if (!done.length) return "A";

    const dayMs = 86400000;
    const today = forDate || this.fmtDate(new Date());
    const lastOf = {};
    done.forEach((w) => {
      if (!lastOf[w.sessionType] || w.date > lastOf[w.sessionType]) lastOf[w.sessionType] = w.date;
    });
    const last = done[done.length - 1];
    const lastGap = (this.parseYmd(today) - this.parseYmd(last.date)) / dayMs;

    const types = ["A", "B", "C"];
    const scored = types.map((t) => {
      const d = lastOf[t];
      let score = d ? (this.parseYmd(today) - this.parseYmd(d)) / dayMs : 999;
      const sameCategory = SESSION_PLAN[t]?.category === SESSION_PLAN[last.sessionType]?.category;
      if (sameCategory && lastGap < 2) score -= 10; // 中1日未満で同系統は避ける
      return { type: t, score };
    });
    scored.sort((a, b) => b.score - a.score || types.indexOf(a.type) - types.indexOf(b.type));
    return scored[0].type;
  },

  microAdjustExercises(type, weeklyExercises, ctx) {
    const { lastLog, analysis, rules } = ctx;
    let list = [...weeklyExercises];
    if (type === "B") {
      const back = this.pickPullExercise(lastLog, rules);
      if (list[0] === "lat-pulldown" || list[0] === "pull-up") list[0] = back;
    }
    return list;
  },

  weakerBetween(a, b, lastLog) {
    const logA = lastLog(a);
    const logB = lastLog(b);
    if (!logA) return a;
    if (!logB) return b;
    const avg = (log) => log.sets.reduce((s, set) => s + set.reps, 0) / log.sets.length;
    return avg(logA) <= avg(logB) ? a : b;
  },

  analyzeWorkout(workout) {
    const progressed = [];
    const maintain = [];
    const struggled = [];
    workout.exercises.forEach((row) => {
      const ex = EXERCISE_MAP[row.id];
      if (!ex) return;
      const reps = row.sets.map((s) => s.reps);
      const hitMax = reps.every((r) => r >= ex.repMax);
      const missMin = reps.some((r) => r < ex.repMin);
      const label = ex.name;
      if (hitMax) progressed.push(label);
      else if (missMin) struggled.push(label);
      else maintain.push(label);
    });
    return { progressed, maintain, struggled };
  },

  analyzeBody(weights) {
    const latest = weights[weights.length - 1];
    const prev = weights[weights.length - 2];
    let fatTrend = "unknown";
    let weightTrend = "unknown";
    if (latest?.bodyFat != null && prev?.bodyFat != null) {
      const d = latest.bodyFat - prev.bodyFat;
      fatTrend = d <= -0.2 ? "down" : d >= 0.2 ? "up" : "flat";
    }
    if (latest?.kg != null && prev?.kg != null) {
      const d = latest.kg - prev.kg;
      weightTrend = d <= -0.15 ? "down" : d >= 0.15 ? "up" : "flat";
    }
    return {
      latest: latest || { kg: PROFILE.startWeightKg, bodyFat: PROFILE.startBodyFat },
      fatTrend,
      weightTrend,
      toGoal: latest?.bodyFat != null ? latest.bodyFat - 11 : PROFILE.startBodyFat - 11,
    };
  },

  analyzeNutrition(meals) {
    const recent = meals.slice(-7);
    const proteinDays = recent.filter((m) => (m.protein || 0) >= PROFILE.proteinTargetG * 0.85).length;
    const poorDays = recent.filter((m) => m.quality === "poor").length;
    return { proteinDays, poorDays, recentCount: recent.length };
  },

  recommend(exercise, last, rules = { incrementMultiplier: 1, repFocus: "standard" }) {
    const mult = rules.incrementMultiplier || 1;
    if (exercise.bodyweight) {
      if (!last) {
        return { weight: 0, reps: exercise.repMin, reason: "自重から開始。回数を伸ばす。", highlight: null, restSec: exercise.restSec };
      }
      const hit = last.sets.every((s) => s.reps >= exercise.repMax);
      const best = Math.max(...last.sets.map((s) => s.reps));
      return {
        weight: 0,
        reps: hit ? exercise.repMax : Math.min(exercise.repMax, best + 1),
        reason: hit ? "前回上限到達。丁寧に+1〜2回。" : "前回の回数から上限を目指す。",
        highlight: hit ? `${exercise.name} 回数アップ` : null,
        restSec: exercise.restSec,
      };
    }
    if (!last) {
      return {
        weight: exercise.startWeight,
        reps: exercise.repMin,
        reason: `初回目安 ${exercise.startWeight}kg。フォーム優先。`,
        highlight: null,
        restSec: exercise.restSec,
      };
    }
    const weight = Math.max(...last.sets.map((s) => Number(s.weight) || 0));
    const workSets = last.sets.filter((s) => Number(s.weight) === weight);
    const hitMax = workSets.every((s) => s.reps >= exercise.repMax);
    const missMin = workSets.some((s) => s.reps < exercise.repMin);
    const step = (exercise.incrementKg || 2.5) * mult;
    if (hitMax && rules.repFocus !== "reps_before_weight") {
      const nextW = this.roundStep(weight + step, step);
      return {
        weight: nextW,
        reps: exercise.repMin,
        reason: `前回${exercise.repMax}回達成 → ${nextW}kg（${rules.message}）。`,
        highlight: `${exercise.name} ${nextW}kg`,
        restSec: exercise.restSec,
      };
    }
    if (hitMax && rules.repFocus === "reps_before_weight") {
      return {
        weight,
        reps: Math.min(exercise.repMax + 2, exercise.repMax),
        reason: "体脂肪優先期。重量は維持し回数とフォームを伸ばす。",
        highlight: null,
        restSec: exercise.restSec,
      };
    }
    if (missMin) {
      return {
        weight,
        reps: exercise.repMin,
        reason: `前回${exercise.repMin}回未満あり。同重量で回数を伸ばす。`,
        highlight: null,
        restSec: exercise.restSec,
      };
    }
    const best = Math.max(...workSets.map((s) => s.reps));
    return {
      weight,
      reps: Math.min(exercise.repMax, best),
      reason: "同重量。回数を上限まで。",
      highlight: null,
      restSec: exercise.restSec,
    };
  },

  roundStep(value, step) {
    const rounded = Math.round(value / step) * step;
    return Number(rounded.toFixed(step < 1 ? 2 : 1));
  },

  buildNote(ctx) {
    const { last, nextType, analysis, body, nutrition, phase, highlights, rules, weeklyPlan } = ctx;
    const meta = SESSION_META[nextType];
    const parts = [];

    parts.push(`今週の目標: 上半身 ${rules.weeklyTargetMin}–${rules.weeklyTargetMax}回（${weeklyPlan.completedThisWeek.length}回済）。`);
    parts.push(`コーチルール: ${rules.message}（${rules.monthsElapsed}ヶ月目）`);

    if (!last) {
      parts.push(`初回は${nextType}（${meta.name}）。${phase}はフォーム優先。`);
    } else {
      parts.push(`前回${last.date.slice(5).replace("-", "/")} ${last.sessionType}を反映。`);
      parts.push(`次回 → ${nextType} ${meta.name}。`);
      if (analysis.progressed.length) parts.push(`好調: ${analysis.progressed.join("、")}。`);
      if (analysis.struggled.length) parts.push(`要改善: ${analysis.struggled.join("、")}。`);
      if (highlights.length) parts.push(`重点: ${highlights.slice(0, 3).join("、")}。`);
    }

    if (body.latest.bodyFat != null) {
      parts.push(`体脂肪 ${body.latest.bodyFat}%（目標まで約${Math.max(0, body.toGoal).toFixed(1)}pt）。`);
    }
    if (nutrition.recentCount && nutrition.proteinDays < 3) {
      parts.push(`タンパク質目安 ${rules.proteinTargetG}g/日を意識。`);
    }
    parts.push(weeklyPlan.coachNote);

    return parts.join(" ");
  },

  buildWeeklyNote(ctx) {
    const { rules, body, weekWorkouts, completedTypes } = ctx;
    const remaining = Math.max(0, rules.weeklyTargetMin - completedTypes.length);
    const parts = [
      `今週は上半身 ${rules.weeklyTargetMin}–${rules.weeklyTargetMax}回が目安です（${completedTypes.length}回済）。`,
      rules.message,
    ];
    if (remaining > 0) parts.push(`あと${remaining}回で今週の最低ライン。`);
    else if (completedTypes.length >= rules.weeklyTargetMax) parts.push("今週の目標回数に到達。休養かランを優先してOK。");
    if (body.latest.bodyFat != null) parts.push(`体脂肪 ${body.latest.bodyFat}%。`);
    return parts.join(" ");
  },

  buildWeeklySummary(workouts, weights) {
    const weekOf = this.currentWeekStart();
    const week = workouts.filter((w) => w.completed && w.date >= weekOf);
    let totalSets = 0;
    let totalReps = 0;
    let totalVolume = 0;
    const byMuscle = {};
    week.forEach((w) => {
      w.exercises.forEach((row) => {
        const ex = EXERCISE_MAP[row.id];
        if (!ex) return;
        const muscle = ex.muscle.split("（")[0];
        byMuscle[muscle] = (byMuscle[muscle] || 0) + row.sets.length;
        row.sets.forEach((s) => {
          totalSets += 1;
          totalReps += s.reps;
          if (!ex.bodyweight) totalVolume += s.weight * s.reps;
        });
      });
    });
    const latest = weights[weights.length - 1];
    return {
      weekOf,
      sessions: week.length,
      totalSets,
      totalReps,
      totalVolumeKg: Math.round(totalVolume),
      topMuscle: Object.entries(byMuscle).sort((a, b) => b[1] - a[1])[0]?.[0] || "—",
      bodyFat: latest?.bodyFat,
      weightKg: latest?.kg,
    };
  },

  recoveryNote(last) {
    if (!last) return null;
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const y = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
    if (last.date === y) return "前日トレ済み。今日はランか休養がおすすめ。やるなら軽めに。";
    return null;
  },

  restSecondsFor(exerciseId) {
    const ex = EXERCISE_MAP[exerciseId];
    if (!ex) return 90;
    const compound = ["bench-press", "incline-press", "ohp", "barbell-row", "lat-pulldown", "pull-up", "seated-row"];
    return compound.includes(exerciseId) ? 90 : 60;
  },

  reviewSession(workout, allWorkouts = [], context = {}) {
    const meta = SESSION_META[workout.sessionType] || { name: workout.sessionType, subtitle: "" };
    const analysis = this.analyzeWorkout(workout);
    const prev = [...allWorkouts]
      .filter((w) => w.completed && w.date < workout.date && w.sessionType === workout.sessionType)
      .sort((a, b) => a.date.localeCompare(b.date))
      .pop();
    const meal = context.meal || null;
    const sleep = context.sleep || null;
    const run = context.run || null;

    const exerciseNotes = [];
    workout.exercises.forEach((row) => {
      const ex = EXERCISE_MAP[row.id];
      if (!ex) return;
      const reps = row.sets.map((s) => s.reps);
      const weights = row.sets.map((s) => s.weight);
      const label = ex.bodyweight ? `${ex.name} ${reps.join("/")}回` : `${ex.name} ${weights[0]}kg ${reps.join("/")}回`;
      let tip = "";
      if (reps.every((r) => r >= ex.repMax)) {
        tip = ex.bodyweight ? "回数上限到達。次回は丁寧に+1〜2回。" : "上限到達。次回は+2.5kgを検討。";
      } else if (reps.some((r) => r < ex.repMin)) {
        tip = "目標回数に届いていない。重量は維持し、フォームと休憩を優先。";
      } else {
        const gap = ex.repMax - Math.max(...reps);
        tip = gap <= 2 ? `あと${gap}回で上限。次セットは休憩${ex.restSec}秒を守る。` : "同重量で回数を積む。";
      }
      exerciseNotes.push({ label, tip });
    });

    const goods = analysis.progressed.length
      ? `${analysis.progressed.join("、")}は上限回数まで到達。次回は重量アップの候補です。`
      : exerciseNotes.length
        ? `${exerciseNotes[0].label}を軸に、同重量で回数を積みましょう。`
        : "上限到達の種目はまだ少ないので、同じ重量で回数を積みましょう。";
    const improves = analysis.struggled.length
      ? `${analysis.struggled.join("、")}は目標回数に届いていません。無理に重量を上げず、セット間の休憩とフォームを優先。`
      : analysis.maintain.length
        ? `${analysis.maintain.join("、")}は伸びしろあり。最後の1〜2回の質を意識。`
        : "大きく崩れた種目はありません。";

    let vsPrev = "この種目グループの前回比較データはまだありません。";
    let volumeDelta = null;
    const volumeOf = (w) =>
      w.exercises.reduce((sum, row) => {
        const ex = EXERCISE_MAP[row.id];
        if (!ex || ex.bodyweight) return sum;
        return sum + row.sets.reduce((s, set) => s + set.weight * set.reps, 0);
      }, 0);
    const volume = volumeOf(workout);
    if (prev) {
      const prevVol = volumeOf(prev);
      volumeDelta = volume - prevVol;
      const diffs = [];
      workout.exercises.forEach((row) => {
        const ex = EXERCISE_MAP[row.id];
        const before = prev.exercises.find((p) => p.id === row.id);
        if (!ex || !before || ex.bodyweight) return;
        const nowW = row.sets[0]?.weight;
        const oldW = before.sets[0]?.weight;
        const nowReps = row.sets.reduce((s, set) => s + set.reps, 0);
        const oldReps = before.sets.reduce((s, set) => s + set.reps, 0);
        if (nowW > oldW) diffs.push(`${ex.name} ${oldW}→${nowW}kg`);
        else if (nowReps > oldReps) diffs.push(`${ex.name} 総レップ${oldReps}→${nowReps}`);
      });
      vsPrev = diffs.length
        ? `前回同セッション（${prev.date.slice(5).replace("-", "/")}）より ${diffs.join("、")}。`
        : volumeDelta > 0
          ? `前回より総ボリューム+${Math.round(volumeDelta)}kg。回数の伸びが効いています。`
          : "重量は前回と同水準。回数の伸びを見ていきましょう。";
    }

    const lifeNotes = [];
    if (meal?.protein && meal.protein < PROFILE.proteinTargetG * 0.7) {
      lifeNotes.push(`タンパク質${meal.protein}gは目安${PROFILE.proteinTargetG}gより少なめ。`);
    } else if (meal?.protein >= PROFILE.proteinTargetG) {
      lifeNotes.push(`タンパク質${meal.protein}gは十分。`);
    }
    if (sleep?.hours != null && sleep.hours < 6.5) {
      lifeNotes.push(`睡眠${sleep.hours}時間は短め。次回まで回復を優先。`);
    }
    if (run?.km) {
      lifeNotes.push(`同日ラン${run.km}kmあり。上半身は疲労が残りやすい。`);
    }

    const summary = `${workout.date.replaceAll("-", "/")} の${workout.sessionType}（${meta.name}）を完了。総ボリューム約${Math.round(volume)}kg。`;
    const next = `次回は ${ { A: "B 引く", B: "C 総合", C: "A 押す" }[workout.sessionType] || "次セッション" }。今日はタンパク質と睡眠を優先。`;
    const detail = exerciseNotes.map((row) => `・${row.label}\n  → ${row.tip}`).join("\n");
    const lifeLine = lifeNotes.length ? `\n\n生活: ${lifeNotes.join(" ")}` : "";

    return {
      summary,
      goods,
      improves,
      vsPrev,
      next,
      detail,
      lifeNotes,
      logLines: exerciseNotes.map((row) => row.label),
      volumeKg: Math.round(volume),
      volumeDelta: volumeDelta != null ? Math.round(volumeDelta) : null,
      source: "local",
      generatedAt: new Date().toISOString(),
      shareText: this.buildSharePrompt(workout, {
        summary,
        goods,
        improves,
        vsPrev,
        next,
        detail,
        lifeLine,
        volumeKg: Math.round(volume),
      }),
    };
  },

  buildSharePrompt(workout, review) {
    const meta = SESSION_META[workout.sessionType] || { name: workout.sessionType };
    const lines = workout.exercises
      .map((row) => {
        const ex = EXERCISE_MAP[row.id];
        if (!ex) return "";
        const sets = row.sets.map((s) => (ex.bodyweight ? `${s.reps}回` : `${s.weight}kg×${s.reps}`)).join(" / ");
        return `- ${ex.name}: ${sets}`;
      })
      .filter(Boolean)
      .join("\n");
    return (
      `あなたは自宅筋トレのパーソナルトレーナーです。以下の記録をもとに、具体的な振り返りと次回アドバイスを日本語で書いてください。\n\n` +
      `【プロフィール】目標体脂肪10-12% / 週2-3回上半身+ラン\n` +
      `【今日】${workout.date} ${workout.sessionType} ${meta.name}\n` +
      `【記録】\n${lines}\n` +
      `【端末内コーチの分析】\n` +
      `総評: ${review.summary}\n` +
      `よかった点: ${review.goods}\n` +
      `改善点: ${review.improves}\n` +
      `前回比: ${review.vsPrev}\n` +
      `種目別:\n${review.detail}${review.lifeLine || ""}\n\n` +
      `上記を踏まえ、見出し「総評」「よかった点」「改善点」「次回へ」で、各2文以内にまとめてください。`
    );
  },
};
