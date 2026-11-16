import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

// Only positional local filesystem arguments reach these helpers. Credentials,
// remote URLs and renderer data never become shell commands or script content.
export const POSIX_INSTALLER = `#!/bin/sh
set -u
old_pid="$1"; target="$2"; replacement="$3"; backup="$4"; health="$5"; result="$6"; executable="$7"; old_executable="$8"
printf '%s' waiting > "$result"
count=0
while kill -0 "$old_pid" 2>/dev/null; do
  count=$((count + 1)); if [ "$count" -ge 120 ]; then printf '%s' exit-timeout > "$result"; exit 1; fi
  sleep 1
done
if [ ! -d "$target" ] || [ ! -d "$replacement" ] || [ -e "$backup" ]; then printf '%s' invalid-path > "$result"; exit 1; fi
if ! mv "$target" "$backup"; then printf '%s' rename-failed > "$result"; exit 1; fi
if ! mv "$replacement" "$target"; then
  mv "$backup" "$target"
  printf '%s' rolled-back > "$result"
  "$target/$old_executable" >/dev/null 2>&1 &
  exit 1
fi
"$target/$executable" >/dev/null 2>&1 &
new_pid=$!
count=0
while [ ! -f "$health" ]; do
  if ! kill -0 "$new_pid" 2>/dev/null; then break; fi
  count=$((count + 1)); if [ "$count" -ge 60 ]; then break; fi
  sleep 1
done
if [ -f "$health" ]; then
  printf '%s' installed > "$result"
  # Keep the previous application directory for manual recovery. No user data
  # are inside either directory, and a later installer never reuses this path.
  exit 0
fi
kill "$new_pid" 2>/dev/null || true
wait "$new_pid" 2>/dev/null || true
if mv "$target" "$replacement" && mv "$backup" "$target"; then
  printf '%s' rolled-back > "$result"
  "$target/$old_executable" >/dev/null 2>&1 &
else
  printf '%s' rollback-failed > "$result"
fi
exit 1
`;

export const WINDOWS_INSTALLER = `param(
  [int]$OldPid, [string]$Target, [string]$Replacement, [string]$Backup,
  [string]$Health, [string]$Result, [string]$Executable, [string]$PreviousExecutable
)
$ErrorActionPreference = 'Stop'
function State([string]$Value) { [IO.File]::WriteAllText($Result, $Value) }
function RenameWithRetry([string]$Source, [string]$Destination) {
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try { [IO.Directory]::Move($Source, $Destination); return }
    catch { if ($attempt -eq 29) { throw }; Start-Sleep -Seconds 1 }
  }
}
State 'waiting'
for ($attempt = 0; $attempt -lt 120; $attempt++) {
  if (!(Get-Process -Id $OldPid -ErrorAction SilentlyContinue)) { break }
  if ($attempt -eq 119) { State 'exit-timeout'; exit 1 }
  Start-Sleep -Seconds 1
}
if (!(Test-Path -LiteralPath $Target -PathType Container) -or !(Test-Path -LiteralPath $Replacement -PathType Container) -or (Test-Path -LiteralPath $Backup)) { State 'invalid-path'; exit 1 }
$movedOld = $false
$movedNew = $false
$newProcess = $null
try {
  RenameWithRetry $Target $Backup; $movedOld = $true
  RenameWithRetry $Replacement $Target; $movedNew = $true
  $newProcess = Start-Process -FilePath (Join-Path $Target $Executable) -WorkingDirectory $Target -PassThru
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    if (Test-Path -LiteralPath $Health -PathType Leaf) { State 'installed'; exit 0 }
    if ($newProcess.HasExited) { break }
    Start-Sleep -Seconds 1; $newProcess.Refresh()
  }
  throw 'New application did not acknowledge startup'
} catch {
  try {
    if ($newProcess -and !$newProcess.HasExited) { Stop-Process -Id $newProcess.Id -Force; $newProcess.WaitForExit() }
    if ($movedNew) { RenameWithRetry $Target $Replacement }
    if ($movedOld) { RenameWithRetry $Backup $Target }
    State 'rolled-back'
    Start-Process -FilePath (Join-Path $Target $PreviousExecutable) -WorkingDirectory $Target
  } catch { State 'rollback-failed' }
  exit 1
}
`;

export async function launchPreparedInstall(plan, { platform = process.platform, spawnProcess = spawn } = {}) {
  const script = path.join(plan.jobDirectory, platform === "win32" ? "install.ps1" : "install.sh");
  await fs.writeFile(script, platform === "win32" ? WINDOWS_INSTALLER : POSIX_INSTALLER, { mode: 0o700, flag: "wx" });
  const args = [String(plan.parentPID), plan.target, plan.replacement, plan.backup, plan.health, plan.result, plan.executable, plan.previousExecutable || plan.executable];
  let command, commandArgs;
  if (platform === "win32") {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    command = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    commandArgs = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args];
  } else { command = "/bin/sh"; commandArgs = [script, ...args]; }
  const child = spawnProcess(command, commandArgs, { detached: true, stdio: "ignore", windowsHide: true });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
  return { pid: child.pid };
}
