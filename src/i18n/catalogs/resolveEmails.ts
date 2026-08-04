// Écran de validation des mails (spec/24 §5) — distinct de `/resolve` (spec/17
// §3) : granularité item par item, pas de recording_id.
export default {
  fr: {
    header: {
      title: "Propositions issues de vos mails",
      subtitlePending: "{count} proposition en attente. Décochez ce que vous ne voulez pas, puis validez.",
      subtitlePendingPlural: "{count} propositions en attente. Décochez ce que vous ne voulez pas, puis validez.",
    },
    empty: {
      text: "Rien à valider pour le moment.",
      back: "Retour",
    },
    actions: {
      validate: "Valider",
      validating: "Enregistrement…",
    },
    item: {
      task: "Tâche",
      context: "Fait de contexte",
      taskProject: "+{project}",
      contextScopeProject: "Projet(s) : {projects}",
      contextScopeGlobal: "Global",
    },
    error: {
      generic: "Une erreur est survenue.",
    },
  },
  en: {
    header: {
      title: "Proposals from your emails",
      subtitlePending: "{count} pending proposal. Uncheck what you don't want, then validate.",
      subtitlePendingPlural: "{count} pending proposals. Uncheck what you don't want, then validate.",
    },
    empty: {
      text: "Nothing to review for now.",
      back: "Back",
    },
    actions: {
      validate: "Validate",
      validating: "Saving…",
    },
    item: {
      task: "Task",
      context: "Context fact",
      taskProject: "+{project}",
      contextScopeProject: "Project(s): {projects}",
      contextScopeGlobal: "Global",
    },
    error: {
      generic: "Something went wrong.",
    },
  },
};
