import { useState } from 'react'
import type { FormEvent } from 'react'
import { LoaderCircle, MailCheck } from 'lucide-react'
import { minuteStrip } from '../data/model'
import { initialProjects, platformLabels } from '../data/sample'
import { formatAgo, formatClock } from '../format'
import { href } from '../routes'
import type { AuthRoute } from '../routes'
import { useDataset, useLiveEvents, useNow, useStore } from '../store'
import { MinuteStrip } from '../ui/Charts'
import { Field } from '../ui/Primitives'

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function useBusy() {
  const [busy, setBusy] = useState(false)
  const run = (action: () => void) => {
    setBusy(true)
    window.setTimeout(() => {
      setBusy(false)
      action()
    }, 650)
  }
  return [busy, run] as const
}

function SignIn() {
  const { signIn } = useStore()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({})
  const [busy, run] = useBusy()

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const next = {
      email: emailPattern.test(email.trim())
        ? undefined
        : 'Enter the email you use for your merchant account.',
      password: password ? undefined : 'Enter your password.',
    }
    setErrors(next)
    if (next.email || next.password) return
    run(() => signIn(email.trim()))
  }

  return (
    <form className="mc-auth-form" onSubmit={submit} noValidate>
      <div className="mc-auth-intro">
        <h1>Sign in to your merchant workspace</h1>
        <p>See every event your apps send, as it arrives.</p>
      </div>
      <Field label="Work email" error={errors.email}>
        {(props) => (
          <input
            {...props}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        )}
      </Field>
      <Field label="Password" error={errors.password}>
        {(props) => (
          <input
            {...props}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        )}
      </Field>
      <a className="mc-link mc-auth-forgot" href={href({ name: 'recover' })}>
        Forgot your password?
      </a>
      <button type="submit" className="mc-btn mc-btn-primary mc-btn-wide" disabled={busy}>
        {busy && <LoaderCircle className="mc-spin" size={16} aria-hidden="true" />}
        {busy ? 'Signing in' : 'Sign in'}
      </button>
      <p className="mc-auth-switch">
        New to KissMyApps Merchant?{' '}
        <a className="mc-link" href={href({ name: 'sign-up' })}>
          Create an account
        </a>
      </p>
    </form>
  )
}

function SignUp() {
  const { signUp } = useStore()
  const [values, setValues] = useState({
    name: '',
    company: '',
    email: '',
    password: '',
    terms: false,
  })
  const [errors, setErrors] = useState<Partial<Record<keyof typeof values, string>>>({})
  const [busy, run] = useBusy()
  const set = (key: keyof typeof values, value: string | boolean) =>
    setValues((current) => ({ ...current, [key]: value }))

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const next: typeof errors = {
      name: values.name.trim() ? undefined : 'Enter your name.',
      company: values.company.trim() ? undefined : 'Enter your company or studio name.',
      email: emailPattern.test(values.email.trim()) ? undefined : 'Enter a valid work email.',
      password: values.password.length >= 10 ? undefined : 'Use at least 10 characters.',
      terms: values.terms ? undefined : 'Accept the merchant terms to continue.',
    }
    setErrors(next)
    if (Object.values(next).some(Boolean)) return
    run(() =>
      signUp({
        name: values.name.trim(),
        email: values.email.trim(),
        company: values.company.trim(),
      }),
    )
  }

  return (
    <form className="mc-auth-form" onSubmit={submit} noValidate>
      <div className="mc-auth-intro">
        <h1>Create your merchant account</h1>
        <p>Add a project for each app, get a key and start sending events in a few minutes.</p>
      </div>
      <Field label="Your name" error={errors.name}>
        {(props) => (
          <input
            {...props}
            autoComplete="name"
            value={values.name}
            onChange={(event) => set('name', event.target.value)}
          />
        )}
      </Field>
      <Field label="Company or studio" error={errors.company}>
        {(props) => (
          <input
            {...props}
            autoComplete="organization"
            value={values.company}
            onChange={(event) => set('company', event.target.value)}
          />
        )}
      </Field>
      <Field label="Work email" error={errors.email}>
        {(props) => (
          <input
            {...props}
            type="email"
            autoComplete="email"
            value={values.email}
            onChange={(event) => set('email', event.target.value)}
          />
        )}
      </Field>
      <Field label="Password" hint="At least 10 characters." error={errors.password}>
        {(props) => (
          <input
            {...props}
            type="password"
            autoComplete="new-password"
            value={values.password}
            onChange={(event) => set('password', event.target.value)}
          />
        )}
      </Field>
      <div className={errors.terms ? 'mc-check has-error' : 'mc-check'}>
        <input
          id="mc-terms"
          type="checkbox"
          checked={values.terms}
          aria-describedby={errors.terms ? 'mc-terms-error' : undefined}
          onChange={(event) => set('terms', event.target.checked)}
        />
        <label htmlFor="mc-terms">
          I agree to the KissMyApps merchant terms and privacy policy.
        </label>
        {errors.terms && (
          <p id="mc-terms-error" className="mc-field-error">
            {errors.terms}
          </p>
        )}
      </div>
      <button type="submit" className="mc-btn mc-btn-primary mc-btn-wide" disabled={busy}>
        {busy && <LoaderCircle className="mc-spin" size={16} aria-hidden="true" />}
        {busy ? 'Creating your account' : 'Create account'}
      </button>
      <p className="mc-auth-switch">
        Already have an account?{' '}
        <a className="mc-link" href={href({ name: 'sign-in' })}>
          Sign in
        </a>
      </p>
    </form>
  )
}

function Recover() {
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string>()
  const [sentTo, setSentTo] = useState<string>()
  const [busy, run] = useBusy()

  if (sentTo) {
    return (
      <div className="mc-auth-form">
        <MailCheck size={28} className="mc-auth-icon" aria-hidden="true" />
        <div className="mc-auth-intro">
          <h1>Check your inbox</h1>
          <p>
            If <strong>{sentTo}</strong> has a merchant account, a reset link is on its way. The
            link works for 30 minutes.
          </p>
        </div>
        <a className="mc-btn mc-btn-secondary mc-btn-wide" href={href({ name: 'sign-in' })}>
          Back to sign in
        </a>
        <button
          type="button"
          className="mc-link mc-auth-switch"
          onClick={() => setSentTo(undefined)}
        >
          Use a different email
        </button>
      </div>
    )
  }

  return (
    <form
      className="mc-auth-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        if (!emailPattern.test(email.trim())) {
          setError('Enter the email you sign in with.')
          return
        }
        setError(undefined)
        run(() => setSentTo(email.trim()))
      }}
    >
      <div className="mc-auth-intro">
        <h1>Reset your password</h1>
        <p>
          Enter the email you sign in with and we will send you a link to choose a new password.
        </p>
      </div>
      <Field label="Work email" error={error}>
        {(props) => (
          <input
            {...props}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        )}
      </Field>
      <button type="submit" className="mc-btn mc-btn-primary mc-btn-wide" disabled={busy}>
        {busy && <LoaderCircle className="mc-spin" size={16} aria-hidden="true" />}
        {busy ? 'Sending' : 'Send reset link'}
      </button>
      <p className="mc-auth-switch">
        Remembered it?{' '}
        <a className="mc-link" href={href({ name: 'sign-in' })}>
          Sign in
        </a>
      </p>
    </form>
  )
}

/** A working fragment of the product, so the first screen shows what merchants get. */
function LiveFragment() {
  const project = initialProjects[0]
  const dataset = useDataset(project)
  const events = useLiveEvents(project)
  const now = useNow()
  if (!dataset) return null
  return (
    <section
      className="mc-auth-fragment"
      data-ui
      aria-label={`Live events from ${project.name}, sample data`}
    >
      <div className="mc-fragment-head">
        <span className="mc-live-dot" aria-hidden="true" />
        <strong>{project.name}</strong>
        <span>Arriving now</span>
      </div>
      <ul className="mc-fragment-sources">
        {project.platforms.map((platform) => {
          const last = events.find((event) => event.platform === platform)
          return (
            <li key={platform}>
              <span className="mc-fragment-source">{platformLabels[platform]}</span>
              <MinuteStrip
                points={minuteStrip(dataset, platform, 40)}
                label={`${platformLabels[platform]}, last 40 minutes`}
              />
              <span className="mc-fragment-ago">
                {last ? formatAgo(last.time, now) : 'No events'}
              </span>
            </li>
          )
        })}
      </ul>
      <ol className="mc-fragment-events">
        {events.slice(0, 7).map((event) => (
          <li key={event.id}>
            <span className="mc-num">{formatClock(event.time)}</span>
            <span className="mc-mono">{event.name}</span>
            <span>{platformLabels[event.platform]}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}

export function AuthScreen({ route }: { route: AuthRoute }) {
  return (
    <div className="mc-auth">
      <div className="mc-auth-column">
        <a className="mc-brand" href={href({ name: 'sign-in' })} aria-label="KissMyApps Merchant">
          <img src="/favicon.svg" alt="" width={32} height={32} />
          <span className="mc-brand-text">
            <span className="mc-brand-word">
              Kissmyapps<span>.dev</span>
            </span>
            <span className="mc-brand-context">Merchant</span>
          </span>
        </a>
        <main id="mc-main" className="mc-auth-main">
          {route.name === 'sign-up' ? (
            <SignUp />
          ) : route.name === 'recover' ? (
            <Recover />
          ) : (
            <SignIn />
          )}
        </main>
        <p className="mc-preview-note">
          Preview build. Any email and password opens the sample workspace.
        </p>
      </div>
      <div className="mc-auth-aside">
        <LiveFragment />
      </div>
    </div>
  )
}
