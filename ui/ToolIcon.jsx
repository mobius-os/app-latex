import { Code, Download, Eye } from '@openai/apps-sdk-ui/components/Icon'

const ICON_PATHS = {
  target: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4" />
    </>
  ),
}

const SDK_ICONS = { source: Code, preview: Eye, download: Download }

export function ToolIcon({ name, size = 24 }) {
  const SdkIcon = SDK_ICONS[name]
  if (SdkIcon) return <SdkIcon width={size} height={size} aria-hidden="true" />
  return (
    <svg
      viewBox="0 0 24 24" width={size} height={size}
      fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden
    >
      {ICON_PATHS[name] || ICON_PATHS.target}
    </svg>
  )
}
