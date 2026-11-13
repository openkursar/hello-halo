import { createRequire } from 'node:module';
import { getLogger } from '../utils/logger.js';
import { loadBinding, nativeError } from './binding.js';

type HostTls = typeof import('node:tls') & { getCACertificates?: (type: 'default') => readonly string[] };
let hostTls: HostTls | undefined;
let observed: readonly string[] | undefined;
let delivered: string[] | undefined;
let reportedUnavailable = false;

export function prepareHttpAttempt(): void {
  const tls = hostTls ??= createRequire(import.meta.url)('node:tls') as HostTls;
  if (typeof tls.getCACertificates !== 'function') {
    if (!reportedUnavailable) {
      reportedUnavailable = true;
      getLogger('Native').warn('Node default CA certificates cannot be inspected; native trust remains in use', { node: process.versions.node });
    }
    return;
  }
  const certificates = tls.getCACertificates('default');
  if (certificates === observed && Object.isFrozen(certificates)) return;
  if (!Array.isArray(certificates) || certificates.some(certificate => typeof certificate !== 'string')) {
    throw new TypeError('Node default CA certificates must be PEM strings');
  }
  if (!delivered || delivered.length !== certificates.length || delivered.some((certificate, index) => certificate !== certificates[index])) {
    try { loadBinding().configureHttpTrust(JSON.stringify(certificates)); }
    catch (error) { throw nativeError(error); }
    delivered = [...certificates];
  }
  observed = certificates;
}
