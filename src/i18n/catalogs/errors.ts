// Codes d'erreur backend traduits côté front (spec/21 §Portée) — le backend
// Rust renvoie un CODE stable (ex. "model_not_found") plutôt qu'un message
// FR/EN en dur ; le front le traduit via `t("errors.codes.<code>")`, avec un
// repli sur le message brut si le code est inconnu (voir `translateError` ci-
// dessous, utilisé par les écrans qui affichent des erreurs backend).
export default {
  fr: {
    codes: {
      model_not_found: "Modèle Whisper introuvable. Téléchargez-le dans les Réglages.",
      wav_not_found: "Fichier audio introuvable pour cet enregistrement.",
      mic_permission_denied: "Accès au microphone refusé. Autorisez-moi dans les réglages système.",
      vault_not_configured: "Aucun dossier Notes configuré. Choisissez-en un dans les Réglages.",
      subscription_inactive: "Abonnement AlfredIA inactif.",
      network_error: "Erreur réseau. Vérifiez votre connexion.",
      unknown: "Erreur inconnue",
    },
  },
  en: {
    codes: {
      model_not_found: "Whisper model not found. Download it from Settings.",
      wav_not_found: "Audio file not found for this recording.",
      mic_permission_denied: "Microphone access denied. Allow me in your system settings.",
      vault_not_configured: "No Notes folder configured. Choose one in Settings.",
      subscription_inactive: "AlfredIA subscription inactive.",
      network_error: "Network error. Check your connection.",
      unknown: "Unknown error",
    },
  },
};
