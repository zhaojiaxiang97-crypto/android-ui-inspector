import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { isBuiltin } from "node:module";
import { test } from "node:test";
import ts from "typescript";

const project = resolve(import.meta.dirname, "..");
const pathName = (file: string) => relative(project, file).split("\\").join("/");
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = resolve(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : /\.(ts|tsx|js|cjs|mjs)$/.test(file) ? [file] : [];
  });
}
function localModule(from: string, specifier: string) {
  const base = resolve(dirname(from), specifier);
  return [base, ...[".ts", ".tsx", ".js", ".cjs", ".mjs"].flatMap(ext => [base + ext, resolve(base, "index" + ext)])]
    .find(file => existsSync(file) && statSync(file).isFile());
}
const productFiles = ["electron", "src", "shared"].flatMap(dir => sourceFiles(resolve(project, dir)));
function references(file: string, text = readFileSync(file, "utf8")) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const result: Array<{ specifier: string; runtime: boolean }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings;
      const runtime = !node.importClause?.isTypeOnly && (Boolean(node.importClause?.name) || !bindings || !ts.isNamedImports(bindings) || !bindings.elements.length || bindings.elements.some(e => !e.isTypeOnly));
      result.push({ specifier: node.moduleSpecifier.text, runtime });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const bindings = node.exportClause;
      const runtime = !node.isTypeOnly && (!bindings || !ts.isNamedExports(bindings) || !bindings.elements.length || bindings.elements.some(e => !e.isTypeOnly));
      result.push({ specifier: node.moduleSpecifier.text, runtime });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) {
      result.push({ specifier: node.moduleReference.expression.text, runtime: !node.isTypeOnly });
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      result.push({ specifier: node.argument.literal.text, runtime: false });
    } else if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      const callee = node.expression;
      const directRequire = ts.isIdentifier(callee) && callee.text === "require";
      const inlineRequire = ts.isCallExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "createRequire";
      if (callee.kind === ts.SyntaxKind.ImportKeyword || directRequire || inlineRequire)
        result.push({ specifier: node.arguments[0].text, runtime: true });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}
const productReferences = new Map(productFiles.map(file => [file, references(file)]));
const runtimeEdges = new Map(productFiles.map(file => [file, productReferences.get(file)!
  .filter(ref => ref.runtime && ref.specifier.startsWith("."))
  .map(ref => localModule(file, ref.specifier)).filter((file): file is string => Boolean(file))]));

test("Provider pool construction belongs to the desktop entry, while capture consumes its type-only port", () => {
  const providerModule = resolve(project, "electron/sdk/provider-session.ts");
  const owners = productFiles.filter(file => runtimeEdges.get(file)?.includes(providerModule)).map(pathName);
  assert.deepEqual(owners, ["electron/main.ts"]);
  // CLI/MCP send live requests to the desktop bridge; they must not grow an unused pool.
  for (const entry of ["electron/automation/cli.ts", "electron/automation/mcp.ts"])
    assert.ok(!runtimeEdges.get(resolve(project, entry))?.includes(providerModule));
  const source = ts.createSourceFile(providerModule, readFileSync(providerModule, "utf8"), ts.ScriptTarget.Latest, true);
  const inspectInitializer = (node: ts.Node) => {
    if (ts.isFunctionLike(node)) return;
    assert.ok(!ts.isCallExpression(node) && !ts.isNewExpression(node), "Provider import must not start resources");
    ts.forEachChild(node, inspectInitializer);
  };
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations)
      if (declaration.initializer) inspectInitializer(declaration.initializer);
    assert.ok(!ts.isExpressionStatement(statement), "Provider import must only declare its API");
  }
});

test("dependency scanner distinguishes runtime and type-only imports across supported syntax", () => {
  const imports = references("fixture.ts", `
    import "./side-effect";
    import {} from "./empty";
    import Default, { type Shape } from "./default";
    import { type Shape } from "./types";
    import type * as Types from "./namespace-types";
    export { type Shape } from "./export-types";
    export { type Shape, value } from "./mixed-export";
    import Legacy = require("./legacy");
    import type LegacyType = require("./legacy-type");
    type Result = import("./import-type").Result;
    import("./dynamic");
    require("fs/promises");
    createRequire(import.meta.url)("./helper.cjs");
    // require("./comment");
    const description = 'import("./text")';
    unrelated("./not-a-module");
  `);
  assert.deepEqual(imports, [
    ["./side-effect", true], ["./empty", true], ["./default", true], ["./types", false],
    ["./namespace-types", false], ["./export-types", false], ["./mixed-export", true],
    ["./legacy", true], ["./legacy-type", false], ["./import-type", false],
    ["./dynamic", true], ["fs/promises", true], ["./helper.cjs", true],
  ].map(([specifier, runtime]) => ({ specifier, runtime })));
  for (const module of ["fs", "fs/promises", "child_process", "node:net"]) assert.ok(isBuiltin(module));
  assert.ok(!isBuiltin("react"));
});

test("product dependencies respect platform and renderer boundaries", () => {
  for (const file of productFiles) {
    const owner = pathName(file);
    const check = (specifier: string, runtime: boolean) => {
      if (!specifier.startsWith(".")) {
        if (owner.startsWith("shared/") || owner.startsWith("src/"))
          assert.ok(!isBuiltin(specifier) && !specifier.startsWith("node:") && specifier !== "electron", `${owner} imports ${specifier}`);
        if (owner.startsWith("shared/")) assert.ok(specifier !== "react" && specifier !== "react-dom", owner);
        return;
      }
      const dependency = localModule(file, specifier);
      assert.ok(dependency, `${owner}: unresolved ${specifier}`);
      const destination = pathName(dependency);
      if (owner === "src/features/history/model.ts" || owner.startsWith("src/features/inspection/") || owner === "src/features/layers/projection.ts")
        assert.ok(!destination.endsWith(".css"), `${owner}: pure model cannot load styles`);
      assert.ok(!/^(scripts|tests|benchmarks)\//.test(destination), `${owner} depends on diagnostics: ${destination}`);
      if (owner.startsWith("shared/")) assert.ok(destination.startsWith("shared/"), `${owner} -> ${destination}`);
      if (owner.startsWith("src/")) assert.ok(!destination.startsWith("electron/"), `${owner} -> ${destination}`);
      if (runtime && /^electron\/(device|platform)\//.test(owner))
        assert.ok(!/^electron\/(capture|sdk|automation|desktop)\//.test(destination) && destination !== "electron/main.ts", `${owner} -> ${destination}`);
      if (owner.startsWith("electron/device/"))
        assert.ok(!destination.startsWith("electron/capture/"), `${owner}: device must not depend on capture, including types: ${destination}`);
    };
    for (const ref of productReferences.get(file)!) check(ref.specifier, ref.runtime);
  }
});

test("product runtime imports have no circular dependencies", () => {
  const visited = new Set<string>();
  function visit(file: string, stack: string[]) {
    assert.ok(!stack.includes(file), [...stack, file].map(pathName).join(" -> "));
    if (visited.has(file)) return;
    for (const dependency of runtimeEdges.get(file) ?? []) visit(dependency, [...stack, file]);
    visited.add(file);
  }
  assert.equal(runtimeEdges.size, productFiles.length);
  for (const file of productFiles) visit(file, []);
});

test("JDWP wire transport and View codecs do not depend on capture orchestration", () => {
  for (const entry of ["jdwp-transport", "view-protocol"]) {
    const file = resolve(project, `electron/capture/${entry}.ts`);
    for (const ref of references(file).filter(ref => ref.runtime && ref.specifier.startsWith(".")))
      assert.fail(`${entry} must not import product orchestration: ${ref.specifier}`);
  }
  const entry = resolve(project, "electron/capture/view-debug.ts");
  const text = readFileSync(entry, "utf8");
  assert.ok(text.includes("export async function probeWindowName") && text.includes("export async function captureViewLayers"));
  assert.doesNotMatch(text, /createConnection|class SocketReader|function parseCapturedViewLayers|function captureViewBitmaps|export .* from/);
});

test("App composes workspace/automation without owning their request subscriptions or snapshot setters", () => {
  const app = readFileSync(resolve(project, "src/App.tsx"), "utf8");
  assert.ok(app.includes("useInspectionWorkspace(") && app.includes("useDebugSession({"));
  assert.doesNotMatch(app, /window\.electronApi\.(inspectDevice|onInspectionPreview|onInspectionProgress|onDebugSession|getDebugSession|startDebugSession)\s*\(/);
  assert.doesNotMatch(app, /\bsetSnapshot\s*\(/);
  assert.ok(app.includes("useSnapshotLibrary({") && app.includes("useWorkbenchCommands({"));
  const library = readFileSync(resolve(project, "src/features/history/useSnapshotLibrary.ts"), "utf8");
  assert.ok(/showSnapshot\(entry\.snapshot[,)]/.test(library) && /showSnapshot\(next,\s*selectedNodeId[,)]/.test(library));
  for (const [owner, forbidden] of [["inspection", "automation"], ["automation", "inspection"]]) {
    const directory = resolve(project, `src/features/${owner}`);
    for (const file of sourceFiles(directory)) for (const ref of references(file).filter(ref => ref.specifier.startsWith(".")))
      assert.ok(!pathName(localModule(file, ref.specifier)!).startsWith(`src/features/${forbidden}/`), `${pathName(file)}: lifecycle owners must not import each other`);
  }
});

test("moved diagnostics resolve imports, child scripts and local evidence paths", () => {
  const evidence = resolve(project, ".benchmarks");
  for (const file of sourceFiles(resolve(project, "scripts/diagnostics"))) {
    for (const ref of references(file).filter(ref => ref.specifier.startsWith(".")))
      assert.ok(localModule(file, ref.specifier), `${pathName(file)}: unresolved ${ref.specifier}`);
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && /(^|\.)(join|resolve)$/.test(node.expression.getText(source))
        && node.arguments[0]?.getText(source) === "import.meta.dirname" && node.arguments[1] && ts.isStringLiteral(node.arguments[1])) {
        const value = node.arguments[1].text, destination = resolve(dirname(file), value);
        if (/\.(ts|cjs|mjs)$/.test(value)) assert.ok(existsSync(destination), `${pathName(file)}: missing child ${value}`);
        if (value.includes(".benchmarks")) assert.ok(destination === evidence || destination.startsWith(evidence + "/"), pathName(file));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
});

test("CLI/MCP builds use product entrypoints and stable output paths", () => {
  const pkg = JSON.parse(readFileSync(resolve(project, "package.json"), "utf8"));
  for (const entry of ["cli", "mcp"]) {
    assert.ok(pkg.scripts[`build:${entry}`].includes(`electron/automation/${entry}.ts`));
    assert.ok(pkg.scripts[`build:${entry}`].includes(`dist-electron/${entry}.cjs`));
    assert.ok(existsSync(resolve(project, `electron/automation/${entry}.ts`)));
  }
  assert.equal(pkg.main, "dist-electron/main.cjs");
  assert.equal(pkg.bin["android-ui"], "dist-electron/cli.cjs");
});

test("retired entrypoints stay removed and the current directory guide resolves", () => {
  for (const file of ["electron/adb.ts", "electron/view-debug.ts", "electron/sdk-hybrid.ts", "electron/mcp-server.ts",
    "electron/mcp-snapshot.ts", "electron/mcp-live.ts", "src/components/Layer3DPreview.tsx", "scripts/cli.ts", "scripts/mcp.ts"])
    assert.ok(!existsSync(resolve(project, file)), `retired forwarding entrypoint: ${file}`);
  const guide = readFileSync(resolve(project, "docs/DEVELOPMENT_STRUCTURE.md"), "utf8");
  const paths = [...guide.matchAll(/`((?:electron|src|shared|scripts|android)\/[^`]+)`/g)].map(match => match[1]);
  assert.ok(paths.length >= 20, "directory guide must identify real entrypoints");
  for (const path of paths) assert.ok(existsSync(resolve(project, path)), `directory guide: ${path}`);
  for (const match of guide.matchAll(/`([A-Za-z]+\.java)`/g))
    assert.ok(existsSync(resolve(project, "android/inspector-sdk/src/main/java/com/androiduiinspector/sdk", match[1])), `SDK directory guide: ${match[1]}`);
});


test("capture orchestration does not hide routing state in command context", () => {
  for (const file of productFiles) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const inspect = (node: ts.Node) => {
      if (ts.isIdentifier(node)) assert.notEqual(node.text, "inspectionContext", `${pathName(file)} retains implicit capture context`);
      ts.forEachChild(node, inspect);
    };
    inspect(source);
  }
  const file = resolve(project, "electron/device/command-context.ts");
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  let stores = 0;
  const inspect = (node: ts.Node) => {
    if (ts.isNewExpression(node) && node.expression.getText(source) === "AsyncLocalStorage") {
      stores++;
      assert.equal(node.typeArguments?.length, 1);
      const argument = node.typeArguments![0];
      const fields = ts.isUnionTypeNode(argument) ? argument.types : [argument];
      assert.ok(fields.length > 0 && fields.every(type => type.getText(source) === "AbortSignal" || type.kind === ts.SyntaxKind.UndefinedKeyword),
        "command context may carry only an AbortSignal, never capture options or routing policy");
    }
    ts.forEachChild(node, inspect);
  };
  inspect(source);
  assert.equal(stores, 1, "command cancellation has one task-local owner");
});

test("capture routing, preview, identity and session regressions call real product functions", () => {
  for (const name of ["sdk-capture-route", "capture-preview-cancel", "sdk-tree-identity-reuse", "capture-session-flow"]) {
    const source = readFileSync(resolve(project, `tests/${name}.test.ts`), "utf8");
    assert.doesNotMatch(source, /new Function|transpileModule|productionDeclarations|source\.slice\(/,
      `${name}: do not execute extracted production source`);
  }
});

test("debug session owns lifecycle while target resolution, execution and recording keep their dependency boundaries", () => {
  const module = (name: string) => resolve(project, `electron/automation/${name}.ts`);
  const dependencies = (name: string) => (runtimeEdges.get(module(name)) ?? []).map(pathName);
  const facade = dependencies("debug-session"), executor = dependencies("debug-step-executor");
  assert.ok(facade.includes("electron/automation/debug-step-executor.ts"));
  assert.ok(facade.includes("electron/automation/debug-session-recording.ts"));
  assert.ok(!facade.includes("electron/automation/debug-evidence.ts"), "session must delegate artifact persistence");
  assert.ok(!facade.includes("electron/automation/debug-target-resolution.ts"), "session must delegate target resolution to its executor");
  assert.ok(executor.includes("electron/automation/debug-target-resolution.ts"));
  assert.ok(executor.includes("electron/automation/debug-task-execution.ts"));
  for (const dependency of executor)
    assert.ok(!/debug-(?:session(?:-recording)?|evidence|logs)\.ts$/.test(dependency), `executor cannot own session or evidence IO: ${dependency}`);

  const domainModules = ["debug-target-resolution", "debug-scroll-geometry", "debug-ui-step", "debug-task-execution", "debug-scroll-execution"];
  for (const name of domainModules) {
    for (const ref of references(module(name)).filter(ref => ref.runtime)) {
      if (!ref.specifier.startsWith(".")) {
        assert.ok(name === "debug-task-execution" && ref.specifier === "node:crypto", `${name}: unexpected runtime IO dependency ${ref.specifier}`);
        continue;
      }
      const dependency = localModule(module(name), ref.specifier)!;
      // Pure sibling decisions may compose; every member is checked for IO here.
      assert.ok(pathName(dependency).startsWith("shared/") || domainModules.some(sibling => module(sibling) === dependency),
        `${name}: domain decisions cannot call device or session IO`);
    }
  }
  const recording = dependencies("debug-session-recording");
  assert.ok(recording.includes("electron/automation/debug-evidence.ts"));
  for (const dependency of recording)
    assert.ok(!/debug-(?:session|step-executor)\.ts$/.test(dependency) && !/^electron\/(?:device|capture)\//.test(dependency),
      `recording cannot execute or observe a device: ${dependency}`);

});

test("node capture facts stay independent of presentation and IO and are called by each migrated consumer", () => {
  const facts = resolve(project, "shared/node-capture-facts.ts");
  const consumers = ["shared/node-presentation-status.ts", "shared/node-image-export.ts", "src/features/reports/live-diagnosis.ts",
    "src/features/layers/Layer3DPreview.tsx", "src/components/NodePropertiesPanel.tsx"];
  for (const ref of references(facts).filter(ref => ref.runtime)) {
    assert.ok(ref.specifier.startsWith("."), `capture facts cannot depend on runtime IO: ${ref.specifier}`);
    const dependency = localModule(facts, ref.specifier);
    assert.ok(dependency && pathName(dependency).startsWith("shared/"), `capture facts must remain independent of application runtimes: ${ref.specifier}`);
    assert.ok(!consumers.includes(pathName(dependency!)), "facts cannot import a consumer's presentation or export policy");
  }
  for (const name of consumers) {
    const file = resolve(project, name), source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    assert.ok(runtimeEdges.get(file)?.includes(facts), `${name} must consume capture facts at runtime`);
    const bindings = new Set<string>();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
        || localModule(file, statement.moduleSpecifier.text) !== facts) continue;
      const named = statement.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) for (const element of named.elements)
        if ((element.propertyName ?? element.name).text === "nodeCaptureFacts") bindings.add(element.name.text);
    }
    let used = false;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && bindings.has(node.expression.text)) used = true;
      ts.forEachChild(node, visit);
    };
    visit(source);
    assert.ok(used, `${name} must use the adapter rather than only importing it`);
  }
});
