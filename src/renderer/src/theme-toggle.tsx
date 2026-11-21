import { useEffect, useState } from 'react'
import type { ThemePreference } from '../../shared/contracts'

export function ThemeSetting() {
  const [theme, setTheme] = useState<ThemePreference>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    void window.mustplay.getThemePreference().then(value => {
      if (active) setTheme(value)
    }).catch(() => { if (active) setError('Не удалось загрузить тему.') })
    return () => { active = false }
  }, [])

  async function changeTheme(value: ThemePreference) {
    setBusy(true)
    setError('')
    try {
      await window.mustplay.setTheme(value)
      setTheme(value)
    } catch {
      setError('Не удалось сохранить тему.')
    } finally {
      setBusy(false)
    }
  }

  return <>
    <label className="settings-option">
      <span>Тема оформления</span>
      <select className="settings-input player-select" aria-label="Тема оформления" value={theme ?? ''} disabled={theme === undefined || busy}
        onChange={event => void changeTheme(event.currentTarget.value as ThemePreference)}>
        {theme === undefined && <option value="">—</option>}
        <option value="system">Системная</option>
        <option value="dark">Тёмная</option>
        <option value="light">Светлая</option>
      </select>
    </label>
    {error && <p role="alert">{error}</p>}
  </>
}
