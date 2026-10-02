/** Error kinds and the message patterns used to recognize them. */
export type ErrorKind = 'noModels' | 'accessDenied' | 'quota' | 'blocked' | 'network' | 'tooLarge' | 'timeout' | 'cancelled' | 'unknown';

export const AUTH_PATTERN = /log ?in|sign ?in|authenticat|credential|api key/i;
export const QUOTA_PATTERN = /quota|rate.?limit|usage limit|limit (?:reached|exceeded)|\b429\b/i;
export const NETWORK_PATTERN = /network|fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|socket|offline|overloaded|connection/i;
