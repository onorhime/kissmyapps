import { useLayoutEffect, useRef, useState } from 'react'

export type Point = { time: number; value: number; partial?: boolean }

/** Validated on #222222 with the dataviz palette check: in band, CVD-safe in this order. */
export const seriesColors = ['#279fd7', '#c28621', '#dc6499', '#48ac51']

export function useWidth<T extends HTMLElement>(fallback = 640) {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(fallback)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () => {
      const next = Math.round(element.getBoundingClientRect().width)
      if (next > 0) setWidth(next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, width] as const
}

/** 4–6 round ticks with the top tick above the maximum, so the line never touches the edge. */
export function niceTicks(max: number, target = 4): number[] {
  if (max <= 0) return [0, 1, 2, 3, 4]
  const rough = max / target
  const magnitude = Math.pow(10, Math.floor(Math.log10(rough)))
  const step =
    [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((value) => value >= rough) ??
    10 * magnitude
  let top = Math.ceil(max / step) * step
  if (top <= max) top += step
  const ticks: number[] = []
  for (let value = 0; value <= top + step / 2; value += step)
    ticks.push(Number(value.toPrecision(12)))
  return ticks
}
