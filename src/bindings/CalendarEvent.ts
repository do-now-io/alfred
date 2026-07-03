export interface CalendarEvent {
  id: string;
  source: "google" | "apple";
  external_id: string;
  title: string;
  start_at: string;
  end_at: string;
  location: string | null;
  description: string | null;
  attendees: string | null;
  all_day: boolean;
  last_synced_at: string;
}
