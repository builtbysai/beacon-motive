import { spawn, type ChildProcess } from "node:child_process";

// While a desktop recording runs, a small red always-on-top window says so. It is a separate process that exits by
// itself if this one disappears, so a crash cannot leave recording invisibly active. It contains no user data.
const script = (parentPid: number) => `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$parent = ${parentPid}
$f = New-Object System.Windows.Forms.Form
$f.Text = 'Motive recording'
$f.FormBorderStyle = 'FixedToolWindow'
$f.TopMost = $true
$f.ShowInTaskbar = $false
$f.StartPosition = 'Manual'
$f.Location = New-Object System.Drawing.Point(20, 20)
$f.ClientSize = New-Object System.Drawing.Size(330, 34)
$f.BackColor = [System.Drawing.Color]::FromArgb(176, 0, 32)
$l = New-Object System.Windows.Forms.Label
$l.Text = ([string][char]0x25CF) + ' Recording (Motive). Passwords are not captured.'
$l.ForeColor = [System.Drawing.Color]::White
$l.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
$l.AutoSize = $false
$l.Dock = 'Fill'
$l.TextAlign = 'MiddleCenter'
$f.Controls.Add($l)
$t = New-Object System.Windows.Forms.Timer
$t.Interval = 1000
$t.Add_Tick({ if (-not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { $f.Close() } })
$t.Start()
[System.Windows.Forms.Application]::Run($f)
`;

export function showRecordingIndicator(): ChildProcess {
  const encoded = Buffer.from(script(process.pid), "utf16le").toString("base64");
  return spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded], { stdio: "ignore" });
}
