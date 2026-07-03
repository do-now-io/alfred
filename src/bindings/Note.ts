export interface Note {
  id: string;
  title: string;
  body: string;
  recording_id: string | null;
  created_at: string;
  updated_at: string;
}
