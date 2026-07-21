export type Lang = "fr" | "en";

/** Un catalogue de traduction : arbre de chaînes, nesté par namespace
 *  (`t("onboarding.welcome.title")`). Chaque module de `src/i18n/catalogs/`
 *  exporte un sous-arbre pour son domaine ; `src/i18n/index.ts` les fusionne. */
export type Catalog = { [key: string]: string | Catalog };
