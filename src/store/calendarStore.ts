import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { CalendarEvent } from "../bindings/CalendarEvent";

interface CalendarStore {
  todayEvents: CalendarEvent[];
  weekEvents: CalendarEvent[];
  fetchTodayEvents: () => Promise<void>;
  fetchWeekEvents: () => Promise<void>;
  triggerSync: () => Promise<void>;
}

export const useCalendarStore = create<CalendarStore>((set) => ({
  todayEvents: [],
  weekEvents: [],

  fetchTodayEvents: async () => {
    try {
      const events = await invoke<CalendarEvent[]>("get_today_events");
      set({ todayEvents: events });
    } catch (e) {
      console.error("Failed to fetch today events:", e);
    }
  },

  fetchWeekEvents: async () => {
    try {
      const events = await invoke<CalendarEvent[]>("get_week_events");
      set({ weekEvents: events });
    } catch (e) {
      console.error("Failed to fetch week events:", e);
    }
  },

  triggerSync: async () => {
    try {
      await invoke("trigger_calendar_sync");
    } catch (e) {
      console.error("Calendar sync failed:", e);
    }
  },
}));
