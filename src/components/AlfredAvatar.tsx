import alfredLogo from "../assets/alfred-logo.png";

// Recadrage CSS du portrait (spec/03/10, feedback tests) : l'asset source est
// carré (2000×2000) mais son contenu ne l'est pas — le portrait occupe le haut
// du cadre, le mot « ALFRED » le bas — d'où le décalage vertical perçu en
// affichage width:100%/height:auto. On zoome/recentre sur le cercle du
// portrait (masque le mot-symbole, déjà illisible aux tailles d'icône).
export default function AlfredAvatar({ size, radius = 0 }: { size: number; radius?: number }) {
  return (
    <div style={{ width: size, height: size, borderRadius: radius, overflow: "hidden", position: "relative", flexShrink: 0 }}>
      <img
        src={alfredLogo}
        alt="Alfred"
        style={{ position: "absolute", width: "160%", height: "160%", left: "-30%", top: "-26.4%" }}
      />
    </div>
  );
}
