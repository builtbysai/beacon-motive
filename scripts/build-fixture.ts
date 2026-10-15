// Compiles the Windows Forms test app with the C# compiler that ships with Windows (.NET Framework 4); no SDK needed.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const csc = `${process.env.WINDIR ?? "C:\\Windows"}\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe`;
if (process.platform !== "win32" || !existsSync(csc)) {
  console.error("The Windows Forms fixture can only be built on Windows with .NET Framework 4.");
  process.exit(1);
}
mkdirSync("target/fixtures", { recursive: true });
// csc reads a leading "/" as an option, so give it Windows-style paths.
const win = (p: string) => path.resolve(p);
execFileSync(csc, ["/nologo", "/target:winexe", `/out:${win("target/fixtures/MotiveFixture.exe")}`, "/r:System.Windows.Forms.dll", "/r:System.Drawing.dll", win("examples/fixtures/winforms/MotiveFixture.cs")], { stdio: "inherit" });
console.log("built target/fixtures/MotiveFixture.exe");
