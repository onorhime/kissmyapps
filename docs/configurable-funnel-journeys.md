# Configurable funnel journeys

KMA reporting has three distinct parts. **Journey stages, conversions and paths** describe the product's customer journey. **Custom metric cards** count additional events or states. **Clicks and verified commerce** provide the common traffic, revenue, refund and earnings figures. The webinar journey is a visible, editable template; it is not an implicit requirement for every product.

This guide describes the local configurable-journey implementation. It does not establish that a hosted migration, product connection or provider activation has happened. Checkout and payouts are separate controls and are not enabled by publishing a reporting definition.

## Who configures and who sends

An authorised KMA **owner or operations administrator** selects the product and funnel, configures the journey, saves a draft and publishes it. Other permitted administrators can read the settings. Creators see the published report for their own permitted product and attribution scope; they cannot change the reporting rules. This work does not introduce a merchant self-service administration role.

The product's developer instruments the actual actions and sends signed server events using the exact configured event names. A template, saved stage or published card does not install tracking in the product. Each product/funnel still needs its own approved HMAC binding and event delivery integration.

For example, a course product can define `trial_started` → `first_lesson_completed` → verified purchase. A scheduling product can instead define `consultation_requested` → `consultation_attended` → verified purchase. Neither needs webinar, English assessment or marathon stages.

## Admin workflow

1. Open the product's funnel reporting configuration. Set the explicit Test/Live click environment and the reporting conversion window.
2. Start with a blank journey, a sales template or a webinar template. Selecting a template should be an explicit edit, not an automatic replacement of an existing draft.
3. Add stages and name them as they should appear to creators. For event stages, enter one or more exact event keys. Use a state or context rule only when the product sends the corresponding evidence.
4. Add conversion rates and paths by selecting existing stages in their required order. Save the draft, review it and publish the version.
5. Give the integration instructions and event list to the product's developer. Configure its signing binding separately, then deliver controlled Test events and verify the resulting report.
6. Add optional custom cards when a separate occurrence count, current-state count or other supported calculation is useful. An event declared in a published journey stage does not need a duplicate custom card merely to be accepted as a V2 journey event.

Saving a draft does not change a creator's published journey. Publishing creates an immutable definition version. The report identifies the journey version being evaluated; its selector is separate from the custom-card version selector.

## Definition contract

The backend uses the following shape. Names are examples, not reserved product concepts.

```json
{
  "stages": [
    {
      "key": "trial",
      "label": "Trial started",
      "source": "event",
      "event_names": ["trial_started"],
      "context_field": "context_id"
    },
    {
      "key": "activated",
      "label": "First lesson completed",
      "source": "event",
      "event_names": ["first_lesson_completed"],
      "context_field": "context_id"
    },
    {
      "key": "paid",
      "label": "Paying customers",
      "source": "purchase"
    }
  ],
  "rates": [
    {
      "key": "trial_activation",
      "label": "Trial → first lesson",
      "steps": ["trial", "activated"]
    }
  ],
  "paths": [
    {
      "key": "trial_purchase",
      "label": "Trial → first lesson → purchase",
      "steps": ["trial", "activated", "paid"]
    }
  ]
}
```

- A definition supports up to 20 stages, 20 conversion rates and 20 paths. A sequence uses 2–8 different existing stages. Event stages accept 1–8 distinct event keys.
- Keys use lowercase letters, numbers and underscores, starting with a letter, up to 80 characters. Labels can be up to 120 characters.
- `source: "event"` reads accepted behavioural events. Optional `state_value` selects a state such as `attended`; optional `context_field` is one of `context_id`, `webinar_id`, `intake_id` or `assessment_attempt_id`.
- `context_id` is the product-neutral option: for example, the same trial, appointment or course run. When a sequence repeats a context field, the evidence must refer to the same non-empty context. Different webinar or assessment-attempt IDs must not be combined to invent a conversion.
- State-based stages use the latest authoritative revision for that person and context. A corrected `missed` or `unknown` state must not leave an older `attended` event counting as current attendance.
- `source: "purchase"` reads verified paid orders. It cannot have an event key, state or context override. Financial event names and identity-link events cannot be repurposed as configurable behavioural stages.

These rules are declarative. They do not accept executable expressions, arbitrary SQL or unrestricted customer properties.

## Counting and versions

Stages count distinct people in the selected valid creator-click cohort. A conversion rate uses people completing its first stage as the denominator, and people completing the entire ordered sequence as the numerator. The same person's events must occur in the stated order within the reporting window; unrelated users' activity cannot be combined. A zero denominator is unavailable, not zero percent.

Paths count distinct people completing the specified ordered sequence. **Paths are independent and may overlap.** A person can complete both `trial → purchase` and `trial → first lesson → purchase`. Do not add the path counts to calculate total buyers. Use the verified commerce figures for distinct paid orders and refunds.

This is deliberately different from the earlier fixed SpeakSix report, which assigned each paid order to one exclusive purchase path. The legacy compatibility payload and its historical receipts describe that earlier calculation. The configured report uses independent person paths and must not be interpreted as an exclusive breakdown of orders.

The reporting window is measured from the attributed acquisition click. It does not change signed commission attribution terms, validation holds, refund cutoffs or payout eligibility. Reporting uses one acquisition cohort rather than dividing today's purchases from old leads by today's clicks. Test and Live activity remain separate, and unclassified historical clicks are not assumed to be Live.

`journey_version` selects the saved journey rules used to evaluate the retained historical cohort. Events, identities and credited creator links are not rewritten when a new definition is published. Selecting a different definition can produce different stage labels or calculations over that evidence; the displayed version makes that choice explicit. The existing custom-card `version` has its own publication intervals and remains independent.

## Integration requirements

Send events from the product's backend to `POST /functions/v1/funnel-metric-events`, using the existing KMA HMAC protocol. The key binding supplies the product and funnel. The caller must not supply or override the credited creator in the event body.

An illustrative V2 behavioural packet is:

```json
{
  "schema_version": "2",
  "environment": "test",
  "event_id": "33333333-3333-4333-8333-333333333333",
  "dedupe_key": "trial:started:trial_123:user_456",
  "event_name": "trial_started",
  "click_id": "opaque_tracking_click_123456",
  "subject_id": "product_scoped_account_digest_123456",
  "context_id": "trial_123",
  "occurred_at": "2026-10-22T12:00:00Z"
}
```

The IDs above are fictional and are not valid acquisition evidence. In a real packet, retain the actual KMA click reference and a stable opaque product-scoped person identifier. Reuse the same event ID, deduplication key and business evidence on retries. Use the actual occurrence time; do not retimestamp a delayed event to make it appear current.

For a state stage, send `state_value` and a positive `state_revision` that increases when authoritative evidence is corrected. The selected context field must be present in the packet. An accepted event can still fail to match a particular stage when the configured state or context is absent; delivery acceptance is not proof of a counted conversion. Do not infer webinar attendance from a page view or a join-link click.

Identity linking after verified ownership uses the existing reserved `identity_linked` infrastructure event. Follow-up email visits, a team-hosted webinar and returning sessions must preserve the original credited click. Keep latest traffic/UTM source separately. Never send email addresses, assessment answer text, payment credentials or other personal data in these analytics fields.

Custom V2 events are accepted when declared by a published journey stage or a current published custom card in that product/funnel. Previously published journey versions continue to register their event keys, including after archival, so a delayed sender does not lose its established contract. Removing a stage changes the report; it does not revoke an older published event key. Saving only a draft does not register a new event. Existing canonical V2 events retain compatibility with the established producer. Rejected or uncertain deliveries must remain visible in the product's outbox for retry or reconciliation; creating a definition does not automatically replay a backlog.

Purchase, refund, dispute, commission and payout outcomes continue to use the verified commerce and earnings integration. A successful response to a behavioural event cannot create a sale, alter creator credit or pay a commission.

## RPCs and diagnostic limits

- `get_admin_funnel_journey_definition(p_funnel_id)` loads the journey draft, published definition and version list.
- `save_admin_funnel_journey_definition(p_input)` saves the definition draft with its expected revision. Stale edits must fail rather than overwrite newer work.
- `publish_admin_funnel_journey_definition(p_input)` publishes the intended saved draft revision.
- Existing admin/creator report RPCs accept `journey_version` independently of the custom-card `version`.

Sample-event validation checks packet structure. A custom-card preview calculates the supplied sample cards; it does not prove the entire journey, a real creator click, the signing connection or provider delivery. For acceptance, send real signed synthetic events through the isolated Test integration and check the resulting configured stages, rates and paths.

## Local acceptance checklist

- Two different products publish different stage/event definitions; a generic course has no automatically injected webinar stages.
- Journey-only custom events are accepted after publication, while undeclared events and wrong product/funnel bindings are rejected.
- Repeat delivery counts once; verified identity linking does not create duplicate people or replace creator attribution.
- Conversions require the same person and correct order. Repeated context fields require the same entity, and late state corrections win without resurrecting stale states through filters.
- Draft edits do not change a published creator report. Historical version selection remains explicit and immutable.
- Creators cannot change definitions or access another creator's report. Behavioural events cannot fabricate financial outcomes.
- Test/Live scope, currencies, conversion windows and unchanged checkout/payout gates are verified separately.

See [the original metric-card contract](funnel-metrics-contract.md) for the six custom-card counting methods and signed transport details. Its historical test receipts describe the releases at their stated dates, not automatic proof of this implementation's current hosted state.
