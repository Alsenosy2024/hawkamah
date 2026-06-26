// ===========================================================================
//  mermaidTheme — one Ailigent (refined teal) theme for EVERY Mermaid v11
//  diagram type, shared by the live chat renderer (MermaidView, htmlLabels on)
//  and the PNG/canvas/PDF path (diagramService, htmlLabels off). Pure data (no
//  mermaid import) so both surfaces stay consistent — flowchart, sequence,
//  class, state, ER, gantt, pie, journey, git, mindmap, timeline, quadrant.
// ===========================================================================

// Brand tokens
const BRAND = '#11a8bc';      // teal
const BRAND_DEEP = '#0b8090';
const BRAND_BLUE = '#1e6fa8';
const BRAND_50 = '#eef8fa';
const BRAND_100 = '#def2f6';
const INK = '#122a33';
const LINE = '#0b8090';
const SURFACE = '#f7fafb';
const HAIR = '#bde4ec';

// Brand-led categorical palette (pie slices, git branches, journey fills, etc.).
const PALETTE = ['#11a8bc', '#1e6fa8', '#0b8090', '#16a34a', '#f59e0b', '#7c3aed', '#db2777', '#0891b2', '#65a30d', '#e11d48', '#2563eb', '#0d9488'];

// Font stack — brand Arabic font first; mermaid applies this across all types.
export const MERMAID_FONT = "'Thmanyah Sans','Tajawal','Almarai',system-ui,sans-serif";

export const MERMAID_THEME_VARIABLES: Record<string, string> = {
  // ── global / flowchart ──
  primaryColor: BRAND_50,
  primaryBorderColor: BRAND,
  primaryTextColor: INK,
  secondaryColor: BRAND_100,
  secondaryBorderColor: HAIR,
  secondaryTextColor: INK,
  tertiaryColor: SURFACE,
  tertiaryBorderColor: HAIR,
  tertiaryTextColor: INK,
  lineColor: LINE,
  textColor: INK,
  mainBkg: BRAND_50,
  nodeBorder: BRAND,
  nodeTextColor: INK,
  clusterBkg: SURFACE,
  clusterBorder: HAIR,
  titleColor: '#0a6775',
  edgeLabelBackground: '#ffffff',
  fontFamily: MERMAID_FONT,
  fontSize: '14px',
  // ── sequence ──
  actorBkg: BRAND_50,
  actorBorder: BRAND,
  actorTextColor: INK,
  actorLineColor: '#9ec9d2',
  signalColor: BRAND_DEEP,
  signalTextColor: INK,
  labelBoxBkgColor: BRAND_100,
  labelBoxBorderColor: BRAND,
  labelTextColor: INK,
  loopTextColor: INK,
  noteBkgColor: '#e9f6f8',
  noteBorderColor: BRAND,
  noteTextColor: INK,
  activationBkgColor: BRAND_100,
  activationBorderColor: BRAND,
  sequenceNumberColor: '#ffffff',
  // ── state / class ──
  labelColor: INK,
  // ── ER ──
  attributeBackgroundColorOdd: SURFACE,
  attributeBackgroundColorEven: BRAND_50,
  // ── gantt ──
  taskBkgColor: BRAND_100,
  taskBorderColor: BRAND,
  taskTextColor: INK,
  taskTextDarkColor: INK,
  taskTextLightColor: '#ffffff',
  taskTextOutsideColor: INK,
  activeTaskBkgColor: BRAND,
  activeTaskBorderColor: BRAND_DEEP,
  doneTaskBkgColor: HAIR,
  doneTaskBorderColor: BRAND_DEEP,
  critBkgColor: '#fde2e2',
  critBorderColor: '#dc2626',
  gridColor: '#e3edf0',
  sectionBkgColor: SURFACE,
  sectionBkgColor2: BRAND_50,
  altSectionBkgColor: '#ffffff',
  todayLineColor: '#dc2626',
  // ── pie ──
  pieTitleTextColor: INK,
  pieSectionTextColor: INK,
  pieStrokeColor: '#ffffff',
  pieOuterStrokeColor: HAIR,
  pieOpacity: '0.92',
  // ── categorical palettes (pie1.., git0.., cScale0..) ──
  ...Object.fromEntries(PALETTE.map((c, i) => [`pie${i + 1}`, c])),
  ...Object.fromEntries(PALETTE.map((c, i) => [`git${i}`, c])),
  ...Object.fromEntries(PALETTE.map((c, i) => [`cScale${i}`, c])),
  ...Object.fromEntries(PALETTE.map((_, i) => [`cScaleLabel${i}`, '#ffffff'])),
  ...Object.fromEntries(PALETTE.map((c, i) => [`fillType${i}`, c])),
  gitBranchLabel0: '#ffffff',
  gitInv0: '#ffffff',
};

// themeCSS backstop: some diagram types (C4, sequence, gantt) hardcode their own
// font and ignore fontFamily — force the brand Arabic font on ALL diagram text,
// and give edge labels a solid background so lines don't strike through them.
export const MERMAID_THEME_CSS =
  `text,.nodeLabel,.edgeLabel,.label,.actor,.messageText,.loopText,.noteText,`
  + `.titleText,.sectionTitle,.taskText,.taskTextOutsideRight,.taskTextOutsideLeft,`
  + `tspan,foreignObject div,foreignObject span{font-family:${MERMAID_FONT} !important;}`
  + `.edgeLabel{background-color:#ffffff;}`;

