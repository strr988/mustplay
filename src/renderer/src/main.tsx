import { createRoot } from 'react-dom/client'
import type { MiniPlayerApi, MustplayApi } from '../../shared/contracts'
import { App } from './app'
import { MiniPlayer } from './mini-player'
import './styles.css'

declare global {
  interface Window {
    mustplay: MustplayApi
    miniPlayer?: MiniPlayerApi
  }
}

const colorScheme = matchMedia('(prefers-color-scheme: light)')
function applyTheme() {
  document.documentElement.dataset.theme = colorScheme.matches ? 'light' : 'dark'
}
applyTheme()
colorScheme.addEventListener('change', () => {
  if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    applyTheme()
    return
  }
  document.startViewTransition(applyTheme)
})
createRoot(document.getElementById('root')!).render(
  window.miniPlayer ? <MiniPlayer api={window.miniPlayer} /> : <App />,
)
