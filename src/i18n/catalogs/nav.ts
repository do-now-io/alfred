// Sidebar (logo, nav, Récents), bandeau /resolve, libellés majordome (spec/21).
export default {
  fr: {
    logo: {
      stopRecording: "Arrêter l'enregistrement",
      startRecording: "Démarrer un enregistrement",
      seeProgress: "Voir la progression",
      seeWhatImProcessing: "Voir ce que je suis en train de traiter",
    },
    sidebar: {
      alfred: "Alfred",
      tasks: "Tâches",
      notes: "Notes",
      calendar: "Agenda",
      graph: "Graphe",
      settings: "Paramètres",
    },
    butler: {
      idle: "À votre service",
      recording: "Tout ouïe…",
      transcribing: "Je prends note…",
      verifying: "Je vérifie…",
      thinking: "Je cogite…",
      tasking: "Je note les tâches…",
      reviewing: "Un point à vérifier",
    },
    recents: {
      title: "Récents",
      workingOnThisNote: "Alfred travaille sur cette note",
      needsReview: "À vérifier — cliquer pour ouvrir",
      renamePrompt: "Renommer la note",
      deleteConfirm: 'Supprimer "{name}" ?',
    },
    resolveBanner: {
      pointsToCheck: "J'ai {count} point à vérifier",
      pointsToCheckPlural: "J'ai {count} points à vérifier",
      ready: "Votre compte-rendu est prêt à valider",
      checkNow: "Vérifier maintenant",
      dismissTitle: "Masquer — reste accessible depuis la note (icône « à vérifier »)",
    },
    ingestError: {
      title: "Le compte-rendu n'a pas pu être rédigé",
      fallback: "Erreur inconnue pendant la rédaction du compte-rendu",
    },
  },
  en: {
    logo: {
      stopRecording: "Stop recording",
      startRecording: "Start a recording",
      seeProgress: "See progress",
      seeWhatImProcessing: "See what I'm currently working on",
    },
    sidebar: {
      alfred: "Alfred",
      tasks: "Tasks",
      notes: "Notes",
      calendar: "Calendar",
      graph: "Graph",
      settings: "Settings",
    },
    butler: {
      idle: "At your service",
      recording: "All ears…",
      transcribing: "Taking notes…",
      verifying: "Checking…",
      thinking: "Thinking it over…",
      tasking: "Noting the tasks…",
      reviewing: "Something to review",
    },
    recents: {
      title: "Recent",
      workingOnThisNote: "Alfred is working on this note",
      needsReview: "Needs review — click to open",
      renamePrompt: "Rename note",
      deleteConfirm: 'Delete "{name}"?',
    },
    resolveBanner: {
      pointsToCheck: "I have {count} point to check",
      pointsToCheckPlural: "I have {count} points to check",
      ready: "Your summary is ready to validate",
      checkNow: "Check now",
      dismissTitle: "Hide — still reachable from the note (« needs review » icon)",
    },
    ingestError: {
      title: "The summary could not be written",
      fallback: "Unknown error while writing the summary",
    },
  },
};
