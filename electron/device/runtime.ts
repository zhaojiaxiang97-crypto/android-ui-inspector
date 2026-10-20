import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { commandSignal } from "./command-context";
import { debugCommandCategory, measureDebugCommand } from "./debug-timing";
import { trackSignalDeadline } from "./signal-deadline";


export const COMMAND_TIMEOUT_MS = 30_000;

export function captureSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const deadline = performance.now() + timeoutMs;
  const timeout = AbortSignal.timeout(timeoutMs);
  return trackSignalDeadline(signal ? AbortSignal.any([signal, timeout]) : timeout, deadline, [signal]);
}

export type CommandResult = {
  code: number | null;
  stdout: Buffer;
  stderr: string;
};

export async function runCommand(command: string, args: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<CommandResult> {
  // Pre-cancelled commands never start and must not increase the command count.
  commandSignal()?.throwIfAborted();
  return measureDebugCommand(debugCommandCategory(command, args), () => executeCommand(command, args, timeoutMs), result => result.code === 0 ? "success" : "failed");
}

function executeCommand(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const signal = commandSignal();
    signal?.throwIfAborted();
    const child = spawn(command, args, { windowsHide: true, signal });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`命令执行超时：${command}`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function addCandidate(candidates: string[], value: string | undefined) {
  if (!value || !existsSync(value) || candidates.includes(value)) return;
  candidates.push(value);
}

export function findAdbPath() {
  const adbName = process.platform === "win32" ? "adb.exe" : "adb";
  const candidates: string[] = [];
  const sdkRoots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT];

  for (const sdkRoot of sdkRoots) {
    addCandidate(candidates, sdkRoot ? join(sdkRoot, "platform-tools", adbName) : undefined);
  }

  if (process.platform === "darwin") {
    addCandidate(candidates, join(homedir(), "Library", "Android", "sdk", "platform-tools", adbName));
    addCandidate(candidates, join("/opt/homebrew", "bin", adbName));
    addCandidate(candidates, join("/usr/local", "bin", adbName));
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    addCandidate(candidates, join(localAppData, "Android", "Sdk", "platform-tools", adbName));

    const wingetPackages = join(localAppData, "Microsoft", "WinGet", "Packages");
    try {
      for (const packageName of readdirSync(wingetPackages)) {
        if (packageName.startsWith("Google.PlatformTools_")) {
          addCandidate(candidates, join(wingetPackages, packageName, "platform-tools", adbName));
        }
      }
    } catch {
      // The optional winget location is absent on most non-Windows machines.
    }
  }

  addCandidate(candidates, join(homedir(), "AppData", "Local", "Android", "Sdk", "platform-tools", adbName));
  for (const pathEntry of (process.env.PATH ?? "").split(delimiter)) {
    addCandidate(candidates, join(pathEntry, adbName));
  }

  return candidates[0] ?? null;
}

export async function runAdb(adbPath: string, args: string[]) {
  return runCommand(adbPath, args);
}

export async function runDeviceAdb(adbPath: string, serial: string, args: string[], timeoutMs = COMMAND_TIMEOUT_MS) {
  return runCommand(adbPath, ["-s", serial, ...args], timeoutMs);
}

export function commandError(prefix: string, result: CommandResult) {
  const detail = result.stderr.trim();
  return detail ? `${prefix}：${detail}` : prefix;
}

export function delay(milliseconds: number) {
  return wait(milliseconds, undefined, { signal: commandSignal() });
}
