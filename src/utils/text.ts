/** Comparaison insensible à la casse et aux accents (« reunion » matche
 *  « Réunion »). Le range couvre le bloc Unicode "Combining Diacritical
 *  Marks" (U+0300–U+036F) — les marques d'accent isolées par
 *  `normalize("NFD")`. */
export const normalizeSearch = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
