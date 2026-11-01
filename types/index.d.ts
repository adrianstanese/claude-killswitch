// One rate-limit window as last reported: five_hour or seven_day.
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

// One point of the usage history: when (ms), which window, percent, its reset.
export type Sample = { t: number; k: string; p: number; r?: string }

export type KillswitchConfig = {
  isArmed: boolean
  threshold: number
  // Set by /killswitch <percent>, so the settings' threshold no longer applies.
  isCustom?: boolean
  // Set while tripped: when the blocking window resets (ms), absent if unknown.
  isTripped: boolean
  resumesAt?: number
  reason?: string
  savedTo?: string
  // Whether a request was in progress when it tripped, so it is resumed after.
  wasWorking?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    killswitch: {
      config: Shaped<KillswitchConfig>
      limits: Limit[]
      isBandHidden: boolean
      // Per window, the resetsAt it was last warned for.
      warned: Record<string, string>
    }
  }
}
