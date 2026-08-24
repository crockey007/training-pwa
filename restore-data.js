const MAC_BACKUP = {
  profileStartDate: "2026-08-17",
  scheduleOverrides: {
    "2026-08-19": "rest",
    "2026-08-21": "rest",
  },
  workouts: [
    {
      date: "2026-08-17",
      sessionType: "A",
      completed: true,
      exercises: [
        { id: "bench-press", sets: [{ weight: 30, reps: 10 }, { weight: 30, reps: 10 }, { weight: 30, reps: 10 }] },
        { id: "incline-press", sets: [{ weight: 20, reps: 8 }, { weight: 20, reps: 8 }, { weight: 20, reps: 8 }] },
        { id: "ohp", sets: [{ weight: 10, reps: 8 }, { weight: 10, reps: 8 }, { weight: 10, reps: 8 }] },
        { id: "pushdown", sets: [{ weight: 10, reps: 10 }, { weight: 10, reps: 10 }, { weight: 10, reps: 10 }] },
        { id: "bench-dip", sets: [{ weight: 0, reps: 10 }, { weight: 0, reps: 10 }] },
      ],
    },
    {
      date: "2026-08-20",
      sessionType: "B",
      completed: true,
      exercises: [
        { id: "lat-pulldown", sets: [{ weight: 20, reps: 8 }, { weight: 20, reps: 8 }, { weight: 20, reps: 8 }] },
        { id: "seated-row", sets: [{ weight: 20, reps: 8 }, { weight: 20, reps: 8 }, { weight: 20, reps: 8 }] },
        { id: "barbell-row", sets: [{ weight: 30, reps: 8 }, { weight: 30, reps: 8 }, { weight: 30, reps: 8 }] },
        { id: "barbell-curl", sets: [{ weight: 15, reps: 10 }, { weight: 15, reps: 10 }, { weight: 15, reps: 10 }] },
        { id: "face-pull", sets: [{ weight: 10, reps: 12 }, { weight: 10, reps: 12 }] },
      ],
    },
    {
      date: "2026-08-23",
      sessionType: "C",
      completed: true,
      exercises: [
        { id: "incline-press", sets: [{ weight: 20, reps: 10 }, { weight: 25, reps: 10 }, { weight: 25, reps: 10 }] },
        { id: "lat-pulldown", sets: [{ weight: 20, reps: 10 }, { weight: 25, reps: 10 }, { weight: 25, reps: 10 }] },
        { id: "side-raise", sets: [{ weight: 2.5, reps: 13 }, { weight: 2.5, reps: 12 }, { weight: 2.5, reps: 12 }] },
        { id: "oh-tricep", sets: [{ weight: 10, reps: 10 }, { weight: 10, reps: 6 }] },
        { id: "hammer-curl", sets: [{ weight: 5, reps: 10 }, { weight: 5, reps: 10 }] },
      ],
    },
  ],
  runs: [
    { date: "2026-08-18", done: true, km: 5.04, kcal: 0, note: "ペース 6:47/km" },
    { date: "2026-08-20", done: true, km: 4.2, kcal: 0, note: "ペース 7:04/km" },
    { date: "2026-08-22", done: true, km: 8.9, kcal: 0, note: "ペース 6:47/km" },
  ],
  meals: [{ date: "2026-08-17", protein: 60, quality: "", note: "" }],
  sleeps: [{ date: "2026-08-17", hours: 7, quality: "good", note: "" }],
  weights: [{ date: "2026-08-17", kg: 68.9, bodyFat: 18.9 }],
};
