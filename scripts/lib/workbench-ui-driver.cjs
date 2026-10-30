const assert = require("node:assert/strict");

const viewports = [[1440, 900], [960, 700], [650, 760]];
async function key(web, keyCode) {
  web.sendInputEvent({ type: "keyDown", keyCode }); web.sendInputEvent({ type: "keyUp", keyCode });
  await web.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
}

async function verifyDisclosureKeyboard(web, selector, expected) {
  await web.executeJavaScript(`document.querySelector(${JSON.stringify(selector + " > summary")}).focus()`);
  for (const open of expected) {
    await key(web, "Space");
    assert.equal(await web.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).open`), open,
      `Native Space did not toggle ${selector}`);
  }
}

async function verifyDialogKeyboard(web, selector, trigger) {
  const dialog = JSON.stringify(selector), button = JSON.stringify(trigger);
  await web.executeJavaScript(`(async () => { for (let i = 0; i < 120; i++) {
    if (document.querySelector(${dialog})?.open) return;
    await new Promise(requestAnimationFrame);
  } throw new Error('Dialog did not open'); })()`);
  for (let i = 0; i < 5; i++) {
    await key(web, "Tab");
    assert(await web.executeJavaScript(`document.querySelector(${dialog}).contains(document.activeElement)`),
      `Native Tab escaped ${selector}`);
  }
  await key(web, "Escape");
  assert(await web.executeJavaScript(`!document.querySelector(${dialog}) && document.activeElement === document.querySelector(${button})`),
    `Native Escape did not close ${selector} or return focus`);
}

module.exports = { viewports, verifyDisclosureKeyboard, verifyDialogKeyboard };
