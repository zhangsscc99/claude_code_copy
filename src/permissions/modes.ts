export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto'] as const
export type PermissionMode = (typeof PERMISSION_MODES)[number]

export function normalizePermissionMode(value: string): PermissionMode | undefined {
  if (value === 'bypass') return 'bypassPermissions'
  return (PERMISSION_MODES as readonly string[]).includes(value) ? value as PermissionMode : undefined
}

export function isPermissionMode(value: string): value is PermissionMode {
  return normalizePermissionMode(value) !== undefined
}
