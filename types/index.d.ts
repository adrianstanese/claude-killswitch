// One rate-limit window as last reported: five_hour or seven_day.
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type KillswitchConfig = {
  isArmed: boolean
  threshold: number
  // Set while tripped: when the blocking window resets (ms), absent if unknown.
  isTripped: boolean
  resumesAt?: number
  reason?: string
  savedTo?: string
}

declare module 'claude-code' {
  interface PluginState {
    killswitch: {
      config: Shaped<KillswitchConfig>
      limits: Limit[]
      isBandHidden: boolean
    }
  }
}
