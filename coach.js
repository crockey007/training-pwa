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
    const nextType = this.nextSessionType(last, weeklyPlan);
    const weeklySession = weeklyPlan.sessions[nextType] || weeklyPlan.sessions.A;
    const exercises = this.microAdjustExercises(nextType, weeklySession.exercises || [], { lastLog, analysis, workouts, rules });
    const targets = {};
    const highlights = [];
    exercises.forEach((id) => {
      const ex = EXERCISE_MAP[id];
      const rec = this.recommend(ex, lastLog(id), rules);
      targets[id] = rec;
      if (rec.highlight) highlights.push(rec.highlight);
    });
    const phase = this.phaseLabel(workouts, body, rules);
    const focus = weeklySession.focus;
    const coachNote = this.buildNote({ last, nextType, analysis, body, nutrition, phase, highlights, rules, weeklyPlan });
    const recoveryNote = this.recoveryNote(last);
    const weeklySummary = this.buildWeeklySummary(workouts, weights);
    const weekSchedule = this.buildWeekSchedule(data, nextType);

    return {
      generatedAt: new Date().toISOString(),
      weekOf: weeklyPlan.weekOf,
      basedOnDate: last?.date || null,
      basedOnSession: last?.sessionType || null,
      nextSessionType: nextType,
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
    const sessions = {
      A: {
        focus: SESSION_META.A.focus,
        exercises: this.baseExercises("A", { lastLog, workouts, rules }),
      },
      B: {
        focus: SESSION_META.B.focus,
        exercises: this.baseExercises("B", { lastLog, workouts, rules }),
      },
      C: {
        focus: SESSION_META.C.focus,
        exercises: this.baseExercises("C", { lastLog, workouts, rules }),
      },
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
      });
    }

    const doneCount = weekWorkouts.length;
    let remaining = Math.max(0, target - doneCount);
    let lastTrain = last?.date || this.addDays(today, -3);
    const preferred = new Set(["月", "水", "金"]);
    const canPlace = (date) => {
      const gap = (this.parseYmd(date) - this.parseYmd(lastTrain)) / 86400000;
      return gap >= 2;
    };
    const place = (day) => {
      if (remaining <= 0 || day.kind !== "open" || day.date < today || !canPlace(day.date)) return false;
      day.kind = "train";
      day.sessionType = upcomingType;
      upcomingType = rotation[upcomingType] || "A";
      lastTrain = day.date;
      remaining -= 1;
      return true;
    };

    days.filter((day) => preferred.has(day.weekday)).forEach(place);
    days.forEach(place);

    const trainDays = days.filter((day) => day.kind === "train");
    if (trainDays[0]) trainDays[0].isNext = true;
    if (trainDays[2]) trainDays[2].optional = true;

    let nextDate = trainDays[0]?.date || null;
    let nextSessionType = trainDays[0]?.sessionType || upcomingType;
    let nextWeekHint = null;
    if (!nextDate) {
      let cursor = weekEnd;
      for (let i = 0; i < 8; i++) {
        if (canPlace(cursor)) {
          nextDate = cursor;
          nextSessionType = upcomingType;
          nextWeekHint = {
            date: cursor,
            weekday: "月火水木金土日"[(this.parseYmd(cursor).getDay() + 6) % 7],
            sessionType: upcomingType,
          };
          break;
        }
        cursor = this.addDays(cursor, 1);
      }
    }

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
        day.detail = day.isNext ? "次のトレーニング" : day.optional ? "余裕があれば" : "予定";
        return;
      }
      const weekend = day.weekday === "土" || day.weekday === "日";
      day.kind = weekend ? "run" : "rest";
      day.label = weekend ? "ラン" : "休養";
      day.detail = weekend ? "ランまたは休養" : "休養日";
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

  nextSessionType(last, weeklyPlan) {
    if (!last) return weeklyPlan.suggestedOrder[0] || "A";
    const rotation = { A: "B", B: "C", C: "A" };
    return rotation[last.sessionType] || "A";
  },

  pickPullExercise(lastLog, rules) {
    const log = lastLog("pull-up");
    if (!log) return "lat-pulldown";
    const best = Math.max(...log.sets.map((s) => s.reps));
    if (best >= rules.pullUpThreshold + 2) return "pull-up";
    if (best >= rules.pullUpThreshold - 1) return "pull-up";
    return "lat-pulldown";
  },

  baseExercises(type, ctx) {
    const { lastLog, workouts, rules } = ctx;
    const analysis = workouts.length ? this.analyzeWorkout(workouts[workouts.length - 1]) : null;
    if (type === "A") {
      if (analysis?.struggled.includes("ベンチプレス")) {
        return ["bench-press", "incline-press", "ohp", "pushdown", "face-pull"];
      }
      return ["bench-press", "incline-press", "ohp", "pushdown", "bench-dip"];
    }
    if (type === "B") {
      const back = this.pickPullExercise(lastLog, rules);
      return [back, "seated-row", "barbell-row", "barbell-curl", "face-pull"];
    }
    const chest = this.weakerBetween("bench-press", "incline-press", lastLog);
    const back = this.pickPullExercise(lastLog, rules);
    const base = [chest, back, "side-raise", "oh-tricep", "hammer-curl", "core"];
    if (workouts.length >= 4 && analysis?.struggled.length) return [...base.slice(0, 5), "face-pull"];
    return base;
  },

  microAdjustExercises(type, weeklyExercises, ctx) {
    const { lastLog, analysis, rules } = ctx;
    let list = [...weeklyExercises];
    if (type === "B") {
      const back = this.pickPullExercise(lastLog, rules);
      if (list[0] === "lat-pulldown" || list[0] === "pull-up") list[0] = back;
    }
    if (analysis?.struggled.includes("ベンチプレス") && type === "A" && !list.includes("face-pull")) {
      list = list.filter((id) => id !== "bench-dip");
      list.push("face-pull");
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
    const weight = last.sets[0].weight;
    const hitMax = last.sets.every((s) => s.reps >= exercise.repMax);
    const missMin = last.sets.some((s) => s.reps < exercise.repMin);
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
    const best = Math.max(...last.sets.map((s) => s.reps));
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

  reviewSession(workout, allWorkouts = []) {
    const meta = SESSION_META[workout.sessionType] || { name: workout.sessionType, subtitle: "" };
    const analysis = this.analyzeWorkout(workout);
    const prev = [...allWorkouts]
      .filter((w) => w.completed && w.date < workout.date && w.sessionType === workout.sessionType)
      .sort((a, b) => a.date.localeCompare(b.date))
      .pop();
    const lines = [];
    workout.exercises.forEach((row) => {
      const ex = EXERCISE_MAP[row.id];
      if (!ex) return;
      const sets = row.sets.map((s) => (ex.bodyweight ? `${s.reps}回` : `${s.weight}kg×${s.reps}`)).join(" / ");
      lines.push(`${ex.name}: ${sets}`);
    });
    const goods = analysis.progressed.length
      ? `${analysis.progressed.join("、")}は上限回数まで到達。次回は重量アップの候補です。`
      : "上限到達の種目はまだ少ないので、同じ重量で回数を積みましょう。";
    const improves = analysis.struggled.length
      ? `${analysis.struggled.join("、")}は目標回数に届いていません。フォームを優先し、無理に重量を上げない。`
      : "大きく崩れた種目はありません。";
    let vsPrev = "この種目グループの前回比較データはまだありません。";
    if (prev) {
      const diffs = [];
      workout.exercises.forEach((row) => {
        const ex = EXERCISE_MAP[row.id];
        const before = prev.exercises.find((p) => p.id === row.id);
        if (!ex || !before || ex.bodyweight) return;
        const nowW = row.sets[0]?.weight;
        const oldW = before.sets[0]?.weight;
        if (nowW > oldW) diffs.push(`${ex.name} ${oldW}→${nowW}kg`);
      });
      vsPrev = diffs.length ? `前回同セッションより ${diffs.join("、")}。` : "重量は前回と同水準。回数の伸びを見ていきましょう。";
    }
    const volume = workout.exercises.reduce((sum, row) => {
      const ex = EXERCISE_MAP[row.id];
      if (!ex || ex.bodyweight) return sum;
      return sum + row.sets.reduce((s, set) => s + set.weight * set.reps, 0);
    }, 0);
    const summary = `${workout.date.replaceAll("-", "/")} の${workout.sessionType}（${meta.name}）を完了。総ボリューム約${Math.round(volume)}kg。`;
    const next = `次回は ${ { A: "B 引く", B: "C 総合", C: "A 押す" }[workout.sessionType] || "次セッション" }。今日はタンパク質と睡眠を優先。`;
    return {
      summary,
      goods,
      improves,
      vsPrev,
      next,
      logLines: lines,
      source: "local",
      generatedAt: new Date().toISOString(),
    };
  },
};
