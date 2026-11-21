import { useEffect, useRef } from 'react'
import type { CSSProperties, RefObject } from 'react'
import type { AudioEffects } from './audio-effects'
import { Icon } from './icons'

export function WavePulse({ audio, effects, playing, intensity }: {
  audio: RefObject<HTMLAudioElement | null>
  effects: RefObject<AudioEffects | null>
  playing: boolean
  intensity: number
}) {
  const artwork = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const target = artwork.current
    const element = audio.current
    const analyser = effects.current?.analyser
    if (!playing || !target || !element || !analyser) return
    const frequency = new Uint8Array(analyser.frequencyBinCount)
    const signal = new Float32Array(analyser.fftSize)
    const bassBins = Math.min(frequency.length - 1, Math.floor(180 * analyser.fftSize / analyser.context.sampleRate))
    let frame = 0
    let level = 0
    let echo = 0

    function draw() {
      if (!target || !element || !analyser) return
      let energy = 0
      if (analyser.context.state === 'running' && !element.muted && element.volume > 0) {
        analyser.getByteFrequencyData(frequency)
        analyser.getFloatTimeDomainData(signal)
        let squares = 0
        for (const sample of signal) squares += sample * sample
        let bass = 0
        for (let index = 1; index <= bassBins; index++) bass = Math.max(bass, frequency[index])
        energy = Math.min(1, Math.sqrt(squares / signal.length) * 1.6 + bass / 400)
      }
      level += (energy - level) * (energy > level ? 0.44 : 0.13)
      echo += (level - echo) * 0.16
      target.style.setProperty('--wave-level', level.toFixed(3))
      target.style.setProperty('--wave-echo', echo.toFixed(3))
      frame = requestAnimationFrame(draw)
    }

    frame = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(frame)
      target.style.removeProperty('--wave-level')
      target.style.removeProperty('--wave-echo')
    }
  }, [audio, effects, playing])

  return <div ref={artwork} className="wave-art" aria-hidden="true"
    style={{ '--wave-intensity': intensity / 100 } as CSSProperties}><Icon name="wave" /></div>
}
