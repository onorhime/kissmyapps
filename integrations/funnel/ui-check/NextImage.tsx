import type { ImgHTMLAttributes } from 'react'
export default function NextImage({
  unoptimized: _u,
  priority: _p,
  ...props
}: ImgHTMLAttributes<HTMLImageElement> & { unoptimized?: boolean; priority?: boolean }) {
  return <img {...props} />
}
