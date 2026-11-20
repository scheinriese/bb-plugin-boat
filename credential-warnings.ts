/** Public help and acknowledgements; never credential values. */
export const CREDENTIAL_RISKS_URL = "https://github.com/scheinriese/bb-plugin-boat/blob/main/docs/settings.md#rented-machine-credential-risks";
export const CLEANUP_NOTICE_PREFIX = "Credential cleanup blocked:";

export const TOKEN_REVOCATION_NOTICE_PREFIX = "GitHub token revocation required:";

export function tokenExposureNotice(machineId: string): string {
  return `${TOKEN_REVOCATION_NOTICE_PREFIX} Revoke or rotate the GitHub token in GitHub settings; it may still be on this Mac or returned hardware (${machineId}). If SSH cleanup cannot be restored, the owner must delete the Mac in the Scaleway console → Apple silicon → select the recorded zone and server → Delete after its minimum. The plugin has no cleanup bypass. This reminder remains until the recorded token expiry passes; unknown expiry cannot clear automatically.`;
}
