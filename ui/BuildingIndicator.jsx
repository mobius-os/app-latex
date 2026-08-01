// Spinner shown in the Build button while a compile runs (CSS animation on
// .building-spin). Same component as Web Studio's.
/* mobius-ui:BuildingIndicator v1 — keep in sync with app-webstudio */
import { Spin } from '@openai/apps-sdk-ui/components/Icon'

export function BuildingIndicator({ size = 20 }) {
  return <Spin width={size} height={size} aria-hidden="true" className="building-spin" />
}
/* /mobius-ui:BuildingIndicator */
