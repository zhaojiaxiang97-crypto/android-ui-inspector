import { verifyTreeRound3 as verifyTreeRound3Base } from "./tree-round3-checks";
import { verifyNodeRefreshMenuChecks } from "./node-refresh-menu-checks";
import "../src/styles/tokens.css";
import "../src/App.css";
import "../src/styles/workbench.css";
import "../src/styles/appearance.css";
async function verifyTreeRound3() {
  const refreshMenu = await verifyNodeRefreshMenuChecks(true);
  try {
    const original = await verifyTreeRound3Base();
    const { cleanup: _cleanup, ...nodeRefreshMenu } = refreshMenu;
    return { ...original, checks: [...original.checks, ...nodeRefreshMenu.checks], nodeRefreshMenu };
  } finally { refreshMenu.cleanup(); }
}
Object.assign(window, { verifyTreeRound3 });
