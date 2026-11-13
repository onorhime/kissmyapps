import { describe, expect, it } from 'vitest'
import { programAppsBackendFixture as apps } from './program-apps-backend.fixture'
import { programBackendFixture as before } from './program-backend.fixture'
import { programRewardsBackendFixture as phase6 } from './program-rewards-backend.fixture'
import {
  appPlatforms,
  changedInput,
  draftFromProgram,
  isAppLink,
  landingKindOf,
  linkAddress,
  offersAppLanding,
  readAppLinks,
  readRewardEvents,
  readState,
  suggestedRewardLabel,
} from './programs'

// The program form's readers against what the Phase 7 database functions really return
// (suite 89_program_app_installs.sql), and against the answers of an older database, captured
// before Phase 7 (program-backend.fixture.ts, program-rewards-backend.fixture.ts).
describe('program readers and the real backend answers, sending people to an app', () => {
  it('reads an app program: its smart link, and that the workspace has app links', () => {
    const answer = apps['workspace_program_get.app_program'] as {
      program: { landing_url: string; app_link: { id: string; url: string; name: string } }
    }
    const state = readState(answer)
    expect(state.app_links_available).toBe(true)
    expect(state.program?.app_link).toEqual(answer.program.app_link)
    expect(offersAppLanding(state)).toBe(true)
    expect(landingKindOf(state.program)).toBe('app')
    // The landing page is the link's address, saved like any other, so nothing new is sent.
    expect(state.program?.landing_url).toBe(answer.program.app_link.url)
    const draft = draftFromProgram(state.program, true)
    expect(draft.landingUrl).toBe(answer.program.landing_url)
    expect(changedInput(draft, state.program)).toEqual({ revision: state.program?.revision })
  })

  it('reads every answer from before Phase 7 as a web page, with no choice offered', () => {
    const older = [
      before.state_draft,
      before.state_live,
      phase6['workspace_program_get.events_draft'],
      phase6['workspace_program_get.both_live'],
    ]
    for (const answer of older) {
      const state = readState(answer)
      expect(state).not.toHaveProperty('app_links_available')
      expect(state.program).not.toHaveProperty('app_link')
      expect(offersAppLanding(state)).toBe(false)
      expect(landingKindOf(state.program)).toBe('web')
    }
  })

  it('reads the smart links a program can send people to, the saved one among them', () => {
    const answer = apps['workspace_program_app_links.listed'] as { links: unknown[] }
    const links = readAppLinks(answer)
    expect(links).toEqual(answer.links)
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ name: 'Get the app', ios: false, android: true })
    expect(appPlatforms(links[0])).toBe('Android')
    expect(readAppLinks({ links: [] })).toEqual([])
    // The saved program's link is found in the list by its id, and has the same address.
    const saved = readState(apps['workspace_program_get.app_program']).program?.app_link
    expect(saved).toBeTruthy()
    const found = links.find((link) => isAppLink(saved!, link))
    expect(found?.id).toBe(saved?.id)
    expect(found?.url).toBe(saved?.url)
  })

  it('reads the words suggested for app events, and none for the rest', () => {
    const events = readRewardEvents(apps['workspace_program_reward_events.with_app_events'])
    const label = (name: string) => events.find((event) => event.name === name)?.suggested_label
    expect(label('app_installed')).toBe('App installed')
    expect(label('app_opened')).toBe('App opened')
    for (const event of events.filter((e) => !['app_installed', 'app_opened'].includes(e.name)))
      expect(event.suggested_label).toBeNull()
    expect(suggestedRewardLabel('app_installed', events)).toBe('App installed')
    // A site's events have no suggestion; their words come from the name.
    const site = readRewardEvents(apps['workspace_program_reward_events.listed'])
    expect(site.map((event) => event.suggested_label)).toEqual([null, null, null])
    expect(suggestedRewardLabel('signup_completed', site)).toBe('Signup completed')
    // An event list from before Phase 7 has no suggestions at all.
    const older = readRewardEvents(phase6['workspace_program_reward_events.listed'])
    for (const event of older) expect(event).not.toHaveProperty('suggested_label')
    expect(suggestedRewardLabel('signup_completed', older)).toBe('Signup completed')
  })

  it('says a link by its address and its app’s platforms in words', () => {
    expect(linkAddress('https://fluent.go.kissmyapps.dev/get-app')).toBe(
      'fluent.go.kissmyapps.dev/get-app',
    )
    expect(linkAddress('https://fluent.go.kissmyapps.dev/')).toBe('fluent.go.kissmyapps.dev')
    expect(appPlatforms({ ios: true, android: true })).toBe('iOS and Android')
    expect(appPlatforms({ ios: true, android: false })).toBe('iOS')
    expect(appPlatforms({ ios: false, android: true })).toBe('Android')
    expect(appPlatforms({ ios: false, android: false })).toBeNull()
  })
})
