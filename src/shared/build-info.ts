/**
 * Build stamp. The version and commit are injected by electron-vite at build
 * time; `dev` means the bundle was produced outside a git checkout. The import
 * tab shows both so a stale build can be spotted before debugging the wrong
 * binary. `app.getVersion()` cannot be used for this: in a dev launch it
 * reports Electron's version, not the application's.
 */
declare const __BUILD_COMMIT__: string | undefined
declare const __BUILD_VERSION__: string | undefined

export const buildCommit = typeof __BUILD_COMMIT__ === 'string' && __BUILD_COMMIT__
  ? __BUILD_COMMIT__
  : 'dev'

export const buildVersion = typeof __BUILD_VERSION__ === 'string' && __BUILD_VERSION__
  ? __BUILD_VERSION__
  : '0.0.0'
