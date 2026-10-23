export type InvitationDeliveryStatus =
  'sent' | 'failed' | 'unknown' | 'sending' | 'not_sent' | 'disabled'

export function invitationDeliveryMessage(status: InvitationDeliveryStatus, email: string) {
  switch (status) {
    case 'sent':
      return {
        title: `Invitation sent to ${email}`,
        detail:
          'The email provider accepted the message. Ask the merchant to check their inbox and spam folder.',
        tone: 'success',
      }
    case 'failed':
      return {
        title: 'Invitation created, but the email was not sent',
        detail:
          'You can retry the email or copy the secure link and share it with the invited merchant.',
        tone: 'error',
      }
    case 'unknown':
      return {
        title: 'Invitation email status is not confirmed',
        detail:
          'The email may have been accepted. Check with the merchant before retrying. Retrying keeps the same invitation link.',
        tone: 'warning',
      }
    case 'sending':
      return {
        title: 'Invitation email is being processed',
        detail:
          'Refresh its status before retrying. The secure invitation link is available to copy.',
        tone: 'neutral',
      }
    case 'disabled':
      return {
        title: 'Invitation email is unavailable',
        detail:
          'Email sending is currently disabled. You can copy the secure invitation link and share it with the invited merchant.',
        tone: 'warning',
      }
    case 'not_sent':
      return {
        title: 'Invitation email has not been sent',
        detail: 'Send the invitation by email or copy its secure link for the invited merchant.',
        tone: 'neutral',
      }
  }
}

export function invitationCooldownSeconds(retryAt: string | null | undefined, now: number) {
  if (!retryAt) return 0
  const at = Date.parse(retryAt)
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : 0
}
