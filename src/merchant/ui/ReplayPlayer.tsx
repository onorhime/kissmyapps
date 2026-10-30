import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { FastForward, LoaderCircle, Pause, Play, RotateCcw } from 'lucide-react'
import { Replayer } from '@rrweb/replay'
import '@rrweb/replay/dist/style.css'
import type { EventRow } from '../api'
import { formatClockDuration } from '../format'
import { Select } from './Primitives'

type RecordedEvent = { type: number; timestamp: number; data?: unknown }

export type ReplayData = {
  events: RecordedEvent[]
  /** Server time minus device time, so session events line up with the recording. */
  skewMs: number
}

const speeds = ['1', '2', '4', '8'] as const

/** Plays an rrweb recording scaled into its box, with a timeline of the session's events. */
export function ReplayPlayer({
  replay,
  events,
  onTime,
  seekTo,
}: {
  replay: ReplayData
  events: EventRow[]
  onTime?: (time: number) => void
  seekTo?: { time: number; nonce: number } | null
}) {
  const stage = useRef<HTMLDivElement>(null)
  const mount = useRef<HTMLDivElement>(null)
  const player = useRef<Replayer | null>(null)
  const frame = useRef<number>(0)
  const [ready, setReady] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [total, setTotal] = useState(0)
  const [start, setStart] = useState(0)
  const [speed, setSpeed] = useState<(typeof speeds)[number]>('1')
  const [skipIdle, setSkipIdle] = useState(true)
  const [skipping, setSkipping] = useState(false)
  const [viewport, setViewport] = useState<{ width: number; height: number } | null>(null)
  const [box, setBox] = useState({ width: 0, height: 0 })

  const complete =
    replay.events.some((event) => event.type === 2) &&
    replay.events.some((event) => event.type === 4)

  useLayoutEffect(() => {
    const element = stage.current
    if (!element) return
    const measure = () => setBox({ width: element.clientWidth, height: element.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const root = mount.current
    if (!root || !complete) return
    const replayer = new Replayer(replay.events as never[], {
      root,
      skipInactive: true,
      showWarning: false,
      mouseTail: { strokeStyle: '#279fd7', lineWidth: 2, duration: 500, lineCap: 'round' },
      triggerFocus: false,
      pauseAnimation: true,
    })
    player.current = replayer
    const meta = replayer.getMetaData()
    setTotal(meta.totalTime)
    setStart(meta.startTime)
    const firstMeta = replay.events.find((event) => event.type === 4)?.data as
      { width?: number; height?: number } | undefined
    if (firstMeta?.width && firstMeta?.height)
      setViewport({ width: firstMeta.width, height: firstMeta.height })
    replayer.on('resize', (dimension) => {
      const size = dimension as { width: number; height: number }
      if (size.width && size.height) setViewport({ width: size.width, height: size.height })
    })
    replayer.on('finish', () => {
      setPlaying(false)
      setCurrent(meta.totalTime)
    })
    replayer.on('skip-start', () => setSkipping(true))
    replayer.on('skip-end', () => setSkipping(false))
    replayer.pause(0)
    setReady(true)
    return () => {
      cancelAnimationFrame(frame.current)
      replayer.destroy()
      player.current = null
      setReady(false)
    }
  }, [replay, complete])

  const tick = useCallback(() => {
    const replayer = player.current
    if (!replayer) return
    const time = Math.min(replayer.getCurrentTime(), replayer.getMetaData().totalTime)
    setCurrent(time)
    onTime?.(time)
    frame.current = requestAnimationFrame(tick)
  }, [onTime])

  useEffect(() => {
    if (!playing) return
    frame.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame.current)
  }, [playing, tick])

  useEffect(() => {
    player.current?.setConfig({ speed: Number(speed), skipInactive: skipIdle })
  }, [speed, skipIdle, ready])

  const seek = useCallback(
    (time: number, play = playing) => {
      const replayer = player.current
      if (!replayer) return
      const clamped = Math.max(0, Math.min(time, total))
      if (play) replayer.play(clamped)
      else replayer.pause(clamped)
      setCurrent(clamped)
      onTime?.(clamped)
    },
    [onTime, playing, total],
  )

  useEffect(() => {
    if (seekTo && ready) seek(seekTo.time)
    // Only a new request from outside moves the player.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seekTo?.nonce, ready])

  const toggle = () => {
    const replayer = player.current
    if (!replayer) return
    if (playing) {
      replayer.pause()
      setPlaying(false)
    } else {
      const from = current >= total ? 0 : current
      replayer.play(from)
      setPlaying(true)
    }
  }

  const scale =
    viewport && box.width
      ? Math.min(box.width / viewport.width, box.height / viewport.height, 1.5)
      : 1
  const markers = events
    .map((event) => ({ event, offset: Date.parse(event.time) - replay.skewMs - start }))
    .filter((marker) => marker.offset >= 0 && marker.offset <= total)

  if (!complete) {
    return (
      <div className="mc-replay-missing">
        <p>
          This recording is incomplete: the first part, with the page as it first appeared, never
          arrived. It usually means the visitor left within a few seconds.
        </p>
      </div>
    )
  }

  return (
    <div className="mc-replay">
      <div className="mc-replay-stage" ref={stage}>
        <div
          className="mc-replay-mount"
          ref={mount}
          style={
            viewport
              ? {
                  width: viewport.width,
                  height: viewport.height,
                  transform: `translate(-50%, -50%) scale(${scale})`,
                }
              : undefined
          }
        />
        {!ready && (
          <div className="mc-replay-loading">
            <LoaderCircle className="mc-spin" size={20} aria-hidden="true" /> Preparing the replay
          </div>
        )}
        {skipping && <div className="mc-replay-skipping">Skipping inactivity</div>}
        {viewport && (
          <span className="mc-replay-size mc-num">
            {viewport.width} × {viewport.height}
          </span>
        )}
      </div>
      <div className="mc-replay-controls">
        <button
          type="button"
          className="mc-icon-btn mc-replay-play"
          onClick={toggle}
          disabled={!ready}
          aria-label={
            playing ? 'Pause' : current >= total && total > 0 ? 'Replay from the start' : 'Play'
          }
        >
          {playing ? (
            <Pause size={18} aria-hidden="true" />
          ) : current >= total && total > 0 ? (
            <RotateCcw size={18} aria-hidden="true" />
          ) : (
            <Play size={18} aria-hidden="true" />
          )}
        </button>
        <span className="mc-num mc-replay-clock">
          {formatClockDuration(current)} / {formatClockDuration(total)}
        </span>
        <div className="mc-replay-track">
          <input
            type="range"
            min={0}
            max={Math.max(1, total)}
            step={100}
            value={current}
            aria-label="Position in the recording"
            aria-valuetext={formatClockDuration(current)}
            onChange={(event) => seek(Number(event.target.value))}
            disabled={!ready}
          />
          <div className="mc-replay-markers" aria-hidden="true">
            {markers.map(({ event, offset }) => (
              <span
                key={event.id}
                className={
                  event.name === 'error_thrown'
                    ? 'is-error'
                    : event.name === 'page_viewed' || event.name === 'screen_viewed'
                      ? 'is-page'
                      : undefined
                }
                style={{ left: `${(offset / Math.max(1, total)) * 100}%` }}
                title={`${event.name} at ${formatClockDuration(offset)}`}
              />
            ))}
          </div>
        </div>
        <Select
          label="Speed"
          hideLabel
          value={speed}
          onChange={setSpeed}
          options={speeds.map((value) => ({ value, label: `${value}×` }))}
        />
        <button
          type="button"
          className={skipIdle ? 'mc-btn mc-btn-quiet is-on' : 'mc-btn mc-btn-quiet'}
          aria-pressed={skipIdle}
          onClick={() => setSkipIdle((value) => !value)}
        >
          <FastForward size={16} aria-hidden="true" /> Skip idle
        </button>
      </div>
    </div>
  )
}
