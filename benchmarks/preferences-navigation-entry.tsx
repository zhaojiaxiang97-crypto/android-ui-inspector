import { verifyPreferencesNavigation } from "./preferences-navigation-checks";
import { verifyInspectionModeSettings } from "./inspection-mode-checks";
import "../src/styles/tokens.css";
import "../src/App.css";
import "../src/styles/workbench.css";
import "../src/styles/entry.css";
import "../src/styles/appearance.css";
Object.assign(window, { verifyPreferencesNavigation, verifyInspectionModeSettings });
