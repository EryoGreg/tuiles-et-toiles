// Injecte dans le paquet mobile (esbuild `inject`) : Buffer et process, que
// les modules du processus principal utilisent comme sous Node.
import { Buffer } from 'buffer';

const debut = Date.now();
const proc = globalThis.process || {};
proc.env = proc.env || {};
proc.platform = proc.platform || 'mobile';
proc.pid = proc.pid || 1;
proc.versions = proc.versions || {};
proc.uptime = proc.uptime || (() => (Date.now() - debut) / 1000);
proc.on = proc.on || (() => proc);
proc.stdout = proc.stdout || { write() {} };
proc.nextTick = proc.nextTick || ((fn, ...a) => Promise.resolve().then(() => fn(...a)));

export const process = proc;
export { Buffer };
globalThis.Buffer = globalThis.Buffer || Buffer;
globalThis.process = proc;
