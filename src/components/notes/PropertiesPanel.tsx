import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MdCalendarToday, MdLabel, MdCategory, MdToggleOn, MdFolderSpecial, MdGroups } from "react-icons/md";
import type { NoteMetadata } from "../../bindings/NoteMetadata";
import { useProfileStore } from "../../store/profileStore";
import ChipsInput from "./ChipsInput";
import { useT } from "../../i18n";

interface Props {
  metadata: NoteMetadata;
  onChange: (updated: NoteMetadata) => void;
}

export default function PropertiesPanel({ metadata, onChange }: Props) {
  const t = useT();
  // Valeurs existantes du vault, pour l'autocomplétion (spec/07 — list_tags /
  // list_projects). Chargées à l'affichage du panneau ; un échec laisse juste
  // les suggestions vides.
  const [allTags, setAllTags] = useState<string[]>([]);
  const [allProjects, setAllProjects] = useState<string[]>([]);
  const profileName = useProfileStore((s) => s.name);
  const loadProfile = useProfileStore((s) => s.load);

  useEffect(() => {
    invoke<string[]>("list_tags").then(setAllTags).catch(() => {});
    invoke<string[]>("list_projects").then(setAllProjects).catch(() => {});
    loadProfile();
  }, [loadProfile]);

  const update = (patch: Partial<NoteMetadata>) =>
    onChange({ ...metadata, ...patch });

  return (
    <div style={{
      padding: "16px 24px",
      borderBottom: "1px solid var(--border)",
      background: "var(--card-bg)",
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 12 }}>
        {t("notes.properties.header")}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {/* Date */}
        <Row icon={<MdCalendarToday />} label={t("notes.properties.dateLabel")}>
          <input
            type="date"
            value={metadata.date}
            onChange={e => update({ date: e.target.value })}
            style={inputStyle}
          />
        </Row>

        {/* Tags — existants + autocomplétion (spec/07) */}
        <Row icon={<MdLabel />} label={t("notes.properties.tagsLabel")}>
          <ChipsInput
            colored
            values={metadata.tags}
            onChange={(tags) => update({ tags })}
            suggestions={allTags}
            placeholder={t("notes.properties.tagPlaceholder")}
            meLabel={t("notes.properties.me")}
          />
        </Row>

        {/* Projets — MULTI-sélection, combobox sur les projets du vault (spec/07) */}
        <Row icon={<MdFolderSpecial />} label={t("notes.properties.projectsLabel")}>
          <ChipsInput
            values={metadata.project}
            onChange={(project) => update({ project })}
            suggestions={allProjects}
            placeholder={t("notes.properties.projectPlaceholder")}
            meLabel={t("notes.properties.me")}
          />
        </Row>

        {/* Participants (spec/07) */}
        <Row icon={<MdGroups />} label={t("notes.properties.participantsLabel")}>
          <ChipsInput
            values={metadata.participants}
            onChange={(participants) => update({ participants })}
            suggestions={[]}
            placeholder={t("notes.properties.participantPlaceholder")}
            selfName={profileName}
            meLabel={t("notes.properties.me")}
          />
        </Row>

        {/* Type */}
        <Row icon={<MdCategory />} label={t("notes.properties.typeLabel")}>
          <select
            className="alfred-select"
            value={metadata.type}
            onChange={e => update({ type: e.target.value })}
          >
            <option value="note">note</option>
            <option value="meeting">meeting</option>
            <option value="task">task</option>
          </select>
        </Row>

        {/* Status */}
        <Row icon={<MdToggleOn />} label={t("notes.properties.statusLabel")}>
          <select
            className="alfred-select"
            value={metadata.status}
            onChange={e => update({ status: e.target.value })}
          >
            <option value="active">active</option>
            <option value="archived">archived</option>
          </select>
        </Row>
      </div>
    </div>
  );
}

function Row({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
      <span style={{ fontSize: 14, width: 16, flexShrink: 0, color: "var(--text-muted)", marginTop: 2, display: "flex", alignItems: "center" }}>{icon}</span>
      <span style={{ fontSize: 13, color: "var(--text-secondary)", width: 64, flexShrink: 0, marginTop: 2 }}>{label}</span>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "transparent", border: "none", outline: "none",
  fontSize: 13, color: "var(--text-primary)", padding: 0,
  fontFamily: "inherit",
};
