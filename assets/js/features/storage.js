// Browsers may expose Storage while denying access to its getter or methods.
// Preferences are optional: a denied read/write must not stop page setup.
export function readStorage(name, key) {
  try {
    return window[name]?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeStorage(name, key, value) {
  try {
    window[name]?.setItem(key, value);
  } catch {}
}
