const assert = require("node:assert/strict");

// Completion markers describe required coverage, not a fixed total. Extra checks
// remain valid as the coordinate harness grows.
const requiredModules = {
  coordinates: [
    "ScreenshotPreview zoom ", "pinch:", "fine wheel:", "scroll-offset mapping",
    "all stable rotations", "rotation and decoded-size mismatch", "legacy snapshot fallback",
    "decode failure and stale image events", "portrait/landscape/cached-portrait",
  ],
  demandAndHover: ["Layer demand:", "real WebGL hit", "no hover texture uploads/selection;"],
  pixels: [
    "pixel: root parent reload", "pixel: nested parent reload", "pixel: isolated bitmaps,",
    "pixel: hidden planes stay absent", "pixel: ancestor clipping", "pixel: padding clips",
    "pixel: rounded outline,", "pixel: Z order,", "pixel: QML RGBA,",
    "pixel: WebGL native/composite reload", "pixel: QML WebGL own styles",
    "pixel: transparent outline picking", "pixel: hide/restore own planes",
    "pixel: focused leaf/root/parent", "pixel: branch parent/descendants",
    "pixel: off-center outline vs opaque face", "pixel: native/trimmed/composite/legacy",
    "pixel: ordinary outlines disabled", "pixel: three selection strengths",
    "pixel: missing and undecodable images", "pixel: progress-bar content/layout separation",
  ],
  appearanceAndGestures: [
    "ScreenshotPreview: appearance preferences persist/recover", "pointer:", "menu:", "double-click:",
  ],
  motion: [
    "motion: 220ms child-to-parent fold", "motion: live reduced-motion changes",
    "motion: failed folded reconstruction", "motion: camera reset", "motion: short 2D/3D reveal",
  ],
  measurements: ["measurement:", "pinned measurement:", "ScreenshotPreview: selected/hovered live measurement", "measurement panel: original pixel distances"],
  imagesAndFraming: ["PNG pixels:", "image actions:", "image preview:", "3D framing:"],
  quickSelect: [
    "actual WebGL: painted yaw/pitch/roll/pan source coordinates",
    "candidate SVG preview leaves tree,",
    "actual ScreenshotPreview: explicit tool",
    "candidate keyboard/hover,",
  ],
  actualApp: [
    "actual App: inherited Android icon keeps",
    "actual App: contextual hint stays in flow",
    "actual App: cached image preview works without output IPC",
    "actual App: image dialog Escape/cancel preserves",
    "actual App: expansion presets retain deep selection",
    "actual App: focused expansion is relative",
    "actual App: tree and searchable inspector distinguish",
    "actual App: measurement replaces and restores inspector",
    "actual App: distinct layout targets",
    "actual App: full business path search",
    "actual App: typed full-tree copy",
    "new snapshot format retains structured types",
    /^actual App: .*\b(?:folded[ -]plane|collapsed plane) candidates\b/,
    "node switch clears both additions;",
  ],
};
const resolutions = [
  "720x1280", "1080x2400", "1440x3200", "1280x720", "2400x1080",
  "3200x1440", "2560x1600", "1600x2560", "1000x1000",
];
const panelWidths = [240, 680];

function inspectCoordinateMatrix(checks) {
  assert.ok(Array.isArray(checks) && checks.every((check) => typeof check === "string" && check.trim()),
    "DPI proxy coordinate checks must be an array of nonempty completion markers");
  const duplicates = checks.filter((check, index) => checks.indexOf(check) !== index);
  const missing = [];
  const completedPairs = [];
  for (const resolution of resolutions) {
    for (const panelWidth of panelWidths) {
      const marker = `${resolution}: panel ${panelWidth}, fit/click/edge/clipping/thin-overlay`;
      if (checks.includes(marker)) completedPairs.push(`${resolution}/panel-${panelWidth}`);
      else missing.push(marker);
    }
  }
  const modules = {};
  for (const [name, markers] of Object.entries(requiredModules)) {
    let completedGroups = 0;
    for (const marker of markers) {
      const matches = checks.filter((check) => typeof marker === "string" ? check.startsWith(marker) : marker.test(check));
      if (matches.length) completedGroups++;
      else missing.push(`${name}: ${String(marker)}`);
    }
    modules[name] = { completedGroups, requiredGroups: markers.length };
  }
  const pixelGroups = checks.filter((check) => check.startsWith("pixel:")).length;
  return {
    totalGroups: checks.length,
    interactionGroups: checks.length - pixelGroups,
    pixelGroups,
    resolutionPanelPairs: completedPairs,
    modules,
    duplicates,
    missing,
  };
}

function assertCompleteCoordinateMatrix(coverage) {
  assert.deepEqual(coverage.duplicates, [], "DPI proxy returned duplicate completion markers");
  assert.deepEqual(coverage.missing, [], "DPI proxy did not complete the required coordinate and interaction matrix");
}

module.exports = { inspectCoordinateMatrix, assertCompleteCoordinateMatrix };
