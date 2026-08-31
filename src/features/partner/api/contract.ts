/**
 * Only these partner-safe database objects may be called by the browser gateway.
 * Keep the names synchronized with the hardened Supabase migration.
 */
export const PARTNER_VIEWS = Object.freeze({
  profile: 'partner_profile',
  products: 'partner_product_directory',
  linkOptions: 'partner_link_option_directory',
  links: 'partner_link_directory',
  payoutSummary: 'partner_payout_summary',
  payoutHistory: 'partner_payout_history',
  documents: 'partner_document_directory',
  agreements: 'partner_agreement_directory',
})

export const PARTNER_RPCS = Object.freeze({
  dashboardSummary: 'get_partner_dashboard_summary',
  dashboardTrends: 'get_partner_dashboard_trends',
  payoutDetail: 'get_partner_payout_detail',
  createLink: 'create_partner_link',
  updateLink: 'update_partner_link',
  setLinkStatus: 'set_partner_link_status',
  updateProfile: 'update_partner_profile',
  updateSettings: 'update_partner_settings',
})

// Explicit selections are a second line of defence. Security must still be
// enforced by grants, RLS and RPC output types in Postgres.
export const PARTNER_COLUMNS = Object.freeze({
  profile:
    'email,full_name,public_name,legal_name,entity_type,country_code,timezone,preferred_currency,website,category,audience_description,audience_countries,channels,channel_details,role,status,notifications',
  products:
    'id,slug,name,status,agreement_status,commercial_model,payout_currency,has_live_funnel,main_tracking_url',
  linkOptions: 'id,kind,product_id,key,name,available',
  links:
    'id,name,product_id,product_name,product_slug,funnel_id,funnel_name,source_id,source_name,campaign_id,campaign_name,sub1,sub2,sub3,status,tracking_url,parent_link_id,clicks,leads,installs,purchases,earnings_minor,currency,created_at',
  payoutSummary:
    'currency,open_minor,approved_minor,scheduled_minor,paid_minor,carried_forward_minor,next_expected_payment_at',
  payoutHistory:
    'id,product_name,period_starts_at,period_ends_at,expected_payment_at,status,eligible_net_minor,earnings_minor,adjustments_minor,final_payout_minor,currency,statement_number,statement_available,payment_method,payment_reference,paid_at',
  documents:
    'id,name,document_type,version,status,created_at,effective_at,expires_at,terminated_at,partner_signed_at,company_signed_at,supersedes_document_id,superseded_by_document_id,download_available',
  agreements:
    'product_id,product_name,version,status,model,starts_at,ends_at,attribution_window_days,renewal_duration_days,payout_frequency_days,payout_currency,minimum_payout_minor,rules',
})
