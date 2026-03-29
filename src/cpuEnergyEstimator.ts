import * as os from "os";
import * as vscode from "vscode";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// TDP lookup table in watts.
// Sources: Intel ARK (ark.intel.com), AMD product pages.
// Entries are tested in order — place more-specific patterns first.
const TDP_TABLE: Array<{ pattern: RegExp; tdpW: number }> = [
  // Intel Core Ultra (Meteor Lake / Arrow Lake — H-series = 45 W)
  { pattern: /Core.*Ultra.*[579]\s+\d{3}HX/i, tdpW: 55 },
  { pattern: /Core.*Ultra.*[579]\s+\d{3}H/i,  tdpW: 45 },
  { pattern: /Core.*Ultra.*[579]\s+\d{3}U/i,  tdpW: 15 },
  // Intel Core 13th / 14th Gen
  { pattern: /Core.*i[3579]-1[34]\d{3}HX/i,   tdpW: 55 },
  { pattern: /Core.*i[3579]-1[34]\d{3}H/i,    tdpW: 45 },
  { pattern: /Core.*i[3579]-1[34]\d{3}P/i,    tdpW: 28 },
  { pattern: /Core.*i[3579]-1[34]\d{3}U/i,    tdpW: 15 },
  // Intel Core 12th Gen
  { pattern: /Core.*i[3579]-12\d{3}HX/i,      tdpW: 55 },
  { pattern: /Core.*i[3579]-12\d{3}H/i,       tdpW: 45 },
  { pattern: /Core.*i[3579]-12\d{3}P/i,       tdpW: 28 },
  { pattern: /Core.*i[3579]-12\d{3}U/i,       tdpW: 15 },
  // Intel Core 11th Gen
  { pattern: /Core.*i[3579]-11\d{3}H/i,       tdpW: 35 },
  { pattern: /Core.*i[3579]-11\d{3}U/i,       tdpW: 15 },
  // Intel Core 10th Gen
  { pattern: /Core.*i[3579]-10\d{3}H/i,       tdpW: 45 },
  { pattern: /Core.*i[3579]-10\d{3}U/i,       tdpW: 15 },
  // AMD Ryzen 7000 Series
  { pattern: /Ryzen.*[579]\s+7\d{3}HX/i,      tdpW: 55 },
  { pattern: /Ryzen.*[579]\s+7\d{3}HS/i,      tdpW: 35 },
  { pattern: /Ryzen.*[579]\s+7\d{3}H/i,       tdpW: 45 },
  { pattern: /Ryzen.*[579]\s+7\d{3}U/i,       tdpW: 15 },
  // AMD Ryzen 5000 Series
  { pattern: /Ryzen.*[579]\s+5\d{3}HX/i,      tdpW: 45 },
  { pattern: /Ryzen.*[579]\s+5\d{3}HS/i,      tdpW: 35 },
  { pattern: /Ryzen.*[579]\s+5\d{3}H/i,       tdpW: 45 },
  { pattern: /Ryzen.*[579]\s+5\d{3}U/i,       tdpW: 15 },
  // Apple Silicon
  { pattern: /Apple M\d+ Ultra/i,             tdpW: 60 },
  { pattern: /Apple M\d+ Max/i,               tdpW: 30 },
  { pattern: /Apple M\d+ Pro/i,               tdpW: 20 },
  { pattern: /Apple M\d/i,                    tdpW: 15 },
  // Intel desktop (K/KF/KS = 125 W, plain = 65 W)
  { pattern: /Core.*i9-\d{4}K/i,              tdpW: 125 },
  { pattern: /Core.*i7-\d{4}K/i,              tdpW: 125 },
  { pattern: /Core.*i[3579]-\d{4}[^A-Z]/i,   tdpW: 65 },
];

// Safe default: mid-range laptop H-series
const DEFAULT_TDP_W = 45;

// Cache so we only query the OS once per extension session
let cachedTdpW: number | undefined;

// Return TDP in watts: user setting → lookup table → default
export async function detectTdpWatts(): Promise<number> {
  const config = vscode.workspace.getConfiguration("testCaseAnalysis");
  const override = config.get<number | null>("tdpWatts");
  if (override !== null && override !== undefined && override > 0) {
    return override;
  }

  if (cachedTdpW !== undefined) {
    return cachedTdpW;
  }

  try {
    const cpuModel = await getCpuModelName();
    const entry = TDP_TABLE.find(({ pattern }) => pattern.test(cpuModel));
    cachedTdpW = entry?.tdpW ?? DEFAULT_TDP_W;
  } catch {
    cachedTdpW = DEFAULT_TDP_W;
  }

  return cachedTdpW;
}

// Return idle baseline in watts: idleBaselinePercent% of TDP (user-configurable)
export function getIdleBaselineW(tdpW: number): number {
  const config = vscode.workspace.getConfiguration("testCaseAnalysis");
  const baselinePercent = config.get<number>("idleBaselinePercent") ?? 12.5;
  return tdpW * (baselinePercent / 100);
}

// Query the CPU model name from the OS
async function getCpuModelName(): Promise<string> {
  const platform = os.platform();

  if (platform === "win32") {
    const { stdout } = await execAsync(
      "powershell -noprofile -command \"(Get-WmiObject Win32_Processor).Name\""
    );
    return stdout.trim();
  }

  if (platform === "linux") {
    const { stdout } = await execAsync(
      "grep -m1 'model name' /proc/cpuinfo | cut -d: -f2"
    );
    return stdout.trim();
  }

  if (platform === "darwin") {
    const { stdout } = await execAsync("sysctl -n machdep.cpu.brand_string");
    return stdout.trim();
  }

  return "";
}
