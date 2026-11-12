/**
 * Web vs Android app. In a browser the app talks to its own origin with a
 * session cookie. In the Android app (Capacitor) the web app is bundled in the
 * APK, talks to the household's server at the address entered on first launch,
 * and signs in with a per-device token.
 */
import { Capacitor } from '@capacitor/core';

const SERVER_KEY = 'so.server';
const TOKEN_KEY = 'so.token';

export const isNative = (): boolean => Capacitor.isNativePlatform();

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage unavailable; the app will ask again.
  }
}

/** The server's base URL ('' in the browser: same origin). */
export function serverUrl(): string {
  return isNative() ? (read(SERVER_KEY) ?? '') : '';
}

export function hasServer(): boolean {
  return !isNative() || Boolean(read(SERVER_KEY));
}

/** Tidy what someone typed: add http(s)://, drop trailing slashes and paths. */
export function normaliseServerUrl(input: string): string {
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = `${/^(localhost|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(s) ? 'http' : 'https'}://${s}`;
  const u = new URL(s);
  return `${u.protocol}//${u.host}`;
}

export function setServerUrl(url: string) {
  write(SERVER_KEY, url);
}

export function deviceToken(): string | null {
  return isNative() ? read(TOKEN_KEY) : null;
}

export function setDeviceToken(token: string | null) {
  write(TOKEN_KEY, token);
}

export function apiUrl(path: string): string {
  return `${serverUrl()}${path}`;
}

/** A name for this phone in "People & roles" → devices. */
export function deviceName(): string {
  const m = navigator.userAgent.match(/Android [\d.]+; ([^;)]+)/);
  const model = m?.[1]?.replace(/ Build\/.*/, '').trim();
  return model && model !== 'K' ? model : 'Android phone';
}
