import alfredLogoMinimal from "../assets/alfred-logo-minimal.png";
import alfredLogoFull from "../assets/alfred-logo.png";

// Portrait d'Alfred (spec/03/10, feedback tests) — deux assets fournis, fond
// transparent, utilisés tels quels (pas de recadrage) : `minimal` (portrait
// seul, sans le mot-symbole "ALFRED") pour les petites icônes, `full` (avec
// "ALFRED") pour les grands formats.
export default function AlfredAvatar({
  size, radius = 0, variant = "minimal",
}: { size: number; radius?: number; variant?: "minimal" | "full" }) {
  return (
    <img
      src={variant === "full" ? alfredLogoFull : alfredLogoMinimal}
      alt="Alfred"
      style={{ width: size, height: size, borderRadius: radius, display: "block", flexShrink: 0, objectFit: "contain" }}
    />
  );
}
