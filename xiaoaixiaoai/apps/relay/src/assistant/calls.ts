/** The one open voice call, whichever provider carries it: a new call replaces the old one. */

export interface OpenCall {
  stop(why: string): void;
}

let current: OpenCall | null = null;

export function claimCall(call: OpenCall): void {
  current?.stop("replaced");
  current = call;
}

export function releaseCall(call: OpenCall): void {
  if (current === call) current = null;
}

export function endAllCalls(): void {
  current?.stop("服务关闭");
}
