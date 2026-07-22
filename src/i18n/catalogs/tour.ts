// Visite guidée post-onboarding (spec/13/21) : téléprompteur de présentation
// + visite de l'app pendant que le pipeline tourne + pop-up « contexte prêt ».
export default {
  fr: {
    skipVisit: "Passer la visite",
    intro: {
      title: "Laissez-moi apprendre à vous connaître",
      text: "Vous allez vous présenter à voix haute pendant que je vous transcris : je m'en servirai pour bien orthographier vos collègues, vos clients et votre jargon. Deux minutes.",
      primary: "Allons-y",
      secondary: "Plus tard",
    },
    processing: {
      title: "Je m'occupe de tout",
      text: "J'écoute ce que vous venez de dire et j'en tire votre contexte : ça prend quelques instants. Je reviendrai vers vous dès que c'est prêt. En attendant, faisons le tour de l'application.",
      primary: "Découvrir l'application",
    },
    statusDot: {
      title: "Ce point, c'est moi",
      text: "Il clignote quand je travaille (j'enregistre, je transcris ou je réfléchis) et reste discret quand je suis disponible. Vous le retrouverez à cet endroit à chaque fois.",
    },
    error: {
      title: "Petit accroc",
      continueBtn: "Continuer",
      recordingFailed: "J'ai rencontré un problème pendant l'enregistrement. Pas de souci, vous pourrez réessayer plus tard.",
      contextFailed: "Je n'ai pas réussi à construire votre contexte, mais votre transcription est bien enregistrée. Vous pourrez remplir la note de contexte à la main.",
      openContextFailed: "Je n'arrive pas à ouvrir votre note de contexte. Vous pourrez la corriger plus tard depuis les Réglages.",
    },
    ready: {
      title: "Je vous connais, mais vérifiez ce que j'ai compris",
      recap: "J'ai rempli votre contexte ({sections} {sectionWord}) et ajouté {terms} noms propres au glossaire de transcription. Un coup d'œil pour corriger ce qu'il faut ?",
      noRecap: "Votre contexte est prêt. Un coup d'œil pour corriger ce qu'il faut ?",
      section: "section",
      sections: "sections",
      primary: "Revoir / corriger",
    },
    recordCta: {
      title: "Pour enregistrer, la prochaine fois",
      text: "Cliquez mon logo en haut à gauche, ou cette carte, à tout moment — je me lance immédiatement.",
    },
    closing: {
      title: "Vous êtes équipé",
      text: "Désormais : parlez, je vous écoute, je résume et je retiens. Et je connais votre univers. Le reste, vous le découvrirez en m'utilisant.",
      primary: "Terminer",
    },
    visit: {
      notes: {
        title: "Vos notes",
        text: "De chaque enregistrement, je produis la transcription et le compte-rendu, rangés ici, regroupés par projet.",
      },
      tasks: {
        title: "Vos tâches",
        text: "Les actions décidées en réunion arrivent toutes seules ici (avec le responsable quand il est nommé). À faire / En cours / Fait : cochez, assignez, archivez.",
      },
      graph: {
        title: "Le graphe",
        text: "Je relie vos notes entre elles par projets et participants, pratique pour retrouver le fil d'un sujet.",
      },
      chat: {
        title: "Questions à Alfred, et comment enregistrer",
        text: "Posez vos questions ici, je réponds en citant vos notes. Et pour enregistrer : cliquez mon logo (en haut à gauche), la carte d'accueil, ou importez un audio.",
      },
      next: "Suivant",
      finishVisit: "Terminer la visite",
    },
    toast: {
      transcribing: "Pendant ce temps, j'écoute et je mets au propre ce que vous venez de dire…{pct}",
      sorting: "Je range tout ça : votre entreprise, votre équipe, vos projets, votre vocabulaire…",
    },
    teleprompter: {
      header: {
        title: "Présentez-vous à Alfred",
        text: "Parlez naturellement, comme si vous décriviez votre travail à un nouveau collègue. Épelez les noms inhabituels. Besoin d'une pause ? Mettez en pause et reprenez quand vous voulez : vous pourrez recommencer ou tout relire et corriger juste après.",
      },
      script: {
        item1: { title: "Qui vous êtes", hint: "Votre prénom, votre rôle, votre entreprise et ce qu'elle fait." },
        item2: { title: "Ce que vous allez enregistrer", hint: "Quels types de réunions ou d'échanges (points d'équipe, appels clients, notes perso…)." },
        item3: { title: "Votre équipe", hint: "Les prénoms de vos collègues proches et leur rôle (« Marie, cheffe de projet ; Tom, dev back… »)." },
        item4: { title: "Vos clients / partenaires", hint: "Les noms d'entreprises et de personnes qui reviennent souvent." },
        item5: { title: "Vos projets en cours", hint: "Leurs noms, surtout les noms de code inhabituels." },
        item6: { title: "Votre vocabulaire", hint: "Les mots, sigles et outils que vous employez souvent. Ex. : « je dis Kube pour Kubernetes, et j'utilise Grafana, GitHub, Terraform… »." },
      },
      recording: "Enregistrement",
      paused: "En pause",
      resume: "Reprendre",
      pause: "Pause",
      finish: "J'ai terminé",
      readyHint: "Prêt ? Lancez et déroulez les points ci-dessus.",
      start: "Commencer l'enregistrement",
    },
  },
  en: {
    skipVisit: "Skip the tour",
    intro: {
      title: "Let me get to know you",
      text: "You'll introduce yourself out loud while I transcribe: I'll use it to spell your colleagues, clients, and jargon correctly. Two minutes.",
      primary: "Let's go",
      secondary: "Later",
    },
    processing: {
      title: "I'm on it",
      text: "I'm listening to what you just said and pulling your context out of it: it'll take a moment. I'll come back to you as soon as it's ready. In the meantime, let's take a tour of the app.",
      primary: "Explore the app",
    },
    statusDot: {
      title: "This dot is me",
      text: "It pulses when I'm working (recording, transcribing, or thinking) and stays quiet when I'm available. You'll find it here every time.",
    },
    error: {
      title: "Small hiccup",
      continueBtn: "Continue",
      recordingFailed: "I ran into a problem during the recording. No worries, you can try again later.",
      contextFailed: "I couldn't build your context, but your transcription was saved just fine. You'll be able to fill in the context note by hand.",
      openContextFailed: "I can't open your context note. You'll be able to fix it later from Settings.",
    },
    ready: {
      title: "I know you now, but check what I understood",
      recap: "I filled in your context ({sections} {sectionWord}) and added {terms} proper noun{termsSuffix} to the transcription glossary. Want to take a look and fix anything?",
      noRecap: "Your context is ready. Want to take a look and fix anything?",
      section: "section",
      sections: "sections",
      primary: "Review / fix",
    },
    recordCta: {
      title: "To record, next time",
      text: "Click my logo up there, or this card, any time — I start right away.",
    },
    closing: {
      title: "You're all set",
      text: "From now on: talk, I'll listen, summarize, and remember. And I know your world. You'll discover the rest as you use me.",
      primary: "Finish",
    },
    visit: {
      notes: {
        title: "Your notes",
        text: "From every recording, I produce the transcription and the summary, stored here, grouped by project.",
      },
      tasks: {
        title: "Your tasks",
        text: "Actions decided in a meeting land here on their own (with an owner when one is named). To do / In progress / Done: check off, assign, archive.",
      },
      graph: {
        title: "The graph",
        text: "I link your notes together by project and participant, handy for picking back up the thread of a topic.",
      },
      chat: {
        title: "Ask Alfred, and how to record",
        text: "Ask your questions here, I'll answer by citing your notes. And to record: click my logo (top left), the home card, or import an audio file.",
      },
      next: "Next",
      finishVisit: "Finish the tour",
    },
    toast: {
      transcribing: "Meanwhile, I'm listening and cleaning up what you just said…{pct}",
      sorting: "I'm sorting it all out: your company, your team, your projects, your vocabulary…",
    },
    teleprompter: {
      header: {
        title: "Introduce yourself to Alfred",
        text: "Speak naturally, as if describing your work to a new colleague. Spell out unusual names. Need a break? Pause and resume whenever you like: you'll be able to start over or review and fix everything right after.",
      },
      script: {
        item1: { title: "Who you are", hint: "Your first name, your role, your company, and what it does." },
        item2: { title: "What you'll be recording", hint: "What kinds of meetings or conversations (team check-ins, client calls, personal notes…)." },
        item3: { title: "Your team", hint: "The first names of your close colleagues and their roles (\"Marie, project lead; Tom, backend dev…\")." },
        item4: { title: "Your clients / partners", hint: "The company and person names that come up often." },
        item5: { title: "Your ongoing projects", hint: "Their names, especially unusual code names." },
        item6: { title: "Your vocabulary", hint: "The words, acronyms, and tools you use often. E.g.: \"I say K8s for Kubernetes, and I use Grafana, GitHub, Terraform…\"." },
      },
      recording: "Recording",
      paused: "Paused",
      resume: "Resume",
      pause: "Pause",
      finish: "I'm done",
      readyHint: "Ready? Start and go through the points above.",
      start: "Start recording",
    },
  },
};
