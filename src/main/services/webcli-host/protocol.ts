export const MAX_BYTES = 10 * 1024 * 1024
export const fail = (code: string, message: string): never => { throw Object.assign(new Error(message), { code }) }
