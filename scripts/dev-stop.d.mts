/** Types for scripts/dev-stop.mjs, so its tests can import it. */

export interface Listener {
  port: number;
  pid: number;
  name?: string;
}

export const DEV_PORTS: number[];
export function mayStop(pid: number, self?: number): boolean;
export function parseNetstat(output: string, ports: number[]): Listener[];
export function parseSs(output: string, ports: number[]): Listener[];
export function devStop(
  ports: number[],
  options?: { dryRun?: boolean; log?: (line: string) => void },
): Promise<number>;
