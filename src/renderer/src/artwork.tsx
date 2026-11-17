import { useCallback, useState } from 'react'
import { Icon } from './icons'

const visibilityListeners = new WeakMap<Element, (visible: boolean) => void>()
const observer = new IntersectionObserver(entries => {
  for (const { target, isIntersecting } of entries) visibilityListeners.get(target)?.(isIntersecting)
})

type ArtworkProps = {
  url: string | null
  eager?: boolean
  onLoad?: (image: HTMLImageElement) => void
}

export function Artwork(props: ArtworkProps) {
  return <ArtworkImage key={props.url} {...props} />
}

function ArtworkImage({ url, eager = false, onLoad }: ArtworkProps) {
  const [failed, setFailed] = useState(false)
  const [visible, setVisible] = useState(false)
  const observe = useCallback((element: HTMLSpanElement | null) => {
    if (!element) return
    visibilityListeners.set(element, setVisible)
    observer.observe(element)
    return () => {
      observer.unobserve(element)
      visibilityListeners.delete(element)
    }
  }, [])

  return (
    <span className="artwork" aria-hidden="true" ref={url && !failed && !eager ? observe : undefined}>
      <Icon name="music" />
      {url && !failed && (eager || visible) && (
        <img src={url} alt="" decoding="async" draggable={false} onLoad={onLoad && (event => onLoad(event.currentTarget))}
          onError={() => setFailed(true)} />
      )}
    </span>
  )
}
